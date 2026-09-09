import assert from 'node:assert/strict';
import { test } from 'vitest';
import { shortAge, shortSize } from './rough.ts';

/** The two magnitudes a card in the list shows: how long ago, and how big. */

test('an age is the largest unit that leaves a whole number', () => {
  assert.equal(shortAge(0), '0s');
  assert.equal(shortAge(5_000), '5s');
  assert.equal(shortAge(59_999), '59s');
  assert.equal(shortAge(60_000), '1m');
  assert.equal(shortAge(5 * 60_000), '5m');
  assert.equal(shortAge(59.9 * 60_000), '59m');
  assert.equal(shortAge(60 * 60_000), '1h');
  assert.equal(shortAge(5 * 3_600_000), '5h');
  assert.equal(shortAge(23.9 * 3_600_000), '23h');
  assert.equal(shortAge(24 * 3_600_000), '1d');
  assert.equal(shortAge(5 * 86_400_000), '5d');
  // Days keep counting: how stale a thread is reads better in days than in
  // months, and nothing here is a date.
  assert.equal(shortAge(400 * 86_400_000), '400d');
});

test('an age is rounded down, so nothing is older than it is', () => {
  assert.equal(shortAge(1_999), '1s');
  assert.equal(shortAge(119_000), '1m');
});

test('a clock that disagrees with the server does not read as the future', () => {
  assert.equal(shortAge(-5_000), '0s');
});

test('a size is said at the magnitude a person would say it', () => {
  assert.equal(shortSize(0), '0 B');
  assert.equal(shortSize(512), '512 B');
  assert.equal(shortSize(1024), '1.0 KB');
  assert.equal(shortSize(12 * 1024), '12 KB');
  assert.equal(shortSize(5.2 * 1024 * 1024), '5.2 MB');
  assert.equal(shortSize(340 * 1024 * 1024), '340 MB');
  assert.equal(shortSize(1.4 * 1024 ** 3), '1.4 GB');
  assert.equal(shortSize(20 * 1024 ** 3), '20 GB');
  // Past the largest unit it keeps growing rather than wrapping to nonsense.
  assert.equal(shortSize(3 * 1024 ** 4), '3.0 TB');
  assert.equal(shortSize(5000 * 1024 ** 4), '5000 TB');
});
