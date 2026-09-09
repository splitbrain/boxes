/**
 * Rough indicators: how long ago, and how big.
 *
 * Both are for a card in a list, where the reader is scanning rather than
 * reading — "which of these did I touch this morning", "which one has a
 * checkout in it". One or two characters of magnitude answers that, and a
 * precise figure would be a worse answer at the same size: exact is what the
 * details view is for, and what these deliberately are not.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * An age as one number and one letter: `5s`, `5m`, `5h`, `5d`.
 *
 * Always the largest unit that leaves a whole number, and always rounded
 * down, so a thread is never said to be older than it is. Days keep counting
 * rather than becoming weeks or months: past a day the number is a rough
 * sense of how stale something is, and `40d` says that better than `1mo`.
 *
 * A negative age is `0s` — the clocks are the browser's and the
 * orchestrator's, and they disagree by however far apart they are set.
 */
export function shortAge(ms: number): string {
  if (ms < MINUTE) return `${Math.max(Math.floor(ms / SECOND), 0)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

/** The units a size is said in, smallest first, each 1024 of the last. */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * A byte count at the magnitude a person would say it: `12 KB`, `5.2 MB`,
 * `1.4 GB`.
 *
 * One decimal below ten and none above it, which is the precision that fits
 * the question — the difference between 340 MB and 341 MB is nothing to
 * anybody, and between 1.4 GB and 2 GB is everything.
 *
 * Not `formatBytes` from attachments.ts, which names one file somebody just
 * picked: there a tenth of a kilobyte is the file they chose, and nothing
 * that goes through a file picker is measured in gigabytes. A workspace is
 * the other end of both.
 */
export function shortSize(bytes: number): string {
  let value = Math.max(bytes, 0);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  // Bytes are whole things; a tenth of one is not a number to print.
  const digits = unit > 0 && value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}
