import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Activity, type Delay } from './activity.ts';

/**
 * Whether the agent is talking, which is a question about silence — so every
 * test here is about time passing, and time is injected rather than waited
 * for. A real second of waiting proves nothing a fake one does not.
 */

const QUIET = 3_000;
const SETTLE = 30_000;

/** A clock the test moves, and the timers armed against it. */
function clock(): { delay: Delay; pass: (ms: number) => void } {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const delay: Delay = (ms, fn) => {
    const id = next++;
    timers.set(id, { at: now + ms, fn });
    return () => timers.delete(id);
  };
  return {
    delay,
    // One level of chaining per call, which is what makes the two thresholds
    // legible in a test: pass the quiet window, then pass the rest.
    pass: (ms) => {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

/** An Activity recording every transition and every settled turn. */
function activity(): {
  a: Activity;
  pass: (ms: number) => void;
  changes: Array<[string, boolean]>;
  settled: string[];
} {
  const { delay, pass } = clock();
  const changes: Array<[string, boolean]> = [];
  const settled: string[] = [];
  const a = new Activity({
    quietMs: QUIET,
    settleMs: SETTLE,
    onChange: (thread, speaking) => changes.push([thread, speaking]),
    onSettled: (thread) => settled.push(thread),
    delay,
  });
  return { a, pass, changes, settled };
}

/** One update, as the adapter sends it. */
function update(sessionUpdate: string, over: Record<string, unknown> = {}): unknown {
  return { sessionUpdate, ...over };
}

/** A tool call the agent is waiting on. */
function toolCall(toolCallId: string, over: Record<string, unknown> = {}): unknown {
  return update('tool_call', {
    toolCallId,
    status: 'pending',
    _meta: { claudeCode: { toolName: 'Bash' } },
    ...over,
  });
}

test('the agent is talking while it says things, and stops when it stops', () => {
  const { a, pass, changes } = activity();
  a.observe('t1', update('agent_message_chunk', { content: { type: 'text', text: 'hi' } }));
  assert.equal(a.speaking('t1'), true);
  assert.deepEqual(changes, [['t1', true]]);

  // Still going: every chunk restarts the clock on its silence.
  pass(QUIET - 1);
  a.observe('t1', update('agent_message_chunk', { content: { type: 'text', text: 'there' } }));
  pass(QUIET - 1);
  assert.equal(a.speaking('t1'), true);

  pass(QUIET);
  assert.equal(a.speaking('t1'), false);
  assert.deepEqual(changes, [
    ['t1', true],
    ['t1', false],
  ]);
});

test('a tool call the agent is waiting on is not silence', () => {
  const { a, pass } = activity();
  a.observe('t1', toolCall('call_1'));
  // Two minutes of a test suite running, which says nothing at all.
  for (let i = 0; i < 40; i++) pass(QUIET);
  assert.equal(a.speaking('t1'), true);

  a.observe('t1', update('tool_call_update', { toolCallId: 'call_1', status: 'completed' }));
  pass(QUIET);
  assert.equal(a.speaking('t1'), false);
});

test('a call that runs in the background is not the agent working', () => {
  const { a, pass } = activity();
  // Announcing it is: the agent just made the call. Waiting for it is not.
  a.observe('t1', toolCall('call_1', { rawInput: { command: 'npm run build', run_in_background: true } }));
  assert.equal(a.speaking('t1'), true);
  pass(QUIET);
  assert.equal(a.speaking('t1'), false);

  a.observe('t1', toolCall('call_2', { _meta: { claudeCode: { toolName: 'Monitor' } } }));
  pass(QUIET);
  assert.equal(a.speaking('t1'), false);
});

test('a turn is settled once, a while after it has actually stopped', () => {
  const { a, pass, settled } = activity();
  a.observe('t1', update('agent_message_chunk'));
  pass(QUIET);
  // Quiet, but not for long enough to tell anybody who is not looking.
  assert.deepEqual(settled, []);
  pass(SETTLE - QUIET);
  assert.deepEqual(settled, ['t1']);

  // And not again for the same silence.
  pass(SETTLE);
  assert.deepEqual(settled, ['t1']);
});

test('a thread that starts talking again is not announced as finished', () => {
  const { a, pass, settled } = activity();
  a.observe('t1', update('agent_message_chunk'));
  pass(QUIET);
  // The pause between two tool calls, or the harness waking the agent with a
  // task's report: either way the turn is not over.
  a.observe('t1', update('agent_message_chunk'));
  pass(SETTLE);
  assert.deepEqual(settled, []);
});

test('a prompt forwarded is the agent working, before it has said anything', () => {
  const { a, changes } = activity();
  a.begin('t1');
  assert.equal(a.speaking('t1'), true);
  assert.deepEqual(changes, [['t1', true]]);
});

test('an update that is not the agent talking is not read as one', () => {
  const { a } = activity();
  // The user setting a mode, and the adapter listing its commands at
  // startup: things about the thread, not from the agent.
  a.observe('t1', update('current_mode_update', { currentModeId: 'plan' }));
  a.observe('t1', update('available_commands_update', { availableCommands: [] }));
  assert.equal(a.speaking('t1'), false);
});

test('threads are answered for separately', () => {
  const { a, pass, changes } = activity();
  a.observe('t1', update('agent_message_chunk'));
  pass(QUIET - 1);
  a.observe('t2', update('agent_message_chunk'));
  pass(1);

  assert.equal(a.speaking('t1'), false);
  assert.equal(a.speaking('t2'), true);
  assert.deepEqual(a.speakingThreads, ['t2']);
  assert.deepEqual(changes, [
    ['t1', true],
    ['t2', true],
    ['t1', false],
  ]);
});

test('a cancelled thread stops talking and announces nothing afterwards', () => {
  const { a, pass, changes, settled } = activity();
  a.observe('t1', toolCall('call_1'));
  a.reset('t1');
  assert.equal(a.speaking('t1'), false);
  pass(SETTLE * 2);
  // The caller publishes the new state itself; nothing here fires late.
  assert.deepEqual(changes, [['t1', true]]);
  assert.deepEqual(settled, []);
});

test('an adapter that has gone takes every thread with it', () => {
  const { a, pass, settled } = activity();
  a.observe('t1', update('agent_message_chunk'));
  a.observe('t2', update('agent_message_chunk'));
  a.clear();
  assert.deepEqual(a.speakingThreads, []);
  pass(SETTLE * 2);
  assert.deepEqual(settled, []);
});

/** The update the adapter sends when a processing cycle is over. */
function cycleEnd(over: Record<string, unknown> = {}): unknown {
  return update('usage_update', {
    used: 41_000,
    size: 200_000,
    cost: { amount: 0.42, currency: 'USD' },
    ...over,
  });
}

test('the adapter saying the cycle is over is taken at its word', () => {
  const { a, changes, settled, pass } = activity();
  a.observe('t1', update('agent_message_chunk'));
  // No timer runs out: the agent said so itself, which is what this adapter's
  // cost-bearing usage_update is (see the file's own header).
  a.observe('t1', cycleEnd());
  assert.equal(a.speaking('t1'), false);
  assert.deepEqual(changes, [
    ['t1', true],
    ['t1', false],
  ]);

  // The notification still waits out the whole settle window.
  assert.deepEqual(settled, []);
  pass(SETTLE);
  assert.deepEqual(settled, ['t1']);
});

test('a running total is not the end of anything', () => {
  const { a } = activity();
  a.observe('t1', update('agent_message_chunk'));
  // The same update kind, sent as a message streams: tokens and a window, no
  // cost. Reading this one as an ending would end every turn at its first
  // paragraph.
  a.observe('t1', update('usage_update', { used: 12_000, size: 200_000 }));
  assert.equal(a.speaking('t1'), true);
});

test('a cycle that ends with a call still open ends anyway', () => {
  const { a } = activity();
  a.observe('t1', toolCall('call_1'));
  // A cancelled turn: the call never completes, and waiting on it would leave
  // the thread speaking for good.
  a.observe('t1', cycleEnd());
  assert.equal(a.speaking('t1'), false);
});

test('the harness waking the agent starts it talking again, and ends again', () => {
  const { a, pass, changes, settled } = activity();
  a.observe('t1', update('agent_message_chunk'));
  a.observe('t1', cycleEnd());
  pass(SETTLE);
  assert.deepEqual(settled, ['t1']);

  // A task reports in. No prompt is open, and the agent works and stops.
  a.observe('t1', update('user_message_chunk'));
  assert.equal(a.speaking('t1'), true);
  a.observe('t1', cycleEnd({ _meta: { '_claude/origin': 'task-notification' } }));
  assert.equal(a.speaking('t1'), false);
  pass(SETTLE);
  assert.deepEqual(settled, ['t1', 't1']);
  assert.deepEqual(changes, [
    ['t1', true],
    ['t1', false],
    ['t1', true],
    ['t1', false],
  ]);
});
