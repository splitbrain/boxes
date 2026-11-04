import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import type { TurnStateParams } from '../../../../shared/types.ts';
import type { AcpClient, AcpClientHandlers } from './acp-client.ts';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  ThreadConfigOption,
  ThreadModeState,
  ThreadUpdate,
} from './acp-types.ts';
import { convertMessage } from './convert.ts';
import { ThreadStore, type ThreadStoreDeps } from './thread-store.ts';
import { type Message, resetIds } from './translate.ts';

/** A fake AcpClient that records the calls of the store. */
class FakeClient {
  /** The ACP thread id the store reads. */
  sessionId: string | null = 'acp-1';
  /** Every request the store sent, in order. */
  readonly requests: Array<{ method: string; params: unknown }> = [];
  /** Every notification the store sent, in order. */
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  /** The resolvers of the requests that the test holds open. */
  private readonly held: Array<(v: unknown) => void> = [];
  /** True to hold every request open until `settle`. */
  hold = false;
  /** The message every request fails with, or null. */
  fail: string | null = null;
  /** True once the store has disposed the client. */
  disposed = false;

  /** @param handlers The store's callbacks, which the tests call directly. */
  constructor(readonly handlers: AcpClientHandlers) {}

  /** Runs a handshake, which is a load and then ready. */
  start(): void {
    this.load();
    this.handlers.onState('ready');
    this.handlers.onReady(this.modes, this.configOptions);
  }

  /**
   * Simulates a session/load, as the handshake and a reconnect run it. The
   * store names its resume point, and `resumes` decides whether the replay
   * continues there.
   */
  load(): void {
    const from = this.handlers.resumePoint();
    this.resumePoints.push(from);
    const resumed = this.resumes && from !== null;
    this.handlers.onReplay(resumed, this.truncates);
  }

  /** Ends the replay, which publishes what it built. */
  finish(): void {
    this.handlers.onReady(this.modes, this.configOptions);
  }

  /** True when the next load is answered as a resume rather than a full replay. */
  resumes = false;
  /** True when the gateway says it does not hold the start of the thread. */
  truncates = false;
  /** The resume point each load asked for, in order. */
  readonly resumePoints: Array<string | null> = [];

  /** The modes the handshake reports. */
  modes: ThreadModeState | null = null;
  /** The config options the handshake reports. */
  configOptions: ThreadConfigOption[] = [];

  /**
   * Records a request and answers it, holds it, or fails it.
   *
   * @param method The JSON-RPC method.
   * @param params The params of the request.
   * @returns The answer, which is an empty object.
   */
  request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (this.fail) return Promise.reject(new Error(this.fail));
    if (this.hold) return new Promise((resolve) => this.held.push(resolve));
    return Promise.resolve({});
  }

  /** Finishes the oldest held request. */
  settle(): void {
    this.held.shift()?.({});
  }

  /**
   * Records a notification.
   *
   * @param method The JSON-RPC method.
   * @param params The params of the notification.
   */
  notify(method: string, params: unknown): void {
    this.notifications.push({ method, params });
  }

  /** Marks the client as disposed. */
  dispose(): void {
    this.disposed = true;
  }
}

/**
 * Creates a store with a fake client, and starts it.
 *
 * @param configure Changes the fake client before the store starts it.
 * @param deps The dependencies that differ from the defaults.
 * @returns The store and its fake client.
 */
function makeStore(
  configure?: (c: FakeClient) => void,
  deps?: Partial<ThreadStoreDeps>,
): { store: ThreadStore; client: FakeClient } {
  resetIds();
  let client!: FakeClient;
  const store = new ThreadStore({
    boxId: 'box-1',
    threadId: 'thread-1',
    createClient: (handlers) => {
      client = new FakeClient(handlers);
      configure?.(client);
      return client as unknown as AcpClient;
    },
    ...deps,
  });
  store.start();
  return { store, client };
}

/**
 * Sends a permission request to the store, as the gateway does.
 *
 * @param client The fake client of the store.
 * @param params The permission request.
 * @param withdrawn The signal the gateway aborts when another browser answers
 *   first. By default nothing aborts it.
 * @returns The answer of the store.
 */
function ask(
  client: FakeClient,
  params: RequestPermissionRequest,
  withdrawn: AbortSignal = new AbortController().signal,
): Promise<RequestPermissionResponse> {
  return client.handlers.onPermission(params, withdrawn);
}

/**
 * Sends one session/update to the store, as the gateway does.
 *
 * @param client The fake client of the store.
 * @param update The update.
 */
function push(client: FakeClient, update: ThreadUpdate): void {
  client.handlers.onUpdate({ sessionId: 'acp-1', update });
}

/**
 * Gives the converted parts of one message. ThreadMessageLike allows a bare
 * string for content. convertMessage never produces one, so the tests read parts.
 *
 * @param message The message.
 * @returns The converted parts.
 */
function partsOf(message: Message): ConvertedPart[] {
  const content = convertMessage(message).content;
  assert.ok(Array.isArray(content), 'convertMessage always produces parts');
  return content as ConvertedPart[];
}

/** One converted part, in the shape that the assertions read. */
type ConvertedPart = {
  /** The kind of the part. */
  type: string;
  /** The text of a text or reasoning part. */
  text?: string;
  /** The tool name of a tool-call part. */
  toolName?: string;
  /** Absent while a call is unfinished, which includes awaiting permission. */
  result?: unknown;
  /** The approval of a tool-call part that asked for permission. */
  approval?: {
    id: string;
    options?: Array<{ id: string; kind: string; label?: string }>;
    approved?: boolean;
    resolution?: string;
  };
  /** The src of an image part. */
  image?: string;
};

test('a snapshot changes identity when a streamed message grows', () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Hel' },
  } as ThreadUpdate);
  const first = store.getSnapshot().messages;

  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'lo' },
  } as ThreadUpdate);
  const second = store.getSnapshot().messages;

  // A view that memoises on identity would keep showing "Hel" otherwise.
  assert.notEqual(first[0], second[0]);
  assert.deepEqual(partsOf(second[0]!), [{ type: 'text', text: 'Hello' }]);
});

test('subscribers are woken on every update', () => {
  const { store, client } = makeStore();
  const listener = vi.fn();
  store.subscribe(listener);
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'x' },
  } as ThreadUpdate);
  expect(listener).toHaveBeenCalled();
});

/** One command still running, as the adapter announced it. */
const BUILD = {
  id: 'aabbccdd',
  command: 'npm run build',
  kind: 'shell',
  stoppable: true,
  startedAt: Date.parse('2026-08-01T10:00:00Z'),
};

/**
 * Builds the turn state of a thread from the gateway. By default, the thread is quiet.
 *
 * @param patch The fields that differ from a quiet thread.
 * @returns The turn state.
 */
function threadState(patch: Partial<TurnStateParams> = {}): TurnStateParams {
  return { sessionId: 'acp-1', active: false, speaking: false, background: [], ...patch };
}

test("a prompt of this browser's own does not claim the agent is talking", async () => {
  const { store, client } = makeStore((c) => {
    c.hold = true;
  });
  assert.equal(store.getSnapshot().isRunning, false);

  const sent = store.send([{ type: 'text', text: 'hello' }]);
  assert.deepEqual(client.requests[0], {
    method: 'session/prompt',
    params: { sessionId: 'acp-1', prompt: [{ type: 'text', text: 'hello' }] },
  });
  // An open request says nothing about the agent. The gateway's turn state
  // decides.
  assert.equal(store.getSnapshot().isRunning, false);
  client.handlers.onTurnState(threadState({ active: true, speaking: true }));
  assert.equal(store.getSnapshot().isRunning, true);

  client.settle();
  await sent;
  // The agent still speaks, because the gateway has not reported otherwise.
  assert.equal(store.getSnapshot().isRunning, true);
  client.handlers.onTurnState(threadState());
  assert.equal(store.getSnapshot().isRunning, false);
});

test("the gateway's turn state runs the thread a browser did not prompt", () => {
  const { store, client } = makeStore();
  assert.equal(store.getSnapshot().isRunning, false);

  // A browser gets the state after its replay when it opens a thread during a turn.
  client.handlers.onTurnState(threadState({ speaking: true }));
  assert.equal(store.getSnapshot().isRunning, true);

  client.handlers.onTurnState(threadState());
  assert.equal(store.getSnapshot().isRunning, false);
});

test('a thread that has stopped talking with work still in it is not running', () => {
  const { store, client } = makeStore();
  // The agent has finished, and a build still runs in the box.
  client.handlers.onTurnState(threadState({ active: true, speaking: false, background: [BUILD] }));
  assert.equal(store.getSnapshot().isRunning, false);
  assert.deepEqual(store.getSnapshot().background, [BUILD]);
});

test('a replay drops the turn state it was told before it', () => {
  const { store, client } = makeStore();
  client.handlers.onTurnState(threadState({ speaking: true, background: [BUILD] }));
  assert.equal(store.getSnapshot().isRunning, true);

  // A reconnect. The gateway states the thread again after the replay.
  client.handlers.onReplay(false, false);
  assert.equal(store.getSnapshot().isRunning, false);
  assert.deepEqual(store.getSnapshot().background, []);
});

test('cancel stops a turn this browser did not start', () => {
  const { store, client } = makeStore();
  client.handlers.onTurnState(threadState({ speaking: true }));
  store.cancel();
  assert.deepEqual(client.notifications, [
    { method: 'session/cancel', params: { sessionId: 'acp-1' } },
  ]);
  assert.equal(store.getSnapshot().isRunning, false);
});

test('an open permission request is reported as one', async () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Write a file',
    status: 'pending',
  } as ThreadUpdate);
  void ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't1' },
    options: [
      { optionId: 'once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'no', name: 'Deny', kind: 'reject_once' },
    ],
  } as RequestPermissionRequest);
  // One allow option per scope and one reject option make a gate.
  assert.equal(store.getSnapshot().awaiting, 'permission');
});

test('several ways to say yes is a question, not a gate', async () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Leave plan mode',
    status: 'pending',
  } as ThreadUpdate);
  void ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't1' },
    // Leaving plan mode offers three different next steps.
    options: [
      { optionId: 'auto', name: 'Yes, and use auto mode', kind: 'allow_always' },
      { optionId: 'acceptEdits', name: 'Yes, and auto-accept edits', kind: 'allow_always' },
      { optionId: 'default', name: 'Yes, and approve each edit', kind: 'allow_once' },
      { optionId: 'plan', name: 'No, keep planning', kind: 'reject_once' },
    ],
  } as RequestPermissionRequest);
  assert.equal(store.getSnapshot().awaiting, 'question');
});

test('answering a request leaves nothing waiting', async () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Write a file',
    status: 'pending',
  } as ThreadUpdate);
  void ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't1' },
    options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }],
  } as RequestPermissionRequest);
  assert.equal(store.getSnapshot().awaiting, 'permission');

  store.respondToApproval('approval-1', 'once');
  assert.equal(store.getSnapshot().awaiting, null);
});

test('a failed prompt clears the running state and reports the reason', async () => {
  const { store } = makeStore((c) => {
    c.fail = 'upstream not connected';
  });
  await assert.rejects(() => store.send([{ type: 'text', text: 'hello' }]));
  assert.equal(store.getSnapshot().isRunning, false);
  assert.equal(store.getSnapshot().error, 'upstream not connected');
});

test('cancel notifies the adapter and stops the running state', () => {
  const { store, client } = makeStore((c) => {
    c.hold = true;
  });
  void store.send([{ type: 'text', text: 'long one' }]);
  store.cancel();
  assert.deepEqual(client.notifications, [
    { method: 'session/cancel', params: { sessionId: 'acp-1' } },
  ]);
  assert.equal(store.getSnapshot().isRunning, false);
});

test('a reconnect replay rebuilds the thread instead of doubling it', () => {
  const { store, client } = makeStore();
  const script: ThreadUpdate[] = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } } as ThreadUpdate,
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    } as ThreadUpdate,
  ];
  for (const u of script) push(client, u);
  assert.equal(store.getSnapshot().messages.length, 2);

  // A new connection has no resume point, so the whole history follows.
  client.handlers.onReplay(false, false);
  // The published conversation stays on screen.
  assert.equal(store.getSnapshot().messages.length, 2);

  // The rebuild is not published message by message.
  const during = store.getSnapshot().messages;
  for (const u of script) push(client, u);
  assert.equal(store.getSnapshot().messages, during);

  // The replay is published once, without doubling.
  client.handlers.onReady(null, []);
  assert.equal(store.getSnapshot().messages.length, 2);
  assert.notEqual(store.getSnapshot().messages, during);
});

test('a refetch publishes what the replay it asked for rebuilt', async () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: 'hi' },
  } as ThreadUpdate);
  assert.equal(store.getSnapshot().messages.length, 1);

  // No onReady follows a refetch, so the store has to end the replay itself.
  const done = store.refetch();
  push(client, {
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: 'hi' },
  } as ThreadUpdate);
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hello again' },
  } as ThreadUpdate);
  await done;

  assert.deepEqual(
    store.getSnapshot().messages.map((m) => m.role),
    ['user', 'assistant'],
    'the replay is published once, and not doubled onto what was there',
  );

  // An update after the refetch still lands.
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: ' and again' },
  } as ThreadUpdate);
  assert.match(JSON.stringify(store.getSnapshot().messages), /and again/);
});

test('a refetch keeps an open question rather than refusing the call it is about', async () => {
  const { store, client } = makeStore();
  push(client, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write a file' });
  let settled = false;
  const answered = ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't1' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  });
  void answered.then(() => {
    settled = true;
  });

  // The connection is up, so a cancel here would reach the agent.
  const done = store.refetch();
  push(client, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write a file' });
  await done;

  assert.equal(settled, false, 'the question is still open for the agent');
  const part = partsOf(store.getSnapshot().messages[0]!)[0]!;
  assert.equal(part.type, 'tool-call');
  assert.ok(part.approval, 'and it is back on the call the replay rebuilt');

  store.respondToApproval(part.approval.id, 'yes');
  assert.deepEqual(await answered, { outcome: { outcome: 'selected', optionId: 'yes' } });
});

test('a question the gateway withdraws stops waiting', async () => {
  const { store, client } = makeStore();
  push(client, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write a file' });
  const withdrawn = new AbortController();
  const answered = ask(
    client,
    {
      sessionId: 'acp-1',
      toolCall: { toolCallId: 't1' },
      options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
    },
    withdrawn.signal,
  );

  // Another browser on the thread answered first.
  withdrawn.abort();

  assert.deepEqual(await answered, { outcome: { outcome: 'cancelled' } });
  assert.equal(store.getSnapshot().awaiting, null);
});

test('a refetch whose load fails still gives the view back what arrived', async () => {
  const { store, client } = makeStore();
  client.fail = 'adapter is gone';
  await store.refetch().catch(() => undefined);
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'still here' },
  } as ThreadUpdate);
  assert.equal(store.getSnapshot().messages.length, 1, 'not frozen behind a replay that failed');
});

test('a permission request attaches to its tool call and its answer unblocks the turn', async () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Write main.ts',
    kind: 'edit',
  });

  const request: RequestPermissionRequest = {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't1' },
    options: [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
  };
  const answered: Promise<RequestPermissionResponse> = ask(client, request);

  // The options render on the tool call, mapped into approval vocabulary.
  const part = partsOf(store.getSnapshot().messages[0]!)[0]!;
  assert.equal(part.type, 'tool-call');
  const approval = part.approval;
  assert.ok(approval);
  assert.deepEqual(approval.options, [
    { id: 'yes', kind: 'allow-once', label: 'Allow' },
    { id: 'no', kind: 'reject-once', label: 'Reject' },
  ]);

  store.respondToApproval(approval.id, 'yes');
  assert.deepEqual(await answered, { outcome: { outcome: 'selected', optionId: 'yes' } });
});

test('a call awaiting permission reports no result, so the question can render', async () => {
  const { store, client } = makeStore();
  // A real edit arrives in the same shape. The adapter sends the diff that it
  // proposes before it gets permission to write it.
  push(client, {
    sessionUpdate: 'tool_call',
    toolCallId: 'td',
    title: 'Write hello.txt',
    kind: 'edit',
  });
  push(client, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'td',
    content: [{ type: 'diff', path: '/workspace/hello.txt', oldText: null, newText: 'hello' }],
  });

  const answered = ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 'td' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  });

  // The runtime treats a result of any kind as a finished call, and a
  // finished call never shows the question.
  const asked = partsOf(store.getSnapshot().messages[0]!)[0]!;
  assert.equal(asked.type, 'tool-call');
  assert.equal(asked.result, undefined);
  assert.ok(asked.approval);
  assert.equal(asked.approval.approved, undefined);
  assert.equal(asked.approval.resolution, undefined);

  store.respondToApproval(asked.approval.id, 'yes');
  await answered;

  // After the answer, the diff is a result again, so the call shows as done.
  const done = partsOf(store.getSnapshot().messages[0]!)[0]!;
  assert.equal(done.type, 'tool-call');
  assert.match(String(done.result), /\+hello/);
});

test('declining to choose cancels the request rather than answering it', async () => {
  const { store, client } = makeStore();
  push(client, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Delete file' });
  const answered = ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't2' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  });

  store.respondToApproval('approval-1', undefined);
  assert.deepEqual(await answered, { outcome: { outcome: 'cancelled' } });
});

test('a permission request for an unannounced call makes a place for itself', async () => {
  const { store, client } = makeStore();
  const answered = ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 'tX', title: 'Run rm -rf' },
    options: [{ optionId: 'no', name: 'Reject', kind: 'reject_once' }],
  });

  const part = partsOf(store.getSnapshot().messages[0]!)[0]!;
  assert.equal(part.type, 'tool-call');
  assert.equal(part.toolName, 'Run rm -rf');

  store.respondToApproval('approval-1', 'no');
  assert.deepEqual(await answered, { outcome: { outcome: 'selected', optionId: 'no' } });
});

test('answering the same approval twice does nothing the second time', async () => {
  const { store, client } = makeStore();
  push(client, { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'Edit' });
  const answered = ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't3' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  });
  store.respondToApproval('approval-1', 'yes');
  store.respondToApproval('approval-1', undefined);
  assert.deepEqual(await answered, { outcome: { outcome: 'selected', optionId: 'yes' } });
});

test('the mode switcher sets the mode optimistically and rolls back on failure', async () => {
  const modes: ThreadModeState = {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'auto', name: 'Auto' },
    ],
  };
  const { store, client } = makeStore((c) => {
    c.modes = modes;
  });
  assert.equal(store.getSnapshot().modes?.currentModeId, 'default');

  await store.setMode('auto');
  assert.deepEqual(client.requests.at(-1), {
    method: 'session/set_mode',
    params: { sessionId: 'acp-1', modeId: 'auto' },
  });
  assert.equal(store.getSnapshot().modes?.currentModeId, 'auto');

  client.fail = 'mode not supported';
  await store.setMode('default');
  assert.equal(store.getSnapshot().modes?.currentModeId, 'auto');
  assert.equal(store.getSnapshot().error, 'mode not supported');
});

test('the model selector sets the option optimistically and rolls back on failure', async () => {
  const configOptions: ThreadConfigOption[] = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'sonnet',
      options: [
        { value: 'sonnet', name: 'Sonnet' },
        { value: 'opus', name: 'Opus' },
      ],
    },
  ];
  const { store, client } = makeStore((c) => {
    c.configOptions = configOptions;
  });
  const currentModel = (): string | undefined =>
    store.getSnapshot().configOptions.find((o) => o.id === 'model')?.currentValue;
  assert.equal(currentModel(), 'sonnet');

  await store.setConfigOption('model', 'opus');
  assert.deepEqual(client.requests.at(-1), {
    method: 'session/set_config_option',
    params: { sessionId: 'acp-1', configId: 'model', value: 'opus' },
  });
  assert.equal(currentModel(), 'opus');

  client.fail = 'no such model';
  await store.setConfigOption('model', 'sonnet');
  assert.equal(currentModel(), 'opus');
  assert.equal(store.getSnapshot().error, 'no such model');
});

test('a config_option_update from the adapter moves the model selector', () => {
  const { store, client } = makeStore((c) => {
    c.configOptions = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'sonnet',
        options: [
          { value: 'sonnet', name: 'Sonnet' },
          { value: 'opus', name: 'Opus' },
        ],
      },
    ];
  });
  push(client, {
    sessionUpdate: 'config_option_update',
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'opus',
        options: [
          { value: 'sonnet', name: 'Sonnet' },
          { value: 'opus', name: 'Opus' },
        ],
      },
    ],
  });
  assert.equal(
    store.getSnapshot().configOptions.find((o) => o.id === 'model')?.currentValue,
    'opus',
  );
});

test('a current_mode_update from the adapter moves the switcher', () => {
  const { store, client } = makeStore((c) => {
    c.modes = {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'auto', name: 'Auto' },
      ],
    };
  });
  push(client, { sessionUpdate: 'current_mode_update', currentModeId: 'auto' });
  assert.equal(store.getSnapshot().modes?.currentModeId, 'auto');
});

test('disposing closes the client', () => {
  const { store, client } = makeStore();
  store.dispose();
  assert.equal(client.disposed, true);
});

test('a turn blocked on a permission request is not reported as running', async () => {
  const { store, client } = makeStore((c) => {
    c.hold = true;
  });
  void store.send([{ type: 'text', text: 'edit the file' }]);
  client.handlers.onTurnState(threadState({ active: true, speaking: true }));
  assert.equal(store.getSnapshot().isRunning, true);

  push(client, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write main.ts' });
  const answered = ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't1' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  });

  assert.equal(store.getSnapshot().isRunning, false);

  store.respondToApproval('approval-1', 'yes');
  await answered;
  assert.equal(store.getSnapshot().isRunning, true);

  client.settle();
});

test("a tool call's image is converted as a part beside the card, not inside it", () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'tool_call',
    toolCallId: 't-shot',
    title: 'Read .playwright-cli/page.png',
    kind: 'read',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } }],
  } as ThreadUpdate);

  const message = store.getSnapshot().messages.at(-1)!;
  const parts = partsOf(message);
  assert.deepEqual(
    parts.map((p) => p.type),
    ['tool-call', 'image'],
  );
  // The card still says a finished call produced something, so it does not
  // render as a tool that returned nothing.
  assert.equal(parts[0]!.result, '[image]');
  assert.equal(parts[1]!.image, 'data:image/png;base64,AAAA');
});

test("an update that replaces a call's content replaces its images with it", () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'tool_call',
    toolCallId: 't-shot2',
    title: 'Screenshot',
    content: [{ type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } }],
  } as ThreadUpdate);
  push(client, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 't-shot2',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'image', data: 'BBBB', mimeType: 'image/png' } }],
  } as ThreadUpdate);

  const parts = partsOf(store.getSnapshot().messages.at(-1)!);
  assert.deepEqual(parts.map((p) => p.image).filter(Boolean), ['data:image/png;base64,BBBB']);
});

/**
 * Builds one named message of a transcript, as the adapter replays it.
 *
 * @param role The speaker.
 * @param messageId The adapter's id for the message.
 * @param text The text of the message.
 * @returns The update.
 */
function said(role: 'user' | 'agent', messageId: string, text: string): ThreadUpdate {
  return {
    sessionUpdate: `${role}_message_chunk`,
    messageId,
    content: { type: 'text', text },
  } as ThreadUpdate;
}

/** The whole conversation that the resume tests replay. */
const TRANSCRIPT: ThreadUpdate[] = [
  said('user', 'msg_1', 'the first question'),
  said('agent', 'msg_2', 'the first answer'),
  said('user', 'msg_3', 'and while you were away'),
  said('agent', 'msg_4', 'this came back'),
];

/**
 * Gives every message as its id, role and text, which is what a reader sees.
 *
 * @param store The store.
 * @returns One tuple of id, role and text per message.
 */
function shapeOf(store: ThreadStore): Array<[string, string, string]> {
  return store.getSnapshot().messages.map((m) => [
    m.id,
    m.role,
    partsOf(m)
      .map((p) => p.text ?? '')
      .join(''),
  ]);
}

test('a reconnect resumes from the last message the adapter named', () => {
  const { store, client } = makeStore();
  for (const u of TRANSCRIPT.slice(0, 2)) push(client, u);

  client.resumes = true;
  client.load();
  // The resume point is the last message the browser holds.
  assert.deepEqual(client.resumePoints, [null, 'msg_2']);

  // The gateway sends the tail, which is the named message and the messages after it.
  for (const u of TRANSCRIPT.slice(1)) push(client, u);
  client.finish();

  assert.deepEqual(shapeOf(store), [
    ['msg_1', 'user', 'the first question'],
    ['msg_2', 'assistant', 'the first answer'],
    ['msg_3', 'user', 'and while you were away'],
    ['msg_4', 'assistant', 'this came back'],
  ]);
});

test('a resumed thread reads the same as one replayed whole', () => {
  const resumed = makeStore();
  for (const u of TRANSCRIPT.slice(0, 2)) push(resumed.client, u);
  resumed.client.resumes = true;
  resumed.client.load();
  for (const u of TRANSCRIPT.slice(1)) push(resumed.client, u);
  resumed.client.finish();

  const whole = makeStore();
  for (const u of TRANSCRIPT) push(whole.client, u);

  // The model is the result of the updates in order. A resume cuts that order
  // and does not read it in a different way.
  assert.deepEqual(shapeOf(resumed.store), shapeOf(whole.store));
});

test('a resume the gateway cannot honour rebuilds the thread from the top', () => {
  const { store, client } = makeStore();
  for (const u of TRANSCRIPT.slice(0, 2)) push(client, u);

  // The gateway did not find the point, because the transcript was compacted
  // after this browser read it. The gateway sends the whole thread instead.
  client.resumes = false;
  client.load();
  for (const u of TRANSCRIPT) push(client, u);
  client.finish();

  assert.deepEqual(shapeOf(store), [
    ['msg_1', 'user', 'the first question'],
    ['msg_2', 'assistant', 'the first answer'],
    ['msg_3', 'user', 'and while you were away'],
    ['msg_4', 'assistant', 'this came back'],
  ]);
});

test('a reconnect mid-turn takes in what was said while the socket was down', () => {
  const { store, client } = makeStore();
  push(client, said('user', 'msg_1', 'the first question'));
  push(client, said('agent', 'msg_2', 'half an ans'));

  client.resumes = true;
  client.load();
  // The transcript holds the whole message that the socket dropped in the
  // middle. The browser takes that message again and does not keep its half.
  push(client, said('agent', 'msg_2', 'half an answer, and the rest'));
  push(client, said('agent', 'msg_3', 'then this'));
  client.finish();

  assert.deepEqual(shapeOf(store), [
    ['msg_1', 'user', 'the first question'],
    ['msg_2', 'assistant', 'half an answer, and the rest'],
    ['msg_3', 'assistant', 'then this'],
  ]);
});

test('nothing is published while a resumed replay is being read', () => {
  const { store, client } = makeStore();
  for (const u of TRANSCRIPT.slice(0, 2)) push(client, u);
  const before = store.getSnapshot().messages;

  client.resumes = true;
  client.load();
  // The tail is published in one go at the end.
  assert.equal(store.getSnapshot().messages, before);
  for (const u of TRANSCRIPT.slice(1)) push(client, u);
  assert.equal(store.getSnapshot().messages, before);

  client.finish();
  assert.equal(store.getSnapshot().messages.length, 4);
});

test('a resume gives up the questions the dead connection was showing', async () => {
  const { store, client } = makeStore();
  push(client, said('agent', 'msg_1', 'about to read a file'));
  push(client, {
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_1',
    title: 'Read',
    status: 'pending',
  } as ThreadUpdate);
  push(client, said('agent', 'msg_2', 'and then this'));
  const answer = ask(client, {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 'toolu_1' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  });
  assert.equal(store.getSnapshot().awaiting, 'permission');

  client.resumes = true;
  client.load();
  push(client, said('agent', 'msg_2', 'and then this'));
  client.finish();

  // The socket that carried the question has gone. The gateway asks again
  // after the replay if the question is still open.
  assert.deepEqual(await answer, { outcome: { outcome: 'cancelled' } });
  assert.equal(store.getSnapshot().awaiting, null);
  const tool = partsOf(store.getSnapshot().messages[0]!).find((p) => p.type === 'tool-call');
  assert.ok(tool);
  assert.equal(tool.approval, undefined);
});

test('a cut thread says so, and a resume keeps what the store holds', () => {
  const { store, client } = makeStore((c) => {
    c.truncates = true;
  });
  push(client, said('agent', 'm1', 'the newest answer'));
  assert.equal(store.getSnapshot().truncated, true);

  // A reconnect continues at the last message of the store, so the store still
  // lacks the old messages, whatever the gateway reports about its own log.
  client.resumes = true;
  client.truncates = false;
  client.load();
  client.finish();
  assert.equal(store.getSnapshot().truncated, true);
});

test('the full history replaces a cut thread once it has arrived', async () => {
  const { store, client } = makeStore((c) => {
    c.truncates = true;
  });
  push(client, said('agent', 'm2', 'the newest answer'));
  const rebuilds = store.getSnapshot().rebuilds;

  client.hold = true;
  const done = store.loadFullHistory();
  assert.equal(store.getSnapshot().loadingHistory, true);
  assert.deepEqual(client.requests.at(-1), {
    method: 'session/load',
    params: {
      sessionId: 'acp-1',
      cwd: '/workspace',
      mcpServers: [],
      _meta: { boxes: { full: true } },
    },
  });

  // The gateway sends its notice, then the replay from the start.
  client.handlers.onReplay(false, false);
  push(client, said('agent', 'm1', 'the oldest answer'));
  push(client, said('agent', 'm2', 'the newest answer'));
  assert.equal(store.getSnapshot().messages.length, 1, 'not published piece by piece');
  client.settle();
  await done;

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.messages.length, 2);
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.loadingHistory, false);
  assert.equal(snapshot.rebuilds, rebuilds + 1, 'the view learns the messages were rebuilt');
});

test('a refused full history leaves the thread as it was', async () => {
  const { store, client } = makeStore((c) => {
    c.truncates = true;
  });
  push(client, said('agent', 'm2', 'the newest answer'));
  const before = store.getSnapshot().messages;

  client.fail = 'The agent is working on this thread.';
  await store.loadFullHistory();

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.messages, before);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.loadingHistory, false);
  assert.equal(snapshot.error, 'The agent is working on this thread.');
});

test('the store publishes the predicted next prompt and a send clears it', async () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'session_info_update',
    _meta: { promptSuggestions: { suggestions: [{ text: 'run the tests' }] } },
  } as ThreadUpdate);
  assert.equal(store.getSnapshot().promptSuggestion, 'run the tests');

  await store.send([{ type: 'text', text: 'deploy it' }]);
  assert.equal(store.getSnapshot().promptSuggestion, null);
});
