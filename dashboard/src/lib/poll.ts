/**
 * Runs `tick` every `everyMs` for as long as the tab is visible, and returns
 * the teardown.
 *
 * Nothing here is polled because it changed — the orchestrator has no way to
 * say so over HTTP — so everything that watches a box does it on a timer, and
 * a timer that keeps firing in a background tab is a request every few seconds
 * for an answer nobody is looking at. Coming back ticks immediately, so the
 * pause costs nothing a reader can see.
 *
 * The first tick is the caller's: a view usually has to load something before
 * it can poll for changes to it, and doing that here would race with it.
 */
export function pollWhileVisible(tick: () => void, everyMs: number): () => void {
  let timer: number | null = null;

  const schedule = (): void => {
    if (timer === null) timer = window.setInterval(tick, everyMs);
  };
  const pause = (): void => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  };
  const onVisibility = (): void => {
    if (document.hidden) {
      pause();
      return;
    }
    tick();
    schedule();
  };

  if (!document.hidden) schedule();
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    pause();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/**
 * Runs `tick` every time the tab becomes visible again, and returns the
 * teardown. No interval: nothing fires while the tab is open and still.
 *
 * This is the poll's plumbing without the poll. A view whose every fetch reads
 * the source of truth on the spot only needs to be fresh *on arrival*, and on
 * a phone arrival is mostly this: switching away to something else and coming
 * back. The idle cost is then zero rather than a request every few seconds for
 * an answer that has not moved.
 *
 * The first tick is the caller's, the same way it is above: a view loads on
 * mount, and doing that here would race with it.
 */
export function refetchOnVisible(tick: () => void): () => void {
  const onVisibility = (): void => {
    if (!document.hidden) tick();
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => document.removeEventListener('visibilitychange', onVisibility);
}
