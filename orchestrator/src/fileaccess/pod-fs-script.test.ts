import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';
import { POD_FS_SCRIPT } from './pod-fs-script.ts';

/**
 * The symlink-containment invariant this script exists to hold, verified by
 * actually running it — as a real local Node process against a real
 * temporary tree, not a mock of one — so these are the same attacks
 * review/fs.test.ts runs against `resolveInRoot` itself: a link out of the
 * root, a link through a directory, a link at the exact write target, and
 * the boundary cases around a file that need not exist yet.
 *
 * A pod would run this under the box image's own Node rather than this
 * process's, and only `execInPod`/`execWithStdin` (untested here — see
 * kubernetes-fileaccess.test.ts) stand between it and a real cluster. What
 * runs identically either way is everything below: the script has no
 * Kubernetes dependency of its own.
 */

function run(args: string[], input?: Buffer): { stdout: Buffer; stderr: string; code: number | null } {
  const result = spawnSync(process.execPath, ['-e', POD_FS_SCRIPT, '--', ...args], { input: input ?? Buffer.alloc(0) });
  return { stdout: result.stdout, stderr: result.stderr.toString('utf8'), code: result.status };
}

let root: string;
let outside: string;
let secret: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'boxes-podfs-root-'));
  outside = mkdtempSync(join(tmpdir(), 'boxes-podfs-outside-'));
  secret = join(outside, 'boxes.db');
  writeFileSync(secret, 'the deployment gateway token');
});

afterEach(() => {
  for (const d of [root, outside]) rmSync(d, { recursive: true, force: true });
});

describe('read', () => {
  test('reads a file inside the root, with its size on stderr', () => {
    writeFileSync(join(root, 'a.txt'), 'hello');
    const { stdout, stderr, code } = run(['read', root, 'a.txt', '1000000']);
    assert.equal(code, 0);
    assert.equal(stdout.toString('utf8'), 'hello');
    assert.deepEqual(JSON.parse(stderr), { size: 5, truncated: false });
  });

  test('caps a read and still reports the real size', () => {
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(100));
    const { stdout, stderr, code } = run(['read', root, 'big.txt', '10']);
    assert.equal(code, 0);
    assert.equal(stdout.length, 10);
    assert.deepEqual(JSON.parse(stderr), { size: 100, truncated: true });
  });

  test('reads binary content byte for byte', () => {
    const bytes = Buffer.from([0x41, 0x00, 0xff, 0x80, 0x42]);
    writeFileSync(join(root, 'a.bin'), bytes);
    const { stdout, code } = run(['read', root, 'a.bin', '1000']);
    assert.equal(code, 0);
    assert.deepEqual(stdout, bytes);
  });

  test('refuses a symlink pointing out of the root', () => {
    symlinkSync(secret, join(root, 'boxes.db'));
    assert.equal(run(['read', root, 'boxes.db', '1000']).code, 5);
  });

  test('refuses a symlink even when it stays inside the root', () => {
    writeFileSync(join(root, 'real.txt'), 'x');
    symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'));
    assert.equal(run(['read', root, 'link.txt', '1000']).code, 5);
  });

  test('refuses a file reached through a linked directory', () => {
    symlinkSync(outside, join(root, 'escape'));
    assert.equal(run(['read', root, 'escape/boxes.db', '1000']).code, 4);
  });

  test('refuses a traversal even if it reaches this program directly', () => {
    // Production never gets here — kubernetes-fileaccess.ts refuses this with
    // validRelativePath before issuing the exec — but the script is the
    // actual trust boundary a compromised or buggy caller crosses, so it has
    // to refuse this on its own too.
    assert.equal(run(['read', root, '../boxes.db', '1000']).code, 4);
  });

  test('a missing file is missing, not outside', () => {
    assert.equal(run(['read', root, 'nosuch.txt', '1000']).code, 3);
  });

  test('a missing root is missing', () => {
    assert.equal(run(['read', join(root, 'nosuch-root'), 'a.txt', '1000']).code, 3);
  });

  test('the root itself resolves through its own realpath', () => {
    const linked = join(outside, 'root-link');
    symlinkSync(root, linked);
    writeFileSync(join(root, 'a.txt'), 'x');
    const { code, stdout } = run(['read', linked, 'a.txt', '1000']);
    assert.equal(code, 0);
    assert.equal(stdout.toString('utf8'), 'x');
  });
});

describe('write', () => {
  test('writes new content, and the parent existing is enough', () => {
    const { code } = run(['write', root, 'REVIEW.md'], Buffer.from('# Code Review\n'));
    assert.equal(code, 0);
    assert.equal(readFileSync(join(root, 'REVIEW.md'), 'utf8'), '# Code Review\n');
    assert.deepEqual(readdirSync(root), ['REVIEW.md']);
  });

  test('an overwrite replaces the whole file and keeps its mode', () => {
    writeFileSync(join(root, 'REVIEW.md'), 'first, and quite a lot longer\n', { mode: 0o640 });
    const before = run(['stat', root, 'REVIEW.md']);
    const { code } = run(['write', root, 'REVIEW.md'], Buffer.from('second\n'));
    assert.equal(code, 0);
    assert.equal(readFileSync(join(root, 'REVIEW.md'), 'utf8'), 'second\n');
    const after = run(['stat', root, 'REVIEW.md']);
    assert.equal(JSON.parse(after.stdout.toString()).mode, JSON.parse(before.stdout.toString()).mode);
  });

  test('a symlink already at the target is refused, not written through', () => {
    symlinkSync(secret, join(root, 'REVIEW.md'));
    const { code } = run(['write', root, 'REVIEW.md'], Buffer.from('x'));
    assert.equal(code, 5);
    assert.equal(readFileSync(secret, 'utf8'), 'the deployment gateway token');
  });

  test('refused behind a linked directory, and nothing lands outside', () => {
    symlinkSync(outside, join(root, 'escape'));
    const { code } = run(['write', root, 'escape/REVIEW.md'], Buffer.from('x'));
    assert.equal(code, 4);
    assert.equal(existsSync(join(outside, 'REVIEW.md')), false);
  });

  test('leaves no temp file behind on success', () => {
    run(['write', root, 'a.txt'], Buffer.from('x'));
    run(['write', root, 'a.txt'], Buffer.from('y'));
    assert.deepEqual(readdirSync(root), ['a.txt']);
  });
});

describe('hash', () => {
  test('follows content, and refuses a missing file', () => {
    const path = join(root, 'a.txt');
    assert.equal(run(['hash', root, 'a.txt', '8000000']).code, 3);
    writeFileSync(path, 'one');
    const first = run(['hash', root, 'a.txt', '8000000']);
    assert.equal(first.code, 0);
    assert.match(first.stdout.toString('utf8'), /^[0-9a-f]{32}$/);
    writeFileSync(path, 'two');
    const second = run(['hash', root, 'a.txt', '8000000']);
    assert.notEqual(second.stdout.toString('utf8'), first.stdout.toString('utf8'));
  });

  test('refuses a symlink the same as read does', () => {
    symlinkSync(secret, join(root, 'boxes.db'));
    assert.equal(run(['hash', root, 'boxes.db', '8000000']).code, 5);
  });
});

describe('remove', () => {
  test('reports whether there was a file', () => {
    const path = join(root, 'a.txt');
    writeFileSync(path, 'x');
    assert.equal(run(['remove', root, 'a.txt']).stdout.toString(), 'true');
    assert.equal(existsSync(path), false);
    assert.equal(run(['remove', root, 'a.txt']).stdout.toString(), 'false');
  });

  test('a symlink escape is refused rather than silently reporting nothing to remove', () => {
    symlinkSync(outside, join(root, 'escape'));
    const { code } = run(['remove', root, 'escape/boxes.db']);
    assert.equal(code, 4);
    assert.equal(existsSync(secret), true);
  });
});

describe('stat', () => {
  test('answers for a directory, a file, and refuses a symlink', () => {
    writeFileSync(join(root, 'a.txt'), 'x');
    mkdirSync(join(root, 'sub'));
    symlinkSync(secret, join(root, 'link'));
    assert.equal(JSON.parse(run(['stat', root, 'sub']).stdout.toString()).isDirectory, true);
    assert.equal(JSON.parse(run(['stat', root, 'a.txt']).stdout.toString()).isDirectory, false);
    assert.equal(run(['stat', root, 'link']).code, 5);
    assert.equal(run(['stat', root, 'nosuch']).code, 3);
  });
});

describe('listdir', () => {
  test('lists entries with their type, without following a symlink', () => {
    writeFileSync(join(root, 'a.txt'), 'x');
    mkdirSync(join(root, 'sub'));
    symlinkSync(outside, join(root, 'escape'));
    type Entry = { name: string; isDirectory: boolean; isSymlink: boolean };
    const entries = JSON.parse(run(['listdir', root, '']).stdout.toString()) as Entry[];
    const byName = new Map(entries.map((e) => [e.name, e]));
    const at = (name: string): Entry => {
      const entry = byName.get(name);
      assert.ok(entry, `expected an entry named ${name}`);
      return entry;
    };
    assert.equal(at('a.txt').isDirectory, false);
    assert.equal(at('a.txt').isSymlink, false);
    assert.equal(at('sub').isDirectory, true);
    assert.equal(at('escape').isSymlink, true);
  });

  test('refuses a directory that is itself a symlink, the same as read does', () => {
    symlinkSync(outside, join(root, 'escape'));
    assert.equal(run(['listdir', root, 'escape']).code, 5);
  });

  test('refuses a directory reached through a linked intermediate directory', () => {
    mkdirSync(join(outside, 'sub'));
    symlinkSync(outside, join(root, 'escape'));
    assert.equal(run(['listdir', root, 'escape/sub']).code, 4);
  });
});

describe('dirsize', () => {
  test('sums files under the root, however deep, and never follows a link out', () => {
    writeFileSync(join(root, 'top.txt'), 'x'.repeat(100));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'y'.repeat(200));
    writeFileSync(join(outside, 'big.bin'), 'z'.repeat(5000));
    symlinkSync(outside, join(root, 'escape'));
    symlinkSync(join(outside, 'big.bin'), join(root, 'escape.bin'));
    assert.equal(run(['dirsize', root, '']).stdout.toString(), '300');
  });

  test('an unreadable root is zero rather than a thrown error', () => {
    assert.equal(run(['dirsize', join(root, 'nosuch'), '']).stdout.toString(), '0');
  });
});
