import type { ExecRecord } from '../../shared/types.ts';
import { appendExecLog, listExecLog, type Db, type ExecRow } from './db.ts';
import * as dk from './docker.ts';
import { log } from './log.ts';

/**
 * Local commands: the `!bang` escape hatch, run inside the session container.
 *
 * The command runs in the container's existing isolation — internal network,
 * read-only rootfs, capabilities dropped, non-root user — so this introduces
 * no privilege the agent does not already have. Nothing here shell-executes
 * on the host: the command travels as an argument to `bash -lc` inside the
 * container and never reaches a host command line.
 */

/** Longest a command may run before it is killed, in milliseconds. */
export const WALL_CLOCK_MS = 120_000;

/** Most output a command may produce before the rest is dropped, in bytes. */
export const MAX_OUTPUT_BYTES = 256 * 1024;

/** How a finished run ended. */
export interface ExecOutcome {
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
}

/** What runCommand needs to know about the session it is running in. */
export interface ExecTarget {
  containerId: string;
  /** Where the command runs; the workspace root, as the adapter does. */
  workingDir: string;
}

/** The limits one run is held to. Both default to the constants above. */
export interface ExecLimits {
  wallClockMs?: number;
  maxOutputBytes?: number;
}

/**
 * The longest prefix of `text` that fits in `maxBytes` bytes of UTF-8, cut on
 * a character boundary.
 *
 * The cap is in bytes because that is what bounds the response and the stored
 * row, while the chunk is a string: slicing by length overshoots the budget
 * by up to four times on non-ASCII output. A UTF-8 continuation byte is
 * `10xxxxxx`, so walking back over those from the cut lands on the start of
 * the character being dropped.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}

/**
 * Runs one command, streaming its combined output to `onChunk`.
 *
 * Both limits are enforced here rather than left to the container: output
 * past the cap is dropped and the exec killed, so a `yes` cannot fill the
 * response, and the wall clock kills a command that never ends.
 */
export async function runCommand(
  target: ExecTarget,
  command: string,
  onChunk: (chunk: string) => void,
  limits: ExecLimits = {},
): Promise<ExecOutcome & { output: string }> {
  const wallClockMs = limits.wallClockMs ?? WALL_CLOCK_MS;
  const maxOutputBytes = limits.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  const exec = await dk.runCommandExec(target.containerId, command, target.workingDir);

  let bytes = 0;
  let truncated = false;
  let timedOut = false;
  const captured: string[] = [];

  const timer = setTimeout(() => {
    timedOut = true;
    exec.kill();
  }, wallClockMs);

  await new Promise<void>((resolve) => {
    exec.output.setEncoding('utf8');
    exec.output.on('data', (chunk: string) => {
      if (truncated) return;
      const piece = truncateToBytes(chunk, maxOutputBytes - bytes);
      if (piece) {
        bytes += Buffer.byteLength(piece, 'utf8');
        captured.push(piece);
        onChunk(piece);
      }
      // Whether the cap left anything of this chunk out, rather than whether
      // the byte total reached it: the cut lands on a character boundary, so
      // the last byte or two of the budget can be unspendable.
      if (piece.length < chunk.length) {
        truncated = true;
        exec.kill();
      }
    });
    exec.output.on('end', resolve);
    exec.output.on('close', resolve);
    exec.output.on('error', () => resolve());
  });

  clearTimeout(timer);
  const exitCode = truncated || timedOut ? null : await exec.exited;

  return { output: captured.join(''), exitCode, truncated, timedOut };
}

/** The trailer line every exec response ends with, carrying the exit code. */
export function trailer(outcome: ExecOutcome): string {
  const notes = [outcome.truncated ? 'truncated' : '', outcome.timedOut ? 'timed out' : '']
    .filter(Boolean)
    .join(', ');
  return `\n[exit ${outcome.exitCode ?? 'null'}${notes ? ` ${notes}` : ''}]\n`;
}

/**
 * Records one finished run, and never lets a failed write break the response.
 *
 * The outcome carries the output, which is the shape {@link runCommand}
 * returns, so one run's text cannot be stored against another's exit code.
 *
 * The thread is what the run is listed under. Null when the session had no
 * thread to log it against, which stores a row nobody is shown.
 */
export function record(
  db: Db,
  sessionId: string,
  threadId: string | null,
  command: string,
  outcome: ExecOutcome & { output: string },
  startedAt: number,
): void {
  try {
    appendExecLog(db, sessionId, {
      thread_id: threadId,
      command,
      output: truncateToBytes(outcome.output, MAX_OUTPUT_BYTES),
      exit_code: outcome.exitCode,
      truncated: outcome.truncated ? 1 : 0,
      timed_out: outcome.timedOut ? 1 : 0,
      started_at: startedAt,
      finished_at: Date.now(),
    });
  } catch (err) {
    log.session(sessionId).warn('exec_log write failed', { error: (err as Error).message });
  }
}

/** One stored row in the shape the API returns. */
function toRecord(row: ExecRow): ExecRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    command: row.command,
    output: row.output,
    exitCode: row.exit_code,
    truncated: row.truncated === 1,
    timedOut: row.timed_out === 1,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** Every command already run in one thread, oldest first. */
export function history(db: Db, sessionId: string, threadId: string): ExecRecord[] {
  return listExecLog(db, sessionId, threadId).map(toRecord);
}
