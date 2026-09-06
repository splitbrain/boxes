import { ChevronDown, ChevronRight, File, GitBranch, MessageSquare } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  ReviewFileStatus,
  ReviewTreeEntry,
  ReviewTreeResponse,
} from '../../../../shared/types.ts';
import { Notice } from '@/components/Notice';
import { cn } from '@/lib/utils';

/**
 * The workspace's files, with git status and comment counts on them.
 *
 * One tree over the whole workspace, not over one repository in it: paths are
 * workspace-relative, and the directory a repository is rooted at is marked,
 * so the boundaries are visible while scrolling across them. Which repository
 * a file belongs to is what decides its status letter and its gutter markers,
 * and there is nothing to switch between.
 *
 * One component for both arrangements: a collapsible left column from `md` up
 * and a Sheet below it. The desktop tool's three panels do not survive a
 * phone, but the tree does — what changes is where it is mounted, not what it
 * renders.
 */

/** What a status colours its row, and the single letter that names it. */
const STATUS: Record<ReviewFileStatus, { className: string; mark: string; label: string }> = {
  modified: { className: 'text-warn', mark: 'M', label: 'modified' },
  staged: { className: 'text-primary', mark: 'S', label: 'staged' },
  untracked: { className: 'text-ok', mark: '?', label: 'untracked' },
  added: { className: 'text-ok', mark: 'A', label: 'added' },
  deleted: { className: 'text-danger', mark: 'D', label: 'deleted' },
  conflict: { className: 'text-danger', mark: '!', label: 'conflict' },
};

/** The paths of the directories that should start open. */
function initialOpen(entries: ReviewTreeEntry[]): Set<string> {
  const open = new Set<string>();
  /**
   * Follows the chain of single-child directories from the top. A `src/main/
   * java/com/…` prefix is noise, not structure, and opening it saves four
   * taps on a phone.
   */
  const walk = (level: ReviewTreeEntry[]): void => {
    if (level.length !== 1) return;
    const only = level[0]!;
    if (!only.isDir) return;
    open.add(only.path);
    walk(only.children ?? []);
  };
  walk(entries);
  return open;
}

export function ReviewTree({
  tree,
  activePath,
  onOpen,
}: {
  tree: ReviewTreeResponse;
  /** The file the pane is showing, so the tree can mark it. */
  activePath: string | null;
  onOpen: (path: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => initialOpen(tree.entries));
  /**
   * The directories that hold a commented file, so a collapsed branch still
   * says there is something in it.
   */
  const commentedDirs = useMemo(() => parentDirs(Object.keys(tree.counts)), [tree.counts]);
  /** The same for the files git reports as changed. */
  const changedDirs = useMemo(() => parentDirs(Object.keys(tree.statuses)), [tree.statuses]);

  const toggle = (path: string): void => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (tree.entries.length === 0) {
    return (
      <p className="px-3 py-4 text-sm text-muted-foreground">
        This workspace is empty. Once the agent has cloned or written something, it shows up
        here.
      </p>
    );
  }

  return (
    <div className="flex flex-col py-1">
      {tree.truncated ? (
        <Notice tone="warn" className="mx-2 mb-1 rounded-md border px-2 py-1 text-xs">
          This tree is very large and was cut short. Files past the cap are not listed.
        </Notice>
      ) : null}
      <Level
        entries={tree.entries}
        depth={0}
        open={open}
        toggle={toggle}
        statuses={tree.statuses}
        counts={tree.counts}
        commentedDirs={commentedDirs}
        changedDirs={changedDirs}
        activePath={activePath}
        onOpen={onOpen}
      />
    </div>
  );
}

/** One level of the tree, and every open level below it. */
function Level({
  entries,
  depth,
  open,
  toggle,
  statuses,
  counts,
  commentedDirs,
  changedDirs,
  activePath,
  onOpen,
}: {
  entries: ReviewTreeEntry[];
  depth: number;
  open: Set<string>;
  toggle: (path: string) => void;
  statuses: Record<string, ReviewFileStatus>;
  counts: Record<string, number>;
  commentedDirs: Set<string>;
  changedDirs: Set<string>;
  activePath: string | null;
  onOpen: (path: string) => void;
}) {
  return (
    <ul className="list-none">
      {entries.map((entry) => {
        const isOpen = open.has(entry.path);
        const status = statuses[entry.path];
        const count = counts[entry.path] ?? 0;

        return (
          <li key={entry.path}>
            <button
              type="button"
              onClick={() => (entry.isDir ? toggle(entry.path) : onOpen(entry.path))}
              aria-expanded={entry.isDir ? isOpen : undefined}
              aria-current={entry.path === activePath ? 'true' : undefined}
              // 44px of tap target on touch, less on a pointer where rows can
              // be dense without being unusable.
              className={cn(
                'flex w-full items-center gap-1.5 rounded-md px-2 text-left text-sm',
                'min-h-11 md:min-h-8',
                'hover:bg-accent hover:text-accent-foreground',
                entry.path === activePath && 'bg-accent font-medium',
              )}
              style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
            >
              {entry.isDir ? (
                isOpen ? (
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                )
              ) : (
                <File className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  status && STATUS[status].className,
                  // A repository root reads as a heading rather than a folder:
                  // it is where one project's statuses and diffs stop meaning
                  // anything and the next one's start.
                  entry.repo && 'font-medium',
                )}
                title={entry.path}
              >
                {entry.name}
              </span>
              {entry.repo ? (
                <GitBranch
                  className="size-3 shrink-0 text-muted-foreground"
                  aria-label="a git repository"
                />
              ) : null}
              {status ? (
                <span
                  aria-label={STATUS[status].label}
                  title={STATUS[status].label}
                  className={cn('shrink-0 font-mono text-xs', STATUS[status].className)}
                >
                  {STATUS[status].mark}
                </span>
              ) : entry.isDir && !isOpen && changedDirs.has(entry.path) ? (
                // Collapsed, with changed files inside: the letters belong to
                // the files, but a branch that hides one has to say so.
                <span
                  aria-label="contains changes"
                  title="contains changes"
                  className="size-1.5 shrink-0 rounded-full bg-warn"
                />
              ) : null}
              {count > 0 ? (
                <span
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-primary/15 px-1.5 text-xs text-primary"
                  aria-label={count === 1 ? '1 comment' : `${count} comments`}
                >
                  <MessageSquare className="size-3" />
                  {count}
                </span>
              ) : entry.isDir && !isOpen && commentedDirs.has(entry.path) ? (
                // A collapsed branch still says there is something in it,
                // which is what makes the tree usable as a to-do list.
                <MessageSquare
                  className="size-3 shrink-0 text-primary"
                  aria-label="contains comments"
                />
              ) : null}
            </button>

            {entry.isDir && isOpen ? (
              <Level
                entries={entry.children ?? []}
                depth={depth + 1}
                open={open}
                toggle={toggle}
                statuses={statuses}
                counts={counts}
                commentedDirs={commentedDirs}
                changedDirs={changedDirs}
                activePath={activePath}
                onOpen={onOpen}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Every directory on the way to one of these paths. */
function parentDirs(paths: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return dirs;
}
