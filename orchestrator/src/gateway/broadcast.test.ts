import assert from 'node:assert/strict';
import { test } from 'vitest';
import { TURN_STATE_METHOD, type TurnStateParams } from '../../../shared/types.ts';
import { Broadcast } from './broadcast.ts';
import type { DownstreamHandle } from './upstream.ts';

/**
 * Update routing, with two browsers attached — which is the case every rule
 * in the class exists for, whether the two watch one thread or two.
 */

/** The thread most of these tests are about. */
const T1 = 'acp-1';
/** A second thread of the same session, watched by nobody unless said. */
const T2 = 'acp-2';

/** A browser that records what it was sent, watching one thread. */
function fakeDownstream(
  id: number,
  acpThreadId: string | null = T1,
  lastActiveAt = 0,
): DownstreamHandle & { sent: unknown[]; turns: boolean[]; states: TurnStateParams[] } {
  const sent: unknown[] = [];
  /** Every thread state this browser was told, in order. */
  const states: TurnStateParams[] = [];
  /** The prompt-open half of each, which most of these tests are about. */
  const turns: boolean[] = [];
  return {
    id,
    acpThreadId,
    lastActiveAt,
    sent,
    turns,
    states,
    notify: (method, params) => {
      if (method === TURN_STATE_METHOD) {
        states.push(params as TurnStateParams);
        turns.push((params as TurnStateParams).active);
        return;
      }
      sent.push(params);
    },
    request: () => Promise.resolve({}),
    close: () => {},
  };
}

/** A session/update notification, as the adapter sends it. */
function update(sessionUpdate: string, text: string, thread = T1): unknown {
  return { sessionId: thread, update: { sessionUpdate, content: { type: 'text', text } } };
}

/** The text of each user_message_chunk a browser received. */
function userChunks(d: { sent: unknown[] }): string[] {
  return d.sent
    .filter(
      (p) =>
        (p as { update?: { sessionUpdate?: string } }).update?.sessionUpdate ===
        'user_message_chunk',
    )
    .map((p) => (p as { update: { content: { text: string } } }).update.content.text);
}

test('an ordinary update reaches every browser watching its thread', () => {
  const b = new Broadcast('s1');
  const [a, c] = [fakeDownstream(1), fakeDownstream(2)];
  b.add(a);
  b.add(c);

  b.update(update('agent_message_chunk', 'hello'));
  assert.equal(a.sent.length, 1);
  assert.equal(c.sent.length, 1);
});

test('an update for one thread does not reach a browser watching another', () => {
  const b = new Broadcast('s1');
  const working = fakeDownstream(1, T1);
  const exploring = fakeDownstream(2, T2);
  b.add(working);
  b.add(exploring);

  b.update(update('agent_message_chunk', 'from the long turn', T1));
  b.update(update('agent_message_chunk', 'from the fork', T2));

  // Two tabs, two conversations, one box: neither shows the other's stream.
  assert.equal(working.sent.length, 1);
  assert.equal(exploring.sent.length, 1);
  assert.deepEqual(working.sent, [update('agent_message_chunk', 'from the long turn', T1)]);
  assert.deepEqual(exploring.sent, [update('agent_message_chunk', 'from the fork', T2)]);
});

test('an update for a thread nobody watches is dropped', () => {
  const b = new Broadcast('s1');
  const watching = fakeDownstream(1, T1);
  b.add(watching);

  // A thread running in the background with its tab closed. Broadcasting this
  // is what would put one conversation into another's transcript.
  b.update(update('agent_message_chunk', 'nobody asked for this', T2));
  assert.equal(watching.sent.length, 0);
});

test('an update naming no thread at all is dropped rather than broadcast', () => {
  const b = new Broadcast('s1');
  const a = fakeDownstream(1);
  b.add(a);

  b.update({ update: { sessionUpdate: 'agent_message_chunk' } });
  assert.equal(a.sent.length, 0);
});

test('a browser whose thread is still resolving receives nothing', () => {
  const b = new Broadcast('s1');
  const resolving = fakeDownstream(1, null);
  b.add(resolving);

  // Counted as attached — it holds a socket open — but it has not been told
  // which thread it is on, so nothing is its.
  assert.equal(b.size, 1);
  b.update(update('agent_message_chunk', 'hello'));
  assert.equal(resolving.sent.length, 0);
});

test('a forwarded prompt is echoed to every browser on its thread, the sender included', () => {
  const b = new Broadcast('s1');
  const [phone, desktop] = [fakeDownstream(1), fakeDownstream(2)];
  b.add(phone);
  b.add(desktop);

  b.beginPrompt({ sessionId: T1, prompt: [{ type: 'text', text: 'run the tests' }] });

  // The adapter only has to replay a prompt, not echo it live, so without
  // this neither device would show what was just asked.
  assert.deepEqual(userChunks(phone), ['run the tests']);
  assert.deepEqual(userChunks(desktop), ['run the tests']);
});

test('a prompt echo reaches only the browsers watching its own thread', () => {
  const b = new Broadcast('s1');
  const working = fakeDownstream(1, T1);
  const exploring = fakeDownstream(2, T2);
  b.add(working);
  b.add(exploring);

  b.beginPrompt({ sessionId: T2, prompt: [{ type: 'text', text: 'what are you doing?' }] });

  assert.deepEqual(userChunks(exploring), ['what are you doing?']);
  assert.deepEqual(userChunks(working), []);
});

test('an adapter that echoes the prompt back does not produce a second copy', () => {
  const b = new Broadcast('s1');
  const a = fakeDownstream(1);
  b.add(a);

  b.beginPrompt({ sessionId: T1, prompt: [{ type: 'text', text: 'hello' }] });
  b.update(update('user_message_chunk', 'hello'));
  assert.deepEqual(userChunks(a), ['hello']);

  b.endPrompt({ sessionId: T1 });
  // Once the prompt is done the adapter is the authority again.
  b.update(update('user_message_chunk', 'from somewhere else'));
  assert.deepEqual(userChunks(a), ['hello', 'from somewhere else']);
});

test('echo suppression on one thread does not silence another thread user messages', () => {
  const b = new Broadcast('s1');
  const working = fakeDownstream(1, T1);
  const exploring = fakeDownstream(2, T2);
  b.add(working);
  b.add(exploring);

  b.beginPrompt({ sessionId: T1, prompt: [{ type: 'text', text: 'mine' }] });
  // The other thread's own user message, which this gateway never echoed.
  b.update(update('user_message_chunk', 'theirs', T2));

  assert.deepEqual(userChunks(exploring), ['theirs']);
});

test('a multi-block prompt is echoed block by block', () => {
  const b = new Broadcast('s1');
  const a = fakeDownstream(1);
  b.add(a);
  b.beginPrompt({
    sessionId: T1,
    prompt: [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ],
  });
  assert.deepEqual(userChunks(a), ['first', 'second']);
});

test('a replay goes only to the browser that asked for it', () => {
  const b = new Broadcast('s1');
  const [reattaching, watching] = [fakeDownstream(1), fakeDownstream(2)];
  b.add(reattaching);
  b.add(watching);

  b.beginReplay(reattaching, T1);
  b.update(update('user_message_chunk', 'old question'));
  b.update(update('agent_message_chunk', 'old answer'));

  // The other tab already has this history; sending it again would render
  // the whole thread twice.
  assert.equal(reattaching.sent.length, 2);
  assert.equal(watching.sent.length, 0);

  b.endReplay(reattaching, T1);
  b.update(update('agent_message_chunk', 'something new'));
  assert.equal(reattaching.sent.length, 3);
  assert.equal(watching.sent.length, 1);
});

test('a replay of one thread does not silence another thread live updates', () => {
  const b = new Broadcast('s1');
  const reattaching = fakeDownstream(1, T2);
  const working = fakeDownstream(2, T1);
  b.add(reattaching);
  b.add(working);

  // The explorer's tab reloads and replays, while the working thread is
  // mid-turn. This is the bug two open tabs hit first.
  b.beginReplay(reattaching, T2);
  b.update(update('agent_message_chunk', 'still working', T1));
  b.update(update('agent_message_chunk', 'replayed history', T2));

  assert.equal(working.sent.length, 1);
  assert.equal(reattaching.sent.length, 1);
});

test('a replayed user message is delivered even during a prompt', () => {
  const b = new Broadcast('s1');
  const a = fakeDownstream(1);
  b.add(a);

  // A load running while a prompt is in flight: the echo suppression must
  // not eat the history the adapter is reading back.
  b.beginPrompt({ sessionId: T1, prompt: [{ type: 'text', text: 'now' }] });
  b.beginReplay(a, T1);
  b.update(update('user_message_chunk', 'from the transcript'));
  assert.deepEqual(userChunks(a), ['now', 'from the transcript']);
});

test('two replays at once each get the history', () => {
  const b = new Broadcast('s1');
  const [one, two, idle] = [fakeDownstream(1), fakeDownstream(2), fakeDownstream(3)];
  b.add(one);
  b.add(two);
  b.add(idle);

  b.beginReplay(one, T1);
  b.beginReplay(two, T1);
  b.update(update('agent_message_chunk', 'history'));
  assert.equal(one.sent.length, 1);
  assert.equal(two.sent.length, 1);
  assert.equal(idle.sent.length, 0);

  b.endReplay(one, T1);
  b.endReplay(two, T1);
  b.update(update('agent_message_chunk', 'live'));
  assert.equal(idle.sent.length, 1);
});

test('a borrowed replay reaches the fork under its own thread id', () => {
  const b = new Broadcast('s1');
  const exploring = fakeDownstream(1, T2);
  const working = fakeDownstream(2, T1);
  b.add(exploring);
  b.add(working);

  // A fork with no transcript of its own, being shown the source's. The
  // browser is pinned to the fork, so what it is sent has to name the fork --
  // an update naming the source is some other conversation's as far as it is
  // concerned.
  b.beginReplay(exploring, T1, T2);
  b.update(update('user_message_chunk', 'old question', T1));
  b.update(update('agent_message_chunk', 'old answer', T1));

  assert.deepEqual(exploring.sent, [
    update('user_message_chunk', 'old question', T2),
    update('agent_message_chunk', 'old answer', T2),
  ]);
  // The tab on the source already has this history on screen.
  assert.equal(working.sent.length, 0);

  b.endReplay(exploring, T1);
  b.update(update('agent_message_chunk', 'live', T1));
  assert.deepEqual(working.sent, [update('agent_message_chunk', 'live', T1)]);
  assert.equal(exploring.sent.length, 2);
});

test('a browser that leaves mid-replay does not strand the others', () => {
  const b = new Broadcast('s1');
  const [leaving, watching] = [fakeDownstream(1), fakeDownstream(2)];
  b.add(leaving);
  b.add(watching);

  b.beginReplay(leaving, T1);
  b.remove(leaving);

  // With the replay target gone, updates go back to everyone left on the
  // thread.
  b.update(update('agent_message_chunk', 'still here'));
  assert.equal(watching.sent.length, 1);
});

test('one browser failing does not stop the others being told', () => {
  const b = new Broadcast('s1');
  const broken: DownstreamHandle = {
    id: 1,
    acpThreadId: T1,
    lastActiveAt: 0,
    notify: () => {
      throw new Error('socket gone');
    },
    request: () => Promise.resolve({}),
    close: () => {},
  };
  const ok = fakeDownstream(2);
  b.add(broken);
  b.add(ok);

  b.update(update('agent_message_chunk', 'hello'));
  assert.equal(ok.sent.length, 1);
});

test('permission requests target the most recently active browser on the asking thread', () => {
  const b = new Broadcast('s1');
  const older = fakeDownstream(1, T1, 1000);
  const newer = fakeDownstream(2, T1, 2000);
  const elsewhere = fakeDownstream(3, T2, 3000);
  b.add(older);
  b.add(newer);
  b.add(elsewhere);

  // The most recent browser overall is on the other thread, and is not the
  // one being asked.
  assert.equal(b.byRecency(T1)[0], newer);
  assert.equal(b.byRecency(T2)[0], elsewhere);
  assert.deepEqual(b.byRecency('acp-nobody'), []);
});

test('the watched threads are what a respawn has to reload', () => {
  const b = new Broadcast('s1');
  const working = fakeDownstream(1, T1);
  b.add(working);
  b.add(fakeDownstream(2, T2));
  b.add(fakeDownstream(3, T2));
  b.add(fakeDownstream(4, null));

  assert.deepEqual(b.watchedThreads.sort(), [T1, T2]);

  // The set shrinks as tabs close, so it needs no storage of its own.
  b.remove(working);
  assert.deepEqual(b.watchedThreads, [T2]);
});

test('a prompt with no blocks echoes nothing but still guards the window', () => {
  const b = new Broadcast('s1');
  const a = fakeDownstream(1);
  b.add(a);

  b.beginPrompt({ sessionId: T1 });
  b.update(update('user_message_chunk', 'adapter said it'));
  assert.deepEqual(userChunks(a), []);

  b.endPrompt({ sessionId: T1 });
  b.update(update('user_message_chunk', 'now allowed'));
  assert.deepEqual(userChunks(a), ['now allowed']);
});

test('nested prompts hold the window until the last one ends', () => {
  const b = new Broadcast('s1');
  const a = fakeDownstream(1);
  b.add(a);

  b.beginPrompt({ sessionId: T1, prompt: [{ type: 'text', text: 'one' }] });
  b.beginPrompt({ sessionId: T1, prompt: [{ type: 'text', text: 'two' }] });
  b.endPrompt({ sessionId: T1 });
  b.update(update('user_message_chunk', 'echoed by the adapter'));
  assert.deepEqual(userChunks(a), ['one', 'two']);

  b.endPrompt({ sessionId: T1 });
  b.update(update('user_message_chunk', 'after'));
  assert.deepEqual(userChunks(a), ['one', 'two', 'after']);
});

test('a prompt tells the browsers on its thread that a turn is running', () => {
  const b = new Broadcast('s1');
  const [a, c, other] = [fakeDownstream(1), fakeDownstream(2), fakeDownstream(3, T2)];
  b.add(a);
  b.add(c);
  b.add(other);

  const prompt = { sessionId: T1, prompt: [{ type: 'text', text: 'go' }] };
  b.beginPrompt(prompt);
  assert.deepEqual(a.turns, [true]);
  // Both browsers on the thread, including the one that did not send it.
  assert.deepEqual(c.turns, [true]);
  // And nobody on another conversation of the same box.
  assert.deepEqual(other.turns, []);

  b.endPrompt(prompt);
  assert.deepEqual(a.turns, [true, false]);
});

test('two prompts on one thread are one turn', () => {
  const b = new Broadcast('s1');
  const a = fakeDownstream(1);
  b.add(a);

  const first = { sessionId: T1, prompt: [] };
  const second = { sessionId: T1, prompt: [] };
  b.beginPrompt(first);
  b.beginPrompt(second);
  assert.deepEqual(a.turns, [true]);
  assert.equal(b.isPrompting(T1), true);

  // The first to finish does not end the turn the second is still running.
  b.endPrompt(first);
  assert.deepEqual(a.turns, [true]);
  assert.equal(b.isPrompting(T1), true);

  b.endPrompt(second);
  assert.deepEqual(a.turns, [true, false]);
  assert.equal(b.isPrompting(T1), false);
});

test('a browser can be told its own thread state, and only its own', () => {
  const b = new Broadcast('s1');
  const [a, other] = [fakeDownstream(1), fakeDownstream(2, T2)];
  b.add(a);
  b.add(other);

  b.threadStateTo(a);
  assert.deepEqual(a.turns, [false]);
  assert.deepEqual(other.turns, []);

  // A connection whose thread has not been settled yet is told nothing;
  // it has not asked for anything either.
  const unpinned = fakeDownstream(3, null);
  b.add(unpinned);
  b.threadStateTo(unpinned);
  assert.deepEqual(unpinned.turns, []);
});

test('re-stating every thread reaches every watched one', () => {
  const b = new Broadcast('s1');
  const [a, other] = [fakeDownstream(1), fakeDownstream(2, T2)];
  b.add(a);
  b.add(other);

  b.refreshThreadStates();
  assert.deepEqual(a.turns, [false]);
  assert.deepEqual(other.turns, [false]);
});

test('the state a browser is told is the one the gateway supplies', () => {
  // What the gateway knows and this class does not: the agent is talking on
  // T1, and it has a build running in it.
  const b = new Broadcast('s1', (thread) => ({
    sessionId: thread,
    active: false,
    speaking: thread === T1,
    background:
      thread === T1 ? [{ id: 'aabbccdd', command: 'npm run build', startedAt: null }] : [],
  }));
  const a = fakeDownstream(1);
  b.add(a);

  b.threadState(T1);
  assert.deepEqual(
    a.states.at(-1)?.background.map((p) => p.command),
    ['npm run build'],
  );
  assert.equal(a.states.at(-1)?.speaking, true);
});
