import assert from 'node:assert/strict';
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
import {
  fileHash,
  fileLines,
  isDirectory,
  MAX_FILE_BYTES,
  readTextFile,
  removeFile,
  resolveInRoot,
  validRelativePath,
  writeFileAtomic,
} from './fs.ts';

/**
 * Symlink containment, which is the security invariant this file exists to
 * hold. The tree it serves is written by an agent, so the tests here are the
 * attacks: a link out of the workspace, a link through a directory, a
 * traversal, and the filenames that merely look like one.
 */

let root: string;
let outside: string;
let secret: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'boxes-fs-root-'));
  outside = mkdtempSync(join(tmpdir(), 'boxes-fs-outside-'));
  secret = join(outside, 'boxes.db');
  writeFileSync(secret, 'the deployment gateway token');
});

afterEach(() => {
  for (const d of [root, outside]) rmSync(d, { recursive: true, force: true });
});

describe('validRelativePath', () => {
  test('accepts an ordinary relative path', () => {
    for (const path of ['a.txt', 'src/app.ts', 'a/b/c/d.txt', '.gitignore', 'a b/c d.txt']) {
      assert.equal(validRelativePath(path), true, path);
    }
  });

  test('accepts a filename that merely contains dots', () => {
    // The check is on segments, not on the text, so a real filename like this
    // stays openable.
    for (const path of ['[...slug].astro', 'a..b.txt', 'src/..hidden', 'x/....y']) {
      assert.equal(validRelativePath(path), true, path);
    }
  });

  test('refuses a traversal, however it is spelled', () => {
    for (const path of [
      '../etc/passwd',
      'a/../../b',
      'a/..',
      '..',
      'a/../b',
      'a\\..\\b',
      '..\\b',
    ]) {
      assert.equal(validRelativePath(path), false, path);
    }
  });

  test('refuses an absolute path, a drive letter and a NUL', () => {
    for (const path of ['/etc/passwd', '\\etc', 'C:/Windows', 'a\0b', '', 'x'.repeat(5000)]) {
      assert.equal(validRelativePath(path), false, JSON.stringify(path));
    }
  });

  test('refuses an empty segment, which would collapse a path', () => {
    assert.equal(validRelativePath('a//b'), false);
    assert.equal(validRelativePath('a/'), false);
  });
});

describe('resolveInRoot', () => {
  test('resolves a file inside the root', () => {
    writeFileSync(join(root, 'a.txt'), 'x');
    const result = resolveInRoot(root, 'a.txt');
    assert.ok(result.ok);
    assert.equal(readFileSync(result.path, 'utf8'), 'x');
  });

  test('refuses a symlink pointing out of the root', () => {
    // The obvious attack: `ln -s /data x` in the workspace would otherwise
    // serve the deployment's database through the file endpoint.
    symlinkSync(secret, join(root, 'boxes.db'));
    const result = resolveInRoot(root, 'boxes.db');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'symlink');
  });

  test('refuses a symlink even when it stays inside the root', () => {
    // What it points at can be changed after the tree was listed, so the link
    // itself is refused rather than its current target inspected.
    writeFileSync(join(root, 'real.txt'), 'x');
    symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'));
    const result = resolveInRoot(root, 'link.txt');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'symlink');
  });

  test('refuses a file reached through a linked directory', () => {
    symlinkSync(outside, join(root, 'escape'));
    const result = resolveInRoot(root, 'escape/boxes.db');
    assert.equal(result.ok, false);
    // The final component is a real file, so what refuses this is the realpath
    // landing outside the root.
    assert.equal(result.ok === false && result.reason, 'outside');
  });

  test('refuses a traversal before touching the filesystem', () => {
    const result = resolveInRoot(root, '../boxes.db');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'invalid');
  });

  test('a missing file is missing, not outside', () => {
    const result = resolveInRoot(root, 'nosuch.txt');
    assert.equal(result.ok === false && result.reason, 'missing');
  });

  test('a file that need not exist yet resolves, if its parent is inside', () => {
    // This is the REVIEW.md case: the first write creates the file.
    const result = resolveInRoot(root, 'REVIEW.md', false);
    assert.ok(result.ok);
    assert.equal(result.path, join(root, 'REVIEW.md'));
  });

  test('a file that need not exist yet is still refused behind a link', () => {
    symlinkSync(outside, join(root, 'escape'));
    const result = resolveInRoot(root, 'escape/REVIEW.md', false);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'outside');
    assert.equal(existsSync(join(outside, 'REVIEW.md')), false);
  });

  test('a root that is not there refuses everything', () => {
    const gone = join(root, 'nosuch-root');
    assert.equal(resolveInRoot(gone, 'a.txt').ok, false);
  });

  test('the root itself resolves through its own realpath', () => {
    // macOS puts temp directories behind /private, so a root given by a path
    // that is itself a link must not make everything under it "outside".
    const linked = join(outside, 'root-link');
    symlinkSync(root, linked);
    writeFileSync(join(root, 'a.txt'), 'x');
    const result = resolveInRoot(linked, 'a.txt');
    assert.ok(result.ok);
  });
});

describe('readTextFile', () => {
  test('reads a text file whole', () => {
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
    const read = readTextFile(join(root, 'a.txt'));
    assert.equal(read.content, 'one\ntwo\n');
    assert.equal(read.truncated, false);
    assert.equal(read.binary, false);
    assert.equal(read.size, 8);
  });

  test('a file past the cap is cut and says so, with its real size', () => {
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(100));
    const read = readTextFile(join(root, 'big.txt'), 10);
    assert.equal(read.content.length, 10);
    assert.equal(read.truncated, true);
    assert.equal(read.size, 100);
  });

  test('a NUL byte makes it binary, with no content returned', () => {
    writeFileSync(join(root, 'a.bin'), Buffer.from([0x41, 0x00, 0x42]));
    const read = readTextFile(join(root, 'a.bin'));
    assert.equal(read.binary, true);
    assert.equal(read.content, '');
    // Not an error: the tree legitimately lists files the viewer cannot show.
    assert.equal(read.size, 3);
  });

  test('an empty file is empty, not binary', () => {
    writeFileSync(join(root, 'empty.txt'), '');
    const read = readTextFile(join(root, 'empty.txt'));
    assert.deepEqual(read, { content: '', truncated: false, binary: false, size: 0 });
  });

  test('the cap is a real number', () => {
    assert.equal(MAX_FILE_BYTES, 2 * 1024 * 1024);
  });
});

test('fileLines drops terminators and the trailing empty line', () => {
  assert.deepEqual(fileLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(fileLines('a\nb'), ['a', 'b']);
  assert.deepEqual(fileLines('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(fileLines(''), []);
  assert.deepEqual(fileLines('\n'), ['']);
});

describe('writeFileAtomic', () => {
  test('writes the content and leaves no temp file behind', () => {
    const path = join(root, 'REVIEW.md');
    writeFileAtomic(path, '# Code Review\n');
    assert.equal(readFileSync(path, 'utf8'), '# Code Review\n');
    assert.deepEqual(readdirSync(root), ['REVIEW.md']);
  });

  test('an overwrite replaces the whole file', () => {
    const path = join(root, 'REVIEW.md');
    writeFileAtomic(path, 'first, and longer\n');
    writeFileAtomic(path, 'second\n');
    assert.equal(readFileSync(path, 'utf8'), 'second\n');
  });

  test('a failed write leaves the previous version and no temp file', () => {
    const path = join(root, 'sub', 'REVIEW.md');
    // No parent directory, so the temp write fails.
    assert.throws(() => writeFileAtomic(path, 'x'));
    assert.deepEqual(readdirSync(root), []);
  });
});

test('removeFile reports whether there was a file', () => {
  const path = join(root, 'a.txt');
  writeFileSync(path, 'x');
  assert.equal(removeFile(path), true);
  assert.equal(existsSync(path), false);
  assert.equal(removeFile(path), false);
});

describe('hashing', () => {
  test('a file hash follows its content, and is empty for no file', () => {
    const path = join(root, 'a.txt');
    assert.equal(fileHash(path), '');
    writeFileSync(path, 'one');
    const first = fileHash(path);
    assert.match(first, /^[0-9a-f]{32}$/);
    assert.equal(fileHash(path), first);
    writeFileSync(path, 'two');
    assert.notEqual(fileHash(path), first);
  });
});

describe('directory probes', () => {
  test('isDirectory answers for a directory, a file and nothing', () => {
    writeFileSync(join(root, 'a.txt'), 'x');
    mkdirSync(join(root, 'sub'));
    assert.equal(isDirectory(join(root, 'sub')), true);
    assert.equal(isDirectory(join(root, 'a.txt')), false);
    assert.equal(isDirectory(join(root, 'nosuch')), false);
  });
});
