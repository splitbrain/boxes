import type { ContainerProcess } from '../docker.ts';

/**
 * Whether a session still has work running in it.
 *
 * A turn that leaves something running in the background ends like any other:
 * the agent says it will report back, the thread goes quiet, and — with the
 * browser closed — every test the reaper makes says the session is idle. Half
 * an hour later the container is stopped, and with it the build, the crawl or
 * the monitor watching them. Nothing says so afterwards: the thread's last
 * line is still the agent promising to report, and the report never comes.
 *
 * So the box is asked what is running in it, rather than told. This used to
 * be a tally kept from the adapter's updates: a tool call that backgrounds
 * something added an entry, and the harness's `<task-notification>` block
 * removed it again. The adding worked. The removing never happened once in
 * production — the harness delivers that block as a queued *prompt*, and the
 * ACP adapter drops a queued turn's echo from the feed as something the
 * client already knows about, which is true of a prompt the client sent and
 * false of one the harness injected. So nothing was ever removed, the tally
 * only ever grew, and a box that had run a background command was held awake
 * until a four-hour cap let go of it.
 *
 * That was an edge: a count of transitions, wrong forever after one is
 * missed. This is a level. It reads what is running now, so it cannot drift,
 * cannot wedge, and needs nothing to be reported at all — a task killed with
 * no notification, an adapter restarted, a frame lost, all answer correctly
 * on the next reading because the question is only ever about the present.
 *
 * What it cannot do is say what the work *is*. A process carries the shell
 * the harness wrapped it in rather than the words the agent chose, so "npm
 * run build" is not recoverable from here. That was the price of the trade,
 * and the answer both readers need — the reaper, and a person wondering
 * whether the agent is finished — is the boolean.
 */

/**
 * Whether any process in the container is work the agent started.
 *
 * The shape being read is the one the session image runs: the adapter Boxes
 * spawned, one agent process under it per conversation, and under those the
 * shells the agent's tool calls run in. So work is anything below an agent
 * process, and the agent processes themselves are not it.
 *
 * Foreground and background tool calls are indistinguishable here — both are
 * the same shell with the same ancestry — and they do not need to be. A
 * foreground command cannot outlive the turn waiting on it, and both callers
 * ask this only of a session with no turn running: the reaper tests that
 * first, and a thread that is mid-turn already says so without help. So at
 * the moment the question is asked, a surviving shell is background work.
 *
 * @param adapter A token from the adapter's own command line, which is the
 *   one Boxes launched and so the one thing here it names itself.
 */
export function backgroundWorkRunning(
  processes: readonly ContainerProcess[],
  adapter: string,
): boolean {
  const adapters = processes.filter((p) => p.command.includes(adapter)).map((p) => p.pid);
  // Nothing that looks like the adapter: the container is not running what
  // this expects, and a shape it cannot read is not evidence of an empty box.
  // Answering "busy" costs a session stopping later than it might; answering
  // "idle" costs one stopped with work in it, which is the mistake that has
  // no repair.
  if (adapters.length === 0) return true;

  const children = new Map<number, number[]>();
  for (const p of processes) {
    if (p.pid === p.ppid) continue;
    children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  }

  // The agents are the adapter's own children; the work is everything under
  // those. A depth rather than a name, so nothing here has to know what the
  // agent process is called.
  const agents = adapters.flatMap((pid) => children.get(pid) ?? []);
  return agents.some((pid) => (children.get(pid) ?? []).length > 0);
}

/**
 * The answer for one container, re-read no more often than `ttlMs`.
 *
 * Every reader wants a boolean it can have without waiting — the reaper mid
 * sweep, a session summary being built for a browser — and every reader wants
 * it to be current. So it is polled behind them: a reading is served from the
 * last one until it goes stale, and refreshing is something the holder does,
 * not something a reader waits on.
 */
export class BackgroundProbe {
  private busy = false;
  private readAt = -Infinity;
  private inFlight: Promise<void> | null = null;
  /** Whether the last reading failed, so the trouble is reported once. */
  private failing = false;

  /**
   * @param list How to ask the box what is running; injected so this is
   *   testable without a Docker daemon under it.
   * @param adapter A token from the adapter's command line.
   * @param ttlMs How long one reading stands for.
   * @param now Present so a test can move time without waiting for it.
   * @param onTrouble Told the error when readings start failing, and null
   *   when they start working again. Only the changes, because a probe polls:
   *   a box that cannot be read would otherwise be three lines a minute for
   *   as long as it lasts, which is how a real fault gets scrolled past. The
   *   answer this holds is a guess whenever it is failing, and a guess that
   *   holds boxes awake indefinitely is worth one line saying so.
   */
  constructor(
    private readonly list: () => Promise<ContainerProcess[]>,
    private readonly adapter: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly onTrouble: (error: Error | null) => void = () => {},
  ) {}

  /**
   * The last reading, and a refresh started if it has gone stale.
   *
   * Never awaits: the first call answers false — an empty box is what a
   * session that has just started actually has — and the reading behind it
   * arrives before the reaper's next sweep, which is minutes away.
   */
  get active(): boolean {
    if (this.now() - this.readAt >= this.ttlMs) this.refresh();
    return this.busy;
  }

  /** Reads the box, at most one reading at a time. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.list()
      .then((processes) => {
        this.busy = backgroundWorkRunning(processes, this.adapter);
        this.readAt = this.now();
        if (this.failing) {
          this.failing = false;
          this.onTrouble(null);
        }
      })
      .catch((error: Error) => {
        // A box that cannot be asked is not a box known to be empty. Hold the
        // last answer and let the next reading settle it; a container that has
        // genuinely gone is stopped by its own state, not by this.
        this.readAt = this.now();
        if (!this.failing) {
          this.failing = true;
          this.onTrouble(error);
        }
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

/** Claude Code tools that run in the background whatever their input says. */
const ALWAYS_BACKGROUND = new Set(['Monitor', 'Workflow']);

/**
 * Whether a tool call leaves something running after the turn that made it.
 *
 * Asked in activity.ts, which is a different question about the same calls: a
 * call that runs in the background is exactly the call whose silence says
 * nothing about whether the agent is still working.
 */
export function startsBackgroundWork(update: {
  name?: string;
  rawInput?: unknown;
  _meta?: { claudeCode?: { toolName?: string } };
}): boolean {
  const input = update.rawInput;
  if (
    input &&
    typeof input === 'object' &&
    (input as { run_in_background?: unknown }).run_in_background === true
  ) {
    return true;
  }
  const tool = update._meta?.claudeCode?.toolName ?? update.name ?? null;
  return typeof tool === 'string' && ALWAYS_BACKGROUND.has(tool);
}
