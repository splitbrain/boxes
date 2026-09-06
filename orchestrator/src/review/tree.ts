import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gitOut } from './git.ts';
import { inWorkspace, type RepoMap } from './repos.ts';

/**
 * The file tree a review browses.
 *
 * A port of the desktop tool's `internal/filetree`, with one addition the
 * desktop tool does not need: an entry cap, because a Boxes workspace can hold
 * an agent's `node_modules` at a depth no ignore list anticipated, and a phone
 * on a slow link is the client.
 *
 * `buildTree` is pure and takes a flat path list. `walkPaths` is the one
 * function here that touches the filesystem, and it walks only the space no
 * repository claims.
 *
 * The tree is over the *workspace*, not over a repository in it, so it is
 * merged from as many sources as the workspace has repositories, plus one walk
 * of what is left over. See `repos.ts` for why.
 */

/** The annotation file, written at the workspace root. Not part of the review. */
export const REVIEW_FILE = 'REVIEW.md';

/**
 * Directory names never included in the tree, whether it comes from git or
 * from a walk. Version-control metadata is here because its contents are not
 * source code anybody reviews.
 */
export const IGNORED_DIRS = new Set([
  // Boxes' own scratch inside a workspace: the files the user attached to a
  // prompt. They are input to the conversation, not source anybody reviews.
  '.boxes',
  'vendor',
  'node_modules',
  'dist',
  'build',
  '.git',
  '.svn',
  '.hg',
]);

/** File extensions left out of the tree, lowercased and with the dot. */
const IGNORED_EXTS = new Set([
  '.exe',
  '.bin',
  '.so',
  '.dylib',
  '.png',
  '.jpg',
  '.gif',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
]);

/**
 * How many entries a tree may hold before it is cut short.
 *
 * A truncated tree is still usable — the paths that made it in are browsable,
 * and the response says it was cut — where an unbounded one on a workspace the
 * agent filled would be a response no phone can render and no link can carry.
 */
export const MAX_ENTRIES = 20_000;

/** One file or directory in the tree. */
export interface TreeEntry {
  name: string;
  /** Path relative to the workspace, slash-separated. */
  path: string;
  isDir: boolean;
  /** Absent for files, which are the bulk of a tree. */
  children?: TreeEntry[];
  /**
   * True on the directory a repository is rooted at, so the boundaries are
   * visible while scrolling across them. Absent everywhere else.
   */
  repo?: boolean;
}

/** A built tree, and whether the entry cap cut it short. */
export interface Tree {
  entries: TreeEntry[];
  truncated: boolean;
}

/** Whether a path is one the tree leaves out. */
function ignored(path: string): boolean {
  const parts = path.split('/');
  const name = parts[parts.length - 1] ?? '';
  const dot = name.lastIndexOf('.');
  if (dot > 0 && IGNORED_EXTS.has(name.slice(dot).toLowerCase())) return true;
  return parts.slice(0, -1).some((dir) => IGNORED_DIRS.has(dir));
}

/** A node while a tree is being assembled. */
interface Node {
  entry: TreeEntry;
  children: Map<string, Node>;
}

/** Builds a tree from a flat list of file paths, relative and slash-separated. */
export function buildTree(paths: string[]): TreeEntry[] {
  const root: Node = { entry: { name: '', path: '', isDir: true }, children: new Map() };

  for (const path of paths) {
    const parts = path.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (i === parts.length - 1) {
        if (!current.children.has(part)) {
          current.children.set(part, {
            entry: { name: part, path, isDir: false },
            children: new Map(),
          });
        }
      } else {
        let next = current.children.get(part);
        if (!next) {
          next = {
            entry: { name: part, path: parts.slice(0, i + 1).join('/'), isDir: true },
            children: new Map(),
          };
          current.children.set(part, next);
        }
        current = next;
      }
    }
  }

  return collect(root);
}

/**
 * Turns assembled nodes into entries: directories first, then names in order,
 * and an empty directory dropped rather than shown.
 */
function collect(node: Node): TreeEntry[] {
  const result: TreeEntry[] = [];
  for (const child of node.children.values()) {
    if (child.entry.isDir) {
      const children = collect(child);
      if (children.length === 0) continue;
      child.entry.children = children;
    }
    result.push(child.entry);
  }
  result.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return result;
}

/**
 * Every tracked and not-ignored file in a git repository, as paths.
 *
 * `-z` gives NUL-separated, unquoted paths, so a filename with non-ASCII or
 * other special characters comes back verbatim rather than in git's C-style
 * quoted form. Returns null when the directory is no repository, which is what
 * sends the caller to the walk.
 *
 * The paths are the repository's own. REVIEW.md is not filtered here, because
 * which one is the review's is a question about the workspace: only
 * `/workspace/REVIEW.md` is, and a `repo-a/REVIEW.md` is a file of that
 * project like any other.
 */
export async function gitFiles(root: string): Promise<string[] | null> {
  const out = await gitOut(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (out === '') {
    // Genuinely empty, or not a repository — the caller cannot tell from this
    // alone, and both answers lead to the same place.
    return null;
  }
  return out.split('\0').filter((path) => path !== '' && !ignored(path));
}

/**
 * Walks a directory into a path list, for the space no repository claims.
 *
 * `skipDir` is asked about every directory before it is descended into, the
 * root included, and is what keeps the walk out of the repositories: inside
 * one, `git ls-files` is the better answer, because it knows what the project
 * called noise. Outside one nobody has said, so loose files all show — an
 * asymmetry that is intended.
 *
 * Directories are read with `withFileTypes`, and a symlink is skipped rather
 * than followed: the tree is agent-controlled, and a link to `/` would
 * otherwise be walked. Reading the file it points at is fs.ts's decision, and
 * it refuses.
 */
export function walkPaths(
  root: string,
  cap: number = MAX_ENTRIES,
  skipDir: (relDir: string) => boolean = () => false,
): { paths: string[]; truncated: boolean } {
  const paths: string[] = [];
  let truncated = false;

  const walk = (absDir: string, relDir: string): void => {
    if (truncated || skipDir(relDir)) return;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skipped, not fatal
    }
    for (const entry of entries) {
      if (paths.length >= cap) {
        truncated = true;
        return;
      }
      const name = entry.name;
      // Only the one at the root: a REVIEW.md deeper in the tree is a file of
      // the project under review like any other.
      if (relDir === '' && name === REVIEW_FILE) continue;
      const rel = relDir === '' ? name : `${relDir}/${name}`;

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(name)) continue;
        walk(join(absDir, name), rel);
      } else if (entry.isFile()) {
        if (ignored(rel)) continue;
        paths.push(rel);
      }
      // Anything else — a symlink, a socket, a device — is not walked and not
      // listed. Following one would leave the tree.
    }
  };

  walk(root, '');
  return { paths, truncated };
}

/**
 * One workspace-relative tree, merged from every repository the workspace
 * holds and a walk of what none of them claims.
 *
 * The merge runs one filter over all of it: an entry contributed by repository
 * `P` for path `p` is dropped when the closest repository to `P/p` is not `P`.
 * That single rule is what kills the nameless `inner/` row an outer
 * repository's `ls-files --others` reports for a work tree inside it, *and*
 * the duplicate that would otherwise appear once the inner repository
 * contributes its own files under the same prefix. It is also what makes the
 * repositories a partition of the workspace rather than overlapping views of
 * it.
 *
 * The merged list is sorted before the cap is applied, so a truncated tree is
 * deterministic rather than "whichever repository was read first".
 */
export async function reviewTree(map: RepoMap): Promise<Tree> {
  const claimed = await Promise.all(
    map.repos.map(async (repo) => {
      const files = (await gitFiles(repo.absolute)) ?? [];
      return files
        .map((path) => inWorkspace(repo, path))
        .filter((path) => map.repoFor(path)?.path === repo.path);
    }),
  );

  // Everything outside every repository, which is the current no-git
  // behaviour moved from being a property of the session to being a property
  // of the file.
  const unclaimed = walkPaths(map.workspace, MAX_ENTRIES, (relDir) => map.at(relDir) !== null);

  const paths = [...claimed.flat(), ...unclaimed.paths]
    .filter((path) => path !== REVIEW_FILE)
    // A trailing slash is git naming a directory rather than a file, which
    // `buildTree` would turn into a row with an empty name that 404s when it
    // is tapped. The closest-repo filter already drops the one case that
    // produces them; this is the guard that they can never reach the tree.
    .filter((path) => !path.endsWith('/'))
    .sort();
  const truncated = unclaimed.truncated || paths.length > MAX_ENTRIES;
  return {
    entries: buildTree(truncated ? paths.slice(0, MAX_ENTRIES) : paths),
    truncated,
  };
}

/**
 * Marks the directories repositories are rooted at, in place.
 *
 * Separate from building the tree because {@link withDeleted} rebuilds it, and
 * a mark that had to survive a rebuild would have to be threaded through
 * `buildTree` — which is pure, takes paths, and is the better for knowing
 * nothing about repositories.
 */
export function markRepoRoots(entries: TreeEntry[], map: RepoMap): TreeEntry[] {
  for (const entry of entries) {
    if (!entry.isDir) continue;
    if (map.at(entry.path) !== null) entry.repo = true;
    markRepoRoots(entry.children ?? [], map);
  }
  return entries;
}

/**
 * Puts the files a change removed back into the tree.
 *
 * Neither `git ls-files` nor a walk can name a file that is no longer on disk,
 * so without this a deletion is the one kind of change a review cannot show —
 * and once it is committed, the file leaves the tree the moment it starts to
 * matter. The paths come from the status map, which reports a deletion whether
 * it is staged, unstaged or committed against the base.
 */
export function withDeleted(entries: TreeEntry[], deleted: string[]): TreeEntry[] {
  const paths = treePaths(entries);
  const gone = deleted.filter(
    (path) => !paths.has(path) && path !== REVIEW_FILE && !ignored(path),
  );
  if (gone.length === 0) return entries;
  return buildTree([...paths, ...gone]);
}

/** Every file path in a tree, for validating a client-supplied path against it. */
export function treePaths(entries: TreeEntry[], into: Set<string> = new Set()): Set<string> {
  for (const entry of entries) {
    if (entry.isDir) treePaths(entry.children ?? [], into);
    else into.add(entry.path);
  }
  return into;
}
