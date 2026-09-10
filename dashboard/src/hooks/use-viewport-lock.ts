import { useEffect } from 'react';

/**
 * How many mounted views are holding the lock.
 *
 * Counted rather than set and cleared, because a route change mounts the next
 * view before it unmounts the last one — and because StrictMode mounts every
 * effect twice in development. Either one would otherwise leave the document
 * unlocked while a locked view is on screen.
 */
let held = 0;

/**
 * Keeps the document itself from scrolling while a full-viewport view is on
 * screen.
 *
 * A thread is `h-dvh` with its own scroller inside it, so the page is meant to
 * have no scroll of its own at all. On a phone it acquires one anyway: the
 * dynamic viewport is measured against browser chrome that comes and goes, and
 * every mismatch — the URL bar expanding on an upward flick, the keyboard
 * opening under a focused composer, plain rounding on iOS — leaves the document
 * a few dozen pixels taller than what is visible. The browser then scrolls
 * those pixels away to keep the focused thing in view, and what goes off the
 * top is the header.
 *
 * That offset belongs to a scroller no gesture reaches, because every touch
 * lands in the thread's scroller instead, so the header stays gone until the
 * thread is back at its top and an overscroll reaches the document. With
 * nothing to scroll there is nothing to strand.
 *
 * Scoped to the views that own the viewport. The reading column — the session
 * list, the forms — scrolls the document on purpose, and the browser hiding its
 * chrome for those is the behaviour to leave alone.
 */
export function useViewportLock(): void {
  useEffect(() => {
    held += 1;
    document.documentElement.classList.add('viewport-locked');

    /*
     * A page already scrolled when the lock goes on stays scrolled: locking
     * removes the overflow, not the offset. Same on the way back from a
     * keyboard on iOS, which scrolls the document before the class can stop it
     * and has been seen to leave the offset behind afterwards.
     */
    const top = (): void => {
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    top();
    // Every moment the visible area changes size is a moment the browser may
    // have scrolled to compensate. visualViewport is where that is observable;
    // resize is the fallback for a browser without it.
    window.visualViewport?.addEventListener('resize', top);
    window.addEventListener('resize', top);

    return () => {
      window.visualViewport?.removeEventListener('resize', top);
      window.removeEventListener('resize', top);
      held -= 1;
      if (held === 0) document.documentElement.classList.remove('viewport-locked');
    };
  }, []);
}
