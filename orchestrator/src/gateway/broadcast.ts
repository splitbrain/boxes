import { TURN_STATE_METHOD, type TurnStateParams } from '../../../shared/types.ts';
import { log } from '../log.ts';
import type { DownstreamHandle } from './upstream.ts';

/**
 * A browser one thread's replay is going to, and the thread id to put on what
 * it is sent. `as` is set only when the replay is borrowed — see beginReplay.
 */
interface ReplayTarget {
  handle: DownstreamHandle;
  as?: string;
}

/**
 * Who each adapter update goes to.
 *
 * Broadcasting everything to everyone is wrong in three places, all of which
 * need more than one browser attached to show up: a phone and a desktop on
 * one session, or two tabs on two threads of one box.
 *
 * Every rule here is scoped to a thread, because every rule is about one
 * conversation. A connection is pinned to a thread and an update carries the
 * thread it is about, so routing is a lookup rather than a guess: a replay of
 * one thread leaves another thread's live updates alone, and a prompt echoed
 * on one thread is not suppressed on another.
 */
export class Broadcast {
  private readonly downstreams = new Set<DownstreamHandle>();
  /**
   * Browsers a session/load is replaying to right now, by the thread being
   * replayed. While a thread has any, its updates go only to them: a replay
   * is by definition a re-send of history, so broadcasting it would duplicate
   * that thread into every other tab watching it.
   */
  private readonly replayTargets = new Map<string, Set<ReplayTarget>>();
  /**
   * How many prompts the gateway is forwarding and has echoed itself, per
   * thread. While a thread's count is above zero the gateway, not the
   * adapter, is the authority on what the user just said on it, so an adapter
   * that echoes the prompt back does not produce a second copy.
   */
  private readonly echoingPrompts = new Map<string, number>();

  /**
   * @param stateOf Everything a browser is told about a thread. The gateway
   *   supplies it, because two thirds of it — whether the agent is speaking,
   *   and what it left running in the background — are known upstream of this
   *   class. The default is the part this class knows on its own, which is
   *   what a test about routing wants.
   */
  constructor(
    private readonly sessionId: string,
    private readonly stateOf: (acpThreadId: string) => TurnStateParams = (acpThreadId) => ({
      sessionId: acpThreadId,
      active: this.isPrompting(acpThreadId),
      speaking: false,
      background: [],
    }),
  ) {}

  /** How many browsers are attached, across every thread. */
  get size(): number {
    return this.downstreams.size;
  }

  /** The ACP threads at least one browser is watching. */
  get watchedThreads(): string[] {
    const threads = new Set<string>();
    for (const d of this.downstreams) {
      if (d.acpThreadId) threads.add(d.acpThreadId);
    }
    return [...threads];
  }

  /** Browsers watching one thread, most recently active first. */
  byRecency(acpThreadId: string): DownstreamHandle[] {
    return [...this.downstreams]
      .filter((d) => d.acpThreadId === acpThreadId)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /** Every attached browser, whichever thread it watches. */
  get all(): DownstreamHandle[] {
    return [...this.downstreams];
  }

  /**
   * Adds a browser. Its thread may still be resolving, in which case it is
   * counted as attached — it is holding a socket open — but nothing is routed
   * to it until it has one.
   */
  add(handle: DownstreamHandle): void {
    this.downstreams.add(handle);
  }

  /** Drops a browser, including from a replay it will never finish reading. */
  remove(handle: DownstreamHandle): void {
    this.downstreams.delete(handle);
    for (const [thread, targets] of this.replayTargets) {
      for (const target of targets) {
        if (target.handle === handle) targets.delete(target);
      }
      if (targets.size === 0) this.replayTargets.delete(thread);
    }
  }

  clear(): void {
    this.downstreams.clear();
    this.replayTargets.clear();
    this.echoingPrompts.clear();
  }

  /** Routes one adapter update to the browsers watching the thread it is about. */
  update(params: unknown): void {
    const thread = threadOf(params);
    // An update that names no thread cannot be routed. Broadcasting it to
    // everyone is what this class exists to stop.
    if (!thread) return;

    const replaying = this.replayTargets.get(thread);
    // A prompt the gateway has already echoed on this thread: whatever the
    // adapter says the user said is the same thing, and sending it again
    // would double it. Replay is exempt, because there the adapter is reading
    // back history the gateway never saw.
    if (
      !replaying &&
      (this.echoingPrompts.get(thread) ?? 0) > 0 &&
      updateKind(params) === 'user_message_chunk'
    ) {
      return;
    }
    // A replay goes to the browsers reading it and to nobody else, each
    // under the thread id it asked about — which is the source's own for an
    // ordinary replay, and the fork's for a borrowed one.
    if (replaying) {
      for (const target of replaying) {
        this.deliver([target.handle], target.as ? retag(params, target.as) : params);
      }
      return;
    }
    // With nobody on this thread the update is dropped rather than broadcast,
    // which is what stops a background thread's stream reaching the wrong tab.
    this.deliver(this.byRecency(thread), params);
  }

  /**
   * Tells the browsers watching a thread what was just prompted on it, and
   * opens the window in which the gateway owns what the user said.
   *
   * The adapter is not required to echo a prompt live — it only has to replay
   * it later — so without this the browser that sent it sees nothing until
   * its next reload, and a second device on the same thread sees nothing at
   * all.
   */
  beginPrompt(params: unknown): void {
    const thread = threadOf(params);
    if (!thread) return;
    const before = this.echoingPrompts.get(thread) ?? 0;
    this.echoingPrompts.set(thread, before + 1);
    // The first prompt on a thread is what starts its turn; a second one
    // arriving while that runs does not start a second turn.
    if (before === 0) this.threadState(thread);
    const blocks = (params as { prompt?: unknown })?.prompt;
    if (!Array.isArray(blocks)) return;
    for (const content of blocks) {
      this.deliver(this.byRecency(thread), {
        sessionId: thread,
        update: { sessionUpdate: 'user_message_chunk', content },
      });
    }
  }

  /** Ends the window in which the gateway owns what the user said on a thread. */
  endPrompt(params: unknown): void {
    const thread = threadOf(params);
    if (!thread) return;
    const left = (this.echoingPrompts.get(thread) ?? 0) - 1;
    if (left > 0) {
      this.echoingPrompts.set(thread, left);
      return;
    }
    this.echoingPrompts.delete(thread);
    this.threadState(thread);
  }

  /** Whether the gateway is carrying a prompt on a thread right now. */
  isPrompting(acpThreadId: string): boolean {
    return (this.echoingPrompts.get(acpThreadId) ?? 0) > 0;
  }

  /**
   * Tells the browsers watching a thread what it is doing.
   *
   * The one thing a browser cannot work out for itself: a turn it did not
   * start, on a thread it has only just re-opened, is indistinguishable from
   * a finished one until somebody says — and so is a monitor left running in
   * the box an hour ago. See TURN_STATE_METHOD.
   */
  threadState(acpThreadId: string): void {
    this.send(this.byRecency(acpThreadId), TURN_STATE_METHOD, this.stateOf(acpThreadId));
  }

  /** The same, to one browser: what a fresh connection is told after its replay. */
  threadStateTo(handle: DownstreamHandle): void {
    if (!handle.acpThreadId) return;
    this.send([handle], TURN_STATE_METHOD, this.stateOf(handle.acpThreadId));
  }

  /**
   * Re-states every watched thread, for whoever has just changed something
   * true of all of them — an adapter that exited, a session stopping.
   */
  refreshThreadStates(): void {
    for (const thread of this.watchedThreads) this.threadState(thread);
  }

  /**
   * Starts routing one thread's updates to one browser only, for the length
   * of its replay. Another thread's updates are untouched, which is what lets
   * a second tab keep streaming while this one rebuilds.
   *
   * `as` re-tags what is replayed with another thread's id: a fork with no
   * transcript of its own is shown the source's, and the browser reading it
   * is pinned to the fork, so an update naming the source would be dropped as
   * some other conversation's.
   */
  beginReplay(handle: DownstreamHandle, acpThreadId: string, as?: string): void {
    let targets = this.replayTargets.get(acpThreadId);
    if (!targets) {
      targets = new Set();
      this.replayTargets.set(acpThreadId, targets);
    }
    targets.add({ handle, as });
  }

  /** Ends that, returning the thread to its watchers. */
  endReplay(handle: DownstreamHandle, acpThreadId: string): void {
    const targets = this.replayTargets.get(acpThreadId);
    if (!targets) return;
    for (const target of targets) {
      if (target.handle === handle) targets.delete(target);
    }
    if (targets.size === 0) this.replayTargets.delete(acpThreadId);
  }

  /** Sends one update to a set of browsers, surviving any one of them failing. */
  private deliver(targets: Iterable<DownstreamHandle>, params: unknown): void {
    this.send(targets, 'session/update', params);
  }

  /** Sends one notification to a set of browsers, surviving any one failing. */
  private send(targets: Iterable<DownstreamHandle>, method: string, params: unknown): void {
    for (const d of targets) {
      try {
        d.notify(method, params);
      } catch (err) {
        log.session(this.sessionId).warn('broadcast failed', {
          method,
          error: (err as Error).message,
        });
      }
    }
  }
}

/** The same update, said to be about another thread. */
function retag(params: unknown, acpThreadId: string): unknown {
  return { ...(params as Record<string, unknown>), sessionId: acpThreadId };
}

/** The ACP thread a message is about, or undefined when it names none. */
export function threadOf(params: unknown): string | undefined {
  const sessionId = (params as { sessionId?: unknown })?.sessionId;
  return typeof sessionId === 'string' && sessionId ? sessionId : undefined;
}

/** The kind of a session/update notification, or undefined for anything else. */
function updateKind(params: unknown): string | undefined {
  const update = (params as { update?: { sessionUpdate?: unknown } })?.update;
  return typeof update?.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
}
