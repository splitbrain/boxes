import { readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { topLevel } from './git.ts';
import { IGNORED_DIRS } from './tree.ts';

/**
 * Which repositories a workspace holds, and which of them owns a path.
 *
 * A session's workspace is not one repository. The agent clones what it was
 * pointed at, forks and clones a second thing to compare against, checks a
 * dependency out beside it, and sometimes ends up with a repository inside a
 * repository. So the review is over the workspace and a repository is an
 * attribute of a path rather than the unit of the thing being reviewed:
 * every file is browsable in one tree, and each is shown with the status and
 * diff of the *closest enclosing* repository.
 *
 * That whole mechanism is {@link RepoMap.repoFor}, a longest-prefix lookup:
 *
 *     repoFor('repo-a/src/x.ts')    -> repo-a
 *     repoFor('repo-a/inner/b.txt') -> repo-a/inner   (nested wins)
 *     repoFor('notes/todo.md')      -> null           (no repository)
 *
 * A nested repository needs no special case, being a longer prefix that
 * wins, and a file no repository claims is shown without git.
 */

/** One repository found in a workspace. */
export interface Repo {
  /**
   * Where it sits relative to the workspace, slash-separated. Empty when the
   * workspace is itself the repository.
   */
  path: string;
  /** Its absolute path on this process's filesystem. */
  absolute: string;
  /** What to call it: its last path segment, or the workspace's own name. */
  name: string;
}

/**
 * How deep under the workspace a repository is looked for.
 *
 * `/workspace/projects/foo` is a shape that occurs; anything much deeper is a
 * dependency tree rather than something a reviewer cloned.
 */
export const MAX_REPO_DEPTH = 6;

/**
 * How many directories one discovery walk may read before it gives up looking.
 *
 * An agent that ran `npm install` has a workspace with tens of thousands of
 * directories in it. The ignore list prunes most of that, and this is what
 * bounds the rest — a walk is one bounded cost per tree fetch, not an
 * unbounded one.
 */
export const MAX_SCANNED_DIRS = 4000;

/** How many repositories a workspace may contribute before the rest are left out. */
export const MAX_REPOS = 32;

/**
 * The repositories of one workspace, with the lookup that assigns a path to
 * one of them.
 *
 * Immutable, and cheap to hold: a handful of paths. It is rediscovered by a
 * tree fetch and reused by everything else, so a fetch is the clock.
 */
export class RepoMap {
  /**
   * Sorted by path, which is also the order the API reports them in — so a
   * truncated or re-read map lists the same repositories in the same places.
   */
  readonly repos: readonly Repo[];

  constructor(
    /** The workspace every path in this map is relative to. */
    readonly workspace: string,
    repos: Repo[],
  ) {
    this.repos = [...repos].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Whether the workspace holds any repository at all. */
  get hasGit(): boolean {
    return this.repos.length > 0;
  }

  /**
   * The closest repository enclosing a workspace-relative path, or null when
   * no repository claims it.
   *
   * Longest prefix wins, which is what makes a repository inside a repository
   * work without a case of its own.
   */
  repoFor(path: string): Repo | null {
    let best: Repo | null = null;
    for (const repo of this.repos) {
      if (!encloses(repo.path, path)) continue;
      if (best === null || repo.path.length > best.path.length) best = repo;
    }
    return best;
  }

  /** The repository rooted exactly at this workspace-relative path, or null. */
  at(path: string): Repo | null {
    return this.repos.find((repo) => repo.path === path) ?? null;
  }
}

/** Whether a repository at `prefix` encloses a workspace-relative path. */
function encloses(prefix: string, path: string): boolean {
  if (prefix === '') return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** A path inside a repository, as the workspace names it. */
export function inWorkspace(repo: Repo, path: string): string {
  return repo.path === '' ? path : `${repo.path}/${path}`;
}

/**
 * A workspace-relative path as its own repository names it.
 *
 * The caller has already established that the repository encloses the path —
 * `repoFor` is how — so this is a slice rather than a check.
 */
export function inRepo(repo: Repo, path: string): string {
  return repo.path === '' ? path : path.slice(repo.path.length + 1);
}

/**
 * Finds every repository in a workspace.
 *
 * The walk prunes `IGNORED_DIRS` and never follows a symlink, and is bounded
 * by {@link MAX_REPO_DEPTH} and {@link MAX_SCANNED_DIRS}. Pruning the ignore
 * list is deliberate: an agent's dependency tree can hold dozens of
 * repositories nobody wants listed, and `npm install` is a normal thing for an
 * agent to do. The cost is that a repository deliberately cloned into
 * `vendor/` is not discovered, which is the right trade at this size.
 *
 * A directory holding a `.git` entry — file *or* directory, so submodules and
 * linked worktrees count — is a candidate, and every candidate is confirmed by
 * asking git for its top level. The comparison is realpath to realpath:
 * `rev-parse --show-toplevel` resolves symlinks, so comparing its answer
 * against a raw path fails for any workspace whose path has a symlinked
 * component, and silently loses git for every session in that deployment.
 */
export async function discoverRepos(workspace: string): Promise<RepoMap> {
  const candidates = candidateDirs(workspace);
  const confirmed = await Promise.all(
    candidates.map(async (candidate) => ((await isWorkTree(candidate.absolute)) ? candidate : null)),
  );
  return new RepoMap(workspace, confirmed.filter((repo) => repo !== null).slice(0, MAX_REPOS));
}

/**
 * The directories under a workspace that hold a `.git`, breadth first.
 *
 * Breadth first so that when a cap bites it is the deepest directories that go
 * unread: a repository the reviewer cloned sits near the top, and a dependency
 * tree is what fills the bottom.
 */
function candidateDirs(workspace: string): Repo[] {
  const found: Repo[] = [];
  let scanned = 0;
  let queue: Array<{ absolute: string; path: string }> = [{ absolute: workspace, path: '' }];

  for (let depth = 0; depth <= MAX_REPO_DEPTH && queue.length > 0; depth++) {
    const next: typeof queue = [];
    for (const dir of queue) {
      if (scanned >= MAX_SCANNED_DIRS || found.length >= MAX_REPOS) return found;
      scanned++;

      let entries;
      try {
        entries = readdirSync(dir.absolute, { withFileTypes: true });
      } catch {
        continue; // unreadable directory: skipped, not fatal
      }

      for (const entry of entries) {
        // A `.git` file is a linked worktree or a submodule, and both are
        // repositories the reviewer can be looking at.
        if (entry.name === '.git' && (entry.isDirectory() || entry.isFile())) {
          found.push({
            absolute: dir.absolute,
            path: dir.path,
            name: dir.path === '' ? workspaceName(workspace) : (dir.path.split('/').pop() ?? ''),
          });
        }
        // `isDirectory` is false for a link to one, so a link is never
        // descended into: the tree is agent-controlled and a link to `/`
        // would otherwise be walked.
        if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
        next.push({
          absolute: join(dir.absolute, entry.name),
          path: dir.path === '' ? entry.name : `${dir.path}/${entry.name}`,
        });
      }
    }
    queue = next;
  }

  return found;
}

/**
 * Whether a directory really is the top of a git work tree.
 *
 * Both sides are resolved before they are compared, because git's answer
 * always is: a repository reached through a symlinked parent has a top level
 * that is not the path it was asked about, and it is the same directory.
 */
async function isWorkTree(dir: string): Promise<boolean> {
  const top = await topLevel(dir);
  if (top === null) return false;
  try {
    return realpathSync(top) === realpathSync(dir);
  } catch {
    return false;
  }
}

/** What to call a repository that is the workspace itself. */
function workspaceName(workspace: string): string {
  return workspace.split('/').filter((part) => part !== '').pop() ?? 'workspace';
}
