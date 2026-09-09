import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * How much disk a session is taking up, measured in the background and read
 * from a cache.
 *
 * Two directories rather than one: the workspace the agent works in, and the
 * home its thread history, tool caches and runtime installs are in — which on
 * a box that has been working is usually the larger of the two. They are
 * summed rather than reported apart, because the question a card is answering
 * is how big this box has got.
 *
 * The session list is polled every five seconds, and walking a workspace is
 * the most expensive thing anything on that path could do: a checkout with a
 * `node_modules` in it is a hundred thousand files, and there may be a dozen
 * sessions. So a request never waits for a measurement. `bytes()` answers
 * with what was last measured — null before the first one — and starts a walk
 * only when there is a reason to believe the answer has moved.
 *
 * Two things make that rare. A measurement stands for a quarter of an hour,
 * because the number is rounded to whole megabytes on a card and an agent
 * cannot write enough to shift one in less: measuring more often costs a walk
 * per session and buys a digit nobody was reading. And a box that is not up
 * is not measured at all beyond the once. Nothing is running in it, so
 * nothing in it is changing — the size a stopped session shows is a fact
 * rather than a sample, and re-walking it every quarter of an hour for the
 * days or weeks it sits there would be the whole cost of this feature, spent
 * on an answer known in advance.
 *
 * Lazy rather than a background loop, for the same reason the background
 * probe is: a deployment nobody is looking at should not be walking disk on a
 * timer. Nothing asks unless a browser is listing sessions, and then the
 * first answer is a poll behind.
 *
 * The home volume is not in this. It is a named volume the orchestrator has
 * no path to, it holds the adapter's transcripts rather than the agent's
 * work, and it is not what anybody means by "how big has this session got".
 */

/**
 * How long a measurement of a running box stands before a reader starts
 * another.
 *
 * Long, because the answer is shown rounded to two significant figures: an
 * agent would have to write a hundred megabytes for the card to change at
 * all, and one that is doing that will still be doing it in a quarter of an
 * hour. A box that has just been created is not made to wait for it — there
 * is no measurement yet, and the first read starts one.
 */
export const SESSION_SIZE_TTL_MS = 15 * 60_000;

/**
 * Apparent size of everything under a directory, in bytes.
 *
 * Sizes rather than allocated blocks — `du --apparent-size` rather than `du`.
 * The two disagree by whatever the filesystem does underneath, which for a
 * tree of many small files is most of the answer, and the one people can
 * check against is the one that adds up the files they can see.
 *
 * Symlinks are counted as nothing and never followed. `readdir` reports the
 * link itself rather than what it points at, so a link the agent planted in
 * its workspace cannot walk this out of the tree — the same containment the
 * review surface and workspace removal keep.
 *
 * A directory that disappears mid-walk is skipped, because a walk of a live
 * workspace races with the agent working in it, and half an answer is the
 * right answer for a rough number. The root is the exception: a workspace
 * that cannot be read at all is news, and throws.
 */
export async function directorySize(root: string): Promise<number> {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (dir === root) throw err;
      continue;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
      } else if (entry.isFile()) {
        try {
          total += (await lstat(child)).size;
        } catch {
          // Deleted between the readdir and the stat. Nothing to add.
        }
      }
    }
  }
  return total;
}

export interface UsageOptions {
  /**
   * The directories a session is made of, on this process's own filesystem.
   *
   * Nulls are expected and dropped: an unknown session has none of them, and
   * a session from before homes became directories has a workspace and a home
   * volume nothing out here can walk. All-null means there is nothing to
   * measure, and the session reports no size rather than a zero.
   */
  pathsOf: (sessionId: string) => Array<string | null>;
  /** How long a measurement stands. */
  ttlMs: number;
  now?: () => number;
  /** Test seam: how one directory is measured. */
  measure?: (path: string) => Promise<number>;
  onTrouble?: (sessionId: string, error: Error) => void;
}

/** What was last measured for one session, and the state it was taken in. */
interface Measurement {
  /** Null when every attempt so far has failed: an attempt is not an answer. */
  bytes: number | null;
  at: number;
  /**
   * Whether the box was up when this was taken.
   *
   * What says a stopped session still needs one walk: the last measurement
   * was of a workspace that was being written to, and the settled size is a
   * different number. Once a measurement has been taken with the box down,
   * nothing can change it, and none is taken again.
   */
  live: boolean;
}

/** Session sizes, measured off the request path and cached per session. */
export class SessionUsage {
  private readonly measured = new Map<string, Measurement>();
  /** Sessions with a walk running or queued, so a poll cannot pile them up. */
  private readonly walking = new Set<string>();
  /**
   * The walks, one after another.
   *
   * A list request asks about every session at once, and starting a dozen
   * disk walks in parallel would make all of them slower and the box less
   * responsive while they ran. They are all going to the same disk, and none
   * of them is being waited for.
   */
  private queue: Promise<void> = Promise.resolve();

  private readonly pathsOf: UsageOptions['pathsOf'];
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly measure: (path: string) => Promise<number>;
  private readonly onTrouble: (sessionId: string, error: Error) => void;

  constructor(options: UsageOptions) {
    this.pathsOf = options.pathsOf;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.measure = options.measure ?? directorySize;
    this.onTrouble = options.onTrouble ?? (() => {});
  }

  /**
   * What the session's workspace last measured, and a walk started if there
   * is reason to think that has moved.
   *
   * Null means "no answer yet" rather than "empty": before the first walk
   * finishes, and for a session with no workspace directory at all. The card
   * shows nothing rather than a zero, which would be a claim.
   *
   * `live` is whether the box could still be writing to the workspace. Only a
   * container known to be down makes it false — a Docker read that failed
   * says nothing about whether the agent is working, and freezing a size on
   * that would be freezing it on a guess.
   */
  bytes(sessionId: string, live: boolean): number | null {
    const paths = this.pathsOf(sessionId).filter((p): p is string => p !== null);
    if (paths.length === 0) return null;
    const last = this.measured.get(sessionId);
    if (this.due(last, live)) this.start(sessionId, paths, live);
    return last?.bytes ?? null;
  }

  /**
   * Drops what was measured, so the next read walks again.
   *
   * For a session going away, and for the one thing that puts enough bytes in
   * a stopped workspace to move the number: an upload. A box that is down
   * cannot grow on its own, which is the assumption the freeze above rests
   * on, and an attachment is where that would otherwise quietly stop being
   * true.
   *
   * The review surface writes into a stopped workspace too, and deliberately
   * does not call this: a REVIEW.md is kilobytes, invisible in a figure
   * rounded to two significant figures, and re-walking a checkout every time
   * somebody types a comment is the cost this cache exists to avoid.
   */
  forget(sessionId: string): void {
    this.measured.delete(sessionId);
  }

  /** Whether there is any reason to walk this workspace again. */
  private due(last: Measurement | undefined, live: boolean): boolean {
    // Nothing known about it at all.
    if (!last) return true;
    // Every attempt so far has failed. Retry on the interval rather than
    // never: a permission fixed by hand should show up eventually.
    if (last.bytes === null) return this.now() - last.at >= this.ttlMs;
    // A box that is down is measured once — the walk that settles what it was
    // left at — and then not again for as long as it stays down.
    if (!live) return last.live;
    return this.now() - last.at >= this.ttlMs;
  }

  /** Test seam: resolves once every walk started so far has finished. */
  settled(): Promise<void> {
    return this.queue;
  }

  /**
   * Queues one session's walks, unless it already has some coming.
   *
   * Its directories are walked one after another and summed, and a failure in
   * either abandons the pair: half a session's size, reported as the whole of
   * it, is worse than the answer this held a minute ago.
   */
  private start(sessionId: string, paths: readonly string[], live: boolean): void {
    if (this.walking.has(sessionId)) return;
    this.walking.add(sessionId);
    this.queue = this.queue.then(async () => {
      try {
        let bytes = 0;
        for (const path of paths) bytes += await this.measure(path);
        // Recorded against the state the box was in when the walk was asked
        // for, not the state it is in now. A session stopped while its own
        // settling walk was queued is one whose next read asks again, which
        // is the right way round to be wrong.
        this.measured.set(sessionId, { bytes, at: this.now(), live });
      } catch (err) {
        // Hold the last answer — a workspace that could not be read is not a
        // workspace known to be empty — but record the attempt, so one that
        // keeps failing is retried on the interval rather than on every
        // request.
        const last = this.measured.get(sessionId);
        this.measured.set(sessionId, { bytes: last?.bytes ?? null, at: this.now(), live });
        this.onTrouble(sessionId, err as Error);
      } finally {
        this.walking.delete(sessionId);
      }
    });
  }
}
