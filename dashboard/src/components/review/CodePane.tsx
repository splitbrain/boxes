import { Fragment, useEffect, useLayoutEffect, useRef } from 'react';
import type { ReviewAnnotation, ReviewLineChange } from '../../../../shared/types.ts';
import type { Token } from '@/lib/highlight';
import { cn } from '@/lib/utils';
import { recallScroll, rememberScroll } from '../../stores/review.ts';

/**
 * The file, one addressable row per line.
 *
 * A CSS grid rather than a `<pre>`: the line-number gutter is sticky against
 * the pane's horizontal scroll, the code cell scrolls as one block so the
 * numbers stay put, and every line is its own element — which is what makes
 * tapping one to comment possible at all.
 *
 * Tap replaces hover throughout, and the row is split between the two things
 * a reader does to a line. The gutter is the change: tapping it opens the hunk
 * around that line, which is where the desktop tool's hover tooltip went and
 * the only place deleted lines exist. The code is the comment: tapping it
 * opens the composer, and comments are inline cards under their line on every
 * screen size.
 *
 * That way round because the code cell is the larger target by far and
 * commenting is the frequent act, while a gutter with no hunk behind it —
 * every line of a file git does not track yet — is not a target at all.
 *
 * File content and comments are agent-influenced and hostile by assumption, so
 * both are rendered as text nodes only. Highlight tokens become React
 * elements; nothing here goes near `dangerouslySetInnerHTML`.
 */

/** What a changed line gets in its gutter and behind its code. */
const CHANGE: Record<ReviewLineChange, { bar: string; row: string; label: string }> = {
  added: { bar: 'bg-ok', row: 'bg-ok/8', label: 'added' },
  modified: { bar: 'bg-warn', row: 'bg-warn/8', label: 'modified' },
};

export interface CodePaneProps {
  /**
   * The open file's path, which is what the remembered scroll position is
   * keyed by — and which file this is, when one replaces another in the same
   * pane.
   */
  path: string;
  content: string;
  /** One token list per line, or null to render the file plain. */
  tokens: Token[][] | null;
  /** Changed lines, keyed by line number as the API sends them. */
  diffLines: Record<string, ReviewLineChange>;
  /** Deletion markers, by the line they sit after. */
  deletions: Map<number, number>;
  /**
   * The hunk each line sits in, by line number, for the gutter to open.
   * Context lines count: standing next to a change and asking what happened
   * here has one answer.
   */
  hunkByLine: Map<number, number>;
  annotations: Map<number, ReviewAnnotation>;
  /** The line whose composer is open, or null. */
  composing: number | null;
  /** Wrap long lines instead of scrolling them. */
  wrap: boolean;
  /** A line to scroll to once, when prev/next or a link asks for it. */
  scrollTo: number | null;
  onSelectLine: (line: number) => void;
  onShowHunk: (hunkIndex: number) => void;
  /** Renders the card and composer that sit under a line. */
  renderUnderLine?: (line: number) => React.ReactNode;
}

export function CodePane({
  path,
  content,
  tokens,
  diffLines,
  deletions,
  hunkByLine,
  annotations,
  composing,
  wrap,
  scrollTo,
  onSelectLine,
  onShowHunk,
  renderUnderLine,
}: CodePaneProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** The path this pane has already positioned, so a poll does not re-do it. */
  const positioned = useRef<string | null>(null);

  /**
   * Puts each file back where it was left, and every file this review has not
   * opened at the top.
   *
   * One pane serves every file, so the scroll offset survives the swap unless
   * something says otherwise — which is how a 40-line file used to open half
   * way down because the last one was long. Before paint, so the reader never
   * sees the wrong position; keyed on the path, so the poll refetching the
   * open file does not throw away where they had got to.
   */
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || positioned.current === path) return;
    positioned.current = path;
    element.scrollTop = recallScroll(path);
  }, [path, content]);

  /** Records where the reader is, for the next time they open this file. */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = (): void => rememberScroll(path, element.scrollTop);
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [path]);

  const lines = splitLines(content);
  // The gutter's width follows the file's size rather than being fixed, so a
  // 30-line file does not reserve room for five digits.
  const digits = Math.max(String(lines.length).length, 2);

  return (
    <div
      ref={scrollRef}
      data-slot="review-code-pane"
      className={cn(
        'min-h-0 flex-1 overflow-auto font-mono text-[13px] leading-[1.55]',
        // The pane scrolls, not the page: the header and the toolbar stay put.
        wrap ? 'overflow-x-hidden' : 'overflow-x-auto',
      )}
    >
      <div className="min-w-full">
        {deletions.has(0) ? (
          <DeletionMarker hunkIndex={deletions.get(0)!} digits={digits} onShowHunk={onShowHunk} />
        ) : null}

        {lines.map((text, index) => {
          const line = index + 1;
          const change = diffLines[String(line)];
          const annotation = annotations.get(line);
          const under = renderUnderLine?.(line);
          const hunkIndex = hunkByLine.get(line);

          return (
            <Fragment key={line}>
              <div
                data-line={line}
                ref={line === scrollTo ? scrollIntoView : undefined}
                className={cn(
                  'group grid grid-cols-[auto_1fr] items-start',
                  change && CHANGE[change].row,
                  (composing === line || annotation) && 'bg-primary/8',
                )}
              >
                <Gutter
                  line={line}
                  digits={digits}
                  change={change}
                  annotated={annotation !== undefined}
                  outdated={annotation?.outdated ?? false}
                  active={composing === line || annotation !== undefined}
                  hunkIndex={hunkIndex}
                  onShowHunk={onShowHunk}
                />

                {/* Tapping the code is how a comment starts.
                    Not a <button>: WebKit and Firefox make text inside one
                    unselectable, and a line of a review is a line somebody
                    copies out. So a tap and the end of a drag share this
                    element and are told apart below.
                    And no aria-label: a button names itself from what is
                    inside it, so labelling this one would replace the line of
                    code with the word "comment" for anybody listening to the
                    file rather than looking at it. The name is the line. */}
                <code
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    if (!selecting(event)) onSelectLine(line);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelectLine(line);
                    }
                  }}
                  className={cn(
                    'block pr-3 pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                    wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
                  )}
                >
                  {tokens?.[index] ? <Tokens tokens={tokens[index]!} /> : text}
                  {/* A zero-width space keeps an empty line the height of a
                      full one, so the gutter and the code never drift apart. */}
                  {text === '' ? '​' : null}
                </code>
              </div>

              {deletions.has(line) ? (
                <DeletionMarker
                  hunkIndex={deletions.get(line)!}
                  digits={digits}
                  onShowHunk={onShowHunk}
                />
              ) : null}

              {under ? (
                <div className="grid grid-cols-[auto_1fr]">
                  <span aria-hidden style={{ minWidth: `${digits + 3.5}ch` }} />
                  <div className="min-w-0 px-2 py-1.5">{under}</div>
                </div>
              ) : null}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One line's numbers and markers, and the way into its hunk.
 *
 * A button only where there is a hunk to open: a file git does not track yet
 * has every line marked added and no hunk anywhere, and a gutter that lights
 * up under the thumb and then does nothing is worse than one that does not.
 */
function Gutter({
  line,
  digits,
  change,
  annotated,
  outdated,
  active,
  hunkIndex,
  onShowHunk,
}: {
  line: number;
  digits: number;
  change: ReviewLineChange | undefined;
  annotated: boolean;
  outdated: boolean;
  /** The line is being commented on, or already carries a comment. */
  active: boolean;
  /** The hunk this line sits in, or undefined when it sits in none. */
  hunkIndex: number | undefined;
  onShowHunk: (hunkIndex: number) => void;
}) {
  const className = cn(
    'sticky left-0 z-10 flex select-none items-stretch gap-1 border-r bg-background pr-1.5 pl-2 text-right text-muted-foreground',
    // 44px of tap target on touch. The line height is smaller than that, so
    // the padding does the work.
    'min-h-[1.55em] py-0',
    hunkIndex !== undefined && 'hover:bg-accent hover:text-accent-foreground',
    change && CHANGE[change].row,
    active && 'bg-primary/8',
  );
  const style = { minWidth: `${digits + 3.5}ch` };
  const inside = (
    <>
      <span
        aria-hidden
        className={cn('w-1 shrink-0 rounded-sm', change ? CHANGE[change].bar : '')}
      />
      <span className="flex-1 tabular-nums">{line}</span>
      {annotated ? (
        <span
          aria-hidden
          className={cn('w-1 shrink-0 rounded-sm', outdated ? 'bg-idle' : 'bg-primary')}
        />
      ) : (
        <span aria-hidden className="w-1 shrink-0" />
      )}
    </>
  );

  if (hunkIndex === undefined) {
    return (
      <span className={className} style={style}>
        {inside}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onShowHunk(hunkIndex)}
      aria-label={`Show the change at line ${line}`}
      title="Show the change here"
      className={className}
      style={style}
    >
      {inside}
    </button>
  );
}

/**
 * Whether a click was the end of selecting text rather than a tap on the line.
 *
 * A drag leaves a selection behind, and a double click is the browser taking a
 * word — neither is somebody asking for the comment box, and opening it would
 * take the focus off what they were selecting.
 */
function selecting(event: React.MouseEvent): boolean {
  if (event.detail > 1) return true;
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed;
}

/** One line's coloured spans. */
function Tokens({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, i) => (
        // Both themes travel as custom properties on the span, and globals.css
        // picks which one paints. Switching theme needs no re-tokenize.
        <span key={i} style={token.style as React.CSSProperties}>
          {token.content}
        </span>
      ))}
    </>
  );
}

/**
 * A block of lines removed between two that survived.
 *
 * Tapping it opens the hunk, which is the only place the removed lines exist:
 * the marker deliberately does not say how many there were, because the number
 * without the content is not information anybody acts on.
 */
function DeletionMarker({
  hunkIndex,
  digits,
  onShowHunk,
}: {
  hunkIndex: number;
  digits: number;
  onShowHunk: (hunkIndex: number) => void;
}) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-center">
      <button
        type="button"
        onClick={() => onShowHunk(hunkIndex)}
        aria-label="Show the lines deleted here"
        className="sticky left-0 z-10 flex min-h-6 items-center justify-end gap-1 border-r bg-background pr-1.5 pl-2 text-danger hover:bg-accent"
        style={{ minWidth: `${digits + 3.5}ch` }}
      >
        <span aria-hidden className="text-xs">
          ⋯
        </span>
      </button>
      <button
        type="button"
        onClick={() => onShowHunk(hunkIndex)}
        className="flex min-h-6 items-center px-2 text-left text-xs text-danger hover:underline"
      >
        lines deleted here — tap to see them
      </button>
    </div>
  );
}

/** Splits content into the lines the pane renders. */
function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Brings a line into view when it is first rendered.
 *
 * A ref callback rather than an effect, because the element does not exist
 * until the row it belongs to renders, and the row that needs scrolling to may
 * be the one that just appeared.
 */
function scrollIntoView(element: HTMLDivElement | null): void {
  element?.scrollIntoView({ block: 'center' });
}
