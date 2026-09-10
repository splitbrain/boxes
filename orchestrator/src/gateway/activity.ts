import { startsBackgroundWork } from './background.ts';

/**
 * Whether the agent is producing output on a thread, now.
 *
 * ACP has no word for it: there is no "the agent is done for now"
 * notification and no stop reason on a prompt being deferred. This adapter
 * says it sideways — it sends a `usage_update` at the end of every processing
 * cycle, and that one carries a `cost` where the ones it sends while a
 * message streams do not. Its result handler emits that before deciding
 * whether to settle the turn or hold it open, so a cost-bearing usage_update
 * is the agent stopping, for a held turn and for a cycle the harness woke on
 * its own alike.
 *
 * It is not promised: the adapter sends it only when the backend reported
 * usage, and no other adapter promises anything of the sort. So silence is
 * the fallback — an update says the agent is working, and silence, once it
 * has lasted `quietMs`, says it has stopped.
 *
 * The one exception is a tool call the agent is waiting on. An `npm test`
 * that runs for two minutes emits nothing while it runs, so a thread with an
 * open call stays speaking however quiet it goes. A call that backgrounds its
 * work is the opposite and is not counted, which is why this and
 * `background.ts` share the predicate that decides which those are.
 *
 * Two thresholds, because the two readers want opposite things. The UI flips
 * at `quietMs`, where an early flip only shows a send button while the model
 * thinks between tool calls. The push waits for `settleMs`, because "your
 * turn has finished" on a lock screen is a claim that cannot be taken back.
 * Neither is consulted when the adapter says the cycle is over.
 */

/** Cancels a delayed call, and is safe to run after it has already fired. */
type Cancel = () => void;

/** Runs `fn` in `ms`. Injected, so a test can decide when later is. */
export type Delay = (ms: number, fn: () => void) => Cancel;

/** The real one, which never holds the process open at shutdown. */
const realDelay: Delay = (ms, fn) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/**
 * Update kinds that are the agent at work.
 *
 * An allowlist rather than "anything that arrives", because some updates are
 * about the thread rather than from the agent — the mode the user just set,
 * the command list the adapter sends at startup — and a thread that flashed
 * as working every time somebody opened the settings would teach its reader
 * to ignore the signal.
 *
 * `user_message_chunk` is in it. That is the prompt somebody sent, or the
 * harness waking the agent with a task's report: either way something has
 * just been given to the agent, and the answer to "is it working" is yes
 * before its first token arrives.
 */
const AT_WORK = new Set([
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
]);

/** Tool call statuses that say the call is over, either way. */
const FINISHED = new Set(['completed', 'failed']);

/** What is known about one thread. */
interface ThreadState {
  speaking: boolean;
  /** Foreground tool calls announced and not yet finished. */
  open: Set<string>;
  /** Cancels whichever timer is armed: the quiet one, or the settle one. */
  cancel: Cancel | null;
}

export class Activity {
  private readonly threads = new Map<string, ThreadState>();
  private readonly quietMs: number;
  private readonly settleMs: number;
  private readonly delay: Delay;
  private readonly onChange: (acpThreadId: string, speaking: boolean) => void;
  private readonly onSettled: (acpThreadId: string) => void;

  /**
   * @param onChange Run on every transition, to tell the browsers watching.
   * @param onSettled Run once a thread has been quiet for `settleMs`, which
   *   is what a "turn finished" notification is worth sending on.
   */
  constructor(opts: {
    quietMs: number;
    settleMs: number;
    onChange: (acpThreadId: string, speaking: boolean) => void;
    onSettled: (acpThreadId: string) => void;
    delay?: Delay;
  }) {
    this.quietMs = opts.quietMs;
    this.settleMs = opts.settleMs;
    this.onChange = opts.onChange;
    this.onSettled = opts.onSettled;
    this.delay = opts.delay ?? realDelay;
  }

  /** Whether the agent is producing output on this thread. */
  speaking(acpThreadId: string): boolean {
    return this.threads.get(acpThreadId)?.speaking === true;
  }

  /** The threads believed to be working, for a session-wide answer. */
  get speakingThreads(): string[] {
    return [...this.threads]
      .filter(([, state]) => state.speaking)
      .map(([thread]) => thread);
  }

  /**
   * A prompt has just been forwarded on this thread.
   *
   * The agent is working from here rather than from its first token, so the
   * browser that sent the prompt gets its spinner in one hop instead of
   * waiting out the model's own latency.
   */
  begin(acpThreadId: string): void {
    this.mark(acpThreadId);
  }

  /**
   * Reads one live `session/update` for what it says about the agent.
   *
   * Replayed updates must not reach this — a transcript is a record of work
   * that has already happened, and reading one would show a working agent for
   * as long as the replay takes. The caller holds that line, the same one it
   * holds for `background.ts`.
   */
  observe(acpThreadId: string, update: unknown): void {
    if (!update || typeof update !== 'object') return;
    const u = update as {
      sessionUpdate?: string;
      toolCallId?: string;
      status?: string;
      name?: string;
      rawInput?: unknown;
      cost?: unknown;
      _meta?: { claudeCode?: { toolName?: string } };
    };
    // The end of a processing cycle, said outright. Whatever was open is
    // over: a turn does not end with the agent still waiting on a call, and a
    // cancelled one is not waiting for it any more either.
    if (u.sessionUpdate === 'usage_update' && endsCycle(u)) {
      this.stop(acpThreadId);
      return;
    }
    if (!u.sessionUpdate || !AT_WORK.has(u.sessionUpdate)) return;

    if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      this.track(acpThreadId, u);
    }
    this.mark(acpThreadId);
  }

  /**
   * Follows one tool call, so that the silence while it runs is not read as
   * the agent having stopped.
   *
   * A call that backgrounds its work is not followed: that is the whole point
   * of backgrounding it, and the box stays awake for it either way, which is
   * `background.ts`'s job.
   */
  private track(
    acpThreadId: string,
    call: {
      toolCallId?: string;
      status?: string;
      name?: string;
      rawInput?: unknown;
      _meta?: { claudeCode?: { toolName?: string } };
    },
  ): void {
    if (!call.toolCallId) return;
    const state = this.state(acpThreadId);
    if (FINISHED.has(call.status ?? '') || startsBackgroundWork(call)) {
      state.open.delete(call.toolCallId);
      return;
    }
    state.open.add(call.toolCallId);
  }

  /** The agent is working on this thread; the clock on its silence restarts. */
  private mark(acpThreadId: string): void {
    const state = this.state(acpThreadId);
    state.cancel?.();
    state.cancel = this.delay(this.quietMs, () => this.quiet(acpThreadId));
    if (state.speaking) return;
    state.speaking = true;
    this.onChange(acpThreadId, true);
  }

  /**
   * The agent has stopped, on the adapter's own say-so rather than on a
   * timer. Everything a timer would eventually have concluded, concluded now.
   */
  private stop(acpThreadId: string): void {
    const state = this.threads.get(acpThreadId);
    if (!state) return;
    state.cancel?.();
    state.cancel = null;
    state.open.clear();
    if (state.speaking) {
      state.speaking = false;
      this.onChange(acpThreadId, false);
    }
    this.armSettle(acpThreadId, this.settleMs);
  }

  /**
   * `quietMs` with nothing said. Either a call the agent is waiting on is
   * still open — in which case the silence means nothing and the wait starts
   * again — or the agent has stopped.
   */
  private quiet(acpThreadId: string): void {
    const state = this.threads.get(acpThreadId);
    if (!state) return;
    state.cancel = null;
    if (state.open.size > 0) {
      state.cancel = this.delay(this.quietMs, () => this.quiet(acpThreadId));
      return;
    }
    if (!state.speaking) return;
    state.speaking = false;
    this.onChange(acpThreadId, false);
    // And now the slower question. The rest of `settleMs` from the last thing
    // the agent said, so a turn that pauses to think is not announced as
    // finished to somebody who is not there to see it resume.
    this.armSettle(acpThreadId, Math.max(this.settleMs - this.quietMs, 0));
  }

  /** Waits out the quiet a notification is worth sending on. */
  private armSettle(acpThreadId: string, ms: number): void {
    const state = this.threads.get(acpThreadId);
    if (!state) return;
    state.cancel = this.delay(ms, () => {
      const current = this.threads.get(acpThreadId);
      if (!current || current.speaking) return;
      current.cancel = null;
      this.onSettled(acpThreadId);
    });
  }

  /**
   * Forgets a thread without announcing anything: for a cancelled turn, whose
   * caller publishes the new state itself.
   */
  reset(acpThreadId: string): void {
    const state = this.threads.get(acpThreadId);
    if (!state) return;
    state.cancel?.();
    this.threads.delete(acpThreadId);
  }

  /** Forgets every thread, for a session whose adapter is gone. */
  clear(): void {
    for (const state of this.threads.values()) state.cancel?.();
    this.threads.clear();
  }

  private state(acpThreadId: string): ThreadState {
    let state = this.threads.get(acpThreadId);
    if (!state) {
      state = { speaking: false, open: new Set(), cancel: null };
      this.threads.set(acpThreadId, state);
    }
    return state;
  }
}

/**
 * Whether a `usage_update` is the one the adapter sends at the end of a
 * processing cycle, rather than one of the running totals it sends while a
 * message streams.
 *
 * The cost is what tells them apart: the end-of-cycle update carries the
 * cycle's own `total_cost_usd`, and the streaming ones carry only the tokens
 * used and the window size. An adapter that sends neither leaves this false
 * and the timers do the work.
 */
function endsCycle(update: { cost?: unknown }): boolean {
  return typeof update.cost === 'object' && update.cost !== null;
}
