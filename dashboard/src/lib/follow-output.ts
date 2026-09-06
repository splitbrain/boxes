/**
 * Whether a scroller is following its own output, decided from its positions
 * and the hands on it.
 *
 * Kept apart from the hook for the same reason as `scroll-away.ts`: this is
 * the whole of the behaviour, and asking a real browser about it meant asking
 * how fast the machine was. `use-follow-output.ts` is the wiring.
 */

/**
 * How near the bottom counts as against it.
 *
 * The same distance `scroll-away.ts` calls pinned, for the same reason: a
 * scroller a few pixels short of its end is at its end as far as a reader is
 * concerned, and a turn's anchor leaves exactly that much rounding behind.
 */
export const AT_BOTTOM = 8;

/**
 * How long after a hand touches the scroller its scrolling is still that
 * hand's.
 *
 * A wheel notch is not a scroll: it starts one, which the browser animates out
 * over a frame or ten, and a flick is several of those. Long enough to cover
 * the tail of one, short enough that the next thing to move the scroller by
 * itself is not blamed on a reader who has let go.
 */
export const REACH = 400;

/**
 * How recently a scroller has to have moved with its output to still count as
 * following it.
 *
 * A thread parked at the bottom with nothing arriving is not following
 * anything; it is being read. The difference matters to the disclosures,
 * which hold the position still for a reader and must not for a turn.
 */
export const ACTIVE = 1000;

export interface FollowState {
  /** Whether the scroller is keeping itself against the bottom. */
  following: boolean;
  /** When a hand was last on the scroller. */
  gesture: number;
  /** When it last moved to stay with its output. */
  followed: number;
}

/**
 * A thread that has just mounted follows, and has been touched by nobody.
 *
 * Never rather than zero for both clocks: `performance.now()` is the page's
 * own age, so a thread mounted inside the first four hundred milliseconds of
 * one would read a zero here as a hand still on the scroller, and stop
 * following its output before it had written any.
 */
export function followStart(): FollowState {
  return { following: true, gesture: -Infinity, followed: -Infinity };
}

/** A hand arriving on the scroller: a wheel, a finger, a thumb on the bar. */
export function followTouched(state: FollowState, now: number): FollowState {
  return { ...state, gesture: now };
}

/**
 * The state after one scroll event.
 *
 * A hand is asked about instead of being read off the position, because the
 * position cannot answer it. A reader going up a hundred pixels and the
 * browser holding the page still while a block above them collapses by a
 * hundred both subtract a hundred from `scrollTop`, and a turn writing into
 * the same frame moves the numbers again underneath both. Nothing the browser
 * does to a scroller of its own accord arrives with a wheel or a finger
 * attached, so that is the question worth asking.
 */
export function followScrolled(
  state: FollowState,
  { behind, now }: { behind: number; now: number },
): FollowState {
  // At the bottom is following, however it got there — a reader arriving back
  // at it is rejoining the turn.
  if (behind <= AT_BOTTOM) return { ...state, following: true };
  if (now - state.gesture < REACH) return { ...state, following: false };
  return state;
}

/**
 * The state after the thread grew, and whether to catch up with it.
 *
 * @param reserving Whether the turn's anchor still has room to give. While the
 *   reserve under an unwritten answer has height the position is the anchor's
 *   business; when it reaches nothing, the answer has outgrown the screen and
 *   the anchor stops moving. That handover is the whole reason this exists.
 */
export function followGrew(
  state: FollowState,
  { behind, reserving, now }: { behind: number; reserving: boolean; now: number },
): { state: FollowState; catchUp: boolean } {
  // Nothing to catch up with, or somebody else's turn to: the runtime's own
  // autoscroll while no turn is running, the anchor while one is.
  if (!state.following || behind <= AT_BOTTOM || reserving) return { state, catchUp: false };
  return { state: { ...state, followed: now }, catchUp: true };
}

/**
 * Whether the scroller is following its own output right now — at the bottom
 * of it, and lately moved to stay there.
 *
 * For the disclosures in a message, which hold the viewport still while they
 * animate and must not do that to a thread that is chasing its own bottom.
 */
export function isFollowing(state: FollowState, now: number): boolean {
  return state.following && now - state.followed < ACTIVE;
}
