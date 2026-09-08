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

/**
 * What a box with work still in it is called, wherever there is only room for
 * a phrase.
 *
 * No count, because the places that use it — a card in the session list — are
 * about the box rather than one conversation, and a box's total is not a
 * number anybody acts on. The thread that owns the work gets the list.
 */
export const STILL_RUNNING = 'still running';

/** "2 commands still running", where there is room for the count. */
export function commandsRunning(count: number): string {
  return count === 1 ? '1 command still running' : `${count} commands still running`;
}
