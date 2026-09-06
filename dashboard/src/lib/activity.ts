import type { BackgroundTask } from '../../../shared/types.ts';

/**
 * Words for the work a thread has left running, wherever it is shown.
 *
 * Boxes used to answer "is this thread busy" with a single bit — a prompt the
 * gateway forwarded is still open — and that bit stopped meaning what the
 * screen said it meant as soon as agents began leaving work behind them. A
 * turn that spawns a background subagent keeps its prompt open long after the
 * agent has finished talking; a task reporting in wakes the agent with no
 * prompt open at all. So the gateway sends three facts instead
 * (`TurnStateParams`), and what a reader is shown is built from all three:
 * `speaking` drives the spinner and the composer, and this is the vocabulary
 * for the third — the one that says a quiet thread is not a finished one.
 *
 * The states themselves are named in `tab-title.ts`, where a tab has to pick
 * exactly one of them.
 */

/** What one background task is called: what the agent called it, or its tool. */
export function taskName(task: BackgroundTask): string {
  return task.title?.trim() || task.tool || 'Background task';
}

/** "2 tasks running", for the places that have room for a phrase and no list. */
export function tasksRunning(count: number): string {
  return count === 1 ? '1 task running' : `${count} tasks running`;
}
