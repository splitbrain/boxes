import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
} from './acp-types.ts';
import type { TurnStateParams } from '../../../../shared/types.ts';
import type { AcpClient, AcpClientHandlers } from './acp-client.ts';
import { ThreadStore, type ThreadStoreDeps } from './thread-store.ts';
import { convertMessage } from './convert.ts';
import { resetIds, type Message } from './translate.ts';

/**
 * The store against a fake client, which is the whole protocol surface it
 * touches: notifications in, requests out.
 */

/** A stand-in AcpClient that records what the store asks of it. */
class FakeClient {
  sessionId: string | null = 'acp-1';
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  /** Resolvers for requests the test wants to hold open. */
  private readonly held: Array<(v: unknown) => void> = [];
  hold = false;
  fail: string | null = null;
  disposed = false;

  constructor(readonly handlers: AcpClientHandlers) {}

  start(): void {
    this.handlers.onResetThread();
    this.handlers.onState('ready');
    this.handlers.onReady(this.modes, this.configOptions);
  }

  modes: SessionModeState | null = null;
  configOptions: SessionConfigOption[] = [];

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

  notify(method: string, params: unknown): void {
    this.notifications.push({ method, params });
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** A store wired to a fake client, already started. */
function makeStore(
  configure?: (c: FakeClient) => void,
  deps?: Partial<ThreadStoreDeps>,
): { store: ThreadStore; client: FakeClient } {
  resetIds();
  let client!: FakeClient;
  const store = new ThreadStore({
    sessionId: 'box-1',
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

/** Pushes one session/update at the store, as the gateway would. */
function push(client: FakeClient, update: SessionUpdate): void {
  client.handlers.onUpdate({ sessionId: 'acp-1', update });
}

/**
 * The converted parts of one message. ThreadMessageLike allows a bare string
 * for content; convertMessage never produces one, so the tests read parts.
 */
function partsOf(message: Message): ConvertedPart[] {
  const content = convertMessage(message).content;
  assert.ok(Array.isArray(content), 'convertMessage always produces parts');
  return content as ConvertedPart[];
}

/** The single text part a shell run writes into the thread. */
function outputOf(message: Message): string {
  const parts = partsOf(message);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.type, 'text');
  return String((parts[0] as unknown as { text: string }).text);
}

/** One converted part, in the shape the assertions read it. */
type ConvertedPart = {
  type: string;
  text?: string;
  toolName?: string;
  /** Absent while a call is unfinished, which includes awaiting permission. */
  result?: unknown;
  approval?: {
    id: string;
    options?: Array<{ id: string; kind: string; label?: string }>;
    approved?: boolean;
    resolution?: string;
  };
  /** The src of an image part, which is a data URL or a remote https one. */
  image?: string;
};

test('a snapshot changes identity when a streamed message grows', () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Hel' },
  } as SessionUpdate);
  const first = store.getSnapshot().messages;

  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'lo' },
  } as SessionUpdate);
  const second = store.getSnapshot().messages;

  // A view that memoised on identity has to see a new object, or it would
  // keep rendering "Hel" after the rest arrived.
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
  } as SessionUpdate);
  expect(listener).toHaveBeenCalled();
});

/** One command still running, as the gateway reads it out of the box. */
const BUILD = { id: 'aabbccdd', command: 'npm run build', startedAt: null };

/** What the gateway says about a thread, defaulting to a quiet one. */
function threadState(patch: Partial<TurnStateParams> = {}): TurnStateParams {
  return { sessionId: 'acp-1', active: false, speaking: false, background: [], ...patch };
}

test('a prompt of this browser\'s own does not claim the agent is talking', async () => {
  const { store, client } = makeStore((c) => {
    c.hold = true;
  });
  assert.equal(store.getSnapshot().isRunning, false);

  const sent = store.send([{ type: 'text', text: 'hello' }]);
  assert.deepEqual(client.requests[0], {
    method: 'session/prompt',
    params: { sessionId: 'acp-1', prompt: [{ type: 'text', text: 'hello' }] },
  });
  // A request being open says nothing about the agent: the adapter holds one
  // open for as long as the background work a turn started takes to settle.
  // The gateway marks the thread as working when it forwards the prompt, and
  // that is what the view goes by.
  assert.equal(store.getSnapshot().isRunning, false);
  client.handlers.onTurnState(threadState({ active: true, speaking: true }));
  assert.equal(store.getSnapshot().isRunning, true);

  client.settle();
  await sent;
  // Still talking: the prompt coming back is not the agent stopping, and the
  // gateway has not said it has.
  assert.equal(store.getSnapshot().isRunning, true);
  client.handlers.onTurnState(threadState());
  assert.equal(store.getSnapshot().isRunning, false);
});

test("the gateway's turn state runs the thread a browser did not prompt", () => {
  const { store, client } = makeStore();
  assert.equal(store.getSnapshot().isRunning, false);

  // What a browser is told after its replay when it re-opens a thread that
  // is mid-turn: nothing is in flight from here, and the turn is real.
  client.handlers.onTurnState(threadState({ speaking: true }));
  assert.equal(store.getSnapshot().isRunning, true);

  client.handlers.onTurnState(threadState());
  assert.equal(store.getSnapshot().isRunning, false);
});

test('a thread that has stopped talking with work still in it is not running', () => {
  const { store, client } = makeStore();
  // The state this whole vocabulary exists for: the agent has finished, the
  // composer is yours, and a build is still going in the box.
  client.handlers.onTurnState(
    threadState({ active: true, speaking: false, background: [BUILD] }),
  );
  assert.equal(store.getSnapshot().isRunning, false);
  assert.deepEqual(store.getSnapshot().background, [BUILD]);
});

test('a replay drops the turn state it was told before it', () => {
  const { store, client } = makeStore();
  client.handlers.onTurnState(
    threadState({ speaking: true, background: [BUILD] }),
  );
  assert.equal(store.getSnapshot().isRunning, true);

  // A reconnect: the gateway re-states the thread after the replay, so
  // holding the old answer over one would claim a turn nobody has confirmed
  // and a task nobody has said is still running.
  client.handlers.onResetThread();
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
  } as SessionUpdate);
  void client.handlers.onPermission({
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't1' },
    options: [
      { optionId: 'once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'no', name: 'Deny', kind: 'reject_once' },
    ],
  } as RequestPermissionRequest);
  // One way to say yes, doubled by scope, and one to say no: a gate.
  assert.equal(store.getSnapshot().awaiting, 'permission');
});

test('several ways to say yes is a question, not a gate', async () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Leave plan mode',
    status: 'pending',
  } as SessionUpdate);
  void client.handlers.onPermission({
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't1' },
    // What leaving plan mode asks: three different things to do next.
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
  } as SessionUpdate);
  void client.handlers.onPermission({
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
  const script: SessionUpdate[] = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } } as SessionUpdate,
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    } as SessionUpdate,
  ];
  for (const u of script) push(client, u);
  assert.equal(store.getSnapshot().messages.length, 2);

  // What a fresh connection does: reset, then replay the same history.
  client.handlers.onResetThread();
  // The conversation somebody is reading is not blanked to do that: the model
  // is what went stale, and the socket dropping is not news about the thread.
  assert.equal(store.getSnapshot().messages.length, 2);

  // Nor is the rebuild published on its way past, message by message.
  const during = store.getSnapshot().messages;
  for (const u of script) push(client, u);
  assert.equal(store.getSnapshot().messages, during);

  // The replay answered: what is on screen is what it said, once, and not
  // both copies of it.
  client.handlers.onReady(null, []);
  assert.equal(store.getSnapshot().messages.length, 2);
  assert.notEqual(store.getSnapshot().messages, during);
});

test('a refetch publishes what the replay it asked for rebuilt', async () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: 'hi' },
  } as SessionUpdate);
  assert.equal(store.getSnapshot().messages.length, 1);

  // A refetch is a session/load on a connection that is already up, so nothing
  // reports itself ready afterwards the way a handshake does. The store has to
  // end its own replay window, or the model never reaches the view again.
  const done = store.refetch();
  push(client, {
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: 'hi' },
  } as SessionUpdate);
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hello again' },
  } as SessionUpdate);
  await done;

  assert.deepEqual(
    store.getSnapshot().messages.map((m) => m.role),
    ['user', 'assistant'],
    'the replay is published once, and not doubled onto what was there',
  );

  // And the thread is live again: an update after the refetch still lands.
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: ' and again' },
  } as SessionUpdate);
  assert.match(JSON.stringify(store.getSnapshot().messages), /and again/);
});

test('a refetch whose load fails still gives the view back what arrived', async () => {
  const { store, client } = makeStore();
  client.fail = 'adapter is gone';
  await store.refetch().catch(() => undefined);
  push(client, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'still here' },
  } as SessionUpdate);
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
  const answered: Promise<RequestPermissionResponse> = client.handlers.onPermission(request);

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
  // The shape a real edit arrives in: the adapter sends the diff it proposes
  // before it is allowed to write it.
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

  const answered = client.handlers.onPermission({
    sessionId: 'acp-1',
    toolCall: { toolCallId: 'td' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  });

  // A result of any kind reads to the runtime as a finished call, and a
  // finished call is never the one being asked about.
  const asked = partsOf(store.getSnapshot().messages[0]!)[0]!;
  assert.equal(asked.type, 'tool-call');
  assert.equal(asked.result, undefined);
  assert.ok(asked.approval);
  assert.equal(asked.approval.approved, undefined);
  assert.equal(asked.approval.resolution, undefined);

  store.respondToApproval(asked.approval.id, 'yes');
  await answered;

  // Once answered the diff is a result again, so the call renders as done.
  const done = partsOf(store.getSnapshot().messages[0]!)[0]!;
  assert.equal(done.type, 'tool-call');
  assert.match(String(done.result), /\+hello/);
});

test('declining to choose cancels the request rather than answering it', async () => {
  const { store, client } = makeStore();
  push(client, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Delete file' });
  const answered = client.handlers.onPermission({
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't2' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  });

  store.respondToApproval('approval-1', undefined);
  assert.deepEqual(await answered, { outcome: { outcome: 'cancelled' } });
});

test('a permission request for an unannounced call makes a place for itself', async () => {
  const { store, client } = makeStore();
  const answered = client.handlers.onPermission({
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
  const answered = client.handlers.onPermission({
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't3' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  });
  store.respondToApproval('approval-1', 'yes');
  store.respondToApproval('approval-1', undefined);
  assert.deepEqual(await answered, { outcome: { outcome: 'selected', optionId: 'yes' } });
});

test('the mode switcher sets the mode optimistically and rolls back on failure', async () => {
  const modes: SessionModeState = {
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
  const configOptions: SessionConfigOption[] = [
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
  const valueOf = (): string | undefined =>
    store.getSnapshot().configOptions.find((o) => o.id === 'model')?.currentValue;
  assert.equal(valueOf(), 'sonnet');

  await store.setConfigOption('model', 'opus');
  assert.deepEqual(client.requests.at(-1), {
    method: 'session/set_config_option',
    params: { sessionId: 'acp-1', configId: 'model', value: 'opus' },
  });
  assert.equal(valueOf(), 'opus');

  client.fail = 'no such model';
  await store.setConfigOption('model', 'sonnet');
  assert.equal(valueOf(), 'opus');
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
  const answered = client.handlers.onPermission({
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't1' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  });

  // The turn is paused for the user, not progressing. Saying otherwise
  // would hide the very question that is holding it up.
  assert.equal(store.getSnapshot().isRunning, false);

  store.respondToApproval('approval-1', 'yes');
  await answered;
  assert.equal(store.getSnapshot().isRunning, true);

  client.settle();
});

test('a bang command runs locally, streams, and never reaches the adapter', async () => {
  const chunks: string[] = [];
  const { store, client } = makeStore(undefined, {
    runExec: async (sessionId, command, onChunk) => {
      assert.equal(sessionId, 'box-1');
      assert.equal(command, 'echo hi');
      onChunk('hi');
      chunks.push('hi');
      onChunk('hi\nthere');
      chunks.push('hi\nthere');
      return { exitCode: 0, truncated: false, timedOut: false };
    },
  });

  await store.runCommand('echo hi');

  // Nothing was sent upstream: a bang line costs no tokens.
  assert.deepEqual(client.requests, []);
  assert.equal(chunks.length, 2);

  const messages = store.getSnapshot().messages;
  // The line as typed, then the output it produced.
  assert.equal(messages[0]!.role, 'user');
  assert.deepEqual(partsOf(messages[0]!), [{ type: 'text', text: '!echo hi' }]);
  assert.equal(outputOf(messages[1]!), '```console\nhi\nthere\n[exit 0]\n```');
});

test('a non-zero exit shows the code under the output', async () => {
  const { store } = makeStore(undefined, {
    runExec: async (_id, _cmd, onChunk) => {
      onChunk('bash: nope: command not found');
      return { exitCode: 127, truncated: false, timedOut: false };
    },
  });

  await store.runCommand('nope');
  const output = outputOf(store.getSnapshot().messages[1]!);
  assert.match(output, /bash: nope: command not found/);
  assert.match(output, /\[exit 127\]/);
});

test('a killed or truncated run says so beside its exit code', async () => {
  const { store } = makeStore(undefined, {
    runExec: async (_id, _cmd, onChunk) => {
      onChunk('a lot of output');
      return { exitCode: null, truncated: true, timedOut: true };
    },
  });

  await store.runCommand('yes');
  assert.match(
    outputOf(store.getSnapshot().messages[1]!),
    /\[exit killed\] · timed out · output truncated/,
  );
});

test('output carrying a fence of its own cannot break out of the block', async () => {
  const { store } = makeStore(undefined, {
    runExec: async (_id, _cmd, onChunk) => {
      onChunk('```\nnot a fence\n```');
      return { exitCode: 0, truncated: false, timedOut: false };
    },
  });

  await store.runCommand('cat readme.md');
  const output = outputOf(store.getSnapshot().messages[1]!);
  assert.ok(output.startsWith('````console\n'), output);
  assert.ok(output.endsWith('\n````'), output);
});

test('a failed exec request is reported in the thread rather than thrown away', async () => {
  const { store } = makeStore(undefined, {
    runExec: async () => {
      throw new Error('503 exec unavailable');
    },
  });

  await store.runCommand('ls');
  assert.match(outputOf(store.getSnapshot().messages[1]!), /503 exec unavailable/);
});

test('previously run commands are appended once, however often they are loaded', async () => {
  const { store } = makeStore(undefined, {
    listExec: async () => [
      {
        id: 7,
        sessionId: 'box-1',
        command: 'git status',
        output: 'clean\n',
        exitCode: 0,
        truncated: false,
        timedOut: false,
        startedAt: 1,
        finishedAt: 2,
      },
    ],
  });

  await store.loadExecHistory();
  await store.loadExecHistory();
  assert.equal(store.getSnapshot().messages.length, 2);
  assert.deepEqual(partsOf(store.getSnapshot().messages[0]!), [
    { type: 'text', text: '!git status' },
  ]);
});

test("a tool call's image is converted as a part beside the card, not inside it", () => {
  const { store, client } = makeStore();
  push(client, {
    sessionUpdate: 'tool_call',
    toolCallId: 't-shot',
    title: 'Read .playwright-cli/page.png',
    kind: 'read',
    status: 'completed',
    content: [
      { type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } },
    ],
  } as SessionUpdate);

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
    content: [
      { type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } },
    ],
  } as SessionUpdate);
  push(client, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 't-shot2',
    status: 'completed',
    content: [
      { type: 'content', content: { type: 'image', data: 'BBBB', mimeType: 'image/png' } },
    ],
  } as SessionUpdate);

  const parts = partsOf(store.getSnapshot().messages.at(-1)!);
  assert.deepEqual(
    parts.map((p) => p.image).filter(Boolean),
    ['data:image/png;base64,BBBB'],
  );
});
