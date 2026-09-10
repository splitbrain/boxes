import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { historyIndex } from '@/lib/history';

/**
 * Makes the back button close a modal surface instead of leaving the screen
 * it was opened over.
 *
 * On a phone, back is the dismiss gesture, and in an installed app on iOS it
 * is the only one, since there is no browser chrome and no Escape key. A
 * dialog that is nothing but component state is therefore invisible to the
 * one control the visitor reaches for: the press goes to the router, and the
 * screen underneath is torn down while the thing they wanted to dismiss was
 * the dialog.
 *
 * So opening pushes a marker: one history entry at the same URL. Nothing about
 * the page changes, which is the point — the entry exists to be popped. Back
 * pops it, this hook notices the index went down, and the overlay closes with
 * the screen behind it untouched. Closing from the inside — the X, the
 * backdrop, Escape, a saved comment — pops the marker too, so a spent entry
 * is never left behind for a later press to fall into.
 *
 * Only for surfaces that block what is behind them. A popover or a tooltip is
 * dismissed by a tap anywhere, and giving those a marker would race the tap
 * that dismisses them: Radix closes on the way down, the click lands on
 * whatever was underneath on the way up, and a pop arriving after a link's
 * push would undo the visitor's own navigation, so they are left alone.
 *
 * @param open Whether the surface is showing.
 * @param onClose Called when back is what closed it. It has to close the
 *   surface, because the marker is already gone by then.
 */
export function useHistoryOverlay(open: boolean, onClose: () => void): void {
  const navigate = useNavigate();
  const location = useLocation();

  /*
   * Everything this hook reads at the moment it acts is read from a ref.
   *
   * `navigate` is rebuilt on every location change, so an effect that
   * depended on it would re-run — and its cleanup would pop — on every
   * navigation in the app. The URL and the state are wanted as they are when
   * the surface opens, which is not necessarily the render that scheduled the
   * effect.
   */
  const nav = useRef(navigate);
  nav.current = navigate;
  const close = useRef(onClose);
  close.current = onClose;
  const url = useRef('');
  url.current = `${location.pathname}${location.search}${location.hash}`;
  const state = useRef<unknown>(null);
  state.current = location.state;

  /** The index of the entry opening pushed, while it is still ours to pop. */
  const marker = useRef<number | null>(null);
  /** And the URL it was pushed at; see stillOnMarker. */
  const markerUrl = useRef('');
  /** Set when back is what closed this, so closing does not pop twice. */
  const popped = useRef(false);
  /** A pop the unmount scheduled, which a remount cancels. */
  const pending = useRef<number | null>(null);

  /*
   * Before the paint that shows the surface, rather than after it: the entry
   * has to exist by the time the surface is on screen, or a press in the gap
   * would be spent leaving the screen underneath — the very thing being fixed
   * here. The gap is a frame wide and a human cannot hit it, but a test can,
   * and a slow frame is a slow frame.
   */
  useLayoutEffect(() => {
    /*
     * A remount cancels the pop its unmount scheduled. React unmounting and
     * mounting a component in place — StrictMode in development — is not a
     * departure, and popping for it would spend a real entry: the pop is
     * asynchronous, so it would land after this render had already pushed a
     * fresh marker and would read as a back press against it.
     */
    if (pending.current !== null) {
      clearTimeout(pending.current);
      pending.current = null;
    }
    if (!open || marker.current !== null) return;
    popped.current = false;
    // The same URL, and the state carried across: a view reads its own state
    // — which thread a review was opened from — and an entry that dropped it
    // would change the view's behaviour just by having had a dialog open.
    nav.current(url.current, {
      state: { ...(state.current as object | null), overlay: true },
      preventScrollReset: true,
    });
    marker.current = historyIndex();
    markerUrl.current = url.current;
  }, [open]);

  useEffect(() => {
    if (!open || marker.current === null) return;
    // On the marker still, or on something pushed over it: the surface is
    // where it was left.
    if (historyIndex() >= marker.current) return;
    // Below it, so the entry was popped. The URL did not change, so nothing
    // moved but this.
    marker.current = null;
    popped.current = true;
    close.current();
  }, [location.key, open]);

  useEffect(() => {
    if (open) return;
    const idx = marker.current;
    marker.current = null;
    if (idx === null) return;
    if (popped.current) {
      popped.current = false;
      return;
    }
    // Closed from the inside. Take the marker back out, if it is still there
    // to take.
    if (stillOnMarker(idx, markerUrl.current)) nav.current(-1);
  }, [open]);

  useEffect(
    () => () => {
      const idx = marker.current;
      if (idx === null || popped.current) return;
      // Unmounted while open, which is how a confirmation goes: the action
      // starts and the dialog is gone in the same commit. Deferred by a task
      // so a remount in place can call it off.
      const at = markerUrl.current;
      pending.current = window.setTimeout(() => {
        pending.current = null;
        marker.current = null;
        if (stillOnMarker(idx, at)) nav.current(-1);
      });
    },
    [],
  );
}

/**
 * Whether the entry the surface is sitting on is still the marker it pushed.
 *
 * The index alone is not enough, because a replace keeps it. A confirmation
 * that acts and leaves does exactly that — deleting a session replaces the
 * entry with the list while its dialog is still mounted — and popping then
 * would take the visitor back to the session they just deleted, which is the
 * kind of surprise this whole strategy is against. Both have to match: the
 * index says nothing was pushed over it, and the URL says nothing took its
 * place.
 */
function stillOnMarker(idx: number, at: string): boolean {
  const { pathname, search, hash } = window.location;
  return historyIndex() === idx && `${pathname}${search}${hash}` === at;
}

/**
 * The open state of a Radix root, wired to the back button.
 *
 * Radix roots take either an `open` prop or none at all, and both forms are in
 * use here — a ConfirmDialog is mounted already open, an attachment preview
 * manages itself. Driving the root from one place covers both, and putting it
 * in the primitives under components/ui means every dialog and sheet in the
 * app gets the behaviour without its own call site having to remember: the
 * next one added gets it too.
 */
export function useOverlayState({
  open,
  defaultOpen,
  onOpenChange,
}: {
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}): { open: boolean; setOpen: (next: boolean) => void } {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolled;

  const setOpen = useCallback(
    (next: boolean) => {
      setUncontrolled(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  useHistoryOverlay(
    isOpen,
    useCallback(() => setOpen(false), [setOpen]),
  );

  return { open: isOpen, setOpen };
}
