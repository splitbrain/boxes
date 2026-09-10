/**
 * A prompt one view stages for another to pick up, consumed once.
 *
 * The review's "Hand to agent" opens the thread with a line already in the
 * composer. It lives beside the router rather than in the history entry's
 * state, which the browser replays: back and then forward would otherwise
 * re-stage the prompt. Taking it clears it.
 *
 * Per session, because two tabs on two boxes are a thing this app supports.
 */
const staged = new Map<string, string>();

/** Leaves a prompt for the given session's thread to open with. */
export function stagePrompt(sessionId: string, prompt: string): void {
  staged.set(sessionId, prompt);
}

/** Takes it, if there is one. A second call gets nothing. */
export function takeStagedPrompt(sessionId: string): string | null {
  const prompt = staged.get(sessionId);
  staged.delete(sessionId);
  return prompt ?? null;
}
