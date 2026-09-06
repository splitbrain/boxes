import { useEffect, useRef } from 'react';
import {
  followGrew,
  followScrolled,
  followStart,
  followTouched,
  isFollowing,
  type FollowState,
} from '@/lib/follow-output.ts';

/**
 * What each scroller is doing with its own output.
 *
 * A map rather than an attribute on the scroller: the runtime watches the
 * viewport's subtree for mutations and reads every non-style attribute change
 * as content arriving, so a flag written on the element would itself be a
 * reason to scroll.
 */
const state = new WeakMap<Element, FollowState>();

/** The nearest thing that scrolls, which for a thread is its viewport. */
function scrollerOf(node: Element | null): Element | null {
  for (let el = node; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === 'scroll' || overflowY === 'auto') return el;
  }
  return null;
}

/**
 * Whether the scroller `node` sits inside is following its own output right
 * now — at the bottom of it, and lately moved to stay there.
 *
 * For the disclosures in a message, which hold the viewport still while they
 * animate and must not do that to a thread that is chasing its own bottom.
 * See `use-disclosure-lock.ts`. A node in a view that never called
 * `useFollowOutput` — the playground, which streams nothing — is not
 * following anything, and the answer is no.
 */
export function isFollowingOutput(node: Element | null): boolean {
  const scroller = scrollerOf(node);
  const current = scroller && state.get(scroller);
  return !!current && isFollowing(current, performance.now());
}

/**
 * Asks whether the turn's anchor still has room to give, of the scroller.
 *
 * A turn anchors the message that started it to the top of the viewport, and
 * pays for the empty space under a short answer with a reserve element the
 * runtime shrinks as the answer grows. While that reserve has height the
 * position is the anchor's business and the viewport is already against its
 * bottom; when it reaches nothing, the answer has outgrown the screen and the
 * anchor stops moving.
 *
 * Read from the DOM because the reserve is a DOM detail: a renamed attribute
 * costs the smooth scroll that opens a turn — this hook would take the
 * viewport to the same place at once instead — and nothing else. Kept for as
 * long as it stays in the document, because the question is asked on every
 * chunk of a turn and a thread is a large thing to search.
 */
function reserveOf(el: Element): () => boolean {
  let reserve: HTMLElement | null = null;

  return () => {
    if (!reserve?.isConnected) {
      reserve = el.querySelector<HTMLElement>('[data-aui-top-anchor-reserve]');
    }
    return !!reserve && reserve.offsetHeight > 0;
  };
}

/**
 * Keeps a thread against the bottom of its own output, and says so.
 *
 * The runtime follows the bottom for everything except the one case it hands
 * to the turn anchor: while a turn runs, the position belongs to the anchor
 * holding the prompt at the top of the viewport, and the anchor only holds —
 * it never follows. That works for as long as the reserve under the answer
 * lasts, which is one screenful. Past that, every tool call and every line of
 * reasoning the turn goes on to write lands below the fold and stays there
 * until the turn ends, which is the whole of a long one.
 *
 * So the reserve running out is the handover: from there to the end of the
 * turn this hook keeps the viewport at the bottom. A reader who takes the
 * scroller away from it is left where they put it, and arriving back at the
 * bottom — by hand or by the button — rejoins the turn.
 *
 * @returns The ref to put on the scroller.
 */
export function useFollowOutput(): React.RefObject<HTMLDivElement | null> {
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;

    state.set(el, followStart());

    /** How much of the thread is below the fold. */
    const behind = (): number => el.scrollHeight - el.clientHeight - el.scrollTop;
    const reserving = reserveOf(el);
    const now = (): number => performance.now();

    const touched = (event: Event): void => {
      // A press lands on something for every reason there is — a disclosure,
      // the composer, a link — and only a press on the scroller itself is a
      // hand on its scrollbar.
      if (event.type === 'pointerdown' && event.target !== el) return;
      state.set(el, followTouched(state.get(el) ?? followStart(), now()));
    };

    const onScroll = (): void => {
      const current = state.get(el);
      if (!current) return;
      state.set(el, followScrolled(current, { behind: behind(), now: now() }));
    };

    const onGrow = (): void => {
      const current = state.get(el);
      if (!current) return;
      const grew = followGrew(current, { behind: behind(), reserving: reserving(), now: now() });
      state.set(el, grew.state);
      if (grew.catchUp) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
    };

    el.addEventListener('scroll', onScroll);
    /**
     * The three ways a hand scrolls this, and no more than those.
     *
     * A key is not one of them, however much it looks like input: the
     * composer sits inside the viewport, so every letter typed into it — and
     * the Return that starts the turn — arrives here as well.
     */
    const gestures = ['wheel', 'touchmove', 'pointerdown'] as const;
    for (const kind of gestures) el.addEventListener(kind, touched, { passive: true });

    /**
     * The scroller and what it holds, both measured.
     *
     * The scroller itself for a viewport that changes size — a keyboard
     * opening under the composer, a rotation. What it holds because content
     * arriving is not the only thing that grows a thread: a disclosure
     * opening or closing animates its height for a fifth of a second without
     * touching the DOM again, and a run of tool calls and reasoning is one of
     * those every few hundred milliseconds. Watching for mutations alone
     * leaves the bottom drifting out of view for the length of every
     * animation, and catching up only when the next chunk lands.
     */
    const size = new ResizeObserver(onGrow);
    size.observe(el);
    const measured = new WeakSet<Element>();
    const measure = (): void => {
      for (const child of el.children) {
        if (measured.has(child)) continue;
        measured.add(child);
        size.observe(child);
      }
    };
    measure();

    const content = new MutationObserver(() => {
      measure();
      onGrow();
    });
    content.observe(el, { childList: true, subtree: true, characterData: true });

    return () => {
      el.removeEventListener('scroll', onScroll);
      for (const kind of gestures) el.removeEventListener(kind, touched);
      size.disconnect();
      content.disconnect();
      state.delete(el);
    };
  }, []);

  return viewport;
}
