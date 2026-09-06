import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';
import { discoverRepos } from './repos.ts';
import {
  buildTree,
  markRepoRoots,
  MAX_ENTRIES,
  reviewTree,
  treePaths,
  walkPaths,
  withDeleted,
  type TreeEntry,
} from './tree.ts';

/** The file tree, ported from the Go implementation's tests. */

describe('buildTree', () => {
  test('flat files come back in order', () => {
    const tree = buildTree(['c.txt', 'a.go', 'b.go']);
    assert.deepEqual(
      tree.map((e) => e.name),
      ['a.go', 'b.go', 'c.txt'],
    );
    assert.ok(tree.every((e) => !e.isDir));
  });

  test('directories come before files, each in order', () => {
    const tree = buildTree(['zebra.txt', 'alpha/file.go', 'beta.txt']);
    assert.deepEqual(
      tree.map((e) => `${e.isDir ? 'd' : 'f'}:${e.name}`),
      ['d:alpha', 'f:beta.txt', 'f:zebra.txt'],
    );
  });

  test('nesting is reproduced, with paths relative to the root', () => {
    const tree = buildTree(['src/main.go', 'src/util/helpers.go', 'README.md']);
    assert.equal(tree.length, 2);
    assert.equal(tree[0]!.name, 'src');
    assert.equal(tree[0]!.isDir, true);
    assert.equal(tree[1]!.name, 'README.md');

    const src = tree[0]!.children!;
    assert.equal(src[0]!.name, 'util');
    assert.equal(src[0]!.isDir, true);
    assert.equal(src[1]!.name, 'main.go');
    assert.equal(src[1]!.path, 'src/main.go');
  });

  test('deep nesting keeps every level', () => {
    const tree = buildTree(['a/b/c/d.txt']);
    const d = tree[0]!.children![0]!.children![0]!.children![0]!;
    assert.equal(d.name, 'd.txt');
    assert.equal(d.path, 'a/b/c/d.txt');
    assert.equal(d.isDir, false);
    // A file carries no children key at all, since files are the bulk of a
    // tree and the response goes to a phone.
    assert.equal('children' in d, false);
  });

  test('several files in one directory all arrive', () => {
    const tree = buildTree(['pkg/a.go', 'pkg/b.go', 'pkg/c.go']);
    assert.equal(tree[0]!.children!.length, 3);
  });

  test('no paths is an empty tree', () => {
    assert.deepEqual(buildTree([]), []);
  });
});

test('treePaths lists every file, and no directory', () => {
  const tree = buildTree(['src/main.go', 'src/util/helpers.go', 'README.md']);
  assert.deepEqual([...treePaths(tree)].toSorted(), [
    'README.md',
    'src/main.go',
    'src/util/helpers.go',
  ]);
});

describe('walkPaths', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boxes-tree-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Creates a file, and the directories above it. */
  function file(rel: string, content = 'x\n'): void {
    const full = join(dir, rel);
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
    writeFileSync(full, content);
  }

  test('walks a plain directory into relative paths', () => {
    file('a.txt');
    file('src/main.ts');
    const { paths, truncated } = walkPaths(dir);
    assert.deepEqual(paths.toSorted(), ['a.txt', 'src/main.ts']);
    assert.equal(truncated, false);
  });

  test('leaves out the noise directories and the binary extensions', () => {
    file('keep.ts');
    file('node_modules/pkg/index.js');
    file('dist/bundle.js');
    file('.git/config');
    file('vendor/lib.go');
    file('logo.png');
    file('tool.exe');
    assert.deepEqual(walkPaths(dir).paths, ['keep.ts']);
  });

  test("leaves out the review's own file, but only at the root", () => {
    file('REVIEW.md');
    file('docs/REVIEW.md');
    // A REVIEW.md deeper in the tree is a file of the project like any other.
    assert.deepEqual(walkPaths(dir).paths, ['docs/REVIEW.md']);
  });

  test('a symlink is neither listed nor followed', () => {
    const outside = mkdtempSync(join(tmpdir(), 'boxes-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'not the agent business');
      file('real.txt');
      symlinkSync(outside, join(dir, 'escape'));
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'));

      const { paths } = walkPaths(dir);
      assert.deepEqual(paths, ['real.txt']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('the entry cap cuts a huge tree short and says so', () => {
    for (let i = 0; i < 12; i++) file(`f${i}.txt`);
    const { paths, truncated } = walkPaths(dir, 5);
    assert.equal(paths.length, 5);
    assert.equal(truncated, true);
  });

  test('the cap is a real number, not a placeholder', () => {
    assert.equal(MAX_ENTRIES, 20_000);
  });
});

describe('reviewTree', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boxes-rtree-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs git in a workspace-relative directory. */
  function git(rel: string, ...args: string[]): void {
    execFileSync('git', args, { cwd: rel === '' ? dir : join(dir, rel), stdio: 'pipe' });
  }

  /** Initialises a repository at a workspace-relative path. */
  function repo(rel: string): void {
    mkdirSync(rel === '' ? dir : join(dir, rel), { recursive: true });
    git(rel, 'init', '-q', '-b', 'main');
    git(rel, 'config', 'user.email', 'test@example.com');
    git(rel, 'config', 'user.name', 'test');
  }

  /** Writes a file, creating the directories above it. */
  function file(rel: string, content = 'x\n'): void {
    const full = join(dir, rel);
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
    writeFileSync(full, content);
  }

  /** The merged tree of the workspace, as a sorted path list. */
  async function paths(): Promise<string[]> {
    const { entries } = await reviewTree(await discoverRepos(dir));
    return [...treePaths(entries)].toSorted();
  }

  test('a repository is listed by git, ignored files included in the ignoring', async () => {
    repo('');
    file('.gitignore', 'ignored.txt\n');
    file('tracked.ts');
    file('untracked.ts');
    file('ignored.txt');
    file('REVIEW.md', '# Code Review\n');
    git('', 'add', 'tracked.ts', '.gitignore');
    git('', 'commit', '-q', '-m', 'init');

    const { entries, truncated } = await reviewTree(await discoverRepos(dir));
    // Tracked and untracked, but not gitignored, and never the workspace's
    // own REVIEW.md.
    assert.deepEqual(
      [...treePaths(entries)].toSorted(),
      ['.gitignore', 'tracked.ts', 'untracked.ts'],
    );
    assert.equal(truncated, false);
  });

  test('a plain directory falls back to a walk', async () => {
    file('a.txt');
    assert.deepEqual(await paths(), ['a.txt']);
  });

  test('an empty repository still answers, with an empty tree', async () => {
    repo('');
    const { entries } = await reviewTree(await discoverRepos(dir));
    assert.deepEqual(entries as TreeEntry[], []);
  });

  test('two repositories side by side merge into one workspace-relative tree', async () => {
    repo('repo-a');
    repo('repo-b');
    file('repo-a/src/x.ts');
    file('repo-b/README.md');
    // The shape the old single-root rule dropped to a plain file browser with
    // no git at all.
    assert.deepEqual(await paths(), ['repo-a/src/x.ts', 'repo-b/README.md']);
  });

  test('the space no repository claims is walked, and shows its loose files', async () => {
    repo('project');
    file('project/a.ts');
    file('notes/todo.md');
    file('loose.txt');
    // Inside a repository the project has said what is noise; outside one
    // nobody has, so everything shows.
    assert.deepEqual(await paths(), ['loose.txt', 'notes/todo.md', 'project/a.ts']);
  });

  test('an unclaimed directory holding a repository is walked around it', async () => {
    repo('projects/foo');
    file('projects/foo/a.ts');
    file('projects/note.md');
    assert.deepEqual(await paths(), ['projects/foo/a.ts', 'projects/note.md']);
  });

  test('a repository inside a repository contributes its own files, once', async () => {
    repo('outer');
    file('outer/a.ts');
    repo('outer/inner');
    file('outer/inner/b.txt');

    // The outer repository's `ls-files --others` reports the inner work tree
    // as a single `inner/` entry, which used to become a nameless row that
    // 404ed when tapped. The closest-repo filter drops it, and the inner
    // repository contributes the real files under the same prefix.
    const listed = await paths();
    assert.deepEqual(listed, ['outer/a.ts', 'outer/inner/b.txt']);
    assert.ok(!listed.includes('outer/inner'));
    assert.ok(!listed.some((path) => path.endsWith('/')));
  });

  test('a REVIEW.md inside a repository is a file of that project', async () => {
    repo('repo-a');
    file('repo-a/REVIEW.md', '# Code Review\n');
    file('REVIEW.md', '# Code Review\n');
    // Only `/workspace/REVIEW.md` is the review's own, and it is the one left
    // out. Which is also why it sits there: outside every repository, so it
    // cannot be committed by accident.
    assert.deepEqual(await paths(), ['repo-a/REVIEW.md']);
  });

  test('repository roots are marked, so the boundaries are visible', async () => {
    repo('repo-a');
    file('repo-a/src/x.ts');
    file('notes/todo.md');

    const map = await discoverRepos(dir);
    const entries = markRepoRoots((await reviewTree(map)).entries, map);
    const byName = new Map(entries.map((e) => [e.name, e]));
    assert.equal(byName.get('repo-a')?.repo, true);
    assert.equal(byName.get('notes')?.repo, undefined);
    // And not on a directory inside one, only on its root.
    assert.equal(byName.get('repo-a')?.children?.[0]?.repo, undefined);
  });
});

describe('withDeleted', () => {
  test('a file the change removed is put back into the tree', () => {
    const entries = withDeleted(buildTree(['src/keep.ts']), ['src/gone.ts']);
    assert.deepEqual([...treePaths(entries)].toSorted(), ['src/gone.ts', 'src/keep.ts']);
  });

  test('a deletion of a file that is still there changes nothing', () => {
    const before = buildTree(['a.ts']);
    // Same array back, not a rebuilt copy: the common case is no deletions at
    // all, and every tree response goes through here.
    assert.equal(withDeleted(before, ['a.ts']), before);
  });

  test('the review file and ignored paths stay out', () => {
    const entries = withDeleted(buildTree(['a.ts']), ['REVIEW.md', 'logo.png', 'b.ts']);
    assert.deepEqual([...treePaths(entries)].toSorted(), ['a.ts', 'b.ts']);
  });
});
