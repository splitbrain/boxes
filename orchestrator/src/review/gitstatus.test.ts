import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';
import { discoverRepos } from './repos.ts';
import {
  baseRev,
  fileStatuses,
  NO_BASE,
  parseNameStatus,
  parsePathList,
  parsePorcelain,
  resolveBase,
  resolveBases,
  workspaceStatuses,
} from './gitstatus.ts';

/** Git statuses and base resolution, ported from the Go implementation's. */

describe('parsePorcelain', () => {
  test('classifies the index and work-tree pairs', () => {
    const out = [
      '?? new.txt',
      ' M modified.txt',
      'M  staged.txt',
      'MM staged-then-modified.txt',
      'A  added.txt',
      'D  deleted-staged.txt',
      ' D deleted.txt',
      'UU conflict.txt',
      'AA both-added.txt',
      'DD both-deleted.txt',
    ].join('\n');
    assert.deepEqual(parsePorcelain(out), {
      'new.txt': 'untracked',
      'modified.txt': 'modified',
      'staged.txt': 'staged',
      // Staged and then changed again: the more urgent of the two is shown.
      'staged-then-modified.txt': 'modified',
      'added.txt': 'added',
      'deleted-staged.txt': 'deleted',
      'deleted.txt': 'deleted',
      'conflict.txt': 'conflict',
      'both-added.txt': 'conflict',
      'both-deleted.txt': 'conflict',
    });
  });

  test('a rename is reported under its new path', () => {
    assert.deepEqual(parsePorcelain('R  old/name.txt -> new/name.txt'), {
      'new/name.txt': 'staged',
    });
  });

  test('short and empty lines are skipped', () => {
    assert.deepEqual(parsePorcelain(''), {});
    assert.deepEqual(parsePorcelain('\n\nxy\n'), {});
  });

  test('a path with a leading ./ is cleaned to match the tree', () => {
    assert.deepEqual(parsePorcelain('?? ./a/b.txt'), { 'a/b.txt': 'untracked' });
  });
});

describe('parseNameStatus', () => {
  test('maps the diff letters onto statuses', () => {
    const out = ['A\tadded.txt', 'D\tgone.txt', 'M\tchanged.txt', 'T\ttypechange.txt'].join('\n');
    assert.deepEqual(parseNameStatus(out), {
      'added.txt': 'added',
      'gone.txt': 'deleted',
      'changed.txt': 'modified',
      'typechange.txt': 'modified',
    });
  });

  test('a rename or copy reports the new path', () => {
    assert.deepEqual(parseNameStatus('R100\told.txt\tnew.txt'), { 'new.txt': 'modified' });
    assert.deepEqual(parseNameStatus('C75\tsrc.txt\tcopy.txt'), { 'copy.txt': 'modified' });
  });

  test('empty output is no statuses', () => {
    assert.deepEqual(parseNameStatus(''), {});
  });
});

test('parsePathList drops the empty trailing entry', () => {
  assert.deepEqual(parsePathList('a.txt\nb/c.txt\n'), ['a.txt', 'b/c.txt']);
  assert.deepEqual(parsePathList(''), []);
});

test('baseRev is HEAD until a base is chosen', () => {
  assert.equal(baseRev(NO_BASE), 'HEAD');
  assert.equal(baseRev({ rev: 'main', commit: 'abc123' }), 'abc123');
});

// --- against a real repository -----------------------------------------------

describe('over a real repository', () => {
  let dir: string;
  const run = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boxes-status-'));
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'test');
    writeFileSync(join(dir, 'tracked.txt'), 'x\n');
    run('add', '.');
    run('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a changed tracked file is modified', async () => {
    writeFileSync(join(dir, 'tracked.txt'), 'changed\n');
    const statuses = await fileStatuses(dir, NO_BASE);
    assert.equal(statuses?.['tracked.txt'], 'modified');
  });

  test('untracked files in a new directory are listed individually', async () => {
    // The file tree lists them individually too, so a collapsed directory
    // entry would match none of them.
    mkdirSync(join(dir, 'newdir', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'newdir', 'a.go'), 'x\n');
    writeFileSync(join(dir, 'newdir', 'sub', 'b.go'), 'x\n');

    const statuses = await fileStatuses(dir, NO_BASE);
    assert.equal(statuses?.['newdir/a.go'], 'untracked');
    assert.equal(statuses?.['newdir/sub/b.go'], 'untracked');
  });

  test('a directory that is no repository has no statuses at all', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'boxes-nogit-'));
    try {
      // Null rather than empty: it is what turns the git features off, and is
      // a different answer from "a repository with nothing changed".
      assert.equal(await fileStatuses(bare, NO_BASE), null);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test('a base resolves through the merge base, so the branch owns its changes', async () => {
    run('checkout', '-q', '-b', 'feature');
    writeFileSync(join(dir, 'feature.txt'), 'mine\n');
    run('add', '.');
    run('commit', '-q', '-m', 'feature work');

    // A commit on main after branching off must not become this branch's.
    run('checkout', '-q', 'main');
    writeFileSync(join(dir, 'theirs.txt'), 'not mine\n');
    run('add', '.');
    run('commit', '-q', '-m', 'main moves on');
    const mainTip = run('rev-parse', 'HEAD').trim();
    run('checkout', '-q', 'feature');

    const resolved = await resolveBase(dir, 'main');
    assert.ok('base' in resolved);
    assert.equal(resolved.base.rev, 'main');
    assert.notEqual(resolved.base.commit, mainTip);
    assert.equal(resolved.base.commit, run('merge-base', 'main', 'HEAD').trim());

    const statuses = await fileStatuses(dir, resolved.base);
    assert.equal(statuses?.['feature.txt'], 'added');
    assert.equal(statuses?.['theirs.txt'], undefined);
  });

  test('a base also covers uncommitted work and untracked files', async () => {
    const first = run('rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'tracked.txt'), 'edited\n');
    writeFileSync(join(dir, 'brand-new.txt'), 'new\n');

    const statuses = await fileStatuses(dir, { rev: first, commit: first });
    assert.equal(statuses?.['tracked.txt'], 'modified');
    assert.equal(statuses?.['brand-new.txt'], 'untracked');
  });

  test('an unknown revision is refused by name', async () => {
    const resolved = await resolveBase(dir, 'no-such-branch');
    assert.ok('error' in resolved);
    assert.match(resolved.error, /unknown revision/);
  });

  test('outside a repository there is no base to resolve', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'boxes-nogit-'));
    try {
      const resolved = await resolveBase(bare, 'HEAD');
      assert.ok('error' in resolved);
      assert.match(resolved.error, /not a git repository/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// --- across a whole workspace ------------------------------------------------

describe('over a workspace of several repositories', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boxes-wsstatus-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs git in a workspace-relative directory. */
  const git = (rel: string, ...args: string[]): string =>
    execFileSync('git', args, {
      cwd: rel === '' ? dir : join(dir, rel),
      stdio: 'pipe',
      encoding: 'utf8',
    });

  /** A repository with one committed file in it. */
  function repo(rel: string): void {
    mkdirSync(rel === '' ? dir : join(dir, rel), { recursive: true });
    git(rel, 'init', '-q', '-b', 'main');
    git(rel, 'config', 'user.email', 'test@example.com');
    git(rel, 'config', 'user.name', 'test');
    // Repository-specific content, so two repositories built the same way in
    // the same second do not end up with the same commit id.
    file(rel === '' ? 'tracked.txt' : `${rel}/tracked.txt`, `${rel}\n`);
    git(rel, 'add', '.');
    git(rel, 'commit', '-q', '-m', 'init');
  }

  /** Writes a workspace-relative file, creating the directories above it. */
  function file(rel: string, content = 'x\n'): void {
    const full = join(dir, rel);
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
    writeFileSync(full, content);
  }

  /** The merged statuses of the workspace, against each repository's HEAD. */
  async function statuses(rev = ''): Promise<Record<string, string>> {
    const map = await discoverRepos(dir);
    return workspaceStatuses(map, await resolveBases(map, rev));
  }

  test('every repository contributes, under its own prefix', async () => {
    repo('repo-a');
    repo('repo-b');
    file('repo-a/tracked.txt', 'changed\n');
    file('repo-b/new.txt');

    assert.deepEqual(await statuses(), {
      'repo-a/tracked.txt': 'modified',
      'repo-b/new.txt': 'untracked',
    });
  });

  test('a nested repository owns its own files, and the outer one does not claim it', async () => {
    repo('outer');
    repo('outer/inner');
    file('outer/inner/new.txt');

    const merged = await statuses();
    // The inner repository's own answer, at its workspace-relative path — and
    // not the outer repository's `inner/` for the whole work tree.
    assert.equal(merged['outer/inner/new.txt'], 'untracked');
    assert.equal(merged['outer/inner'], undefined);
    assert.equal(merged['outer/inner/tracked.txt'], undefined);
  });

  test('a workspace with no repository has no statuses', async () => {
    file('notes/todo.md');
    assert.deepEqual(await statuses(), {});
  });

  test('one revision resolves separately in each repository', async () => {
    repo('repo-a');
    repo('repo-b');
    for (const name of ['repo-a', 'repo-b']) {
      git(name, 'checkout', '-q', '-b', 'feature');
      file(`${name}/feature.txt`);
      git(name, 'add', '.');
      git(name, 'commit', '-q', '-m', 'feature work');
    }

    const map = await discoverRepos(dir);
    const bases = await resolveBases(map, 'main');
    assert.equal(bases.size, 2);
    // Different commits: `main` means main-in-each, not one shared id.
    assert.notEqual(bases.get('repo-a')!.commit, bases.get('repo-b')!.commit);

    const merged = await workspaceStatuses(map, bases);
    assert.equal(merged['repo-a/feature.txt'], 'added');
    assert.equal(merged['repo-b/feature.txt'], 'added');
  });

  test('a repository the revision names nothing in falls back to its working tree', async () => {
    repo('repo-a');
    repo('repo-b');
    git('repo-a', 'branch', 'release');
    file('repo-b/tracked.txt', 'changed\n');

    const map = await discoverRepos(dir);
    const bases = await resolveBases(map, 'release');
    // Resolved in one, absent from the other — a soft failure rather than a
    // failed request, because that shape is ordinary.
    assert.deepEqual([...bases.keys()], ['repo-a']);

    const merged = await workspaceStatuses(map, bases);
    assert.equal(merged['repo-b/tracked.txt'], 'modified');
  });

  test('no revision resolves nothing anywhere', async () => {
    repo('repo-a');
    const map = await discoverRepos(dir);
    assert.equal((await resolveBases(map, '')).size, 0);
    assert.equal((await resolveBases(map, 'no-such-branch')).size, 0);
  });
});
