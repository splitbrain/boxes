import { useCallback, useRef, type MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import { historyIndex } from '@/lib/history';

/** What a back control needs; see useUp. */
export interface Up {
  /**
   * The parent, so the control can be a real link: middle click opens it in a
   * tab, the context menu can copy it, and a keyboard gets it for free.
   */
  href: string;
  /** Swallows the ordinary click and steps out instead. */
  onClick: (event: MouseEvent<HTMLElement>) => void;
  /** The same step for something that is not a link — a Cancel, a handoff. */
  go: () => void;
  /**
   * The stack index the view was entered at.
   *
   * For a view with a step inside itself — the review, whose open file is one
   * on a phone — this is how it tells whether there is an entry of its own to
   * pop or whether it is sitting on the entry it arrived at.
   */
  entry: number;
}

/**
 * Leaving a view, by popping the entries it pushed rather than pushing one
 * more.
 *
 * This is the rule the whole strategy rests on: a control labelled back or up
 * never pushes. Every one of them used to be a plain link, so sessions →
 * thread → back left the stack as sessions, thread, sessions — and the
 * device's own back button then went *into* the thread again. Two controls
 * pointing the same way is what made the button feel unpredictable, and no
 * amount of remembering where the visitor came from fixes it.
 *
 * What gets popped is everything this view put on the stack, in one step: the
 * file the review opened, the thread a fork moved to, the markers its dialogs
 * left behind. Leaving is one press, and nothing of the view is left for a
 * later back press to fall into.
 *
 * Where there is nothing of ours to pop — a pasted link, a push
 * notification, a shortcut on a home screen, all of which start the stack at
 * this view — the parent replaces the current entry instead. Back then leads
 * out of the app the way it did before, which is what the browser's own
 * button is for; up leads to the parent, which is what this control is for.
 * That is the one case where a press after this one can land back inside the
 * view, since the entries it pushed are below the entry being replaced.
 *
 * Call it in the view that owns the route, not in a component nested inside
 * one: the entry it pops back to is the one that was on top when the hook
 * first ran, so it has to run when the view is entered.
 *
 * @param parent Where the view sits under, for the link and for the fallback.
 */
export function useUp(parent: string): Up {
  const navigate = useNavigate();
  /**
   * The stack index this view was entered at.
   *
   * A ref filled on the first render rather than state: it never changes, and
   * nothing should re-render because of it. Re-entering the view by a back
   * press remounts and fills it again, with the index that entry now has.
   */
  const entry = useRef<number | null>(null);
  entry.current ??= historyIndex();

  const go = useCallback(() => {
    const from = entry.current ?? historyIndex();
    // Every entry this view added, plus the entry the view itself is.
    const delta = historyIndex() - from + 1;
    if (from > 0 && delta > 0) navigate(-delta);
    // Nothing of the app's below, so there is nothing to pop back to: the
    // parent takes this entry's place rather than being pushed on top of it,
    // which is the difference between the browser's back button leading out
    // of the app and it leading in circles. What the view pushed inside
    // itself stays underneath — the browser's history is the browser's, and
    // a synthesized parent is the best an entry point can do.
    else void navigate(parent, { replace: true });
  }, [navigate, parent]);

  const onClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      // A modified click is the visitor asking the browser for something else
      // — a tab, a window, a download — and that is what href is there for.
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      go();
    },
    [go],
  );

  return { href: parent, onClick, go, entry: entry.current };
}
