/**
 * A prompt one view stages for another to pick up, consumed once.
 *
 * The review's "Hand to agent" opens the thread with a line already in the
 * composer. That used to travel in the history entry's state, which the
 * browser replays: pressing back and then forward re-staged the prompt, and a
 * turn nobody typed reappeared in the composer. History state describes an
 * entry, and this describes a handover — so it lives beside the router
 * instead of inside it, and taking it clears it.
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
