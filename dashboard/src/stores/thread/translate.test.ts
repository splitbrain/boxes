import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import { buildEnvelope } from '../../lib/attachments.ts';
import type { ThreadUpdate } from './acp-types.ts';
import {
  applyUpdate,
  emptyModel,
  findTool,
  resetIds,
  type ThreadModel,
  type ToolPart,
  toolOutputText,
  truncateFrom,
} from './translate.ts';

/**
 * Folds a script of updates into a fresh model, the way a replay arrives.
 *
 * @param updates The updates, in order.
 * @returns The model.
 */
function fold(...updates: ThreadUpdate[]): ThreadModel {
  const model = emptyModel();
  for (const u of updates) applyUpdate(model, u);
  return model;
}

/**
 * Builds a text chunk of the given kind.
 *
 * @param sessionUpdate The kind of the chunk.
 * @param text The text of the chunk.
 * @param messageId The adapter's id for the message, if any.
 * @returns The update.
 */
function chunk(
  sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk',
  text: string,
  messageId?: string,
): ThreadUpdate {
  return {
    sessionUpdate,
    content: { type: 'text', text },
    ...(messageId ? { messageId } : {}),
  } as ThreadUpdate;
}

beforeEach(() => resetIds());

test('streamed chunks of one message become one growing text part', () => {
  const model = fold(
    chunk('agent_message_chunk', 'Hel'),
    chunk('agent_message_chunk', 'lo, '),
    chunk('agent_message_chunk', 'world'),
  );
  assert.equal(model.messages.length, 1);
  assert.deepEqual(model.messages[0]!.parts, [{ type: 'text', text: 'Hello, world' }]);
});

test('a role change starts a new message', () => {
  const model = fold(
    chunk('user_message_chunk', 'hi'),
    chunk('agent_message_chunk', 'hello'),
    chunk('user_message_chunk', 'again'),
  );
  assert.deepEqual(
    model.messages.map((m) => m.role),
    ['user', 'assistant', 'user'],
  );
});

test('a change of messageId starts a new message even in the same role', () => {
  const model = fold(
    chunk('agent_message_chunk', 'first', 'msg-a'),
    chunk('agent_message_chunk', ' more', 'msg-a'),
    chunk('agent_message_chunk', 'second', 'msg-b'),
  );
  assert.equal(model.messages.length, 2);
  assert.equal(model.messages[0]!.id, 'msg-a');
  assert.deepEqual(model.messages[0]!.parts, [{ type: 'text', text: 'first more' }]);
  assert.deepEqual(model.messages[1]!.parts, [{ type: 'text', text: 'second' }]);
});

test('thought chunks become a reasoning part beside the prose', () => {
  const model = fold(
    chunk('agent_thought_chunk', 'let me look'),
    chunk('agent_message_chunk', 'Here it is.'),
  );
  assert.equal(model.messages.length, 1);
  assert.deepEqual(model.messages[0]!.parts, [
    { type: 'reasoning', text: 'let me look' },
    { type: 'text', text: 'Here it is.' },
  ]);
});

test('a tool call becomes a part, and its update merges into it', () => {
  const model = fold(
    {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read cidr.ts',
      kind: 'read',
      status: 'pending',
      rawInput: { path: 'proxy/src/cidr.ts' },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'export function' } }],
    },
  );
  const part = findTool(model, 't1')!;
  assert.equal(part.status, 'completed');
  assert.equal(part.title, 'Read cidr.ts');
  assert.equal(part.kind, 'read');
  assert.deepEqual(part.rawInput, { path: 'proxy/src/cidr.ts' });
  assert.equal(toolOutputText(part), 'export function');
  // One card, not two.
  assert.equal(model.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool').length, 1);
});

test('an update that arrives before its tool call still lands', () => {
  const model = fold(
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't9',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'partial' } }],
    },
    { sessionUpdate: 'tool_call', toolCallId: 't9', title: 'Search', status: 'in_progress' },
  );
  const part = findTool(model, 't9')!;
  assert.equal(part.title, 'Search');
  assert.equal(toolOutputText(part), 'partial');
  assert.equal(model.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool').length, 1);
});

test('streamed tool content replaces rather than accumulates', () => {
  const model = fold(
    { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Run tests' },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      content: [{ type: 'content', content: { type: 'text', text: 'ok 1' } }],
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      content: [{ type: 'content', content: { type: 'text', text: 'ok 1\nok 2' } }],
    },
  );
  assert.equal(toolOutputText(findTool(model, 't2')!), 'ok 1\nok 2');
});

test('an omitted field leaves the previous value alone', () => {
  const model = fold(
    { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'Edit main.ts', kind: 'edit' },
    { sessionUpdate: 'tool_call_update', toolCallId: 't3', status: 'completed' },
  );
  const part = findTool(model, 't3')!;
  assert.equal(part.title, 'Edit main.ts');
  assert.equal(part.kind, 'edit');
});

test('a diff renders as a unified block naming its file', () => {
  const model = fold({
    sessionUpdate: 'tool_call',
    toolCallId: 't4',
    title: 'Edit',
    content: [{ type: 'diff', path: 'a.ts', oldText: 'let x = 1;', newText: 'const x = 1;' }],
  });
  assert.equal(
    toolOutputText(findTool(model, 't4')!),
    ['--- a.ts', '-let x = 1;', '+const x = 1;'].join('\n'),
  );
});

test('a plan replaces the previous one', () => {
  const model = fold(
    { sessionUpdate: 'plan', entries: [{ content: 'read the code' }] },
    { sessionUpdate: 'plan', entries: [{ content: 'read the code' }, { content: 'fix it' }] },
  );
  assert.equal(model.plan?.length, 2);
});

test('a mode update moves the current mode without inventing a mode list', () => {
  const model = emptyModel();
  applyUpdate(model, { sessionUpdate: 'current_mode_update', currentModeId: 'auto' });
  assert.equal(model.modes, null);

  model.modes = {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'auto', name: 'Auto' },
    ],
  };
  applyUpdate(model, { sessionUpdate: 'current_mode_update', currentModeId: 'auto' });
  assert.equal(model.modes.currentModeId, 'auto');
  assert.equal(model.modes.availableModes.length, 2);
});

test('a command list replaces the previous one', () => {
  const model = fold(
    {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'review' }, { name: 'release' }],
    },
    { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] },
  );
  assert.deepEqual(model.commands, [{ name: 'compact' }]);
  assert.deepEqual(model.messages, []);
});

test('an unknown update kind is noted by name and renders nothing', () => {
  const model = fold({ sessionUpdate: 'usage_update', tokens: 12 } as unknown as ThreadUpdate);
  assert.equal(model.messages.length, 0);
  assert.deepEqual([...model.unknown], ['usage_update']);
});

test('a kind that arrives over and over is noted once', () => {
  // The adapter sends a usage update at the end of every cycle.
  const model = emptyModel();
  for (let i = 0; i < 100; i++) {
    applyUpdate(model, { sessionUpdate: 'usage_update', tokens: i } as unknown as ThreadUpdate);
  }
  assert.equal(model.unknown.size, 1);
});

test('replaying the same script twice from a fresh model gives the same thread', () => {
  const script: ThreadUpdate[] = [
    chunk('user_message_chunk', 'run the tests'),
    { sessionUpdate: 'tool_call', toolCallId: 't5', title: 'Run tests', status: 'pending' },
    { sessionUpdate: 'tool_call_update', toolCallId: 't5', status: 'completed' },
    chunk('agent_message_chunk', 'All green.'),
  ];
  const strip = (m: ThreadModel): unknown =>
    m.messages.map((msg) => ({
      role: msg.role,
      parts: msg.parts.map((p) => (p.type === 'tool' ? { tool: (p as ToolPart).title } : p)),
    }));
  assert.deepEqual(strip(fold(...script)), strip(fold(...script)));
});

/**
 * Builds an image chunk of the given kind, carrying a base64 payload.
 *
 * @param sessionUpdate The kind of the chunk.
 * @param data The base64 payload.
 * @param mimeType The MIME type of the image.
 * @returns The update.
 */
function imageChunk(
  sessionUpdate: 'user_message_chunk' | 'agent_message_chunk',
  data: string,
  mimeType = 'image/png',
): ThreadUpdate {
  return { sessionUpdate, content: { type: 'image', data, mimeType } } as ThreadUpdate;
}

test('an image chunk becomes its own part, between the prose either side', () => {
  const model = fold(
    chunk('agent_message_chunk', 'Here it is:'),
    imageChunk('agent_message_chunk', 'AAAA'),
    chunk('agent_message_chunk', 'and that is the page.'),
  );
  assert.equal(model.messages.length, 1);
  assert.deepEqual(model.messages[0]!.parts, [
    { type: 'text', text: 'Here it is:' },
    { type: 'image', src: 'data:image/png;base64,AAAA' },
    { type: 'text', text: 'and that is the page.' },
  ]);
});

test('an image a user sent survives the replay of their prompt', () => {
  const model = fold(imageChunk('user_message_chunk', 'BBBB', 'image/jpeg'));
  assert.equal(model.messages[0]!.role, 'user');
  assert.deepEqual(model.messages[0]!.parts, [
    { type: 'image', src: 'data:image/jpeg;base64,BBBB' },
  ]);
});

test('an image block with no payload the browser can load is said in words', () => {
  const model = fold(
    {
      sessionUpdate: 'agent_message_chunk',
      // The adapter sends a remote image with no payload, and with a URL that
      // assistant-ui would refuse as a src.
      content: { type: 'image', data: '', mimeType: '', uri: 'http://example.test/a.png' },
    } as ThreadUpdate,
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: '', mimeType: '' },
    } as ThreadUpdate,
  );
  assert.deepEqual(model.messages[0]!.parts, [
    { type: 'text', text: '[image: http://example.test/a.png][image]' },
  ]);
});

test('an https image block is passed through as its own src', () => {
  const model = fold({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'image', uri: 'https://example.test/a.png' },
  } as ThreadUpdate);
  assert.deepEqual(model.messages[0]!.parts, [
    { type: 'image', src: 'https://example.test/a.png' },
  ]);
});

test("a tool call's image result is named in its output rather than left empty", () => {
  const model = fold({
    sessionUpdate: 'tool_call',
    toolCallId: 't10',
    title: 'Read screenshot.png',
    kind: 'read',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'image', data: 'CCCC', mimeType: 'image/png' } }],
  });
  assert.equal(toolOutputText(findTool(model, 't10')!), '[image]');
});

/**
 * Builds the envelope for one attachment, as a user chunk.
 *
 * The composer sends what the user attached as one block of text. The thread
 * reads it the same way live and on replay.
 *
 * @param overrides The fields that differ from a PDF attachment.
 * @returns The update.
 */
function attached(
  overrides: Partial<Parameters<typeof buildEnvelope>[0][number]> = {},
): ThreadUpdate {
  return chunk(
    'user_message_chunk',
    buildEnvelope([
      {
        path: '.boxes/attachments/report.pdf',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        size: '840.0 KB',
        ...overrides,
      },
    ]),
  );
}

test('an attached file becomes a chip rather than the instructions the model got', () => {
  const model = fold(attached(), chunk('user_message_chunk', 'what does this say?'));

  assert.deepEqual(model.messages[0]!.parts, [
    {
      type: 'attachment',
      name: 'report.pdf',
      path: '.boxes/attachments/report.pdf',
      mimeType: 'application/pdf',
    },
    { type: 'text', text: 'what does this say?' },
  ]);
});

test('an attached image is a chip too: what it becomes on screen is the converter', () => {
  const model = fold(
    attached({ path: '.boxes/attachments/shot.png', mimeType: 'image/png' }),
    chunk('user_message_chunk', 'what is wrong here?'),
  );

  assert.deepEqual(model.messages[0]!.parts[0], {
    type: 'attachment',
    name: 'shot.png',
    path: '.boxes/attachments/shot.png',
    mimeType: 'image/png',
  });
});

test('an envelope that cannot be read is shown rather than swallowed', () => {
  const model = fold(
    chunk(
      'user_message_chunk',
      '<attachments>\n- a.png (image/png, 1 B, later field)\n</attachments>',
    ),
  );
  assert.equal(model.messages[0]!.parts[0]!.type, 'text');
});

test('the envelope is only read in a user or agent message, never as a thought', () => {
  // The reasoning stream holds only reasoning parts.
  const model = fold({
    sessionUpdate: 'agent_thought_chunk',
    content: {
      type: 'text',
      text: buildEnvelope([
        {
          path: '.boxes/attachments/a.png',
          name: 'a.png',
          mimeType: 'image/png',
          size: '1 B',
        },
      ]),
    },
  } as ThreadUpdate);
  assert.equal(model.messages[0]!.parts[0]!.type, 'reasoning');
});

/**
 * A monitor's event, as the harness sends one.
 *
 * A background task reports by waking the agent with a block of XML in the
 * user role. The thread shows it as a task row, not as the user talking.
 */
const NOTIFICATION = [
  '<task-notification>',
  '<task-id>bnztwmmw5</task-id>',
  '<summary>Monitor event: "crawl progress"</summary>',
  '<event>2200/30321 ok=2193 bad=7</event>',
  '</task-notification>',
].join('\n');

test('a background task reporting in becomes a row of its own, not prose', () => {
  const model = fold(chunk('user_message_chunk', NOTIFICATION));

  assert.deepEqual(model.messages[0]!.parts, [
    {
      type: 'task',
      taskId: 'bnztwmmw5',
      summary: 'Monitor event: "crawl progress"',
      body: '2200/30321 ok=2193 bad=7',
    },
  ]);
});

test('what the user typed around one is still what they typed', () => {
  // One message, because without message ids only the role separates them.
  const model = fold(
    chunk('user_message_chunk', 'keep going'),
    chunk('user_message_chunk', NOTIFICATION),
  );

  assert.equal(model.messages.length, 1);
  assert.deepEqual(
    model.messages[0]!.parts.map((p) => p.type),
    ['text', 'task'],
  );
});

test('an agent quoting the format is quoting it', () => {
  const model = fold(chunk('agent_message_chunk', `the harness sends\n${NOTIFICATION}`));
  assert.equal(model.messages[0]!.parts[0]!.type, 'text');
});

test('a notification this build cannot read is shown rather than swallowed', () => {
  const model = fold(
    chunk('user_message_chunk', NOTIFICATION.replace(/<task-id>.*<\/task-id>\n/, '')),
  );
  assert.equal(model.messages[0]!.parts[0]!.type, 'text');
});

test('only a message the adapter named carries its id', () => {
  const model = fold(
    chunk('agent_message_chunk', 'named', 'msg_1'),
    chunk('user_message_chunk', 'not'),
  );
  assert.equal(model.messages[0]!.named, true);
  // The model numbered the message itself, so it cannot serve as a resume point.
  assert.equal(model.messages[1]!.named, undefined);
});

test('truncating drops the message named and everything after it', () => {
  const model = fold(
    chunk('user_message_chunk', 'first', 'msg_1'),
    chunk('agent_message_chunk', 'second', 'msg_2'),
    { sessionUpdate: 'tool_call', toolCallId: 'toolu_1', title: 'Read' } as ThreadUpdate,
    chunk('agent_message_chunk', 'third', 'msg_3'),
  );

  const dropped = truncateFrom(model, 'msg_2');

  assert.deepEqual(
    dropped.map((m) => m.id),
    ['msg_2', 'msg_3'],
  );
  assert.deepEqual(
    model.messages.map((m) => m.id),
    ['msg_1'],
  );
  // The tool index loses the call, or a later update would merge into a
  // dropped part.
  assert.equal(findTool(model, 'toolu_1'), undefined);
});

test('truncating from a message the model does not hold changes nothing', () => {
  const model = fold(chunk('agent_message_chunk', 'only', 'msg_1'));
  assert.deepEqual(truncateFrom(model, 'msg_gone'), []);
  assert.deepEqual(
    model.messages.map((m) => m.id),
    ['msg_1'],
  );
});

test('a truncated model plus the rest is the model the whole thread builds', () => {
  const script = [
    chunk('user_message_chunk', 'the first question', 'msg_1'),
    chunk('agent_message_chunk', 'the first answer', 'msg_2'),
    { sessionUpdate: 'tool_call', toolCallId: 'toolu_1', title: 'Read' } as ThreadUpdate,
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'toolu_1',
      status: 'completed',
    } as ThreadUpdate,
    chunk('agent_message_chunk', 'and the rest', 'msg_3'),
  ];
  const whole = fold(...script);

  resetIds();
  const resumed = fold(...script.slice(0, 2));
  truncateFrom(resumed, 'msg_2');
  for (const u of script.slice(1)) applyUpdate(resumed, u);

  // A reconnect can take the tail alone, because the result is the same.
  assert.deepEqual(resumed.messages, whole.messages);
});

/**
 * Builds a session_info_update that carries a predicted next prompt.
 *
 * @param texts The texts of the suggestions.
 * @returns The update.
 */
function suggest(...texts: string[]): ThreadUpdate {
  return {
    sessionUpdate: 'session_info_update',
    _meta: { promptSuggestions: { suggestions: texts.map((text) => ({ text })) } },
  } as ThreadUpdate;
}

test('a session info update sets the predicted next prompt', () => {
  const model = fold(chunk('agent_message_chunk', 'Done.'), suggest('  ', 'run the tests '));
  assert.equal(model.promptSuggestion, 'run the tests');
  assert.equal(model.unknown.size, 0);
});

test('an empty suggestion list clears the predicted prompt', () => {
  assert.equal(fold(suggest('run the tests'), suggest()).promptSuggestion, null);
});

test('a session info update without a suggestion keeps the predicted prompt', () => {
  const model = fold(suggest('run the tests'), {
    sessionUpdate: 'session_info_update',
    title: 'A title',
  } as ThreadUpdate);
  assert.equal(model.promptSuggestion, 'run the tests');
});

test('a user message clears the predicted prompt', () => {
  const model = fold(suggest('run the tests'), chunk('user_message_chunk', 'deploy it'));
  assert.equal(model.promptSuggestion, null);
});
