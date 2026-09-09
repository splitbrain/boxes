import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { directorySize, WorkspaceUsage } from './diskusage.ts';

/**
 * How big a workspace is: the walk itself, and the cache in front of it that
 * keeps a five-second poll off the disk.
 */

let dir: string;
let outside: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-du-'));
  outside = mkdtempSync(join(tmpdir(), 'boxes-du-outside-'));
});

afterEach(() => {
  for (const d of [dir, outside]) rmSync(d, { recursive: true, force: true });
});

test('a workspace measures the files under it, however deep', async () => {
  writeFileSync(join(dir, 'top.txt'), 'x'.repeat(100));
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'y'.repeat(200));
  writeFileSync(join(dir, 'src', 'deep', 'b.ts'), 'z'.repeat(300));

  assert.equal(await directorySize(dir), 600);
});

test('an empty workspace is zero rather than an error', async () => {
  assert.equal(await directorySize(dir), 0);
});

test('a symlink is counted as nothing and not followed out of the tree', async () => {
  writeFileSync(join(outside, 'big.bin'), 'x'.repeat(5000));
  writeFileSync(join(dir, 'own.txt'), 'x'.repeat(10));
  // The tree is agent-controlled: a link planted in it must not make the
  // workspace look like whatever it points at, and must not walk out of it.
  symlinkSync(outside, join(dir, 'escape'));
  symlinkSync(join(outside, 'big.bin'), join(dir, 'escape.bin'));

  assert.equal(await directorySize(dir), 10);
});

test('a workspace that cannot be read at all is news', async () => {
  await assert.rejects(() => directorySize(join(dir, 'nosuch')));
});

/**
 * A usage cache over a stub measurer, so the walks are countable.
 *
 * `up` is the reading the manager passes for a running box, which is what the
 * tests below are about unless they say otherwise.
 */
const up = true;
const down = false;

function usage(over: {
  pathOf?: (id: string) => string | null;
  measure?: (path: string) => Promise<number>;
  now?: () => number;
} = {}) {
  const walks: string[] = [];
  const cache = new WorkspaceUsage({
    pathOf: over.pathOf ?? ((id) => `/data/workspaces/${id}`),
    ttlMs: 1000,
    now: over.now ?? (() => 0),
    measure:
      over.measure ??
      ((path) => {
        walks.push(path);
        return Promise.resolve(42);
      }),
  });
  return { cache, walks };
}

test('the first read answers with no number, and the next one with the measurement', async () => {
  const { cache, walks } = usage();

  // Nothing has been measured, and nothing waits for it: a list request is
  // not going to walk a checkout before it answers.
  assert.equal(cache.bytes('s1', up), null);
  await cache.settled();
  assert.deepEqual(walks, ['/data/workspaces/s1']);
  assert.equal(cache.bytes('s1', up), 42);
});

test('a measurement stands until it goes stale', async () => {
  let now = 0;
  const { cache, walks } = usage({ now: () => now });

  cache.bytes('s1', up);
  await cache.settled();
  assert.equal(walks.length, 1);

  // Twelve polls inside the window walk nothing.
  for (let i = 0; i < 12; i++) {
    now += 50;
    assert.equal(cache.bytes('s1', up), 42);
  }
  await cache.settled();
  assert.equal(walks.length, 1);

  now = 1000;
  assert.equal(cache.bytes('s1', up), 42);
  await cache.settled();
  assert.equal(walks.length, 2);
});

test('a session with no workspace directory has no size and is never walked', async () => {
  const { cache, walks } = usage({ pathOf: () => null });

  assert.equal(cache.bytes('legacy', up), null);
  await cache.settled();
  assert.deepEqual(walks, []);
});

test('a walk that fails leaves no number behind, and is not retried per request', async () => {
  let attempts = 0;
  const { cache } = usage({
    measure: () => {
      attempts++;
      return Promise.reject(new Error('EACCES'));
    },
  });

  assert.equal(cache.bytes('s1', up), null);
  await cache.settled();
  // Zero would be a claim about a workspace nobody could read.
  assert.equal(cache.bytes('s1', up), null);
  await cache.settled();
  assert.equal(attempts, 1);
});

test('a failed walk holds the answer that came before it', async () => {
  let now = 0;
  let fail = false;
  const { cache } = usage({
    now: () => now,
    measure: () => (fail ? Promise.reject(new Error('gone')) : Promise.resolve(7)),
  });

  cache.bytes('s1', up);
  await cache.settled();
  assert.equal(cache.bytes('s1', up), 7);

  fail = true;
  now = 5000;
  cache.bytes('s1', up);
  await cache.settled();
  assert.equal(cache.bytes('s1', up), 7);
});

test('one session with a slow walk does not queue a second for the same session', async () => {
  let finish = (): void => {};
  let walks = 0;
  const { cache } = usage({
    measure: () => {
      walks++;
      return new Promise<number>((resolve) => {
        finish = () => resolve(1);
      });
    },
  });

  // Two polls arriving while the first walk is still running. The walk starts
  // on a microtask, because nothing on the request path waits for it.
  cache.bytes('s1', up);
  await Promise.resolve();
  assert.equal(walks, 1);
  cache.bytes('s1', up);
  await Promise.resolve();
  assert.equal(walks, 1);
  finish();
  await cache.settled();
  assert.equal(walks, 1);
});

test('a box that is down is measured once and then left alone', async () => {
  let now = 0;
  let walks = 0;
  const { cache } = usage({
    now: () => now,
    measure: () => {
      walks++;
      return Promise.resolve(42);
    },
  });

  // It was running, and what was measured then was a workspace being written
  // to. Stopping it settles that, which is worth one more walk.
  cache.bytes('s1', up);
  await cache.settled();
  assert.equal(walks, 1);

  cache.bytes('s1', down);
  await cache.settled();
  assert.equal(walks, 2);

  // And then nothing, however long it sits there and however often the list
  // is polled. Nothing is running in it, so nothing in it is changing.
  for (const days of [1, 2, 7, 30]) {
    now = days * 86_400_000;
    assert.equal(cache.bytes('s1', down), 42);
  }
  await cache.settled();
  assert.equal(walks, 2);
});

test('a box that comes back up is measured again', async () => {
  let now = 0;
  let walks = 0;
  const { cache } = usage({
    now: () => now,
    measure: () => {
      walks++;
      return Promise.resolve(42);
    },
  });

  cache.bytes('s1', down);
  await cache.settled();
  assert.equal(walks, 1);

  // Inside the interval, being up on its own is not news.
  now = 500;
  cache.bytes('s1', up);
  await cache.settled();
  assert.equal(walks, 1);

  // Past it, an agent has had time to write something.
  now = 5000;
  cache.bytes('s1', up);
  await cache.settled();
  assert.equal(walks, 2);
});

test('a box that stops while its walk is queued is measured again after it lands', async () => {
  let finish: (bytes: number) => void = () => {};
  let walks = 0;
  const { cache } = usage({
    measure: () => {
      walks++;
      return new Promise<number>((resolve) => {
        finish = resolve;
      });
    },
  });

  // Asked for while it was up, so what it measures is a moving workspace —
  // whatever the box's state is by the time it finishes.
  cache.bytes('s1', up);
  await Promise.resolve();
  assert.equal(walks, 1);
  finish(42);
  await cache.settled();

  cache.bytes('s1', down);
  await Promise.resolve();
  assert.equal(walks, 2);
  finish(50);
  await cache.settled();
  assert.equal(cache.bytes('s1', down), 50);
  await cache.settled();
  assert.equal(walks, 2);
});

test('a walk that failed on a stopped box is retried rather than frozen', async () => {
  let now = 0;
  let fail = true;
  let walks = 0;
  const { cache } = usage({
    now: () => now,
    measure: () => {
      walks++;
      return fail ? Promise.reject(new Error('EACCES')) : Promise.resolve(9);
    },
  });

  cache.bytes('s1', down);
  await cache.settled();
  assert.equal(cache.bytes('s1', down), null);
  await cache.settled();
  // No answer is not an answer to freeze on: a permission fixed by hand
  // should show up on the next interval.
  assert.equal(walks, 1);

  fail = false;
  now = 5000;
  cache.bytes('s1', down);
  await cache.settled();
  assert.equal(cache.bytes('s1', down), 9);
});

test('an upload into a stopped box has its size measured again', async () => {
  let size = 42;
  let walks = 0;
  const { cache } = usage({
    measure: () => {
      walks++;
      return Promise.resolve(size);
    },
  });

  cache.bytes('s1', down);
  await cache.settled();
  assert.equal(walks, 1);
  assert.equal(cache.bytes('s1', down), 42);

  // The one way bytes arrive in a workspace with nothing running in it.
  size = 99;
  cache.forget('s1');
  cache.bytes('s1', down);
  await cache.settled();
  assert.equal(cache.bytes('s1', down), 99);
});

test('a deleted session takes its measurement with it', async () => {
  const { cache } = usage();

  cache.bytes('s1', up);
  await cache.settled();
  assert.equal(cache.bytes('s1', up), 42);

  cache.forget('s1');
  assert.equal(cache.bytes('s1', up), null);
});
