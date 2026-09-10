import type { ThreadSummary } from '../../../shared/types.ts';

/**
 * What a thread is called.
 *
 * The agent generates a title at the end of a turn. Until it has, the thread
 * goes by the first line of the last prompt sent on it, which is there from
 * the moment it is sent — so a long first turn is not spent nameless. A
 * thread nobody has prompted has neither, and goes by its ordinal, which is
 * per session and never reused.
 */
export function threadName(thread: ThreadSummary): string {
  return thread.title?.trim() || `Thread ${thread.ordinal}`;
}
