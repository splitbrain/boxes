import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { openDb } from './db.ts';
import * as dk from './docker.ts';
import { MAX_OUTPUT_BYTES, WALL_CLOCK_MS, history, record, runCommand, trailer } from './exec.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Local commands, against a fake Docker socket.
 *
 * The fake produces the same 8-byte-framed stream a real `Tty: false` exec
 * does and is demuxed by dockerode's own modem, so the framing is exercised
 * rather than assumed.
 */

/** One frame of a demuxable Docker stream. */
function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** What the fake exec should do when started. */
interface Behaviour {
  /** Frames to emit, in order. */
  writes: Buffer[];
  /** Milliseconds between frames. */
  gapMs?: number;
  /** Exit code exec.inspect() reports. */
  exitCode?: number | null;
  /** Never end the stream, so only a limit can stop it. */
  never?: boolean;
}

/** Installs a fake Docker client that runs one canned exec. */
function fakeDocker(behaviour: Behaviour): { commands: string[][] } {
  const commands: string[][] = [];
  // Borrow a real modem so demuxStream is the real implementation.
  const modem = new Docker({ socketPath: '/var/run/docker.sock' }).modem;

  dk.setDockerForTests({
    modem,
    getContainer: () => ({
      exec: async (opts: { Cmd: string[] }) => {
        commands.push(opts.Cmd);
        return {
          start: async () => {
            const stream = new PassThrough();
            void (async () => {
              for (const write of behaviour.writes) {
                if (behaviour.gapMs) await sleep(behaviour.gapMs);
                stream.write(write);
              }
              if (!behaviour.never) stream.end();
            })();
            return stream;
          },
          inspect: async () => ({ ExitCode: behaviour.exitCode ?? 0 }),
        };
      },
    }),
  } as unknown as Docker);

  return { commands };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const TARGET = { containerId: 'c1', workingDir: '/workspace' };

afterEach(() => dk.setDockerForTests(null));

test('output is streamed as it arrives and reported whole at the end', async () => {
  const { commands } = fakeDocker({
    writes: [frame(1, 'one\n'), frame(1, 'two\n')],
    gapMs: 5,
  });

  const chunks: string[] = [];
  const result = await runCommand(TARGET, 'echo one; echo two', (c) => chunks.push(c));

  assert.deepEqual(chunks, ['one\n', 'two\n']);
  assert.equal(result.output, 'one\ntwo\n');
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, false);
  assert.equal(result.timedOut, false);
  // The command travels as an argument, never as part of a host command line.
  assert.deepEqual(commands[0], ['bash', '-lc', 'echo one; echo two']);
});

test('stderr is merged into the same stream, in arrival order', async () => {
  fakeDocker({ writes: [frame(1, 'out\n'), frame(2, 'err\n'), frame(1, 'more\n')] });
  const result = await runCommand(TARGET, 'noisy', () => {});
  assert.equal(result.output, 'out\nerr\nmore\n');
});

test('a non-zero exit code is reported', async () => {
  fakeDocker({ writes: [frame(2, 'bash: nope: command not found\n')], exitCode: 127 });
  const result = await runCommand(TARGET, 'nope', () => {});
  assert.equal(result.exitCode, 127);
  assert.match(trailer(result), /^\n\[exit 127\]\n$/);
});

test('output past the cap is dropped and the exec killed', async () => {
  const big = 'x'.repeat(64);
  fakeDocker({ writes: [frame(1, big), frame(1, big), frame(1, big)], gapMs: 5, never: true });

  const seen: string[] = [];
  const result = await runCommand(TARGET, 'yes', (c) => seen.push(c), {
    maxOutputBytes: 100,
  });

  assert.equal(result.truncated, true);
  assert.equal(result.output.length, 100);
  assert.equal(seen.join('').length, 100, 'the caller never sees more than the cap either');
  // A killed exec has no exit code to report, and says so.
  assert.equal(result.exitCode, null);
  assert.match(trailer(result), /\[exit null truncated\]/);
});

test('the cap is bytes, and a multi-byte character is never cut in half', async () => {
  // Every one of these is three bytes of UTF-8, so a cap counted in bytes has
  // room for two of them and no more — where a cap counted in string length
  // would let seven through, at more than three times the budget.
  const wide = '€'.repeat(8);
  fakeDocker({ writes: [frame(1, wide), frame(1, wide)], gapMs: 5, never: true });

  const seen: string[] = [];
  const result = await runCommand(TARGET, 'wide', (c) => seen.push(c), { maxOutputBytes: 7 });

  assert.equal(result.truncated, true);
  assert.ok(
    Buffer.byteLength(result.output, 'utf8') <= 7,
    `the byte budget holds: ${Buffer.byteLength(result.output, 'utf8')} bytes`,
  );
  assert.equal(result.output, '€€', 'cut on a character boundary, not mid-sequence');
  assert.equal(seen.join(''), result.output, 'the caller saw exactly what was captured');
  assert.ok(!result.output.includes('\ufffd'), 'no replacement character at the cut');
});

test('the default limits are the ones the endpoint documents', () => {
  assert.equal(WALL_CLOCK_MS, 120_000);
  assert.equal(MAX_OUTPUT_BYTES, 256 * 1024);
});

test('a command that never ends is killed by the wall clock', async () => {
  fakeDocker({ writes: [frame(1, 'still here\n')], never: true });

  // Nothing ends this stream, so only the timer can. The limit is a
  // parameter so the test drives the real kill path rather than waiting out
  // the two-minute default.
  const result = await runCommand(TARGET, 'sleep forever', () => {}, { wallClockMs: 100 });

  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.output, 'still here\n');
  assert.match(trailer(result), /\[exit null timed out\]/);
});

test('the trailer names both limits when both were hit', () => {
  assert.match(
    trailer({ exitCode: null, truncated: true, timedOut: true }),
    /\[exit null truncated, timed out\]/,
  );
});

test('records are stored and read back in the API shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boxes-exec-'));
  try {
    const db = openDb(dir);
    record(
      db,
      's1',
      't1',
      'git status',
      { output: 'clean\n', exitCode: 0, truncated: false, timedOut: false },
      1000,
    );
    record(
      db,
      's1',
      't1',
      'yes',
      { output: 'y'.repeat(10), exitCode: null, truncated: true, timedOut: true },
      2000,
    );
    record(
      db,
      's1',
      't2',
      'pwd',
      { output: '/workspace\n', exitCode: 0, truncated: false, timedOut: false },
      2500,
    );
    record(
      db,
      's2',
      't1',
      'ls',
      { output: '', exitCode: 0, truncated: false, timedOut: false },
      3000,
    );

    const rows = history(db, 's1', 't1');
    assert.equal(rows.length, 2, 'only this thread of this session');
    assert.equal(rows[0]!.command, 'git status');
    assert.equal(rows[0]!.exitCode, 0);
    assert.equal(rows[0]!.truncated, false);
    assert.equal(rows[1]!.exitCode, null);
    assert.equal(rows[1]!.truncated, true);
    assert.equal(rows[1]!.timedOut, true);
    assert.equal(rows[1]!.startedAt, 2000);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing container fails the run rather than the process', async () => {
  dk.setDockerForTests({
    modem: new Docker({ socketPath: '/var/run/docker.sock' }).modem,
    getContainer: () => ({
      exec: async () => {
        throw Object.assign(new Error('No such container'), { statusCode: 404 });
      },
    }),
  } as unknown as Docker);

  await assert.rejects(() => runCommand(TARGET, 'ls', () => {}), /No such container/);
});
