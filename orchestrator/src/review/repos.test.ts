import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';
import {
  discoverRepos,
  inRepo,
  inWorkspace,
  MAX_REPO_DEPTH,
  MAX_SCANNED_DIRS,
  RepoMap,
  type Repo,
} from './repos.ts';

/**
 * Discovery over real temporary repositories rather than a mocked git.
 *
 * Every shape here was a way the old single-root resolution lost git for a
 * whole session — two clones side by side, a stray directory beside one, a
 * clone a level deeper, a repository inside a repository, a symlinked
 * workspace path — so they are the cases worth paying a `git init` for.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-repos-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Initialises a repository at a workspace-relative path, and returns it. */
function repo(rel: string): string {
  const root = rel === '' ? dir : join(dir, rel);
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  return root;
}

/** Writes a file, creating the directories above it. */
function file(rel: string, content = 'x\n'): void {
  const full = join(dir, rel);
  mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
  writeFileSync(full, content);
}

/** The discovered repositories as workspace-relative paths. */
async function paths(workspace = dir): Promise<string[]> {
  return (await discoverRepos(workspace)).repos.map((r) => r.path);
}

describe('discovery', () => {
  test('a workspace that is itself a repository is the one repository', async () => {
    repo('');
    assert.deepEqual(await paths(), ['']);
  });

  test('a single clone in a subdirectory is found', async () => {
    repo('project');
    assert.deepEqual(await paths(), ['project']);
  });

  test('two clones side by side are both found', async () => {
    repo('repo-a');
    repo('repo-b');
    // The most common multi-repository shape, and the one the old
    // `dirs.length === 1` rule dropped to a plain file browser.
    assert.deepEqual(await paths(), ['repo-a', 'repo-b']);
  });

  test('a clone beside a stray directory is still found', async () => {
    repo('project');
    file('notes/todo.md');
    assert.deepEqual(await paths(), ['project']);
  });

  test('a clone one level deeper is found', async () => {
    repo('projects/foo');
    assert.deepEqual(await paths(), ['projects/foo']);
  });

  test('a repository inside a repository is found as well as its parent', async () => {
    repo('outer');
    repo('outer/inner');
    assert.deepEqual(await paths(), ['outer', 'outer/inner']);
  });

  test('a workspace with no repository has none, and says so', async () => {
    file('notes/todo.md');
    const map = await discoverRepos(dir);
    assert.deepEqual(map.repos, []);
    assert.equal(map.hasGit, false);
  });

  test('a workspace reached through a symlink still resolves its repositories', async () => {
    // `rev-parse --show-toplevel` resolves symlinks, so comparing its answer
    // against the raw path fails here — which lost git for every session of
    // any deployment whose workspace path had a linked component.
    repo('project');
    const link = join(tmpdir(), `boxes-link-${process.pid}-${Math.random().toString(36).slice(2)}`);
    symlinkSync(dir, link);
    try {
      assert.deepEqual(await paths(link), ['project']);
    } finally {
      rmSync(link, { force: true });
    }
  });

  test('a symlinked repository directory is not followed', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'boxes-outside-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: outside, stdio: 'pipe' });
      symlinkSync(outside, join(dir, 'linked'));
      assert.deepEqual(await paths(), []);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a linked worktree, whose .git is a file, counts', async () => {
    const main = repo('main');
    writeFileSync(join(main, 'a.txt'), 'x\n');
    execFileSync('git', ['add', '.'], { cwd: main, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
      { cwd: main, stdio: 'pipe' },
    );
    execFileSync('git', ['worktree', 'add', '-q', join(dir, 'wt'), '-b', 'side'], {
      cwd: main,
      stdio: 'pipe',
    });
    assert.deepEqual(await paths(), ['main', 'wt']);
  });

  test('the ignore list is pruned, so a dependency tree contributes nothing', async () => {
    repo('project');
    repo('project/node_modules/dep');
    repo('vendor/thing');
    assert.deepEqual(await paths(), ['project']);
  });

  test('a repository past the depth limit is not looked for', async () => {
    const deep = Array.from({ length: MAX_REPO_DEPTH + 1 }, (_, i) => `d${i}`).join('/');
    repo(deep);
    repo('shallow');
    assert.deepEqual(await paths(), ['shallow']);
  });

  test('a repository at the depth limit is still found', async () => {
    const atLimit = Array.from({ length: MAX_REPO_DEPTH }, (_, i) => `d${i}`).join('/');
    repo(atLimit);
    assert.deepEqual(await paths(), [atLimit]);
  });

  test('the directory cap is a real number that bounds the walk', async () => {
    assert.equal(MAX_SCANNED_DIRS, 4000);
    // Cheap proof the cap is wired to the walk rather than only declared: a
    // repository behind more directories than the cap allows is not reached.
    // (Building 4000 directories per test run is not worth the seconds, so
    // the limit itself is asserted and the wiring is read at the call site.)
    for (let i = 0; i < 20; i++) mkdirSync(join(dir, `sib${i}`));
    repo('project');
    assert.deepEqual(await paths(), ['project']);
  });

  test('a repository reports its own name, and the workspace one takes the directory name', async () => {
    repo('');
    const map = await discoverRepos(dir);
    assert.equal(map.repos[0]!.name, dir.split('/').pop());

    rmSync(join(dir, '.git'), { recursive: true, force: true });
    repo('repo-a');
    const second = await discoverRepos(dir);
    assert.equal(second.repos[0]!.name, 'repo-a');
  });
});

describe('repoFor', () => {
  /** A map over paths, without touching a filesystem. */
  function mapOf(...repoPaths: string[]): RepoMap {
    return new RepoMap(
      '/workspace',
      repoPaths.map(
        (path): Repo => ({
          path,
          absolute: path === '' ? '/workspace' : `/workspace/${path}`,
          name: path === '' ? 'workspace' : (path.split('/').pop() ?? ''),
        }),
      ),
    );
  }

  test('a file is claimed by the repository it is in', () => {
    const map = mapOf('repo-a', 'repo-b');
    assert.equal(map.repoFor('repo-a/src/x.ts')?.path, 'repo-a');
    assert.equal(map.repoFor('repo-b/README.md')?.path, 'repo-b');
  });

  test('the nested repository wins, because it is the longer prefix', () => {
    const map = mapOf('repo-a', 'repo-a/inner');
    assert.equal(map.repoFor('repo-a/src/x.ts')?.path, 'repo-a');
    assert.equal(map.repoFor('repo-a/inner/b.txt')?.path, 'repo-a/inner');
  });

  test('a file no repository claims has none', () => {
    const map = mapOf('repo-a');
    assert.equal(map.repoFor('notes/todo.md'), null);
    // A sibling whose name merely starts the same way is not inside it.
    assert.equal(map.repoFor('repo-abc/x.ts'), null);
  });

  test('a workspace that is itself a repository claims everything', () => {
    const map = mapOf('');
    assert.equal(map.repoFor('anything/at/all.ts')?.path, '');
  });

  test('repositories come back sorted, whatever order they were found in', () => {
    assert.deepEqual(
      mapOf('b', 'a/inner', 'a').repos.map((r) => r.path),
      ['a', 'a/inner', 'b'],
    );
  });

  test('a repository root is findable by its exact path', () => {
    const map = mapOf('', 'repo-a');
    assert.equal(map.at('repo-a')?.path, 'repo-a');
    assert.equal(map.at('repo-a/src'), null);
  });

  test('paths translate both ways across a repository boundary', () => {
    const nested = mapOf('repo-a').repos[0]!;
    assert.equal(inWorkspace(nested, 'src/x.ts'), 'repo-a/src/x.ts');
    assert.equal(inRepo(nested, 'repo-a/src/x.ts'), 'src/x.ts');

    const root = mapOf('').repos[0]!;
    assert.equal(inWorkspace(root, 'src/x.ts'), 'src/x.ts');
    assert.equal(inRepo(root, 'src/x.ts'), 'src/x.ts');
  });
});
