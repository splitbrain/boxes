
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
 * What a box with work still in it is called, wherever there is room to say
 * so.
 *
 * No count and no names: the orchestrator reads this from the processes alive
 * in the container, which carry the shell a command was wrapped in rather than
 * the words the agent chose for it. "Something is still running" is the whole
 * of what can honestly be said, and it is also the whole of what the question
 * — is this thread finished? — needs answering.
 */
export const STILL_RUNNING = 'still running';
