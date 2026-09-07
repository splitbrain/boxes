import { ArrowLeft, FilePlus2, Send } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import type { ReviewDiffHunk, ReviewRepo } from '../../../shared/types.ts';
import { Notice } from '@/components/Notice';
import { Shelf } from '@/components/Shelf';
import { BasePicker } from '@/components/review/BasePicker';
import { CodePane } from '@/components/review/CodePane';
import { CommentCard } from '@/components/review/CommentCard';
import { ComposerSheet, InlineComposer } from '@/components/review/CommentComposer';
import { HunkSheet } from '@/components/review/HunkSheet';
import { ReviewToolbar } from '@/components/review/ReviewToolbar';
import { ReviewTree } from '@/components/review/ReviewTree';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useScrollAway } from '@/hooks/use-scroll-away';
import { useViewportLock } from '@/hooks/use-viewport-lock';
import { cn } from '@/lib/utils';
import { useSessions } from '../stores/sessions.ts';
import {
  closeFile,
  compose,
  deleteComment,
  loadFile,
  loadTree,
  newReview,
  open as openReview,
  refreshOnReturn,
  saveComment,
  setBase,
  useReview,
} from '../stores/review.ts';

/**
 * The prompt "Hand to agent" stages in the thread's composer.
 *
 * One line, because that is the whole point: the review lives in the
 * workspace, so pointing the agent at it needs no export, no paste, and no
 * copy of the comments anywhere. And it is the same line however many
 * repositories the workspace holds, because there is exactly one REVIEW.md and
 * it is at the top of the workspace the agent works in.
 */
const HANDOFF_PROMPT = 'Read REVIEW.md and address the comments in it.';

/**
 * Reviewing a session's code, at `/sessions/:id/review`.
 *
 * The open file is in the search string, so a file is linkable and the
 * browser's own back button works — which on a phone is also one step of the
 * stack: sessions → thread → file list → file, out of each by the same back
 * button in the header and by no other control.
 *
 * The layout collapses the desktop tool's three panels into patterns that work
 * at both sizes rather than two parallel UIs: the tree is a column beside the
 * pane from `md` up and the screen before it below, and the same components
 * render in both. That is why the stack is a step shorter on a pointer — the
 * list and the file are one view there, so back leaves the review.
 *
 * The view owns the whole viewport the way the thread view does, because a code
 * pane in a reading column is not a code pane.
 */
export function SessionReview() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const path = params.get('path');

  const { tree, file, loadingTree, loadingFile, error, composing, saving } = useReview();
  const { sessions } = useSessions();
  const session = sessions.find((s) => s.id === id);

  /**
   * Long lines wrap unless the reader turns it off.
   *
   * A phone is narrower than most source files, so the alternative default is
   * a pane where the end of every long line is off screen and reading it means
   * scrolling the code sideways under a sticky gutter. Wrapping keeps a line
   * addressable — it is still one row, one number, one tap to comment — and
   * the toggle is there for the times the columns matter.
   */
  const [wrap, setWrap] = useState(true);
  const [hunk, setHunk] = useState<ReviewDiffHunk | null>(null);
  /** A line to scroll to once, set by the prev/next toolbar. */
  const [scrollTo, setScrollTo] = useState<number | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);
  /** The comment a tap on a bin is asking to remove, or null. */
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  /**
   * The conversation this review was opened from, so leaving it goes back
   * there rather than to whichever thread the session has current — after a
   * fork those are two different conversations, and the fork cannot act on
   * the comments while it is in plan mode.
   *
   * Read once: opening a file is a navigation of this same route, which keeps
   * the component mounted but carries no state of its own. A reload has none
   * either, and falls back to the session's current thread.
   */
  const [origin] = useState<string | null>(
    () => (location.state as { threadId?: string } | null)?.threadId ?? null,
  );
  const navigate = useNavigate();
  /**
   * Whether the tree and the pane are side by side, which decides what the
   * back button steps out to and which composer arrangement to mount.
   *
   * A media query in JavaScript rather than in CSS because both are decisions
   * about what to mount, not how to paint it: a Sheet renders into a portal a
   * `md:hidden` wrapper cannot reach, and two back buttons behind two
   * visibility classes would be two back buttons to anything not looking at
   * the screen.
   */
  const wide = useMediaQuery('(min-width: 768px)');

  // Point the store at this session and load it. The store is a singleton, so
  // re-entering the same session paints instantly from what is already there
  // and updates when the fetch lands.
  //
  // The mount is one of the three moments a review refetches; coming back to
  // the tab is the second, and closing a file back to the tree is the third.
  // There is no poll, so nothing costs anything while this sits open.
  useEffect(() => {
    openReview(id);
    void loadTree();
    return refreshOnReturn();
  }, [id]);

  // The URL is the source of truth for which file is open, so a back button, a
  // pasted link and a tree tap all go through the same path.
  useEffect(() => {
    if (path) void loadFile(path);
    else closeFile();
  }, [path]);

  const openPath = useCallback(
    (next: string) => {
      setParams((current) => {
        const params = new URLSearchParams(current);
        params.set('path', next);
        return params;
      });
      setScrollTo(null);
    },
    [setParams],
  );

  const back = useCallback(() => {
    setParams((current) => {
      const params = new URLSearchParams(current);
      params.delete('path');
      return params;
    });
    // File → tree does not remount, so without this nothing would refetch and
    // the tree would keep the statuses and counts it was painted with.
    void loadTree();
  }, [setParams]);

  /** Deletion markers by the line they sit after, for the pane. */
  const deletions = useMemo(
    () => new Map((file?.diff.deletions ?? []).map((d) => [d.afterLine, d.hunkIndex])),
    [file?.diff.deletions],
  );
  const annotations = useMemo(
    () => new Map((file?.annotations ?? []).map((a) => [a.line, a])),
    [file?.annotations],
  );
  /**
   * The hunk each line sits in, which is what a tap on the gutter opens.
   *
   * A hunk's range covers the context git printed around the change as well as
   * the change itself, so the lines either side of one answer "what happened
   * here" with the same hunk — a change is read with its surroundings, and on a
   * phone that is the difference between a target and a sliver. A hunk that
   * only removed lines covers nothing in the file that survived; its deletion
   * marker is the way in, and always was.
   */
  const hunkByLine = useMemo(() => {
    const map = new Map<number, number>();
    (file?.diff.hunks ?? []).forEach((hunk, index) => {
      for (let line = hunk.startLine; line <= hunk.endLine; line++) map.set(line, index);
    });
    return map;
  }, [file?.diff.hunks]);
  /**
   * The changed lines, in order, for counting and stepping through them.
   *
   * A deletion has no line of its own, and its marker sits under the line it
   * followed — so that line is where stepping stops and what the count
   * counts. Without it a file whose only change is a deletion reports none,
   * while the tree calls it modified and the gutter marks it.
   */
  const changedLines = useMemo(() => {
    const lines = new Set(Object.keys(file?.diff.lines ?? {}).map(Number));
    for (const deletion of file?.diff.deletions ?? []) {
      lines.add(Math.max(1, deletion.afterLine));
    }
    return [...lines].sort((a, b) => a - b);
  }, [file?.diff.lines, file?.diff.deletions]);
  const commentedLines = useMemo(
    () => (file?.annotations ?? []).map((a) => a.line).sort((a, b) => a - b),
    [file?.annotations],
  );

  /**
   * The card and the composer that sit under a line.
   *
   * The pane calls this for every rendered line, so it answers null for almost
   * all of them; what it returns is what makes comments inline on every screen
   * size rather than a sidebar that a phone has to fold away.
   */
  const underLine = useCallback(
    (line: number) => {
      if (!file) return null;
      const annotation = annotations.get(line);
      const open = composing === line;
      if (!annotation && !open) return null;
      return (
        <div className="flex flex-col gap-1.5">
          {annotation && !open ? (
            <CommentCard
              annotation={annotation}
              busy={saving}
              onEdit={() => compose(line)}
              // Asked about first: a comment is typed prose with no undo, and
              // the bin sits a thumb's width from the pencil.
              onDelete={() => setConfirmDelete(line)}
            />
          ) : null}
          {/* On touch the composer is a bottom sheet instead — the keyboard is
              coming up anyway, and a textarea in a scrolling code pane ends up
              behind it. */}
          {open && wide ? (
            <InlineComposer
              line={line}
              initial={annotation?.comment ?? ''}
              busy={saving}
              onSave={(comment) => void saveComment(file.path, line, comment)}
              onCancel={() => compose(null)}
            />
          ) : null}
        </div>
      );
    },
    [file, annotations, composing, saving, wide],
  );

  /** Steps to the next or previous entry of a sorted line list. */
  const step = (lines: number[], direction: -1 | 1): void => {
    if (lines.length === 0) return;
    const from = scrollTo ?? (direction === 1 ? 0 : Number.MAX_SAFE_INTEGER);
    const next =
      direction === 1
        ? (lines.find((line) => line > from) ?? lines[0]!)
        : ([...lines].reverse().find((line) => line < from) ?? lines.at(-1)!);
    setScrollTo(next);
  };

  const name = session?.name ?? id;
  const thread = origin ?? session?.currentThreadId;

  // The code pane is the scroller here, the same way the thread is in a
  // thread: the document must not acquire one of its own.
  useViewportLock();

  // And the same header behaviour as the thread's, called the same way:
  // reading down a file puts the chrome away, a flick back up returns it.
  const { away, container } = useScrollAway('[data-slot="review-code-pane"]');

  // No state symbol: a review is a thing you are doing, not a thing waiting
  // on you. What it needs to say is which box, and which file of it.
  useDocumentTitle(
    [file ? shortPath(file.path) : null, 'Review', name].filter(Boolean).join(' · '),
  );

  return (
    <div ref={container} className="flex h-dvh flex-col">
      <Shelf away={away}>
        <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          {/* One back button, one step out, wherever it is pressed.
              On a phone the stack is sessions → thread → file list → file, so
              a file's parent is the list and the list's parent is the thread.
              From md up the list and the file are one view side by side, so
              there is nothing between the review and the thread. */}
          {file && !wide ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 px-2"
              onClick={back}
              aria-label="Back to the file list"
            >
              <ArrowLeft className="size-4" />
            </Button>
          ) : (
            <Button asChild variant="ghost" size="sm" className="shrink-0 px-2">
              <Link
                to={thread ? `/sessions/${id}/threads/${thread}` : `/sessions/${id}`}
                aria-label="Back to the thread"
              >
                <ArrowLeft className="size-4" />
              </Link>
            </Button>
          )}

          <div className="flex min-w-16 flex-1 flex-col">
            <span className="truncate text-sm font-medium">
              {file ? shortPath(file.path) : 'Review'}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {name}
              {/* Which repository the open file belongs to, rather than a root
                  the review no longer has. A file no repository claims says
                  so, since that is why it has no statuses and no markers. */}
              {file ? ` · ${whichRepo(file.repo, tree?.repos ?? [])}` : ''}
              {tree && !tree.hasGit ? ' · no git' : ''}
              {/* Which base is active belongs in the status line, the way the
                  desktop tool's does: it changes what every colour in the tree
                  and every marker in the gutter means. One expression resolves
                  separately in each repository, so where it landed is part of
                  what it means. */}
              {tree?.base.rev
                ? ` · vs ${tree.base.rev}${resolvedIn(tree.repos)}`
                : tree?.hasGit
                  ? ' · vs working tree'
                  : ''}
            </span>
          </div>

          {/* Only where there is a repository to compare in. */}
          {tree?.hasGit ? (
            <BasePicker
              base={tree.base}
              repos={tree.repos}
              busy={saving}
              onSet={(rev) => void setBase(rev)}
            />
          ) : null}

          {/* The reason this feature belongs inside Boxes at all: the review is
              a file of the project the agent is working on, so handing it over is
              one line of prompt rather than an export. Staged in the composer,
              not sent — the reviewer decides when to ask. */}
          {tree && Object.keys(tree.counts).length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() =>
                void navigate(thread ? `/sessions/${id}/threads/${thread}` : `/sessions/${id}`, {
                  state: { prefill: HANDOFF_PROMPT },
                })
              }
              title="Open the thread with a prompt to address these comments"
            >
              <Send className="size-3.5" />
              <span className="hidden sm:inline">Hand to agent</span>
            </Button>
          ) : null}

          {tree?.hasReview ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              disabled={saving}
              onClick={() => setConfirmNew(true)}
              aria-label="Start a new review"
              title="Start a new review, discarding these comments"
            >
              <FilePlus2 />
            </Button>
          ) : null}
        </header>
      </Shelf>

      {error ? <Notice className="shrink-0 border-b px-3 py-2">{error}</Notice> : null}

      <div className="flex min-h-0 flex-1">
        {/* One tree in the document, two arrangements.
            From md up it is the left column, whatever is open. Below md it is
            the whole screen until a file is picked and gone once one is —
            one step of the stack, which the header's back button returns to.
            Rendering it twice and hiding one would put two of every row in
            the page. */}
        <aside
          className={cn(
            'shrink-0 overflow-auto md:block md:w-72 md:border-r lg:w-80',
            file ? 'hidden' : 'w-full',
          )}
        >
          {tree ? (
            <ReviewTree tree={tree} activePath={file?.path ?? null} onOpen={openPath} />
          ) : (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              {loadingTree ? 'Loading…' : 'Nothing to show.'}
            </p>
          )}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {file ? (
            <>
              <ReviewToolbar
                changeCount={changedLines.length}
                commentCount={commentedLines.length}
                wrap={wrap}
                onWrap={() => setWrap((w) => !w)}
                onStepChange={(direction) => step(changedLines, direction)}
                onStepComment={(direction) => step(commentedLines, direction)}
              />
              {file.deleted ? (
                <Empty>This file was deleted, so there is nothing left to read.</Empty>
              ) : file.binary ? (
                <Empty>This file is binary, so there is nothing to show.</Empty>
              ) : (
                <>
                  {file.truncated ? (
                    <Notice tone="warn" className="shrink-0 border-b px-3 py-1.5 text-xs">
                      This file is larger than the display limit. Only the first part is shown.
                    </Notice>
                  ) : null}
                  <CodePane
                    path={file.path}
                    content={file.content}
                    tokens={file.tokens}
                    diffLines={file.diff.lines}
                    deletions={deletions}
                    hunkByLine={hunkByLine}
                    annotations={annotations}
                    composing={composing}
                    wrap={wrap}
                    scrollTo={scrollTo}
                    onSelectLine={(line) => compose(composing === line ? null : line)}
                    onShowHunk={(index) => setHunk(file.diff.hunks[index] ?? null)}
                    renderUnderLine={underLine}
                  />
                </>
              )}
            </>
          ) : (
            // Below md the tree above has the screen, so this belongs to the
            // pointer arrangement only.
            <div className="hidden min-h-0 flex-1 md:flex">
              <Empty>
                {loadingFile ? 'Loading…' : 'Pick a file from the tree to start reading.'}
              </Empty>
            </div>
          )}
        </main>
      </div>

      <HunkSheet hunk={hunk} onClose={() => setHunk(null)} />

      {/* Below md, writing a comment happens here rather than inline. */}
      <ComposerSheet
        line={!wide && file ? composing : null}
        initial={composing === null ? '' : (annotations.get(composing)?.comment ?? '')}
        busy={saving}
        onSave={(comment) => {
          if (file && composing !== null) void saveComment(file.path, composing, comment);
        }}
        onCancel={() => compose(null)}
      />

      {confirmDelete !== null && file ? (
        <ConfirmDialog
          title={`Delete the comment on line ${confirmDelete}?`}
          description="It is removed from REVIEW.md. The code itself is untouched."
          confirmLabel="Delete"
          danger
          busy={saving}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const line = confirmDelete;
            setConfirmDelete(null);
            void deleteComment(file.path, line);
          }}
        />
      ) : null}

      {confirmNew ? (
        <ConfirmDialog
          title="Start a new review?"
          description="REVIEW.md is deleted, so every comment in this review goes with it. The code itself is untouched."
          confirmLabel="Delete the review"
          danger
          busy={saving}
          onCancel={() => setConfirmNew(false)}
          onConfirm={() => {
            setConfirmNew(false);
            void newReview();
          }}
        />
      ) : null}
    </div>
  );
}

/** The centred message a pane with nothing in it shows. */
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * What to call the repository an open file belongs to.
 *
 * A file outside every repository is not a failure — it is the workspace's own
 * loose files, or a directory nobody cloned — but it is worth saying, because
 * it explains a pane with no gutter markers in it.
 */
function whichRepo(repo: string | null, repos: ReviewRepo[]): string {
  if (repo === null) return 'no repository';
  return repos.find((r) => r.path === repo)?.name ?? repo;
}

/** " (2 of 3)" when a base landed in some repositories but not all of them. */
function resolvedIn(repos: ReviewRepo[]): string {
  if (repos.length <= 1) return '';
  const landed = repos.filter((repo) => repo.baseCommit !== '').length;
  return landed === repos.length ? '' : ` (${landed} of ${repos.length})`;
}

/**
 * A path shortened from the left, so the filename — the part that identifies
 * it — survives a narrow header.
 */
function shortPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join('/')}`;
}
