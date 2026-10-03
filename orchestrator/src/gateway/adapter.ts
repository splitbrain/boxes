import { client as acpClient, type ClientConnection } from '@agentclientprotocol/sdk';
import type { Stream } from '@agentclientprotocol/sdk';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { PassThrough, Readable } from 'node:stream';
import {
  getThread,
  insertThread,
  setThreadAcpId,
  setThreadConfig,
  threadByAcpId,
  threadConfig,
  upsertHarnessCatalog,
  type Db,
  type ThreadRow,
} from '../db.ts';
import { HARNESS_IDS, type Harness, type HarnessId } from '../harness.ts';
import type { Logger } from '../log.ts';
import { runtime } from '../runtime.ts';
import type { AdapterExec } from '../runtime/types.ts';
import { ACP_METHOD } from '../../../shared/acp.ts';
import type {
  BackgroundProcess,
  ThreadConfigOption,
  ThreadModeState,
} from '../../../shared/types.ts';
import { TaskBoard } from './background.ts';
import { threadOf } from './broadcast.ts';
import type { AdapterOptions } from './thread-log.ts';

/** Pass-through parser, leaving params and their _meta untouched. */
const raw = <T = unknown>(params: unknown): T => params as T;

/**
 * Update kinds the SDK's schema does not know, which
 * {@link AdapterConnection.siftExtensions} takes off the stream.
 */
const EXTENSION_UPDATE = /^async_task_/;

/** How many times the adapter spawn is tried before the box errors. */
const MAX_SPAWN_ATTEMPTS = 3;

/** Wait before each retry, in milliseconds, by retry number. */
const SPAWN_BACKOFF_MS = [1000, 3000];

/** JSON-RPC code the ACP SDK uses for a resource that does not exist. */
const RESOURCE_NOT_FOUND = -32002;

/** JSON-RPC code an adapter refusing an unauthenticated `session/*` call uses. */
const AUTH_REQUIRED = -32000;

/**
 * How many hops {@link inheritedSource} follows back along a chain of forks.
 * The bound stops a row that points at itself.
 */
const MAX_INHERIT_HOPS = 32;

/**
 * The client capabilities Boxes sends at `initialize`.
 *
 * Only the async-task extension, which both adapters need before they send
 * async-task updates. With no filesystem or terminal capability, the adapter
 * sends the client only `session/update` and `session/request_permission`.
 */
const CLIENT_CAPABILITIES = {
  _meta: { jetbrains: { air: { version: 1, capabilities: ['asyncTasks'] } } },
} as const;

/** A thread id that names none of the box's threads; the API turns this into a 404. */
export const THREAD_NOT_FOUND = 'Thread not found';

/** Why a thread cannot be forked yet; the API turns this into a 409. */
export const NOTHING_TO_FORK = 'That thread has nothing to fork from yet';

/** True when the adapter reported a missing thread rather than a failure. */
export function isResourceNotFound(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === RESOURCE_NOT_FOUND;
}

/**
 * True when the adapter refused because it has no credential.
 *
 * Matched on the code and the message, because -32000 is the generic server
 * error. Codex's adapter answers every `session/*` call this way while the
 * box holds only a placeholder for the credential.
 */
export function isAuthRequired(err: unknown): boolean {
  const error = err as { code?: number; message?: unknown } | null;
  return (
    error?.code === AUTH_REQUIRED &&
    typeof error.message === 'string' &&
    error.message.startsWith('Authentication required')
  );
}

/**
 * The value to select for a wanted model: the name itself when the adapter
 * offers it, else a bracketed variant of it such as `opus[1m]`, which is the
 * same model with a different context window. A name that merely starts the
 * same way, such as `opusplan`, is a different model and never matches.
 */
export function pickModel(
  options: ReadonlyArray<{ value: string }>,
  wanted: string,
): string | null {
  if (options.some((option) => option.value === wanted)) return wanted;
  return options.find((option) => option.value.startsWith(`${wanted}[`))?.value ?? null;
}

/**
 * The nearest thread a fork can be branched from again, or null when there is
 * none: the first thread up its chain that has a transcript of its own.
 *
 * The chain matters for a fork of a fork that has not been prompted, because
 * the middle thread has no transcript either.
 */
export function inheritedSource(
  db: Db,
  boxId: string,
  thread: ThreadRow,
): ThreadRow | null {
  let row: ThreadRow | undefined = thread;
  for (let hop = 0; hop < MAX_INHERIT_HOPS; hop++) {
    const next: string | null = row?.inherits_from ?? null;
    if (!next) return null;
    row = getThread(db, next);
    if (!row || row.box_id !== boxId) return null;
    if (row.acp_session_id && !row.inherits_from) return row;
  }
  return null;
}

/** The adapter's answer to a `session/load`: the modes and options it left the thread in. */
export type LoadAnswer = {
  modes?: ThreadModeState | null;
  configOptions?: ThreadConfigOption[] | null;
} | null;

/**
 * The config options from the adapter's answer to a `session/set_config_option`.
 *
 * @returns The options, or undefined when the answer lists none.
 */
export function answeredOptions(res: unknown): ThreadConfigOption[] | undefined {
  const configOptions = (res as { configOptions?: unknown } | null)?.configOptions;
  return Array.isArray(configOptions) ? (configOptions as ThreadConfigOption[]) : undefined;
}

/**
 * The modes and config options from the adapter's answer to a `session/new`,
 * `session/fork` or `session/load`. Absent ones read as none.
 */
export function optionsOf(res: LoadAnswer): AdapterOptions {
  return { modes: res?.modes ?? null, configOptions: res?.configOptions ?? [] };
}

/**
 * What a connection needs from the box that owns it: the shared container,
 * the browsers and their threads, and where updates go.
 */
export interface AdapterHost {
  /** The box's id. */
  readonly boxId: string;
  /** The orchestrator's database. */
  readonly db: Db;
  /**
   * Starts the box and attaches the egress proxy, and resolves to the
   * container id. Two adapters starting at once start one container.
   */
  ensureContainer(): Promise<string>;
  /** The box's most recently active thread, or null before it has one. */
  latestThread(): ThreadRow | null;
  /** Every conversation a browser is watching, by the adapter's own id. */
  watchedThreads(): readonly string[];
  /** Receives an adapter update, and whether it is part of a replay. */
  onUpdate(harness: HarnessId, params: unknown, replaying: boolean): void;
  /** Answers a permission request. The adapter blocks until it resolves. */
  onPermission(params: unknown): Promise<unknown>;
  /** Reports the conversations lost when the adapter process exited. */
  onThreadsLost(acpThreadIds: readonly string[]): void;
  /** Closes the browsers pinned to one conversation, so each reconnects. */
  dropWatchers(acpThreadId: string): void;
  /**
   * Opens a log for a conversation this adapter has just minted.
   *
   * @param from The conversation it was forked from, whose log is copied.
   */
  openLog(acpThreadId: string, options: AdapterOptions, from?: string): void;
  /** Starts reading a transcript into this conversation's log. */
  beginFill(acpThreadId: string): void;
  /** Ends the transcript read, so the thread's updates go to browsers again. */
  endFill(acpThreadId: string, options: AdapterOptions): void;
  /** Forgets a conversation's log, for one the adapter does not hold. */
  dropLog(acpThreadId: string): void;
  /**
   * Sets the current mode in a conversation's log.
   *
   * @returns The mode that was current before, or null when the log has none.
   */
  logMode(acpThreadId: string, modeId: string): string | null;
  /**
   * Sets one option's value in a conversation's log.
   *
   * @param answered The options the adapter answered the change with, if any.
   */
  logConfig(
    acpThreadId: string,
    configId: string,
    value: string,
    answered?: ThreadConfigOption[],
  ): void;
  /** Reports that the connection is up and carrying threads. */
  onUp(): void;
  /** Sets the box status: running, or error after every spawn attempt failed. */
  onStatus(status: 'running' | 'error'): void;
}

/**
 * The orchestrator's ACP connection to one harness's adapter in one box: the
 * exec, the ACP handshake, and the conversations that process holds.
 *
 * A box has one per harness its threads run. Everything here belongs to the
 * process and is lost with it. Browsers, permissions and the box's processes
 * belong to the {@link AdapterHost}.
 */
export class AdapterConnection {
  /** The adapter process, while it runs. */
  private exec: AdapterExec | null = null;
  /** The ACP connection over the exec's stdio, while it is open. */
  private conn: ClientConnection | null = null;
  /** The adapter's answer to `initialize`, once the handshake is done. */
  private initializeResponse: unknown = null;
  /** The start in flight, shared by concurrent callers. */
  private starting: Promise<void> | null = null;
  /** Set by a deliberate stop, so an exec exit does not trigger a respawn. */
  private stopping = false;
  /**
   * Loads in flight on this adapter, per thread. An update on a thread with a
   * load in flight is part of a replay.
   */
  private readonly replaying = new Map<string, number>();
  /**
   * The conversations this adapter process holds: every one it has minted or
   * loaded.
   *
   * A stored ACP id says only that a thread had a conversation once. Emptied
   * with the connection, because a fresh adapter holds nothing.
   */
  private readonly live = new Set<string>();
  /**
   * The category of each config option the adapter has mentioned, by option id.
   *
   * A `session/set_config_option` names only an option and a value, and an
   * option in the `mode` category is not recorded.
   */
  private readonly categories = new Map<string, string | null>();
  /**
   * The tasks this adapter process has announced as running in the background.
   * They are lost with the process, and nothing announces them again.
   */
  private readonly tasks = new TaskBoard();
  /** Whether the missing credential has already been said once. */
  private unauthenticated = false;

  constructor(
    /** The harness whose adapter this connection runs. */
    readonly harness: Harness,
    /** The box that owns this connection. */
    private readonly host: AdapterHost,
    /** Tagged with the box and this harness, since a box may run two. */
    private readonly slog: Logger,
  ) {}

  /** Whether the adapter process is up. */
  get isConnected(): boolean {
    return this.conn !== null;
  }

  /** The initialize response to hand browsers, cached verbatim. */
  get cachedInitialize(): unknown {
    return this.initializeResponse;
  }

  /** Whether this connection holds nothing: no process and no start in flight. */
  get holdsNothing(): boolean {
    return this.conn === null && this.exec === null && this.starting === null;
  }

  /**
   * Whether this adapter advertised the fork capability. False for an adapter
   * that has not been reached yet.
   */
  get canFork(): boolean {
    // ACP marks a supported capability with an object, even `{}`.
    const fork = (
      this.initializeResponse as {
        agentCapabilities?: { sessionCapabilities?: { fork?: unknown } | null } | null;
      } | null
    )?.agentCapabilities?.sessionCapabilities?.fork;
    return fork !== undefined && fork !== null;
  }

  /** Whether this process is holding one conversation right now. */
  holds(acpThreadId: string): boolean {
    return this.live.has(acpThreadId);
  }

  /** Every conversation this process is holding. */
  get liveThreads(): string[] {
    return [...this.live];
  }

  // --- background work -------------------------------------------------------

  /**
   * Reads one update for what it says about a task this adapter is running.
   * Replayed updates count too, because an announced task is still running.
   *
   * @returns Whether the thread's bar has changed.
   */
  noteTask(acpThreadId: string, update: unknown): boolean {
    return this.tasks.note(acpThreadId, update);
  }

  /** What one conversation of this adapter has running. */
  tasksFor(acpThreadId: string): BackgroundProcess[] {
    return this.tasks.for(acpThreadId);
  }

  /** The conversations of this adapter with something running in them. */
  get taskThreads(): string[] {
    return this.tasks.threads;
  }

  /** Whether this adapter has any task running at all. */
  get hasTasks(): boolean {
    return this.tasks.any;
  }

  /**
   * Stops one task of a conversation, or every task it has, through
   * `_session/async_task/stop`. A `session/cancel` does not reach a
   * background task.
   *
   * An answer of `stopped: false` means the task was already over, so its
   * entry goes either way. A failed request keeps the entry, because the task
   * may still run.
   *
   * @returns How many tasks the adapter said it stopped.
   */
  async stopTasks(acpThreadId: string, taskId?: string): Promise<number> {
    const wanted = taskId ? [taskId] : this.tasks.for(acpThreadId).map((task) => task.id);
    let stopped = 0;
    for (const id of wanted) {
      try {
        const answer = (await this.request('_session/async_task/stop', {
          sessionId: acpThreadId,
          asyncTaskId: id,
        })) as { stopped?: unknown } | null;
        if (answer?.stopped === true) stopped += 1;
        else this.slog.info('the task was already over', { acpThreadId, asyncTaskId: id });
        this.tasks.drop(acpThreadId, id);
      } catch (err) {
        this.slog.warn('could not stop a task', {
          acpThreadId,
          asyncTaskId: id,
          error: (err as Error).message,
        });
      }
    }
    return stopped;
  }

  /**
   * Brings up the container, the exec and the ACP handshake. Concurrent callers
   * share one attempt.
   *
   * The check uses the initialize response, because the connection exists
   * before its handshake has finished.
   */
  async ensureStarted(): Promise<void> {
    if (this.conn && this.initializeResponse) return;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  /** Spawns the adapter and brings back its threads, retrying with a backoff. */
  private async start(): Promise<void> {
    this.stopping = false;
    const containerId = await this.host.ensureContainer();
    // A repair that replaces the container stops this connection and sets
    // the flag. Cleared again, so the spawn below reacts to its exec exiting.
    this.stopping = false;

    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_SPAWN_ATTEMPTS; attempt++) {
      if (this.stopping) return;
      if (attempt > 0) {
        const wait = SPAWN_BACKOFF_MS[attempt - 1]!;
        this.slog.warn('retrying adapter spawn', { attempt, waitMs: wait });
        await new Promise((r) => setTimeout(r, wait));
      }
      try {
        await this.spawnAndInitialize(containerId);
      } catch (err) {
        lastError = err;
        this.slog.error('adapter spawn failed', { attempt, error: (err as Error).message });
        this.teardownConnection();
        continue;
      }
      try {
        await this.loadThreads();
      } catch (err) {
        // A missing credential is not a spawn failure, and a retry cannot fix
        // it. The connection stays up, and each request fails with the
        // adapter's own message.
        if (isAuthRequired(err)) {
          this.noteAuthRequired(err);
          this.host.onUp();
          return;
        }
        lastError = err;
        this.slog.error('adapter could not bring its threads back', {
          attempt,
          error: (err as Error).message,
        });
        this.teardownConnection();
        continue;
      }
      // A stop arrived while this was coming up.
      if (this.stopping) {
        this.teardownConnection();
        return;
      }
      this.host.onStatus('running');
      // Restarts the box reading's poll for browsers that stayed attached.
      this.host.onUp();
      return;
    }
    // The box was stopped during the retries.
    if (this.stopping) return;
    this.host.onStatus('error');
    throw new Error(
      `${this.harness.label} adapter failed to start after ${MAX_SPAWN_ATTEMPTS} attempts: ` +
        `${(lastError as Error)?.message}`,
    );
  }

  /** Spawns the adapter exec and performs the ACP handshake. */
  private async spawnAndInitialize(containerId: string): Promise<void> {
    const exec = await runtime().exec.spawnAdapterExec(
      containerId,
      [...this.harness.cmd],
      runtime().boxes.WORKSPACE_DIR,
    );
    this.exec = exec;

    // The adapter logs to stderr and keeps stdout for the protocol.
    exec.stderr.setEncoding('utf8');
    exec.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) this.slog.debug('adapter stderr', { line: line.slice(0, 2000) });
      }
    });

    // An exec that has been replaced can report its exit late.
    void exec.exited.then((code) => {
      if (this.exec === exec) this.handleExecExit(code);
    });

    const stream = this.makeStream(exec);
    const app = acpClient({ name: `boxes-${this.host.boxId}` })
      .onNotification(ACP_METHOD.sessionUpdate as string, raw, ({ params }) => {
        this.host.onUpdate(this.harness.id, params, this.isReplaying(params));
      })
      .onRequest(ACP_METHOD.sessionRequestPermission as string, raw, ({ params }) =>
        this.host.onPermission(params),
      );

    const conn = app.connect(stream);
    this.conn = conn;

    this.initializeResponse = await conn.agent.request(ACP_METHOD.initialize, {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    this.slog.info('adapter initialized', { workingDir: runtime().boxes.WORKSPACE_DIR });
  }

  /**
   * Brings back every conversation of this harness that this connection has to
   * carry: the box's most recently active thread when it runs this harness,
   * and each thread of this harness a browser is watching.
   */
  private async loadThreads(): Promise<void> {
    // A box with no thread at all gets its first one here.
    const latest = this.host.latestThread();
    if (!latest) {
      await this.mintFirstThread();
    } else if (latest.harness === this.harness.id) {
      const replayed = latest.acp_session_id ? await this.loadThread(latest) : false;
      if (!replayed) await this.mintInto(latest.id);
    }

    for (const acpThreadId of this.host.watchedThreads()) {
      if (this.live.has(acpThreadId)) continue;
      const row = threadByAcpId(this.host.db, this.host.boxId, this.harness.id, acpThreadId);
      if (!row && this.heldElsewhere(acpThreadId)) continue;
      try {
        if (row?.acp_session_id && (await this.loadThread(row))) continue;
      } catch (err) {
        if (isAuthRequired(err)) throw err;
        // A fault on a watched thread does not fail the spawn.
        this.slog.warn('could not reload a watched thread', {
          threadId: row?.id ?? null,
          error: (err as Error).message,
        });
      }
      // The id is dead. Each browser on it reconnects and pins the current id.
      this.host.dropWatchers(acpThreadId);
    }
  }

  /** Whether a conversation id belongs to a thread of some other harness. */
  private heldElsewhere(acpThreadId: string): boolean {
    return HARNESS_IDS.some(
      (id) =>
        id !== this.harness.id &&
        threadByAcpId(this.host.db, this.host.boxId, id, acpThreadId) !== undefined,
    );
  }

  /** Gives a box with no thread row its first conversation, on this harness. */
  private async mintFirstThread(): Promise<void> {
    const acpSessionId = await this.mintAcpThread(null, this.harness.defaultModeId, {
      ...this.harness.defaultConfig,
    });
    const created = insertThread(this.host.db, this.host.boxId, {
      harness: this.harness.id,
      acpSessionId,
    });
    this.slog.info('first thread recorded', { threadId: created.id });
  }

  /**
   * Makes this adapter hold one of the box's threads: its stored
   * conversation when the adapter still has the transcript for it, a fresh one
   * when it does not.
   *
   * @returns The adapter's id for the thread.
   */
  async bringUp(threadId: string): Promise<string> {
    await this.ensureStarted();
    // Read after the spawn, which may already have loaded this thread.
    const row = getThread(this.host.db, threadId);
    if (!row) throw new Error(THREAD_NOT_FOUND);
    if (row.acp_session_id && this.live.has(row.acp_session_id)) return row.acp_session_id;
    if (row.acp_session_id && (await this.loadThread(row))) return row.acp_session_id;
    return this.mintInto(threadId);
  }

  /**
   * Mints a fresh adapter conversation and records it against a thread row.
   *
   * A fork that has not been prompted yet is branched from its source again.
   * When the source cannot be branched either, the thread starts empty.
   *
   * @returns The adapter's id for the new conversation.
   */
  async mintInto(threadId: string): Promise<string> {
    const row = getThread(this.host.db, threadId);
    const source = row ? inheritedSource(this.host.db, this.host.boxId, row) : null;
    // The row's recorded mode wins over the default for the thread's kind.
    const modeId =
      row?.mode_id ?? (source ? this.harness.forkModeId : this.harness.defaultModeId);
    const config = row ? threadConfig(row) : { ...this.harness.defaultConfig };
    let branched: string | null = null;
    if (source?.acp_session_id) {
      try {
        if (!(await this.hold(source))) throw new Error(NOTHING_TO_FORK);
        branched = await this.mintAcpThread(source.acp_session_id, modeId, config);
      } catch (err) {
        if (isAuthRequired(err)) throw err;
        this.slog.warn('could not branch a fork again; starting it empty', {
          threadId,
          from: source.id,
          error: (err as Error).message,
        });
      }
    }
    const acpSessionId = branched ?? (await this.mintAcpThread(null, modeId, config));
    setThreadAcpId(this.host.db, threadId, acpSessionId);
    this.slog.info('thread had no adapter conversation; minted one', {
      threadId,
      acpSessionId,
      forkedFrom: branched ? source?.id : null,
    });
    return acpSessionId;
  }

  /**
   * Makes sure this adapter holds one of the box's threads, and loads it when
   * it does not.
   *
   * @returns False when the adapter no longer has the thread's transcript.
   */
  async hold(thread: ThreadRow): Promise<boolean> {
    if (!thread.acp_session_id) return false;
    if (this.live.has(thread.acp_session_id)) return true;
    return this.loadThread(thread);
  }

  /**
   * Mints an ACP thread and gives it the mode and settings it is meant to have.
   *
   * @param from The thread to fork, or null to start empty.
   * @returns The adapter's id for the new thread.
   */
  async mintAcpThread(
    from: string | null,
    modeId: string,
    config: Record<string, string>,
  ): Promise<string> {
    const method = from ? ACP_METHOD.sessionFork : ACP_METHOD.sessionNew;
    const res = (await this.request(method, {
      ...(from ? { sessionId: from } : {}),
      cwd: runtime().boxes.WORKSPACE_DIR,
      mcpServers: [],
      ...this.meta(),
    })) as {
      sessionId?: string;
      modes?: ThreadModeState | null;
      configOptions?: ThreadConfigOption[] | null;
    };
    if (!res?.sessionId) throw new Error(`${method} returned no sessionId`);
    this.live.add(res.sessionId);
    this.host.openLog(res.sessionId, optionsOf(res), from ?? undefined);
    this.noteCatalog(res);
    this.slog.info('acp session created', { method, acpSessionId: res.sessionId, from });
    await this.applyMode(res.sessionId, res.modes ?? null, modeId);
    await this.applyConfig(res.sessionId, res.configOptions ?? null, config);
    return res.sessionId;
  }

  /**
   * Loads a stored thread, reading its transcript into the thread's log.
   *
   * This is the only place that asks for the adapter's replay. It runs only
   * on a thread that cannot be talking: one this adapter has just spawned
   * for, or one no browser is pinned to. So everything that arrives meanwhile
   * belongs to the transcript.
   *
   * A thread that was never prompted has no transcript and does not survive a
   * container stop. Any error other than a missing thread is rethrown, so a
   * transient fault does not discard a live thread.
   *
   * @returns False when the adapter no longer holds the thread.
   */
  private async loadThread(thread: ThreadRow): Promise<boolean> {
    const acpSessionId = thread.acp_session_id!;
    this.host.beginFill(acpSessionId);
    try {
      const res = await this.replay(acpSessionId);
      this.host.endFill(acpSessionId, optionsOf(res));
      this.live.add(acpSessionId);
      this.noteCatalog(res ?? {});
      this.slog.info('acp thread loaded', { threadId: thread.id, acpSessionId });
      await this.restoreSettings(thread, res);
      return true;
    } catch (err) {
      this.host.dropLog(acpSessionId);
      if (!isResourceNotFound(err)) throw err;
      this.live.delete(acpSessionId);
      this.slog.warn('stored thread is gone; starting a fresh one', {
        threadId: thread.id,
        acpSessionId,
        error: (err as Error).message,
      });
      setThreadAcpId(this.host.db, thread.id, null);
      return false;
    }
  }

  /**
   * Asks the adapter to replay a thread, with its updates marked as a
   * replay. Where the updates go is up to the caller.
   *
   * A load may reset the thread's mode and settings, so the caller puts them
   * back with {@link restoreSettings} once the replay has been routed.
   *
   * @returns The adapter's answer to the load.
   */
  async replay(acpThreadId: string): Promise<LoadAnswer> {
    // The same `_meta` a fresh thread gets, because the adapter reads it on
    // load too.
    return (await this.whileReplaying(acpThreadId, () =>
      this.request(ACP_METHOD.sessionLoad, {
        sessionId: acpThreadId,
        cwd: runtime().boxes.WORKSPACE_DIR,
        mcpServers: [],
        ...this.meta(),
      }),
    )) as LoadAnswer;
  }

  /**
   * Puts a thread back on the mode and settings its row records, after a
   * load. A load restores only the conversation.
   *
   * @param res The adapter's answer to the load.
   */
  async restoreSettings(thread: ThreadRow, res: LoadAnswer): Promise<void> {
    const acpSessionId = thread.acp_session_id!;
    await this.applyMode(
      acpSessionId,
      res?.modes ?? null,
      thread.mode_id ?? this.harness.defaultModeId,
    );
    await this.applyConfig(acpSessionId, res?.configOptions ?? null, threadConfig(thread));
  }

  /**
   * Puts a thread in the given mode, after a mint or a load.
   *
   * Does nothing when the adapter does not offer the mode or is already in it.
   */
  async applyMode(
    acpSessionId: string,
    modes: ThreadModeState | null,
    modeId: string,
  ): Promise<void> {
    if (!modes?.availableModes?.some((mode) => mode.id === modeId)) return;
    if (modes.currentModeId === modeId) return;
    // Logged before the request, so that a `current_mode_update` for a mode
    // the adapter falls back to replaces it.
    this.host.logMode(acpSessionId, modeId);
    try {
      await this.request(ACP_METHOD.sessionSetMode, { sessionId: acpSessionId, modeId });
      this.slog.info('thread put in its mode', { acpSessionId, modeId });
    } catch (err) {
      this.host.logMode(acpSessionId, modes.currentModeId);
      // A thread in the adapter's own mode is still usable.
      this.slog.warn('could not set the mode', { error: (err as Error).message });
    }
  }

  /**
   * Puts a thread back on its recorded settings: one `set_config_option` per
   * offered option whose current value differs.
   *
   * The option in the `mode` category is skipped, because the mode goes
   * through `session/set_mode`. A value the adapter rejects is logged.
   */
  async applyConfig(
    acpSessionId: string,
    configOptions: ThreadConfigOption[] | null,
    config: Record<string, string>,
  ): Promise<void> {
    if (!configOptions) return;
    for (const option of configOptions) {
      if (option.category === 'mode') continue;
      const value = this.wantedValue(option, config[option.id]);
      if (value === null || value === option.currentValue) continue;
      try {
        const res = await this.request(ACP_METHOD.sessionSetConfigOption, {
          sessionId: acpSessionId,
          configId: option.id,
          value,
        });
        this.host.logConfig(acpSessionId, option.id, value, answeredOptions(res));
        this.slog.info('thread put back on a setting', {
          acpSessionId,
          configId: option.id,
          value,
        });
      } catch (err) {
        this.slog.warn('could not set a thread setting', {
          configId: option.id,
          value,
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * What one option should be set to, or null to leave the adapter's value.
   *
   * Only the model has a fallback: a recorded model the adapter no longer
   * offers, or no recorded model, falls back to the harness's default through
   * {@link pickModel}. Other options use the recorded value.
   */
  private wantedValue(option: ThreadConfigOption, recorded: string | undefined): string | null {
    if (option.category !== 'model') return recorded ?? null;
    const offered = option.options ?? [];
    const fallback = this.harness.defaultConfig[option.id];
    return (
      (recorded ? pickModel(offered, recorded) : null) ??
      (fallback ? pickModel(offered, fallback) : null)
    );
  }

  /**
   * Records what the adapter says a thread is configured with, merged over what
   * the row holds. The option in the `mode` category is skipped.
   *
   * Called with the answer to a `session/set_config_option` and with a
   * `config_option_update`, because the adapter also changes settings by
   * itself.
   */
  recordConfigOptions(acpSessionId: string, configOptions: ThreadConfigOption[]): void {
    const row = this.rowOf(acpSessionId);
    if (!row) return;
    const config = threadConfig(row);
    let changed = false;
    for (const option of configOptions) {
      if (typeof option?.id !== 'string') continue;
      this.categories.set(option.id, option.category ?? null);
      if (option.category === 'mode') continue;
      if (typeof option.currentValue !== 'string') continue;
      if (config[option.id] === option.currentValue) continue;
      config[option.id] = option.currentValue;
      changed = true;
    }
    if (changed) setThreadConfig(this.host.db, row.id, config);
  }

  /**
   * Records one option from the request that set it, for an adapter that
   * answers a `session/set_config_option` with nothing. An option known to be
   * in the `mode` category is skipped.
   */
  recordConfigValue(acpSessionId: string, configId: string, value: string): void {
    if (this.categories.get(configId) === 'mode') return;
    const row = this.rowOf(acpSessionId);
    if (!row) return;
    const config = threadConfig(row);
    if (config[configId] === value) return;
    config[configId] = value;
    setThreadConfig(this.host.db, row.id, config);
  }

  /** One of this harness's threads, by the adapter's own id for it. */
  rowOf(acpSessionId: string): ThreadRow | undefined {
    return threadByAcpId(this.host.db, this.host.boxId, this.harness.id, acpSessionId);
  }

  /**
   * Sends a request to the adapter. Logs the missing credential once when the
   * adapter refuses for want of one.
   */
  async request(method: string, params: unknown): Promise<unknown> {
    const conn = this.conn;
    if (!conn) throw new Error(`${this.harness.label} adapter is not connected`);
    try {
      const result = await conn.agent.request(method, params);
      this.unauthenticated = false;
      return result;
    } catch (err) {
      if (isAuthRequired(err)) this.noteAuthRequired(err);
      throw err;
    }
  }

  /** Sends a notification to the adapter. */
  async notify(method: string, params: unknown): Promise<void> {
    const conn = this.conn;
    if (!conn) throw new Error(`${this.harness.label} adapter is not connected`);
    await conn.agent.notify(method, params);
  }

  /**
   * Runs a `session/load` with the thread's updates marked as a replay until
   * it settles.
   *
   * A load sends the conversation as ordinary notifications, so this marker is
   * what tells them apart from live updates.
   *
   * @param acpThreadId The thread id the replayed updates carry.
   */
  async whileReplaying<T>(acpThreadId: string, load: () => Promise<T>): Promise<T> {
    this.replaying.set(acpThreadId, (this.replaying.get(acpThreadId) ?? 0) + 1);
    try {
      return await load();
    } finally {
      const left = (this.replaying.get(acpThreadId) ?? 1) - 1;
      if (left > 0) this.replaying.set(acpThreadId, left);
      else this.replaying.delete(acpThreadId);
    }
  }

  /** Whether an update is a thread's own transcript being read back. */
  private isReplaying(params: unknown): boolean {
    const thread = threadOf(params);
    return thread !== undefined && this.replaying.has(thread);
  }

  /** Says once that this adapter has no account to run under. */
  private noteAuthRequired(err: unknown): void {
    if (this.unauthenticated) return;
    this.unauthenticated = true;
    this.slog.warn('the adapter has no credential to run under', {
      credential: this.harness.credentialId,
      error: (err as Error).message,
    });
  }

  /** The `_meta` this harness's thread calls carry, or nothing when it has none. */
  meta(): { _meta?: Record<string, unknown> } {
    return this.harness.threadMeta ? { _meta: { ...this.harness.threadMeta } } : {};
  }

  /** Caches what this answer advertised, for a dialog with no adapter to ask. */
  private noteCatalog(res: {
    modes?: ThreadModeState | null;
    configOptions?: ThreadConfigOption[] | null;
  }): void {
    if (!res.modes && !res.configOptions) return;
    for (const option of res.configOptions ?? []) {
      if (typeof option?.id === 'string') this.categories.set(option.id, option.category ?? null);
    }
    try {
      upsertHarnessCatalog(this.host.db, this.harness.id, res.modes, res.configOptions);
    } catch (err) {
      this.slog.debug('harness catalogue write failed', { error: (err as Error).message });
    }
  }

  /**
   * Takes the async-task extension's notifications off the stream before the
   * SDK parses it, and passes them to {@link AdapterHost.onUpdate} directly.
   *
   * The SDK's session-update router checks each `session/update` against its
   * schema, and drops an update kind it does not know before any handler
   * runs. These updates can arrive ahead of SDK-parsed frames that the adapter
   * sent earlier.
   */
  private siftExtensions(stdout: Readable): Readable {
    const passed = new PassThrough();
    let buffer = '';
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let full = true;
      let cut = buffer.indexOf('\n');
      while (cut !== -1) {
        const line = buffer.slice(0, cut + 1);
        buffer = buffer.slice(cut + 1);
        if (!this.consumeExtension(line)) full = passed.write(line) && full;
        cut = buffer.indexOf('\n');
      }
      // Backpressure: a slow reader pauses the adapter's stdout.
      if (!full) {
        stdout.pause();
        passed.once('drain', () => stdout.resume());
      }
    });
    // A half-written last line goes to the SDK, which rejects a broken frame.
    stdout.on('end', () => {
      if (buffer) passed.write(buffer);
      passed.end();
    });
    stdout.on('error', (err: Error) => passed.destroy(err));
    return passed;
  }

  /**
   * Delivers one line if it is an extension notification.
   *
   * @returns Whether the line was one. Any other line stays on the stream.
   */
  private consumeExtension(line: string): boolean {
    if (!line.includes('async_task_')) return false;
    let message: {
      id?: unknown;
      method?: unknown;
      params?: { update?: { sessionUpdate?: unknown } };
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return false;
    }
    if (message.id !== undefined || message.method !== ACP_METHOD.sessionUpdate) return false;
    const kind = message.params?.update?.sessionUpdate;
    if (typeof kind !== 'string' || !EXTENSION_UPDATE.test(kind)) return false;
    this.host.onUpdate(this.harness.id, message.params, this.isReplaying(message.params));
    return true;
  }

  /** ACP Stream over the demuxed exec: ndJSON in, ndJSON out. */
  private makeStream(exec: AdapterExec): Stream {
    const readable = Readable.toWeb(
      this.siftExtensions(exec.stdout),
    ) as ReadableStream<Uint8Array>;
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) =>
        new Promise<void>((resolve, reject) => {
          exec.stdin.write(chunk, (err) => (err ? reject(err) : resolve()));
        }),
      close: () => {
        exec.stdin.end();
      },
    });
    return ndJsonStream(writable, readable);
  }

  /**
   * Drops the connection when the adapter exits on its own. The next message
   * for one of its threads calls ensureStarted, which respawns the adapter
   * and loads the threads again.
   */
  private handleExecExit(code: number | null): void {
    if (this.stopping) return;
    this.slog.warn('adapter exec exited', { code });
    // Includes threads with tasks, so their bars are cleared as well.
    const lost = new Set([...this.live, ...this.tasks.threads]);
    this.teardownConnection();
    this.host.onThreadsLost([...lost]);
  }

  /** Closes the connection and kills the exec, tolerating either being gone. */
  teardownConnection(): void {
    try {
      this.conn?.close();
    } catch {
      // already closed
    }
    this.conn = null;
    this.initializeResponse = null;
    // A fresh adapter holds none of these threads.
    this.live.clear();
    // A leftover count would mark every later update of its thread as replay.
    this.replaying.clear();
    // Nothing announces the old process's tasks again.
    this.tasks.clear();
    try {
      this.exec?.kill();
    } catch {
      // already gone
    }
    this.exec = null;
  }

  /**
   * Stops this adapter deliberately, which suppresses the respawn. The box
   * tells the browsers itself.
   */
  stop(): void {
    this.stopping = true;
    this.teardownConnection();
  }
}
