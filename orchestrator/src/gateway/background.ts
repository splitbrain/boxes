import type { ContainerProcess } from '../docker.ts';
import type { BackgroundProcess } from '../../../shared/types.ts';

/**
 * What is running in a session's box, and which conversation left it there.
 *
 * A turn that leaves something running in the background ends like any other:
 * the agent says it will report back, the thread goes quiet, and — with the
 * browser closed — every test the reaper makes says the session is idle. Half
 * an hour later the container is stopped, and with it the build, the crawl or
 * the monitor watching them.
 *
 * So the box is asked what is running in it rather than told. This is a level
 * rather than a count of transitions, so it cannot drift and needs nothing to
 * be reported: a task killed with no notification, an adapter restarted, a
 * frame lost all answer correctly on the next reading, because the question
 * is about the present.
 *
 * The reading is per conversation, which the box itself says: every agent
 * process carries on its command line the conversation it is running, and
 * `readTree` reads it. The stop button beside the work has to reach that work
 * rather than the reader's own conversation.
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
 * the conversation it was forked from, and its work is not that one's.
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
   * Commands running under an agent process that names no conversation.
   *
   * They count for the box and belong to no thread: they hold the reaper off
   * the way any other work does, and there is no conversation to show them
   * beside. Kept as their command lines rather than a count, because a box
   * that says "still running" with no thread saying it is a thing somebody
   * will have to explain, and this is the only evidence of what it was.
   */
  unnamed: readonly string[];
}

/**
 * Nothing running anywhere.
 *
 * A box that is not there, or not up, is this rather than a box that could
 * not be read: those are opposite answers — one is knowledge and the other is
 * silence — and conflating them said "still running" about every stopped
 * session for as long as the orchestrator remembered it.
 */
const NOTHING: BackgroundReading = { byThread: new Map(), unnamed: [] };

/** Whether a reading has anything in it at all, which is what the reaper asks. */
export function anyWorkRunning(reading: BackgroundReading): boolean {
  return reading.unnamed.length > 0 || reading.byThread.size > 0;
}

/**
 * Why a reading is busy with nothing to show for it, or null when it is not.
 *
 * The one state that reads as a fault from the outside: a card saying "still
 * running" with every one of its threads quiet. It is a legitimate answer —
 * work Boxes can see and cannot place — but nobody can act on it without
 * knowing which of the two ways it happened, so it is said once, in the log.
 */
export function unexplained(reading: BackgroundReading): string | null {
  if (reading.unnamed.length === 0) return null;
  return `work under an agent that names no conversation: ${reading.unnamed.join(', ')}`;
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
 * stop resolves it against the box's own processes and can only match
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
 * The words the agent chose are in there, between the quotes.
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
 * agents, by depth.
 *
 * The id on a command line is the other half. A process carrying one is an
 * agent wherever it sits under the adapter, so a launcher or a re-exec
 * between the two does not make the real agent look like work; and an agent
 * is never work itself, so the same wrapper does not make it look busy. The
 * depth rule is kept underneath as the safe answer for an agent that names no
 * conversation: its work is real, and only who to show it to is unknown.
 *
 * With no adapter in the box at all, an id is the whole of the rule. Boxes
 * spawns the adapter as an exec and does not keep one there between
 * connections, so a container that is up and has never been opened — or that
 * has outlived the orchestrator process that opened it — runs the entrypoint
 * and nothing else. Such a box reads as empty, and the id is what keeps that
 * safe: an agent that outlived its adapter is still an agent, and its work is
 * still found.
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
  // them. `claude-agent-acp` names the adapter's package, and the CLI it
  // spawns lives inside that package's own node_modules, so the token Boxes
  // launched the adapter with is on the agent's command line too, three
  // directories into a path. A conversation id is not: that is on every agent
  // and on nothing else.
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
      // Under the adapter, or — with no adapter in the box at all — the only
      // trace left of one, which is what makes an empty answer safe below.
      if (adapters.size === 0 || under(p, adapters)) agents.set(p.pid, thread);
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
  const { agents } = readTree(processes, adapter);
  const byThread = new Map<string, BackgroundProcess[]>();
  const unnamed: string[] = [];
  for (const p of processes) {
    if (p.pid === p.ppid) continue;
    if (agents.has(p.pid)) continue;
    if (!agents.has(p.ppid)) continue;
    const thread = agents.get(p.ppid) ?? null;
    if (thread === null) {
      unnamed.push(commandOf(p.command));
      continue;
    }
    const entry: BackgroundProcess = {
      id: processId(p.command),
      command: commandOf(p.command),
      startedAt: p.elapsedSeconds === null ? null : now - p.elapsedSeconds * 1000,
    };
    byThread.set(thread, [...(byThread.get(thread) ?? []), entry]);
  }
  return { byThread, unnamed };
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
export interface ProbeOptions {
  /**
   * How to ask the box what is running, or null where there is no box to ask
   * — no container, or one that is not up. Null is an answer and not a
   * failure: a stopped box is empty, and saying so is the difference between
   * a session that is quiet and one that says "still running" forever.
   *
   * Injected so this is testable without a Docker daemon under it.
   */
  list: () => Promise<ContainerProcess[] | null>;
  /** A token from the adapter's command line. */
  adapter: string;
  /** How long one reading stands for. */
  ttlMs: number;
  /** Present so a test can move time without waiting for it. */
  now?: () => number;
  /**
   * Told the error when readings start failing, and null when they start
   * working again. Only the changes, because a probe polls: a box that cannot
   * be read would otherwise be three lines a minute for as long as it lasts,
   * which is how a real fault gets scrolled past. The answer this holds is a
   * guess whenever it is failing, and a guess that holds boxes awake
   * indefinitely is worth one line saying so.
   */
  onTrouble?: (error: Error | null) => void;
  /**
   * Told which conversations' work has changed, whenever a reading differs
   * from the one before it. Only those, so a poll over a box where nothing is
   * happening says nothing at all.
   */
  onChange?: (threads: readonly string[]) => void;
  /**
   * Told why a reading is busy with nothing to show for it, and null when
   * that clears. See `unexplained`: it is the state that looks like a fault
   * from the outside, and the log is the only place the reason can go.
   */
  onUnexplained?: (why: string | null) => void;
}

export class BackgroundProbe {
  private reading: BackgroundReading = NOTHING;
  private readAt = -Infinity;
  private inFlight: Promise<void> | null = null;
  /** Whether the last reading failed, so the trouble is reported once. */
  private failing = false;
  /** The last reason reported, so the same one is not reported twice. */
  private reported: string | null = null;

  private readonly list: ProbeOptions['list'];
  private readonly adapter: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onTrouble: (error: Error | null) => void;
  private readonly onChange: (threads: readonly string[]) => void;
  private readonly onUnexplained: (why: string | null) => void;

  constructor(options: ProbeOptions) {
    this.list = options.list;
    this.adapter = options.adapter;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.onTrouble = options.onTrouble ?? (() => {});
    this.onChange = options.onChange ?? (() => {});
    this.onUnexplained = options.onUnexplained ?? (() => {});
  }

  /**
   * Whether anything at all is running in the box, and a refresh started if
   * the reading has gone stale.
   *
   * Never awaits: the first call answers false, which is what a session that
   * has just started has, and the reading behind it arrives before the
   * reaper's next sweep.
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

  /**
   * The conversations with something running, for a list that shows every
   * thread of a box at once and has to say which of them is holding it up.
   */
  get workingThreads(): string[] {
    this.freshen();
    return [...this.reading.byThread.keys()];
  }

  /**
   * Forgets what was read, for a box that is going away.
   *
   * Stopping a session is the one moment the answer is known without asking,
   * and waiting a poll to say so would leave "still running" on a box that
   * has just been shut down.
   */
  clear(): void {
    const before = this.reading;
    this.reading = NOTHING;
    this.readAt = -Infinity;
    const changed = changedThreads(before, this.reading);
    if (changed.length > 0) this.onChange(changed);
    if (this.reported !== null) {
      this.reported = null;
      this.onUnexplained(null);
    }
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
        // No box to ask is not the same as a box that would not answer: it is
        // empty, and known to be.
        this.reading =
          processes === null ? NOTHING : readBackgroundWork(processes, this.adapter, this.now());
        this.readAt = this.now();
        if (this.failing) {
          this.failing = false;
          this.onTrouble(null);
        }
        const changed = changedThreads(before, this.reading);
        if (changed.length > 0) this.onChange(changed);
        const why = unexplained(this.reading);
        if (why !== this.reported) {
          this.reported = why;
          this.onUnexplained(why);
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
