/**
 * What a browser tab is called, and the symbol that says what it wants.
 *
 * Boxes is a thing you leave running and come back to, usually with several
 * tabs open on several boxes. A row of tabs all called "Boxes" says nothing
 * about which one is mid-turn and which one has been sitting on a question
 * for ten minutes — which is exactly what you opened them to find out.
 *
 * The symbol goes first because the front of a title is the part a narrow tab
 * still shows, and it is the part that changes.
 */

/** What a tab is doing, in the order of how much it wants you. */
export type TabState = 'permission' | 'question' | 'running' | 'waiting' | 'idle';

/**
 * The symbol for each state.
 *
 * Plain BMP glyphs rather than emoji: every platform has these in a system
 * font, and a tab title is not the place to find out which ones a machine
 * renders as a hollow box.
 */
const SYMBOL: Record<TabState, string> = {
  permission: '⚠',
  question: '?',
  running: '⟳',
  // Between the two: nothing is being said, and the thread is not empty of
  // work either. A ring with something in it, next to the hollow one.
  waiting: '◍',
  idle: '○',
};

/** What each state means, for the places that spell it out. */
export const TAB_STATE_LABEL: Record<TabState, string> = {
  permission: 'waiting for a permission decision',
  question: 'waiting for an answer',
  running: 'running a turn',
  waiting: 'waiting for you, with work still running',
  idle: 'idle',
};

/**
 * The title of a thread's tab: its state, the box, and which of the box's
 * conversations it is.
 *
 * The box first and the thread second, the same order and the same names the
 * thread's own header uses — which box you are in matters more than which of
 * its conversations, and a title that disagreed with the header would be a
 * second vocabulary to learn.
 */
export function threadTitle(
  state: TabState,
  sessionName: string,
  threadLabel: string | null,
): string {
  const where = [sessionName, threadLabel].filter(Boolean).join(' · ');
  return `${SYMBOL[state]} ${where}`;
}
