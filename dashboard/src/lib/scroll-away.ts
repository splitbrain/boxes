/**
 * Whether a header should stand aside, decided from a scroller's positions
 * alone.
 *
 * Kept apart from the hook that listens for them because this is the whole of
 * the behaviour and none of it needs a browser: a run of samples in, a
 * decision out. `use-scroll-away.ts` is the wiring, and `scroll-away.test.ts`
 * is where the thresholds below are actually held to.
 */

/** How near the top the header is simply always there. */
export const AT_TOP = 48;
/**
 * How near the bottom counts as pinned to it.
 *
 * A view that follows its own output sits exactly here for as long as the
 * output lasts: a thread streaming a reply, or writing the result of a `!bang`
 * command, keeps the scroller against its bottom and grows the content behind
 * it. Every one of those steps looks like reading down, and none of it is.
 *
 * Asking the scroller rather than the app is what makes that reliable. The
 * thread's own `isRunning` clears while the last chunks are still landing —
 * measured, not guessed — so a header that trusted it moved on its own right
 * at the end of every turn.
 */
export const AT_BOTTOM = 8;
/** How far a downward run has to go before it gives way. */
export const HIDE_AFTER = 32;
/**
 * And how far back up before it returns.
 *
 * The smaller of the two: going is a decision about the reading you are doing,
 * coming back is a request, and a request should not have to be repeated. Not
 * *much* smaller, though — a scroller settling after a smooth scroll drifts by
 * a dozen pixels in either direction, and a header that answered those would
 * flicker for a living. Any flick worth the name clears two dozen.
 */
export const SHOW_AFTER = 24;
/**
 * A single step longer than this is a jump rather than reading.
 *
 * Both views scroll themselves sometimes — a review restoring the position a
 * file was left at, or putting a hunk in the middle of the pane; a thread
 * anchoring a new turn's message to the top. None of that is a reader's
 * decision about chrome, and all of it arrives as one enormous step, where a
 * hand on the glass arrives as a frame's worth at a time. Three hundred pixels
 * in a frame is faster than a fling and slower than any jump worth making.
 */
export const JUMP = 320;
/**
 * How long a decision takes to settle, and small steps go unread for.
 *
 * Collapsing the row grows the scroller by its height, and Chrome answers a
 * container growing under anchored content by nudging `scrollTop` a few pixels
 * to hold that content still. Those pixels arrive as an upward run — which is
 * the signal to come back, which grows the scroller again. The row would sit
 * there flapping, and the reason would be itself.
 *
 * Only steps small enough to be that nudge are disregarded, and only for as
 * long as the transition runs. A real flick inside the window is still a
 * flick: swallowing it wholesale would strand the header until the next scroll
 * event, and a flick that changed nothing is exactly what this was supposed to
 * stop being.
 */
export const SETTLE_MS = 300;
/** The most a settling scroller nudges itself by in one step. */
export const NUDGE = 24;

/** One scroll event, as much of it as the decision uses. */
export interface ScrollAwaySample {
  /** Where the scroller is now. */
  top: number;
  /** How much of the content is still below the fold. */
  behind: number;
  /** The clock, in the units `performance.now()` speaks. */
  now: number;
}

export interface ScrollAwayState {
  /** True while the header should be out of the way. */
  away: boolean;
  /** Where the scroller was at the last event. */
  last: number;
  /** Where the current run began: the last time direction changed. */
  anchor: number;
  descending: boolean;
  /** Until when a step small enough to be the collapse settling is ignored. */
  settledUntil: number;
}

/** A header in reach, and a scroller nobody has touched yet. */
export function scrollAwayStart(): ScrollAwayState {
  return { away: false, last: 0, anchor: 0, descending: false, settledUntil: 0 };
}

/**
 * The state after one scroll event.
 *
 * The rule is a run rather than a position: the header goes once you have
 * scrolled thirty-odd pixels further down without changing your mind, and
 * comes back on the first hint of going the other way. Runs are measured from
 * the last turn rather than from the last event, so the pixel of jitter a
 * finger leaves on the glass cannot toggle anything, and a slow drift down
 * still adds up to a decision.
 */
export function scrollAway(state: ScrollAwayState, sample: ScrollAwaySample): ScrollAwayState {
  const { top, behind, now } = sample;
  const step = top - state.last;
  if (step === 0) return state;

  const moved = { ...state, last: top };

  /** Deciding is idempotent, and a decision that changed nothing settles nothing. */
  const decide = (next: boolean, over: Partial<ScrollAwayState> = {}): ScrollAwayState =>
    next === state.away
      ? { ...moved, ...over }
      : { ...moved, ...over, away: next, settledUntil: now + SETTLE_MS };

  // The top is chrome rather than content, and a view too short to scroll
  // never leaves it. Nothing hides here.
  if (top <= AT_TOP) return decide(false, { anchor: top, descending: false });

  // Against the bottom: whatever moved the scroller, it was the content
  // arriving rather than a reader leaving. Follow the position so the next run
  // is measured from where reading actually resumes, and decide nothing. This
  // is also what keeps the collapse from flapping down here: a taller viewport
  // clamps the scroll position, and the clamp arrives as an upward step that
  // would otherwise read as a request to come back.
  if (behind <= AT_BOTTOM) return { ...moved, anchor: top };

  // A jump — restoring where a file was left, anchoring a new turn's message
  // to the top — is not reading either. Nor is a step small enough to be the
  // collapse settling.
  const jumped = Math.abs(step) > JUMP;
  const nudged = Math.abs(step) < NUDGE && now < state.settledUntil;
  if (jumped || nudged) return { ...moved, anchor: top };

  const down = step > 0;
  const turned = down !== state.descending;
  const anchor = turned ? top - step : state.anchor;
  const run = top - anchor;
  const crossed = down ? run > HIDE_AFTER : -run > SHOW_AFTER;

  return crossed
    ? decide(down, { anchor, descending: down })
    : { ...moved, anchor, descending: down };
}
