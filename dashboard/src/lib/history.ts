/**
 * Where in the browser's history stack this document is sitting.
 *
 * React Router keeps a running index in each entry's own state — see
 * `getHistoryState` in its history module — and it is the only thing a page
 * can learn about entries it is not currently on. Two behaviours are built on
 * it, and both are about not pushing where a pop belongs:
 *
 * - a back control that pops the entries its view pushed rather than pushing
 *   another one on top of them (see useUp), and
 * - an overlay that can tell whether the entry it opened over is still the one
 *   on top, which is what makes it safe to take that entry back out (see
 *   useHistoryOverlay).
 *
 * Zero when there is nothing to read: a tab opened straight onto this
 * document has no entry of the app's beneath it, which is exactly the case
 * where back has nowhere of ours to go and something else has to happen.
 */
export function historyIndex(): number {
  const idx = (window.history.state as { idx?: number | null } | null)?.idx;
  return typeof idx === 'number' ? idx : 0;
}
