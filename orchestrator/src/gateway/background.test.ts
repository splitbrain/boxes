import assert from 'node:assert/strict';
import { test } from 'vitest';
import { BackgroundWork } from './background.ts';

/**
 * What the reaper is told about work a session left running.
 *
 * The class reads the updates a browser would see, so every fixture here is
 * one of those: a tool call that backgrounds something, and the block the
 * harness sends when it is over. The clock is injected because the whole
 * point of the cap is what happens hours later.
 */

const HOUR = 60 * 60_000;

/** The thread these tests are about; a second one appears where it matters. */
const T1 = 'acp-1';
const T2 = 'acp-2';

/** A tracker with a four-hour cap and a clock the test moves. */
function tracker(): { work: BackgroundWork; pass: (ms: number) => void } {
  let now = 1_000_000;
  const work = new BackgroundWork(4 * HOUR, () => now);
  return {
    work,
    pass: (ms: number) => {
      now += ms;
    },
  };
}

/** A tool call, as the adapter announces one. */
function toolCall(toolCallId: string, rawInput: unknown, toolName = 'Bash'): unknown {
  return {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'npm run build',
    status: 'pending',
    rawInput,
    _meta: { claudeCode: { toolName } },
  };
}

/** The harness reporting a task in, as a chunk in the user's own role. */
function notification(lines: string[]): unknown {
  return {
    sessionUpdate: 'user_message_chunk',
    content: {
      type: 'text',
      text: ['<task-notification>', ...lines, '</task-notification>'].join('\n'),
    },
  };
}

test('a session that has started nothing has nothing running', () => {
  const { work } = tracker();
  work.observe(T1, toolCall('toolu_1', { command: 'npm test' }));
  work.observe(T1, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
  assert.equal(work.active, false);
});

test('a backgrounded command holds the reaper off until it reports back', () => {
  const { work } = tracker();
  work.observe(T1, toolCall('toolu_1', { command: 'npm run build', run_in_background: true }));
  assert.equal(work.active, true);

  work.observe(T1, 
    notification([
      '<task-id>bm74el4o7</task-id>',
      '<tool-use-id>toolu_1</tool-use-id>',
      '<status>completed</status>',
      '<summary>Background command "npm run build" completed (exit code 0)</summary>',
    ]),
  );
  assert.equal(work.active, false);
});

test('a monitor is running work too, whatever its input says', () => {
  const { work } = tracker();
  work.observe(T1, toolCall('toolu_2', { command: 'tail -f build.log' }, 'Monitor'));
  assert.equal(work.active, true);
});

test('one command finishing does not clear another that is still going', () => {
  const { work } = tracker();
  work.observe(T1, toolCall('toolu_1', { run_in_background: true }));
  work.observe(T1, toolCall('toolu_2', { run_in_background: true }));
  work.observe(T1, 
    notification([
      '<task-id>b1</task-id>',
      '<tool-use-id>toolu_1</tool-use-id>',
      '<status>completed</status>',
      '<summary>Background command "one" completed (exit code 0)</summary>',
    ]),
  );
  assert.equal(work.active, true);
});

test('a report that is not the end of anything ends nothing', () => {
  const { work } = tracker();
  work.observe(T1, toolCall('toolu_1', { run_in_background: true }));
  // A monitor's event: it names no call, and says the task is still going.
  work.observe(T1, 
    notification([
      '<task-id>bnztwmmw5</task-id>',
      '<summary>Monitor event: "crawl progress"</summary>',
      '<event>2200/30321 ok=2193</event>',
    ]),
  );
  assert.equal(work.active, true);
});

test('a task whose ending never arrives delays the reaper rather than stopping it', () => {
  const { work, pass } = tracker();
  work.observe(T1, toolCall('toolu_1', { run_in_background: true }));

  pass(3 * HOUR);
  assert.equal(work.active, true);
  pass(2 * HOUR);
  assert.equal(work.active, false);
});

test('a re-announced call is the same call, and expires on its own clock', () => {
  const { work, pass } = tracker();
  work.observe(T1, toolCall('toolu_1', { run_in_background: true }));
  pass(3 * HOUR);
  // Replay, or the adapter refining a call as its input streams in. Either
  // way this is the call from three hours ago, not a new one.
  work.observe(T1, toolCall('toolu_1', { run_in_background: true }));
  pass(2 * HOUR);
  assert.equal(work.active, false);
});

test('an adapter whose exec is gone has nothing left to wait for', () => {
  const { work } = tracker();
  work.observe(T1, toolCall('toolu_1', { run_in_background: true }));
  work.clear();
  assert.equal(work.active, false);
});

test('an entry says what the work is and when it started', () => {
  const { work, pass } = tracker();
  work.observe(T1, toolCall('toolu_1', { command: 'npm run build', run_in_background: true }));
  pass(90_000);
  work.observe(T1, {
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_2',
    title: 'watch the crawl',
    status: 'pending',
    rawInput: {},
    _meta: { claudeCode: { toolName: 'Monitor' } },
  });

  // Oldest first, which is the order the work was started in and the order a
  // reader will have watched it appear.
  assert.deepEqual(
    work.forThread(T1).map((t) => [t.toolCallId, t.tool, t.title]),
    [
      ['toolu_1', 'Bash', 'npm run build'],
      ['toolu_2', 'Monitor', 'watch the crawl'],
    ],
  );
  // Ninety seconds apart, as a bar showing their ages has to be able to say.
  const [first, second] = work.forThread(T1);
  assert.equal((second?.startedAt ?? 0) - (first?.startedAt ?? 0), 90_000);
});

test('a task belongs to the conversation that started it', () => {
  const { work } = tracker();
  work.observe(T1, toolCall('toolu_1', { run_in_background: true }));
  work.observe(T2, toolCall('toolu_2', { run_in_background: true }));

  assert.deepEqual(work.forThread(T1).map((t) => t.toolCallId), ['toolu_1']);
  assert.deepEqual(work.forThread(T2).map((t) => t.toolCallId), ['toolu_2']);
  assert.deepEqual(work.threads.sort(), [T1, T2]);
  // The box is what the reaper asks about, and both threads are in it.
  assert.equal(work.count, 2);
  assert.equal(work.active, true);
});

test("a report ends its own thread's task and leaves the other alone", () => {
  const { work } = tracker();
  work.observe(T1, toolCall('toolu_1', { run_in_background: true }));
  work.observe(T2, toolCall('toolu_2', { run_in_background: true }));

  work.observe(T1, 
    notification([
      '<task-id>bg_1</task-id>',
      '<tool-use-id>toolu_1</tool-use-id>',
      '<status>completed</status>',
      '<summary>Build finished</summary>',
    ]),
  );

  assert.deepEqual(work.forThread(T1), []);
  assert.deepEqual(work.forThread(T2).map((t) => t.toolCallId), ['toolu_2']);
});

test('an expired task is gone from the list as well as from the count', () => {
  const { work, pass } = tracker();
  work.observe(T1, toolCall('toolu_1', { run_in_background: true }));
  pass(5 * HOUR);
  assert.deepEqual(work.forThread(T1), []);
  assert.equal(work.count, 0);
});
