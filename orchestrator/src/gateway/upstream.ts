import type { Config } from '../config.ts';
import {
  clearBoxTurns,
  clearThreadInheritance,
  latestThread,
  getThread,
  insertThread,
  setThreadMode,
  setThreadTitle,
  setThreadTurnActive,
  threadByAcpId,
  threadConfig,
  touchBox,
  touchThread,
  type Db,
  type BoxRow,
  type ThreadRow,
} from '../db.ts';
import { DEFAULT_HARNESS, harness, HARNESS_IDS, type HarnessId } from '../harness.ts';
import { log, type Logger } from '../log.ts';
import type { NotifyKind, Notifier } from '../notify.ts';
import { runtime } from '../runtime.ts';
import type { ContainerProcess } from '../runtime/types.ts';
import { Activity } from './activity.ts';
import {
  AdapterConnection,
  NOTHING_TO_FORK,
  THREAD_NOT_FOUND,
  answeredOptions,
  optionsOf,
  type AdapterHost,
  type LoadAnswer,
} from './adapter.ts';
import { BackgroundProbe, workPids } from './background.ts';
import { Broadcast, threadOf } from './broadcast.ts';
import type { PendingStore } from './pending.ts';
import type { AdapterOptions } from './thread-log.ts';
import { ACP_METHOD, UPDATE_KIND } from '../../../shared/acp.ts';
import {
  BOXES_META,
  type BackgroundProcess,
  type BoxWork,
  type LoadMeta,
  type ThreadConfigOption,
  type ThreadOptions,
  type TurnStateParams,
} from '../../../shared/types.ts';

/** How much of one tapped ACP message a debug line carries. */
const MAX_TAPPED_CHARS = 64_000;

/**
 * A JSON.stringify replacer that replaces the base64 payload of image and
 * audio blocks with its length.
 *
 * A `function` rather than an arrow, because it reads the holder through
 * `this`: a terminal's output is also named `data` and must stay.
 */
function withoutMediaPayloads(this: unknown, key: string, value: unknown): unknown {
  if (key !== 'data' || typeof value !== 'string') return value;
  const type = (this as { type?: unknown })?.type;
  if (type !== 'image' && type !== 'audio') return value;
  return `[${value.length} base64 chars omitted]`;
}

/** A browser attached to this box, as seen from the upstream side. */
export interface DownstreamHandle {
  readonly id: number;
  /**
   * The ACP thread this connection is for, fixed once the pin resolves. Null
   * until then, and nothing is routed to it meanwhile.
   */
  acpThreadId: string | null;
  /** When this browser last sent something. The most recent one gets permission requests. */
  lastActiveAt: number;
  /** Sends a notification to this browser. */
  notify(method: string, params: unknown): void;
  /**
   * Sends a request to this browser and awaits its answer.
   *
   * @param signal Withdraws the question, for example after another browser
   *   answered it. The promise still settles on this browser's own answer.
   */
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  /** Closes this browser's socket, which makes it reconnect from scratch. */
  close(): void;
}

/** Every harness, for the reading of a box, which may run either adapter or both. */
const ALL_HARNESSES = HARNESS_IDS.map((id) => harness(id));

/** How long work gets between TERM and KILL, in milliseconds. */
const TERM_GRACE_MS = 2_000;

export { NOTHING_TO_FORK, THREAD_NOT_FOUND };

/**
 * The message id a browser's `session/load` asks to resume from, read from
 * its `_meta`. Undefined when it asks for the whole thread, or sends
 * anything but a non-empty string.
 */
function resumePointOf(params: unknown): string | undefined {
  const meta = (params as { _meta?: Record<string, unknown> } | null)?._meta;
  const asked = (meta?.[BOXES_META] as LoadMeta | undefined)?.resumeFrom;
  return typeof asked === 'string' && asked ? asked : undefined;
}

/** Whether a browser's `session/load` asks for the full history, read from its `_meta`. */
function wantsFullHistory(params: unknown): boolean {
  const meta = (params as { _meta?: Record<string, unknown> } | null)?._meta;
  return (meta?.[BOXES_META] as LoadMeta | undefined)?.full === true;
}

/** Why the full history cannot be loaded while the thread works. */
export const THREAD_WORKING =
  'The agent is working on this thread. Load the full history once it is idle.';

/** Why a prompt or a second request is refused while the full history loads. */
export const HISTORY_LOADING =
  'The full history of this thread is loading. Try again once it is shown.';

/** Why an unprompted fork has no full history to load. */
const NO_OWN_HISTORY = 'This fork has no history of its own until it is prompted.';

/**
 * The start of the text block in which the dashboard names a prompt's
 * attachments for the model. A thread is not named after it.
 */
const ATTACHMENTS_OPEN = '<attachments>';

/** The longest a thread's name may be, in characters. */
const MAX_PROMPT_NAME_LENGTH = 120;

/** A name cut to {@link MAX_PROMPT_NAME_LENGTH}, with an ellipsis for the cut part. */
function capName(name: string): string {
  if (name.length <= MAX_PROMPT_NAME_LENGTH) return name;
  return `${name.slice(0, MAX_PROMPT_NAME_LENGTH - 1)}…`;
}

/**
 * A thread name from the first non-empty line of a prompt's text, skipping
 * the attachments block. Null when the prompt has no such line.
 */
function nameFromPrompt(params: unknown): string | null {
  const blocks = (params as { prompt?: unknown } | null)?.prompt;
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks as Array<{ type?: unknown; text?: unknown } | null>) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    if (block.text.startsWith(ATTACHMENTS_OPEN)) continue;
    const line = block.text.split('\n').find((candidate) => candidate.trim() !== '');
    if (line === undefined) continue;
    return capName(line.trim().replace(/\s+/g, ' '));
  }
  return null;
}

/**
 * The gateway state of one box: its adapter connections, the browsers
 * attached to it, and the reading of what runs in its container.
 *
 * It owns one {@link AdapterConnection} per harness its threads run, and
 * routes every message to the connection that holds the conversation it
 * names. The orchestrator owns the connections, so a turn runs to the end
 * whoever is watching. Each browser connection is pinned to one thread.
 */
export class UpstreamBox implements AdapterHost {
  /** One adapter process per harness a thread of this box runs. */
  private readonly connections = new Map<HarnessId, AdapterConnection>();
  /** The container start, shared by every connection that wants one. */
  private containerStarting: Promise<string> | null = null;
  /** Who each adapter update goes to. */
  private readonly downstreams: Broadcast;
  /** Whether this box still has work running in it. */
  private readonly background: BackgroundProbe;
  /** Whether the agent is talking on each thread. */
  private readonly activity: Activity;
  /** The logger tagged with this box. */
  private readonly slog: Logger;
  /** Bring-ups in flight by thread id, so concurrent pins share one. */
  private readonly resolving = new Map<string, Promise<string>>();
  /** The poll that refreshes the box reading while a browser is attached. */
  private polling: ReturnType<typeof setInterval> | null = null;
  /**
   * When each thread last had an approval announced, by the adapter's thread
   * id, or the empty string for a question that names no thread. A thread
   * announces one approval per hold window.
   */
  private readonly announcedApprovals = new Map<string, number>();
  /** KILL escalations armed and not yet fired, so a stop can cancel them. */
  private readonly escalations = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    /** The box's id. */
    readonly boxId: string,
    /** The orchestrator's database. */
    readonly db: Db,
    /** The orchestrator's configuration. */
    private readonly cfg: Config,
    /** The queue of unanswered permission requests. */
    private readonly pending: PendingStore,
    /** Sends push notifications. */
    private readonly notifier: Notifier,
    /** Receives the box status reported by the adapter connections. */
    private readonly onStatusChange: (status: BoxRow['status']) => void,
    /**
     * Runs, and is awaited, just before the container is started. It brings
     * the container up to date, from writing the agent configuration to
     * rebuilding a container Docker no longer has, so it may change the box's
     * container id.
     */
    private readonly beforeStart: () => Promise<void>,
  ) {
    this.slog = log.box(boxId);
    this.downstreams = new Broadcast(boxId, (thread) => this.threadState(thread));
    this.background = new BackgroundProbe({
      list: () => this.containerProcesses(),
      harnesses: ALL_HARNESSES,
      ttlMs: cfg.BACKGROUND_POLL_SECONDS * 1_000,
      // A failing probe keeps its last answer, which may keep the box awake.
      onTrouble: (error) =>
        error
          ? this.slog.warn('cannot read what is running in the box', {
              error: error.message,
            })
          : this.slog.info('reading what is running in the box again'),
      // Logged with the commands, the only trace of work no task names.
      onChange: (reading) =>
        reading.busy
          ? this.slog.info('the box has work running in it', { work: reading.work })
          : this.slog.info('nothing is running in the box any more'),
    });
    this.activity = new Activity({
      quietMs: cfg.AGENT_QUIET_SECONDS * 1000,
      settleMs: cfg.AGENT_SETTLE_SECONDS * 1000,
      onChange: (thread) => this.downstreams.threadState(thread),
      // Announced only when no browser is watching the thread.
      onSettled: (thread) => {
        if (this.downstreams.byRecency(thread).length === 0) this.announce('idle', thread);
      },
    });
  }

  // --- the connections ------------------------------------------------------

  /**
   * The connection for one harness, created on first use. Creating it starts
   * nothing; `ensureStarted` spawns the adapter.
   */
  private connection(id: HarnessId): AdapterConnection {
    let conn = this.connections.get(id);
    if (!conn) {
      conn = new AdapterConnection(
        harness(id),
        this,
        log.tagged({ box: this.boxId, harness: id }),
      );
      this.connections.set(id, conn);
    }
    return conn;
  }

  /**
   * Starts the adapter of one harness. Without a harness, starts the one of
   * the box's most recently active thread, or the default harness before the
   * box has a thread.
   */
  async ensureStarted(harnessId?: HarnessId): Promise<void> {
    await this.connection(harnessId ?? this.defaultHarness()).ensureStarted();
  }

  /** The harness of the box's most recently active thread, or the registry's default. */
  private defaultHarness(): HarnessId {
    return this.latest?.harness ?? DEFAULT_HARNESS;
  }

  /**
   * Whether threads of one harness can be forked, as that adapter's
   * `initialize` advertised. False for an adapter that has not been reached.
   */
  canFork(harnessId: HarnessId): boolean {
    return this.connections.get(harnessId)?.canFork ?? false;
  }

  /** The harnesses whose adapters have advertised the fork capability. */
  get forkableHarnesses(): Set<HarnessId> {
    const forkable = new Set<HarnessId>();
    for (const [id, conn] of this.connections) if (conn.canFork) forkable.add(id);
    return forkable;
  }

  /**
   * The initialize response to hand a browser: the one cached by the adapter
   * holding the thread that browser is pinned to. The two adapters advertise
   * different modes and session capabilities.
   */
  initializeFor(acpThreadId: string): unknown {
    const conn = this.connectionHolding(acpThreadId);
    return conn?.cachedInitialize ?? null;
  }

  /** The connection whose adapter is holding one conversation, if any is. */
  private connectionHolding(acpThreadId: string): AdapterConnection | null {
    for (const conn of this.connections.values()) {
      if (conn.holds(acpThreadId)) return conn;
    }
    return null;
  }

  /**
   * One of this box's threads by the adapter's own id for it, whichever
   * harness it belongs to. Both adapters mint UUIDs, so at most one harness
   * has a match.
   */
  private rowOfAcp(acpThreadId: string): ThreadRow | undefined {
    for (const id of HARNESS_IDS) {
      const row = threadByAcpId(this.db, this.boxId, id, acpThreadId);
      if (row) return row;
    }
    return undefined;
  }

  /**
   * The connection a forwarded message belongs on, found by the thread it
   * names or else the browser's own thread: the connection holding that
   * thread, else the one for its stored harness. Without a thread, or with
   * an unknown one, the box's default.
   */
  private connectionFor(params: unknown, from?: DownstreamHandle): AdapterConnection {
    const acpThreadId = threadOf(params) ?? from?.acpThreadId ?? null;
    if (acpThreadId) {
      const holding = this.connectionHolding(acpThreadId);
      if (holding) return holding;
      const row = this.rowOfAcp(acpThreadId);
      if (row) return this.connection(row.harness);
    }
    return this.connection(this.defaultHarness());
  }

  // --- what the connections ask of the box -------------------------------

  /**
   * Starts the box container. Concurrent callers share one start, and a later
   * call starts it again.
   */
  ensureContainer(): Promise<string> {
    if (!this.containerStarting) {
      this.containerStarting = this.startContainer().finally(() => {
        this.containerStarting = null;
      });
    }
    return this.containerStarting;
  }

  /** Brings the box up and makes sure the egress proxy is on its network. */
  private async startContainer(): Promise<string> {
    if (!this.row().container_id) throw new Error('Box has no container');

    // The row is read again, because this may have replaced the container.
    await this.beforeStart();
    const row = this.row();
    if (!row.container_id) throw new Error('Box has no container');

    await runtime().boxes.startContainer(row.container_id);
    await runtime().boxes.ensureProxyAttached(row.network_name);
    return row.container_id;
  }

  /** Every conversation a browser is watching, for a connection coming back up. */
  watchedThreads(): readonly string[] {
    return this.downstreams.watchedThreads;
  }

  /**
   * Opens a log for a conversation an adapter has just minted.
   *
   * The logs belong to the box, so they outlive adapter restarts.
   */
  openLog(acpThreadId: string, options: AdapterOptions, from?: string): void {
    this.downstreams.openLog(acpThreadId, options, from);
  }

  /** Starts reading a transcript into a conversation's log. */
  beginFill(acpThreadId: string): void {
    this.downstreams.beginFill(acpThreadId);
  }

  /** Ends the transcript read, so the thread's updates go to browsers again. */
  endFill(acpThreadId: string, options: AdapterOptions): void {
    this.downstreams.endFill(acpThreadId, options);
  }

  /** Forgets a conversation's log, for one the adapter does not hold. */
  dropLog(acpThreadId: string): void {
    this.downstreams.dropLog(acpThreadId);
  }

  /** Sets the current mode in a conversation's log. */
  logMode(acpThreadId: string, modeId: string): string | null {
    return this.downstreams.logMode(acpThreadId, modeId);
  }

  /** Sets one option's value in a conversation's log. */
  logConfig(
    acpThreadId: string,
    configId: string,
    value: string,
    answered?: ThreadConfigOption[],
  ): void {
    this.downstreams.logConfig(acpThreadId, configId, value, answered);
  }

  /** Restarts the box reading's poll when a connection is up. */
  onUp(): void {
    this.pollWhileWatched();
  }

  /** Passes a connection's status on as the box's status. */
  onStatus(status: 'running' | 'error'): void {
    this.onStatusChange(status);
  }

  /**
   * Forgets what one adapter's conversations were in the middle of, and
   * rejects their queued permission requests.
   *
   * The browsers are told after every thread is cleared, so no state sent
   * halfway through claims a turn on a cleared thread.
   */
  onThreadsLost(acpThreadIds: readonly string[]): void {
    for (const acpThreadId of acpThreadIds) {
      setThreadTurnActive(this.db, this.boxId, acpThreadId, false);
      this.activity.reset(acpThreadId);
      // No answer can reach an adapter that is gone.
      this.pending.failThread(this.boxId, acpThreadId, 'The agent adapter exited');
    }
    this.downstreams.refreshThreadStates();
  }

  // --- the box ---------------------------------------------------------------

  /** How many browsers are attached to this box. */
  get attachedCount(): number {
    return this.downstreams.size;
  }

  /**
   * Whether this box has work running in the background, which holds off the
   * idle reaper.
   *
   * True when an adapter has announced a task, because some tasks, such as a
   * monitor inside the CLI, are not processes of their own. Otherwise the
   * box reading answers, which also finds work a dead adapter left behind.
   * Null when no task is announced and the box has not been read yet.
   */
  get backgroundActive(): boolean | null {
    if ([...this.connections.values()].some((conn) => conn.hasTasks)) return true;
    return this.background.active;
  }

  /**
   * What the last reading found running in the box, for a reader deciding
   * whether to stop it.
   *
   * Only the reading, without the adapters' tasks, so this can be empty while
   * {@link backgroundActive} is true.
   */
  get boxWork(): readonly BoxWork[] {
    return this.background.work;
  }

  /**
   * Whether this upstream holds nothing at all: no browser attached, no
   * permission request waiting, no adapter connection, no start in flight and
   * no KILL escalation armed. The manager may then drop it.
   */
  get holdsNothing(): boolean {
    return (
      this.downstreams.size === 0 &&
      [...this.connections.values()].every((conn) => conn.holdsNothing) &&
      this.containerStarting === null &&
      this.escalations.size === 0 &&
      this.pending.countForBox(this.boxId) === 0
    );
  }

  /** Test seam: takes a reading now rather than when one goes stale. */
  refreshBackgroundForTests(): Promise<void> {
    return this.background.refresh();
  }

  /**
   * Polls the box reading while a browser is attached. The last browser to
   * detach stops it.
   *
   * Without a browser, the reaper's own checks refresh the reading.
   */
  private pollWhileWatched(): void {
    if (this.polling || this.downstreams.size === 0) return;
    this.polling = setInterval(
      () => void this.background.refresh(),
      this.cfg.BACKGROUND_POLL_SECONDS * 1_000,
    );
    this.polling.unref?.();
    // Reads once now for the browser that has just arrived.
    void this.background.refresh();
  }

  /** Stops the poll of the box reading. */
  private stopPolling(): void {
    if (!this.polling) return;
    clearInterval(this.polling);
    this.polling = null;
  }

  /**
   * Stops one task of a conversation, or every task it has, through the
   * adapter that holds the conversation. Sends the thread's state afterwards.
   *
   * @returns How many tasks the adapter said it stopped. Zero when no adapter
   *   holds the conversation or the tasks were already over.
   */
  async stopBackgroundWork(acpThreadId: string, taskId?: string): Promise<number> {
    const conn = this.connectionHolding(acpThreadId);
    if (!conn) return 0;
    const stopped = await conn.stopTasks(acpThreadId, taskId);
    this.downstreams.threadState(acpThreadId);
    return stopped;
  }

  /**
   * Kills everything running in the box that Boxes did not put there, such as
   * work that no task names after an adapter respawn.
   *
   * The pids are read from inside the container just before use. Each process
   * gets TERM, deepest first, and whatever is left after
   * {@link TERM_GRACE_MS} gets KILL. The call does not wait for the KILL.
   *
   * @returns How many processes got TERM. Zero when nothing was running.
   */
  async stopBoxWork(): Promise<number> {
    const containerId = this.row().container_id;
    if (!containerId) return 0;
    if ((await runtime().boxes.containerState(containerId)) !== 'running') return 0;

    const doomed = workPids(
      await runtime().exec.containerProcessesFromInside(containerId),
      ALL_HARNESSES,
    );
    if (doomed.length === 0) {
      // The card shows an outdated reading, so a fresh one corrects it.
      void this.background.refresh();
      return 0;
    }

    this.slog.info('stopping everything running in the box', { pids: doomed });
    await runtime().exec.killInContainer(containerId, 'TERM', doomed);
    // No reading yet, because the signalled processes are likely still in
    // the table. The escalation takes one when it settles.
    this.escalate(containerId);
    return doomed.length;
  }

  /**
   * Sends KILL, after {@link TERM_GRACE_MS}, to whatever work is still
   * running. It reads the work again rather than reusing the TERM pids.
   */
  private escalate(containerId: string): void {
    const timer = setTimeout(() => {
      this.escalations.delete(timer);
      void (async () => {
        try {
          const left = workPids(
            await runtime().exec.containerProcessesFromInside(containerId),
            ALL_HARNESSES,
          );
          if (left.length === 0) return;
          this.slog.info('work in the box ignored TERM; killing', { pids: left });
          await runtime().exec.killInContainer(containerId, 'KILL', left);
        } catch (err) {
          this.slog.warn('could not finish stopping what the box was running', {
            error: (err as Error).message,
          });
        } finally {
          void this.background.refresh();
        }
      })();
    }, TERM_GRACE_MS);
    timer.unref?.();
    this.escalations.add(timer);
  }

  /**
   * What is running in this box's container, for the probe. Null when the box
   * has no container or it is not running.
   */
  private async containerProcesses(): Promise<ContainerProcess[] | null> {
    const containerId = this.row().container_id;
    if (!containerId) return null;
    if ((await runtime().boxes.containerState(containerId)) !== 'running') return null;
    return runtime().exec.containerProcesses(containerId);
  }

  /** The threads of this box the agent is talking on. */
  get speakingThreads(): string[] {
    return this.activity.speakingThreads;
  }

  /** The threads of this box with an announced task, across every adapter. */
  get workingThreads(): string[] {
    return [...this.connections.values()].flatMap((conn) => conn.taskThreads);
  }

  /**
   * What one conversation has running, whichever adapter announced it. Only
   * the adapter that holds a conversation runs its tasks.
   */
  private tasksFor(acpThreadId: string): BackgroundProcess[] {
    for (const conn of this.connections.values()) {
      const tasks = conn.tasksFor(acpThreadId);
      if (tasks.length > 0) return tasks;
    }
    return [];
  }

  /**
   * Everything a browser is told about a thread: whether a prompt is in
   * flight, whether the agent is talking, and what it has left running.
   */
  threadState(acpThreadId: string): TurnStateParams {
    return {
      sessionId: acpThreadId,
      active: this.downstreams.isPrompting(acpThreadId),
      speaking: this.activity.speaking(acpThreadId),
      background: this.tasksFor(acpThreadId),
    };
  }

  // --- browsers --------------------------------------------------------------

  /**
   * Adds a browser to the broadcast set. It counts as attached for the reaper
   * at once, but receives nothing until `pin` has set its thread.
   */
  attach(handle: DownstreamHandle): void {
    this.downstreams.add(handle);
    this.pollWhileWatched();
    this.slog.info('downstream attached', { attached: this.downstreams.size });
  }

  /**
   * Pins a connection to one of the box's conversations, bringing it up on
   * its harness's adapter first.
   *
   * @param threadId One of the box's threads, or null for the most recently
   *   active one.
   * @returns The adapter's id for the thread.
   */
  async pin(handle: DownstreamHandle, threadId: string | null): Promise<string> {
    const acpThreadId = await this.resolveThread(threadId);
    handle.acpThreadId = acpThreadId;
    this.slog.info('downstream pinned to a thread', { handle: handle.id, acpThreadId });
    return acpThreadId;
  }

  /**
   * The live adapter id for one of the box's threads, bringing the thread
   * up first when its adapter is not already holding it.
   *
   * @param threadId One of the box's threads, or null for the most recently
   *   active one.
   */
  private async resolveThread(threadId: string | null): Promise<string> {
    let row = threadId ? getThread(this.db, threadId) : this.latest;
    if (!row && !threadId) {
      // The default adapter mints the first thread of a box that has none.
      await this.ensureStarted();
      row = this.latest;
    }
    if (!row || row.box_id !== this.boxId) throw new Error(THREAD_NOT_FOUND);
    const conn = this.connection(row.harness);
    if (row.acp_session_id && conn.holds(row.acp_session_id)) return row.acp_session_id;
    // Two tabs opening the same thread at once share one bring-up.
    const inFlight = this.resolving.get(row.id);
    if (inFlight) return inFlight;
    const attempt = conn.bringUp(row.id).finally(() => this.resolving.delete(row.id));
    this.resolving.set(row.id, attempt);
    return attempt;
  }

  /** Removes a browser from the broadcast set, leaving the upstream running. */
  detach(handle: DownstreamHandle): void {
    this.downstreams.remove(handle);
    if (this.downstreams.size === 0) this.stopPolling();
    this.slog.info('downstream detached', { attached: this.downstreams.size });
  }

  /**
   * Closes the sockets of the browsers watching one thread, so each
   * reconnects and pins the thread's current id.
   */
  dropWatchers(acpThreadId: string): void {
    for (const handle of this.downstreams.byRecency(acpThreadId)) {
      try {
        handle.close();
      } catch (err) {
        this.slog.debug('downstream close failed', { error: (err as Error).message });
      }
    }
  }

  /** This box's stored row. Throws once the box is gone. */
  private row(): BoxRow {
    const row = this.db
      .prepare('SELECT * FROM boxes WHERE id = ?')
      .get(this.boxId) as BoxRow | undefined;
    if (!row) throw new Error(`Box ${this.boxId} not found`);
    return row;
  }

  /** Marks the box as active now, which holds off the reaper. */
  private touch(): void {
    touchBox(this.db, this.boxId);
  }

  /** Forgets everything this box was in the middle of, across every adapter. */
  private clearThreadStates(): void {
    clearBoxTurns(this.db, this.boxId);
    this.activity.clear();
    this.downstreams.refreshThreadStates();
  }

  // --- threads --------------------------------------------------------------

  /**
   * The box's most recently active thread, which a connection naming no
   * thread is pinned to. Null before the box has one.
   */
  get latest(): ThreadRow | null {
    return latestThread(this.db, this.boxId) ?? null;
  }

  /** The box's most recently active thread, for the adapter connections. */
  latestThread(): ThreadRow | null {
    return this.latest;
  }

  /**
   * Starts a fresh, empty thread on the same workspace. No browser is moved
   * onto it.
   *
   * The row is written before the adapter is asked, so a harness without a
   * credential still gets a thread. Such a thread has no conversation until
   * the next pin brings it up.
   */
  async newThread(options?: ThreadOptions): Promise<ThreadRow> {
    const wanted = harness(options?.harness ?? DEFAULT_HARNESS);
    const thread = insertThread(this.db, this.boxId, {
      harness: wanted.id,
      modeId: options?.modeId ?? null,
      config: options?.config ?? { ...wanted.defaultConfig },
    });
    this.slog.info('new thread', {
      threadId: thread.id,
      ordinal: thread.ordinal,
      harness: wanted.id,
    });
    try {
      // An adapter that starts now mints the conversation of the most
      // recently active thread, which is this row. The pin's resolution
      // reuses it rather than minting a second one.
      const acpSessionId = await this.resolveThread(thread.id);
      return { ...thread, acp_session_id: acpSessionId };
    } catch (err) {
      this.slog.warn('the new thread has no conversation yet', {
        threadId: thread.id,
        error: (err as Error).message,
      });
      return thread;
    }
  }

  /**
   * Branches one conversation into a second that carries its context. The
   * source is left as it was.
   *
   * The fork keeps the source's harness and settings. It starts in the
   * harness's fork mode, such as `plan` for Claude, because it shares the
   * source's workspace.
   */
  async forkThread(sourceThreadId: string): Promise<ThreadRow> {
    const source = getThread(this.db, sourceThreadId);
    if (!source || source.box_id !== this.boxId) {
      throw new Error(THREAD_NOT_FOUND);
    }
    if (!source.acp_session_id) throw new Error(NOTHING_TO_FORK);
    const wanted = harness(source.harness);
    const conn = this.connection(wanted.id);
    await conn.ensureStarted();
    // The fork's log is copied from the source's, so the source must be held.
    if (!(await conn.hold(source))) throw new Error(NOTHING_TO_FORK);
    const config = threadConfig(source);
    const acpSessionId = await conn.mintAcpThread(
      source.acp_session_id,
      wanted.forkModeId,
      config,
    );
    // The source is recorded, because the adapter writes the fork no
    // transcript until its first prompt. The mode is recorded, because an
    // empty column means the harness's default mode.
    const thread = insertThread(this.db, this.boxId, {
      harness: wanted.id,
      acpSessionId,
      modeId: wanted.forkModeId,
      config,
      inheritsFrom: source.id,
    });
    this.slog.info('thread forked', { from: source.id, threadId: thread.id });
    return thread;
  }

  // --- what arrives from the adapters ----------------------------------------

  /**
   * Taps an adapter update and delivers it to the browsers it is meant for.
   *
   * @param replaying Whether the update is part of a replay on that adapter.
   */
  onUpdate(harnessId: HarnessId, params: unknown, replaying: boolean): void {
    this.touch();
    // A replay is not the agent talking.
    const thread = threadOf(params);
    const update = (params as { update?: unknown })?.update;
    if (!replaying && thread) this.activity.observe(thread, update, harnessId);
    this.recordThreadInfo(harnessId, params, replaying);
    this.tap('up', ACP_METHOD.sessionUpdate, params);
    this.downstreams.update(params);
    // After the update, so the transcript and the task bar agree. Task
    // updates are forwarded to browsers as well.
    if (thread !== undefined && this.connection(harnessId).noteTask(thread, update)) {
      this.downstreams.threadState(thread);
    }
  }

  /**
   * Keeps a thread's row in step with what the adapter says about it: the
   * title, the mode, the settings, and when it was last heard from.
   *
   * The adapter changes the mode and settings on its own too, for example
   * when a plan is accepted. A replayed update does not count as the thread
   * being heard from, so opening a thread does not move it up the list.
   */
  private recordThreadInfo(harnessId: HarnessId, params: unknown, replaying: boolean): void {
    const acpSessionId = (params as { sessionId?: string })?.sessionId;
    if (!acpSessionId) return;
    const row = threadByAcpId(this.db, this.boxId, harnessId, acpSessionId);
    if (!row) return;
    if (!replaying) touchThread(this.db, row.id);

    const update = (
      params as {
        update?: {
          sessionUpdate?: string;
          title?: unknown;
          currentModeId?: unknown;
          configOptions?: ThreadConfigOption[];
        };
      }
    )?.update;
    switch (update?.sessionUpdate) {
      case UPDATE_KIND.sessionInfo:
        // A missing title changes nothing. A null title clears it, and the
        // thread is shown by its ordinal again.
        if (update.title === null) setThreadTitle(this.db, row.id, null);
        else if (typeof update.title === 'string' && update.title.trim()) {
          setThreadTitle(this.db, row.id, capName(update.title.trim()));
        }
        return;
      case UPDATE_KIND.currentMode:
        if (typeof update.currentModeId === 'string') {
          setThreadMode(this.db, row.id, update.currentModeId);
        }
        return;
      case UPDATE_KIND.configOption:
        if (Array.isArray(update.configOptions)) {
          this.connection(harnessId).recordConfigOptions(acpSessionId, update.configOptions);
        }
        return;
      default:
        return;
    }
  }

  /**
   * Puts a permission request to the most recently active browser watching
   * the thread that asked, or queues it when none is. The adapter blocks
   * until the answer arrives.
   */
  onPermission(params: unknown): Promise<unknown> {
    this.touch();
    this.tap('up', ACP_METHOD.sessionRequestPermission, params);

    const thread = threadOf(params);
    const target = thread ? this.downstreams.byRecency(thread)[0] : undefined;
    if (target) {
      return target.request(ACP_METHOD.sessionRequestPermission, params).catch((err) => {
        // The browser went away mid-question, so the request is queued.
        this.slog.warn('permission forward failed; queueing', {
          error: (err as Error).message,
        });
        return this.queuePermission(params);
      });
    }
    return this.queuePermission(params);
  }

  /** Holds a permission request for a browser to answer, and sends a notification. */
  private queuePermission(params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const entry = this.pending.add(
        this.boxId,
        threadOf(params) ?? null,
        ACP_METHOD.sessionRequestPermission,
        params,
        { resolve, reject },
        this.cfg.PERMISSION_HOLD_MINUTES * 60_000,
        (timedOut) => this.applyPermissionFallback(timedOut.row.id, params, resolve),
      );
      this.slog.info('permission request queued', { pendingId: entry.row.id });
      const thread = threadOf(params) ?? null;
      if (this.mayAnnounceApproval(thread)) this.announce('approval', thread);
    });
  }

  /**
   * Whether a thread may announce that it waits for an approval, at most once
   * per PERMISSION_HOLD_MINUTES. Records the announcement when it may.
   */
  private mayAnnounceApproval(acpThreadId: string | null): boolean {
    const key = acpThreadId ?? '';
    const last = this.announcedApprovals.get(key) ?? 0;
    const now = Date.now();
    if (now - last < this.cfg.PERMISSION_HOLD_MINUTES * 60_000) return false;
    this.announcedApprovals.set(key, now);
    return true;
  }

  /**
   * Applies PERMISSION_FALLBACK once PERMISSION_HOLD_MINUTES has passed. The
   * deny fallback answers with a reject option from the request's own list,
   * never an invented one, and cancels the request when none is offered.
   */
  private applyPermissionFallback(
    pendingId: number,
    params: unknown,
    resolve: (r: unknown) => void,
  ): void {
    if (this.cfg.PERMISSION_FALLBACK === 'hold') {
      this.slog.info('permission hold elapsed; still holding', { pendingId });
      return;
    }
    const options = (params as { options?: Array<{ optionId?: string; kind?: string }> })?.options;
    const reject = options?.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
    this.pending.settle(pendingId);
    if (reject?.optionId) {
      this.slog.warn('permission denied by timeout fallback', {
        pendingId,
        optionId: reject.optionId,
      });
      resolve({ outcome: { outcome: 'selected', optionId: reject.optionId } });
    } else {
      this.slog.warn('permission cancelled by timeout fallback (no reject option offered)', {
        pendingId,
      });
      resolve({ outcome: { outcome: 'cancelled' } });
    }
  }

  /**
   * Tells the notifier that a thread wants somebody, naming the thread as
   * well as the box. Not awaited, so a turn does not wait on a push service.
   */
  private announce(kind: NotifyKind, acpThreadId: string | null): void {
    const thread = acpThreadId ? this.rowOfAcp(acpThreadId) : undefined;
    let boxName: string;
    try {
      boxName = this.row().name;
    } catch {
      // The box was deleted in the meantime.
      return;
    }
    void this.notifier.notify({
      kind,
      boxId: this.boxId,
      boxName,
      threadId: thread?.id ?? null,
      // The same name the dashboard shows.
      threadName: thread ? thread.title?.trim() || `Thread ${thread.ordinal}` : null,
      // Whether this thread still has background tasks running.
      background: acpThreadId ? this.tasksFor(acpThreadId).length > 0 : false,
    });
  }

  /**
   * Sends a browser its thread's state and the queued permission requests of
   * its thread.
   *
   * Called after the browser has taken the thread's replay, because a client
   * drops what it showed before the replay.
   */
  flushPendingTo(handle: DownstreamHandle): void {
    const thread = handle.acpThreadId;
    if (!thread) return;
    // A replay does not say whether a turn is still running.
    this.downstreams.threadStateTo(handle);
    for (const entry of this.pending.listForThread(this.boxId, thread)) {
      const params = JSON.parse(entry.row.params) as unknown;
      // Withdrawn when another browser answers first. Removed once this
      // browser answers, so settling does not abort its own delivery.
      const delivery = new AbortController();
      entry.deliveries.add(delivery);
      handle
        .request(ACP_METHOD.sessionRequestPermission, params, delivery.signal)
        .then((result) => {
          entry.deliveries.delete(delivery);
          if (this.pending.settle(entry.row.id)) entry.resolve(result);
        })
        .catch((err) => {
          entry.deliveries.delete(delivery);
          this.slog.warn('pending permission delivery failed; leaving queued', {
            pendingId: entry.row.id,
            error: (err as Error).message,
          });
        });
    }
  }

  // --- what arrives from the browsers ----------------------------------------

  /**
   * Forwards a browser request to the adapter holding the conversation it is
   * about, and tracks prompt turns. A `session/load` is answered from the
   * thread's log instead.
   *
   * @param from The browser that asked. It gets the log for a load, and its
   *   thread picks the adapter for a request that names no thread.
   */
  async forwardRequest(
    method: string,
    params: unknown,
    from?: DownstreamHandle,
  ): Promise<unknown> {
    const conn = this.connectionFor(params, from);
    await conn.ensureStarted();
    this.tap('down', method, params);

    const thread = threadOf(params);
    const isPrompt = method === ACP_METHOD.sessionPrompt && thread !== undefined;
    const isLoad = method === ACP_METHOD.sessionLoad && thread !== undefined && from !== undefined;

    // A turn would mix its updates into the replay.
    if (isPrompt && this.downstreams.isRelaying(thread)) throw new Error(HISTORY_LOADING);
    if (isPrompt) {
      // The first prompt gives a fork its own transcript, so a restart loads
      // it rather than branching the source again.
      const row = conn.rowOf(thread);
      if (row?.inherits_from) clearThreadInheritance(this.db, row.id);
      // A thread without a title is named after the prompt until the agent
      // sends a title.
      if (row && !row.title) {
        const name = nameFromPrompt(params);
        if (name) setThreadTitle(this.db, row.id, name);
      }
      this.setTurnActive(thread, true);
      // Before the echo, so the state sent with it says the agent is working.
      this.activity.begin(thread);
      this.downstreams.beginPrompt(params);
    }
    if (isLoad && wantsFullHistory(params)) return this.relayHistory(conn, from, thread);
    // The pin already filled the log, and a new replay would mix with live
    // updates.
    if (isLoad) return this.downstreams.open(from, thread, resumePointOf(params));

    const modeId =
      method === ACP_METHOD.sessionSetMode && thread !== undefined
        ? (params as { modeId?: unknown })?.modeId
        : undefined;
    // Logged before the request, so that a `current_mode_update` for a mode
    // the adapter falls back to replaces it.
    const previousMode =
      thread !== undefined && typeof modeId === 'string'
        ? this.downstreams.logMode(thread, modeId)
        : null;
    try {
      const result = await conn.request(method, params);
      // Recorded here too, because the adapter need not send a
      // current_mode_update for a requested change. The log's mode, because
      // a current_mode_update for a mode the adapter fell back to has
      // replaced the requested one there.
      if (thread !== undefined && typeof modeId === 'string') {
        const row = conn.rowOf(thread);
        if (row) setThreadMode(this.db, row.id, this.downstreams.modeOf(thread) ?? modeId);
      }
      if (method === ACP_METHOD.sessionSetConfigOption && thread !== undefined) {
        this.recordConfigChange(conn, thread, params, result);
      }
      return result;
    } catch (err) {
      if (thread !== undefined && previousMode !== null) {
        this.downstreams.logMode(thread, previousMode);
      }
      throw err;
    } finally {
      if (isPrompt) {
        this.setTurnActive(thread, false);
        this.downstreams.endPrompt(params);
        // The idle announcement comes from Activity, not from here: a prompt
        // can stay open until the turn's background subagents settle.
      }
    }
  }

  /**
   * Sends one browser the full history of its thread, replayed by the adapter
   * again. The replay goes to that browser only.
   *
   * A replay and a live turn look the same on the wire, so this runs only
   * while the thread is idle: no prompt in flight, the agent quiet, and no
   * background task that could wake it. Prompts are refused until the replay
   * is over.
   *
   * @returns The answer to the browser's `session/load`.
   */
  private async relayHistory(
    conn: AdapterConnection,
    handle: DownstreamHandle,
    acpThreadId: string,
  ): Promise<AdapterOptions> {
    if (this.downstreams.isRelaying(acpThreadId)) throw new Error(HISTORY_LOADING);
    if (
      this.downstreams.isPrompting(acpThreadId) ||
      this.activity.speaking(acpThreadId) ||
      this.tasksFor(acpThreadId).length > 0
    ) {
      throw new Error(THREAD_WORKING);
    }
    const row = conn.rowOf(acpThreadId);
    if (!row || !conn.holds(acpThreadId)) throw new Error(THREAD_NOT_FOUND);
    // The adapter would replay nothing, because it writes a fork no
    // transcript until its first prompt.
    if (row.inherits_from) throw new Error(NO_OWN_HISTORY);
    this.slog.info('replaying the full history', { handle: handle.id, acpThreadId });
    this.downstreams.beginRelay(handle, acpThreadId);
    let res: LoadAnswer;
    try {
      res = await conn.replay(acpThreadId);
    } finally {
      this.downstreams.endRelay(acpThreadId);
    }
    // After the relay, so the updates this causes reach every browser and
    // the log.
    await conn.restoreSettings(row, res);
    return optionsOf(res);
  }

  /**
   * Records a setting a browser changed, in the thread's log and row, from the
   * adapter's answer where there is one and from the request where there is
   * not. The row skips the option in the `mode` category.
   */
  private recordConfigChange(
    conn: AdapterConnection,
    acpThreadId: string,
    params: unknown,
    result: unknown,
  ): void {
    const answered = answeredOptions(result);
    const { configId, value } = (params ?? {}) as { configId?: unknown; value?: unknown };
    if (typeof configId === 'string' && typeof value === 'string') {
      this.downstreams.logConfig(acpThreadId, configId, value, answered);
    }
    if (answered) {
      conn.recordConfigOptions(acpThreadId, answered);
      return;
    }
    if (typeof configId === 'string' && typeof value === 'string') {
      conn.recordConfigValue(acpThreadId, configId, value);
    }
  }

  /** Records whether a prompt turn is running on one thread, and marks the box active. */
  private setTurnActive(acpThreadId: string, active: boolean): void {
    setThreadTurnActive(this.db, this.boxId, acpThreadId, active);
  }

  /** Forwards a browser notification to the adapter its thread is on. */
  async forwardNotification(method: string, params: unknown): Promise<void> {
    const conn = this.connectionFor(params);
    await conn.ensureStarted();
    this.tap('down', method, params);
    const thread = threadOf(params);
    if (method === ACP_METHOD.sessionCancel && thread) {
      this.setTurnActive(thread, false);
      this.activity.reset(thread);
      this.downstreams.threadState(thread);
    }
    await conn.notify(method, params);
  }

  /** Writes one message to the log at debug level, where `docker logs` sees it. */
  tap(direction: 'up' | 'down', method: string, params: unknown): void {
    if (!log.wants('debug')) return;
    this.slog.debug('acp', {
      direction,
      method,
      payload: JSON.stringify(params, withoutMediaPayloads).slice(0, MAX_TAPPED_CHARS),
    });
  }

  // --- shutdown --------------------------------------------------------------

  /** Stops every connection deliberately, which suppresses the respawns. */
  stop(): void {
    this.stopPolling();
    // An escalation that fired later would read a box that is gone.
    for (const timer of this.escalations) clearTimeout(timer);
    this.escalations.clear();
    // A stopped box runs nothing, so the reading is cleared now.
    this.background.clear();
    for (const conn of this.connections.values()) conn.stop();
    this.clearThreadStates();
    // The next question from a fresh adapter may be announced again.
    this.announcedApprovals.clear();
    this.pending.failBox(this.boxId, 'Box stopped');
  }

  /** Stops for good and forgets every attached browser. */
  close(): void {
    this.stop();
    this.downstreams.clear();
  }
}
