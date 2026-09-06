import assert from 'node:assert/strict';
import { test } from 'vitest';
import { scrollAway, scrollAwayStart, type ScrollAwayState } from './scroll-away.ts';

/**
 * The header giving way to reading, and coming back when asked.
 *
 * A scroller and a clock, both stepped by hand. The browser was asked these
 * questions once, by wheeling a real Chromium and reading the answer off the
 * screen, and it answered differently depending on how busy the machine was:
 * a wheel notch is animated out over however many frames the box can spare,
 * and the assertions were about where it had got to. Nothing here has a
 * wall clock in it.
 */

/** A frame, which is what one scroll event is worth. */
const FRAME = 16;

/** A scroller of a given content and viewport, driven a frame at a time. */
function reading(content: number, view = 900): {
  by: (dy: number, frames?: number) => void;
  to: (top: number) => void;
  grows: (by: number, slack?: number) => void;
  tick: (ms: number) => void;
  away: () => boolean;
  top: () => number;
} {
  let state: ScrollAwayState = scrollAwayStart();
  let height = content;
  let top = 0;
  let now = 0;

  /** One scroll event, from wherever the position has been put. */
  const event = (): void => {
    top = Math.max(0, Math.min(top, height - view));
    now += FRAME;
    state = scrollAway(state, { top, behind: height - view - top, now });
  };

  return {
    /** A hand on the glass: `dy` a frame, for as many frames as it lasts. */
    by: (dy, frames = 1) => {
      for (let i = 0; i < frames; i += 1) {
        top += dy;
        event();
      }
    },
    /** One enormous step, which is how the views scroll themselves. */
    to: (next) => {
      top = next;
      event();
    },
    /**
     * Content arriving under a scroller already against its bottom.
     *
     * A few pixels short of the end rather than exactly on it, because that is
     * where a turn's anchor leaves the position: `slack` is the rounding
     * `AT_BOTTOM` exists to forgive.
     */
    grows: (by, slack = 4) => {
      height += by;
      top = height - view - slack;
      event();
    },
    /** Time passing with nothing moving. */
    tick: (ms) => {
      now += ms;
    },
    away: () => state.away,
    top: () => top,
  };
}

test('the header is there to begin with, and a view too short to scroll never loses it', () => {
  const page = reading(600, 900);
  assert.equal(page.away(), false);
  page.by(40, 4);
  assert.equal(page.away(), false);
});

test('reading down puts the header away, and a flick back up returns it', () => {
  const page = reading(8000);
  page.by(100, 8);
  assert.equal(page.away(), true);

  // Not from the top, which is the whole point: the header used to be
  // recoverable only from the very top of the thread.
  page.by(-100, 2);
  assert.equal(page.away(), false);
  assert.ok(page.top() > 100);
});

test('the header comes back on its own near the top, however it got there', () => {
  const page = reading(8000);
  page.by(100, 8);
  assert.equal(page.away(), true);

  // Near it, not at it: the top of a view is chrome rather than content, and
  // the band is wide enough that landing just inside it still counts.
  page.to(20);
  assert.equal(page.away(), false);
  assert.ok(page.top() > 0);

  page.to(0);
  assert.equal(page.away(), false);
});

test('a run has to be a run: jitter on the glass toggles nothing', () => {
  const page = reading(8000);
  page.by(100, 8);
  assert.equal(page.away(), true);

  // A finger resting on a moving surface, going nowhere. Neither direction
  // adds up to the run either threshold asks for.
  for (let i = 0; i < 12; i += 1) page.by(i % 2 ? 6 : -6);
  assert.equal(page.away(), true);
});

test('the view scrolling itself is not reading', () => {
  // Restoring where a file was left, or centring a hunk: one enormous step,
  // and the header has to sit through it. Below md the only way back to the
  // file tree is the button inside it.
  const page = reading(20_000);
  page.to(4000);
  assert.equal(page.away(), false);

  // And the same going the other way, out of a header that had given way.
  page.by(100, 8);
  assert.equal(page.away(), true);
  page.to(12_000);
  assert.equal(page.away(), true);
});

test('a turn writing its own output moves nothing', () => {
  // The thread is against its bottom and the content is growing behind it,
  // which arrives here as a downward step per chunk. None of it is a reader
  // deciding anything, and the header stayed put for the whole of a turn.
  const page = reading(2000);
  for (let i = 0; i < 40; i += 1) page.grows(120);
  assert.equal(page.away(), false);

  // And a reader who then walks away from the bottom is reading again.
  page.by(-100, 3);
  page.by(100, 8);
  assert.equal(page.away(), true);
});

test('the nudge a collapsing row leaves behind is not a request', () => {
  // Putting the header away grows the scroller by its height, and Chrome
  // holds anchored content still by nudging scrollTop up a few pixels. That
  // nudge is an upward run, which is the signal to come back — which would
  // grow the scroller again, and the row would flap for a living.
  const page = reading(8000);
  page.by(100, 8);
  assert.equal(page.away(), true);

  for (let i = 0; i < 6; i += 1) page.by(-8);
  assert.equal(page.away(), true);
});

test('a real flick inside the settling window is still a flick', () => {
  // Swallowing everything for the length of the transition would strand the
  // header until the next scroll event, which is the bug this replaced.
  const page = reading(8000);
  page.by(100, 8);
  assert.equal(page.away(), true);
  page.by(-100, 2);
  assert.equal(page.away(), false);
});

test('and once the window has passed, small steps are read again', () => {
  const page = reading(8000);
  page.by(100, 8);
  assert.equal(page.away(), true);

  page.tick(400);
  for (let i = 0; i < 6; i += 1) page.by(-8);
  assert.equal(page.away(), false);
});
