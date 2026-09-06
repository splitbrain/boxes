import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  followGrew,
  followScrolled,
  followStart,
  followTouched,
  isFollowing,
  type FollowState,
} from './follow-output.ts';

/**
 * A thread keeping up with a turn, and letting go of one when a reader does.
 *
 * A turn anchors the prompt that started it to the top of the viewport and
 * writes the answer underneath, paying for the space an unwritten answer does
 * not fill yet with a reserve the runtime shrinks as the answer arrives. That
 * lasts one screenful. Past it the anchor has nothing left to give — and it
 * only ever held a position, it never followed one — so this takes over.
 *
 * The browser was asked this once, by streaming a turn into a real Chromium
 * and sampling the overhang every 25ms for twenty seconds, on the assertion
 * that not one of those four hundred samples ever showed a pixel below the
 * fold. One late frame on a busy box was a failing build.
 */

/** A turn arriving into a thread, a chunk at a time. */
function turn(): {
  writes: (behind: number, opts?: { reserving?: boolean }) => boolean;
  reads: (behind: number) => void;
  touches: () => void;
  tick: (ms: number) => void;
  following: () => boolean;
} {
  let state: FollowState = followStart();
  let now = 0;

  return {
    /** A chunk lands, leaving `behind` pixels under the fold. Did it catch up? */
    writes: (behind, { reserving = false } = {}) => {
      now += 16;
      const grew = followGrew(state, { behind, reserving, now });
      state = grew.state;
      // Catching up puts the scroller against the bottom, which is a scroll.
      if (grew.catchUp) state = followScrolled(state, { behind: 0, now });
      return grew.catchUp;
    },
    /** The scroller moves to `behind` pixels from the end. */
    reads: (behind) => {
      now += 16;
      state = followScrolled(state, { behind, now });
    },
    /** A wheel notch, a finger, a thumb on the bar. */
    touches: () => {
      state = followTouched(state, now);
    },
    tick: (ms) => {
      now += ms;
    },
    following: () => isFollowing(state, now),
  };
}

test('the anchor keeps the position while it still has room to give', () => {
  const thread = turn();
  // Everything under the answer is the reserve, and moving the scroller here
  // would fight the anchor for it.
  assert.equal(thread.writes(600, { reserving: true }), false);
  assert.equal(thread.writes(400, { reserving: true }), false);
});

test('and this takes over the moment it runs out', () => {
  const thread = turn();
  thread.writes(600, { reserving: true });
  // The reserve is gone and the turn is still writing: from here to the end
  // of it, every chunk is caught up with.
  assert.equal(thread.writes(300), true);
  assert.equal(thread.writes(300), true);
  assert.equal(thread.writes(300), true);
});

test('a chunk that changed nothing is not chased', () => {
  const thread = turn();
  // Already against the bottom, give or take the rounding an anchor leaves.
  assert.equal(thread.writes(0), false);
  assert.equal(thread.writes(4), false);
});

test('a reader who takes the scroller away is left where they put it', () => {
  const thread = turn();
  thread.writes(300);

  // A hand on the glass, and then the position it left behind.
  thread.touches();
  thread.reads(1200);
  assert.equal(thread.following(), false);
  // The turn writes on underneath, and none of it moves the page.
  assert.equal(thread.writes(1500), false);
  assert.equal(thread.writes(1800), false);
});

test('arriving back at the bottom rejoins the turn', () => {
  const thread = turn();
  thread.touches();
  thread.reads(1200);
  assert.equal(thread.writes(1500), false);

  // By hand or by the button, the bottom is the bottom.
  thread.touches();
  thread.reads(0);
  assert.equal(thread.writes(300), true);
});

test('the browser moving the scroller on its own is not a reader leaving', () => {
  // A block above the reading position collapsing subtracts from scrollTop
  // exactly the way a hand does. Nothing the browser does of its own accord
  // arrives with a wheel attached, so an untouched scroller keeps following.
  const thread = turn();
  thread.writes(300);
  thread.reads(900);
  assert.equal(thread.following(), true);
  assert.equal(thread.writes(900), true);
});

test('a hand that has let go stops being a hand', () => {
  const thread = turn();
  thread.touches();

  // A wheel notch is animated out over a frame or ten, and the tail of that
  // is still the hand's: a scroller moving away from the bottom now is a
  // reader leaving, and the thread lets go of it.
  thread.reads(900);
  assert.equal(thread.writes(900), false);

  // Long after, it is not the hand's, and the same movement is the browser's
  // own. The thread is still the turn's to follow.
  const later = turn();
  later.touches();
  later.tick(600);
  later.reads(900);
  assert.equal(later.writes(900), true);
});

test('a thread parked at the bottom with nothing arriving is being read, not followed', () => {
  const thread = turn();
  assert.equal(thread.writes(300), true);
  assert.equal(thread.following(), true);

  // Which is what the disclosures ask: they hold the position still for a
  // reader, and must not do that to a turn that is chasing its own bottom.
  thread.tick(1500);
  assert.equal(thread.following(), false);
});
