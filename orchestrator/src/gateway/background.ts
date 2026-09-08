import type { ContainerProcess } from '../docker.ts';
import type { BackgroundProcess } from '../../../shared/types.ts';

/**
 * What is running in a session's box, and which conversation left it there.
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
 * The reading is per conversation, because that is the question a reader
 * asks. It was a boolean about the whole box once, and every thread was sent
 * it: a shell one conversation left behind said "something is still running"
 * on all of them, including a thread opened a minute ago that had never run
 * anything. The box does say which conversation each process belongs to — see
 * `readTree` — and the answer is only useful once it does, because the
 * stop button beside it has to reach the work rather than the reader's own
 * conversation.
 */

/**
 * The conversation an agent process is running, read off its command line.
 *
 * The SDK spawns the CLI with the session it is to be, so the id is on the
 * process: `--session-id=<uuid>` for a conversation the adapter minted or
 * forked, `--resume=<uuid>` for one it loaded after a restart. Both are the
 * adapter's own id for the thread — `createSession` passes the ACP session id
 * as one or the other — which is the id every ACP message names and the id
 * the threads table stores. So no bookkeeping is needed to tie a process to a
 * conversation: it is written on the process.
 *
 * `--session-id` wins where both appear, which is a fork: `--resume` names
 * the conversation it was forked *from*, and its work is not that one's.
 * `--resume-session-at` is a message id rather than a session id, and does
 * not match — the `=` is part of what is looked for.
 */
export function threadOfAgent(command: string): string | null {
  return (
    /(?:^|\s)--session-id=(\S+)/.exec(command)?.[1] ??
    /(?:^|\s)--resume=(\S+)/.exec(command)?.[1] ??
    null
  );
}

/** One reading of a box: what is running in it, by conversation. */
export interface BackgroundReading {
  /**
   * Work under each conversation's agent process, by the adapter's own id for
   * that thread. Only conversations with something running appear.
   */
  byThread: ReadonlyMap<string, BackgroundProcess[]>;
  /**
   * Whether anything is running under an agent process whose conversation
   * could not be read.
   *
   * It counts for the box and belongs to no thread: it holds the reaper off
   * the way any other work does, and there is no conversation to show it
   * beside. A reading that could not be taken at all is this too — see
   * `readBackgroundWork`.
   */
  unattributed: boolean;
}

/** Nothing running anywhere, which is what an empty box reads as. */
const NOTHING: BackgroundReading = { byThread: new Map(), unattributed: false };

/** Whether a reading has anything in it at all, which is what the reaper asks. */
export function anyWorkRunning(reading: BackgroundReading): boolean {
  return reading.unattributed || reading.byThread.size > 0;
}

/**
 * A stable id for one running process, from the command line it is running.
 *
 * The pid cannot be it. `docker top` runs `ps` on the host, so the pids it
 * reports are the host's and mean nothing inside the container — where the
 * kill has to happen. The command line is the same string in both places and
 * identifies the call on its own: the harness gives every tool call its own
 * `/tmp/claude-<hex>-cwd` to write its working directory to, so two runs of
 * the same command are two different strings here.
 *
 * FNV-1a, because this needs to be short, stable across readings, and the
 * same on both sides of a stop request. It is not a security boundary: the
 * stop resolves it against the box's own processes and can only ever match
 * something the box is running.
 */
export function processId(command: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < command.length; i += 1) {
    hash ^= command.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * What the agent asked for, out of the shell the harness wrapped it in.
 *
 * A tool call's process is not the command the agent wrote. It is a shell
 * restoring a snapshot, undoing an alias, then `eval`-ing the command and
 * writing its working directory somewhere for the next call to pick up:
 *
 *     /bin/bash -c source /home/agent/.claude/shell-snapshots/snapshot-….sh
 *       2>/dev/null || true && shopt -u extglob … && eval 'npm run build'
 *       < /dev/null && pwd -P >| /tmp/claude-9138-cwd
 *
 * The words the agent chose are in there, between the quotes. Boxes said for
 * a while that they were not — that a process carried the wrapper and the
 * command was lost with it — and built the bar that says so around it. They
 * are simply in the middle of the line.
 *
 * Anything that is not that shape is its own name: a process the harness did
 * not wrap, or a wrapper of some later shape, reads better as itself than as
 * a failed parse.
 */
export function commandOf(process: string): string {
  const eval_ = /(?:^|\s)eval '((?:[^']|'\\'')*)'/.exec(process);
  if (!eval_) return process.trim();
  // `bash -c` is given the command single-quoted, so a quote inside it
  // arrives as the four characters that close, escape and reopen.
  return (eval_[1] ?? '').replaceAll(`'\\''`, `'`).trim();
}

/**
 * The adapter processes in a box, and every agent under them with the
 * conversation each is running — null where a process is an agent but does
 * not say which conversation it is.
 *
 * The shape being read is the one the session image runs: the adapter Boxes
 * spawned, one agent process under it per conversation, and under those the
 * shells the agent's tool calls run in. So the adapter's own children are
 * agents, by depth, and that alone was the rule once.
 *
 * The id on a command line is the other half. A process carrying one is an
 * agent wherever it sits under the adapter, so a launcher or a re-exec
 * between the two does not make the real agent look like work; and an agent
 * is never work itself, so the same wrapper does not make it look busy. The
 * depth rule is kept underneath as the safe answer for an agent that names no
 * conversation: its work is real, and only who to show it to is unknown.
 */
function readTree(
  processes: readonly ContainerProcess[],
  adapter: string,
): { adapters: ReadonlySet<number>; agents: ReadonlyMap<number, string | null> } {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  /** Whether any of `pids` is above a process, however far up. */
  const under = (start: ContainerProcess, pids: ReadonlySet<number>): boolean => {
    const seen = new Set<number>();
    let at: ContainerProcess | undefined = start;
    while (at && !seen.has(at.pid)) {
      seen.add(at.pid);
      if (pids.has(at.ppid)) return true;
      at = byPid.get(at.ppid);
    }
    return false;
  };

  // The agents first, because they are what tells the adapter apart from
  // them. `claude-agent-acp` is the name of the adapter's *package*, and the
  // CLI it spawns lives inside that package's own node_modules — so the token
  // Boxes launched the adapter with is on the agent's command line too, three
  // directories into a path. What is not is a conversation id: that is on
  // every agent and on nothing else.
  const named = new Set(
    processes.filter((p) => threadOfAgent(p.command) !== null).map((p) => p.pid),
  );
  const adapters = new Set(
    processes
      .filter((p) => p.command.includes(adapter) && !named.has(p.pid) && !under(p, named))
      .map((p) => p.pid),
  );

  const agents = new Map<number, string | null>();
  for (const p of processes) {
    if (adapters.has(p.pid)) continue;
    const thread = threadOfAgent(p.command);
    if (thread !== null) {
      // A stray id outside the adapter's tree is not a conversation this
      // connection has anything to do with.
      if (under(p, adapters)) agents.set(p.pid, thread);
      continue;
    }
    if (adapters.has(p.ppid)) agents.set(p.pid, null);
  }
  return { adapters, agents };
}

/**
 * One reading: what is running in the box, and whose it is.
 *
 * Work is what sits under an agent process. Each of an agent's own children
 * is one entry — a tool call is one shell, whatever that shell then spawns —
 * and what is under it is that entry's own tree, which the stop takes with
 * it.
 *
 * Foreground and background calls are the same shell with the same ancestry,
 * and nothing here tells them apart. It does not need to: a foreground
 * command cannot outlive the turn waiting on it, so a shell that is still
 * here when the thread is quiet is background work, and one that is here
 * mid-turn is the turn — which the thread already says for itself.
 *
 * @param adapter A token from the adapter's own command line, which is the
 *   one Boxes launched and so the one thing here it names itself.
 * @param now Epoch milliseconds, for turning an age into a start time.
 */
export function readBackgroundWork(
  processes: readonly ContainerProcess[],
  adapter: string,
  now: number = Date.now(),
): BackgroundReading {
  const { adapters, agents } = readTree(processes, adapter);
  // Nothing that looks like the adapter: the container is not running what
  // this expects, and a shape it cannot read is not evidence of an empty box.
  // Answering "busy" costs a session stopping later than it might; answering
  // "idle" costs one stopped with work in it, which is the mistake that has
  // no repair.
  if (adapters.size === 0) return { byThread: new Map(), unattributed: true };

  const byThread = new Map<string, BackgroundProcess[]>();
  let unattributed = false;
  for (const p of processes) {
    if (p.pid === p.ppid) continue;
    if (agents.has(p.pid)) continue;
    if (!agents.has(p.ppid)) continue;
    const thread = agents.get(p.ppid) ?? null;
    if (thread === null) {
      unattributed = true;
      continue;
    }
    const entry: BackgroundProcess = {
      id: processId(p.command),
      command: commandOf(p.command),
      startedAt: p.elapsedSeconds === null ? null : now - p.elapsedSeconds * 1000,
    };
    byThread.set(thread, [...(byThread.get(thread) ?? []), entry]);
  }
  return { byThread, unattributed };
}

/**
 * The pids to kill to stop a thread's work, deepest first.
 *
 * One entry is a whole tree: the shell a tool call runs in, and whatever that
 * shell started. Killing the shell alone would leave `npm run build` running
 * with init for a parent, out of the reading — a box that looks empty with a
 * build still in it, which is worse than not having stopped it. Children
 * first, for the same reason: a parent killed first hands its children to
 * init before they are signalled.
 *
 * `id` picks one entry; without one, everything that conversation has left
 * running. Nothing else can be named: an agent process is never a target, and
 * neither is work belonging to another thread.
 *
 * The processes must be the container's own reading, because these numbers
 * are about to be handed to a `kill` inside it.
 */
export function workToStop(
  processes: readonly ContainerProcess[],
  adapter: string,
  acpThreadId: string,
  id?: string,
): number[] {
  const { agents } = readTree(processes, adapter);
  const children = new Map<number, ContainerProcess[]>();
  for (const p of processes) {
    if (p.pid === p.ppid) continue;
    children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  }

  const roots = processes.filter(
    (p) =>
      !agents.has(p.pid) &&
      agents.get(p.ppid) === acpThreadId &&
      (id === undefined || processId(p.command) === id),
  );

  const doomed: number[] = [];
  const seen = new Set<number>();
  const walk = (p: ContainerProcess): void => {
    if (seen.has(p.pid) || agents.has(p.pid)) return;
    seen.add(p.pid);
    for (const child of children.get(p.pid) ?? []) walk(child);
    // After its own children, so the list runs from the leaves up.
    doomed.push(p.pid);
  };
  for (const root of roots) walk(root);
  return doomed;
}

/** The ids in one reading of one thread, which is what a change is measured in. */
function shapeOf(entries: readonly BackgroundProcess[] | undefined): string {
  return (entries ?? [])
    .map((e) => e.id)
    .sort()
    .join(',');
}

/** Every thread whose work differs between two readings. */
function changedThreads(before: BackgroundReading, after: BackgroundReading): string[] {
  const threads = new Set([...before.byThread.keys(), ...after.byThread.keys()]);
  return [...threads].filter(
    (t) => shapeOf(before.byThread.get(t)) !== shapeOf(after.byThread.get(t)),
  );
}

/**
 * The answer for one container, re-read no more often than `ttlMs`.
 *
 * Every reader wants an answer it can have without waiting — the reaper mid
 * sweep, a session summary being built for a browser — and every reader wants
 * it to be current. So it is polled behind them: a reading is served from the
 * last one until it goes stale, and refreshing is something the holder does,
 * not something a reader waits on.
 *
 * A level has to be pushed as well as read. Nothing reports a build finishing
 * and nothing ever will, so a browser that is shown "still running" learns it
 * has stopped only when this notices: `onChange` is how the bar above a
 * composer goes away, and without it the bar was permanent for as long as the
 * thread stayed open.
 */
export class BackgroundProbe {
  private reading: BackgroundReading = NOTHING;
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
   * @param onChange Told which conversations' work has changed, whenever a
   *   reading differs from the one before it. Only those, so a poll over a
   *   box where nothing is happening says nothing at all.
   */
  constructor(
    private readonly list: () => Promise<ContainerProcess[]>,
    private readonly adapter: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly onTrouble: (error: Error | null) => void = () => {},
    private readonly onChange: (threads: readonly string[]) => void = () => {},
  ) {}

  /**
   * Whether anything at all is running in the box, and a refresh started if
   * the reading has gone stale.
   *
   * Never awaits: the first call answers false — an empty box is what a
   * session that has just started actually has — and the reading behind it
   * arrives before the reaper's next sweep, which is minutes away.
   */
  get active(): boolean {
    this.freshen();
    return anyWorkRunning(this.reading);
  }

  /**
   * What one conversation has running, for the thread state a browser is
   * sent. Empty for a thread that has left nothing behind, which is the
   * answer for every thread in a box whose work belongs to another one.
   */
  work(acpThreadId: string): BackgroundProcess[] {
    this.freshen();
    return this.reading.byThread.get(acpThreadId) ?? [];
  }

  /** Starts a reading if the last one has gone stale. */
  private freshen(): void {
    if (this.now() - this.readAt >= this.ttlMs) void this.refresh();
  }

  /** Reads the box, at most one reading at a time. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.list()
      .then((processes) => {
        const before = this.reading;
        this.reading = readBackgroundWork(processes, this.adapter, this.now());
        this.readAt = this.now();
        if (this.failing) {
          this.failing = false;
          this.onTrouble(null);
        }
        const changed = changedThreads(before, this.reading);
        if (changed.length > 0) this.onChange(changed);
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
