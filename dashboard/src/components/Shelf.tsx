import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * A row that can be put away, taking its height with it.
 *
 * Collapsed rather than slid out over the content: what is above the thread
 * has to be gone to be worth anything on a phone, and a header floating over
 * the first message would cover the message rather than yield the forty-five
 * pixels. The thread below is `flex-1`, so the space is handed
 * straight to the conversation.
 *
 * The height is measured rather than named. A header with a two-line title,
 * a mode switcher and a model switcher is not a number this file can know,
 * and `height: auto` is not a value CSS will animate from — so a resize
 * observer keeps the real one, and the transition runs between that and zero.
 * Until the first measurement there is no inline height at all, which is what
 * makes the first paint the natural one.
 */
export function Shelf({
  away,
  className,
  children,
}: {
  /** True to put it away. */
  away: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const el = content.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') {
      setHeight(el.offsetHeight);
      return;
    }
    // Fires once on observe, so the height is known from the first frame.
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      data-slot="shelf"
      // Whether it is away, for a test that has to ask: a row put away by a
      // parent collapsing around it keeps a box of its own, so measuring the
      // header says nothing.
      data-away={away ? '' : undefined}
      className={cn(
        'shrink-0 overflow-hidden transition-[height] duration-200 ease-out motion-reduce:transition-none',
        className,
      )}
      style={height === null ? undefined : { height: away ? 0 : height }}
      // Nothing in a row that is not on screen should be reachable by tab or
      // readable by a screen reader. `inert` is both, and it also drops focus
      // out of a select that was open when the row went away.
      inert={away}
    >
      <div ref={content}>{children}</div>
    </div>
  );
}
