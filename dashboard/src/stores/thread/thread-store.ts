import { ACP_METHOD, UPDATE_KIND } from '../../../../shared/acp.ts';
import type { BackgroundProcess } from '../../../../shared/types.ts';
import { type AcpClient, type ConnectionState, loadParams } from './acp-client.ts';
import type {
  AvailableCommand,
  ContentBlock,
  PermissionOption,
  PlanEntry,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ThreadConfigOption,
  ThreadModeState,
  ThreadNotification,
} from './acp-types.ts';
import {
  applyUpdate,
  emptyModel,
  findTool,
  type Message,
  messageOfTool,
  type ThreadModel,
  truncateFrom,
} from './translate.ts';

/**
 * The type of answer that the thread waits for from the user.
 *
 * `permission` asks whether a tool call may proceed. `question` asks which of
 * several courses to take, e.g., how to leave plan mode. ACP carries both as
 * a permission request, and the tab shows which type waits.
 */
export type Awaiting = 'permission' | 'question';

/** The state that the view renders. Every field is replaced, never mutated. */
export interface ThreadSnapshot {
  /** The messages of the thread, in order. */
  messages: readonly Message[];
  /**
   * True while the agent produces text, thinking or a tool call of its own.
   * The gateway decides the value.
   *
   * An open prompt does not count. The adapter holds a prompt open until the
   * subagents of a turn settle, and a thread woken by a task report works
   * without any prompt.
   */
  isRunning: boolean;
  /**
   * The processes that this thread left running in its box, e.g., a command or
   * a monitor. Usually empty.
   */
  background: readonly BackgroundProcess[];
  /** The type of question that waits for an answer, or null. */
  awaiting: Awaiting | null;
  /** The state of the connection to the gateway. */
  connection: ConnectionState;
  /** The modes the adapter offers, or null. */
  modes: ThreadModeState | null;
  /** The options the adapter lets a client set, such as the model. */
  configOptions: readonly ThreadConfigOption[];
  /** The agent's current plan, or null. */
  plan: PlanEntry[] | null;
  /** The slash commands the adapter accepts, for the composer to complete. */
  commands: AvailableCommand[];
  /** The prompt that the agent expects the user to send next, or null. */
  promptSuggestion: string | null;
  /** The last send or connection error, or null. */
  error: string | null;
  /**
   * True until a replay has been read into this store.
   *
   * The view shows a placeholder meanwhile, not an empty thread.
   */
  loading: boolean;
  /**
   * True when the thread lacks its oldest messages, because the gateway does
   * not hold them. {@link ThreadStore.loadFullHistory} fetches them.
   */
  truncated: boolean;
  /** True while the full history is loading. */
  loadingHistory: boolean;
  /**
   * The number of replays of the whole thread that rebuilt the messages. A
   * rebuild can bring messages back under other ids.
   */
  rebuilds: number;
}

/** The snapshot of a thread before the store has read anything into it. */
export const INITIAL_SNAPSHOT: ThreadSnapshot = {
  messages: [],
  isRunning: false,
  background: [],
  awaiting: null,
  connection: 'connecting',
  modes: null,
  configOptions: [],
  plan: null,
  commands: [],
  promptSuggestion: null,
  error: null,
  loading: true,
  truncated: false,
  loadingHistory: false,
  rebuilds: 0,
};

/** A permission request that has been shown but not yet answered. */
interface OpenApproval {
  /** The tool call the request is about. */
  toolCallId: string;
  /**
   * The options of the request, so the view can show the card again on a tool
   * call that a refetch rebuilt.
   */
  options: PermissionOption[];
  /** Sends the answer back to the gateway. */
  resolve: (response: RequestPermissionResponse) => void;
}

/** The dependencies of the store. A test replaces all of them. */
export interface ThreadStoreDeps {
  /** Builds the client. A test supplies a fake. */
  createClient: (handlers: ConstructorParameters<typeof AcpClient>[2]) => AcpClient;
  /** The box this thread belongs to. */
  boxId: string;
  /** The id of the thread in the box. */
  threadId: string;
}

/**
 * The live state of one thread, with the ACP connection, the message model
 * built from it, and the actions of the view.
 *
 * React reads it through useSyncExternalStore. It has no React dependency, so
 * tests run without a renderer.
 */
export class ThreadStore {
  /** The message model, mutated as updates arrive. */
  private model: ThreadModel = emptyModel();
  /** The published state. */
  private snapshot: ThreadSnapshot;
  /** The snapshot copy of each message. The store copies a message again only when it changes. */
  private views = new Map<Message, Message>();
  /** The subscribers to wake on every publish. */
  private readonly listeners = new Set<() => void>();
  /** The permission requests still open, oldest first, by approval id. */
  private readonly approvals = new Map<string, OpenApproval>();
  /** The connection, or null before `start` and after `dispose`. */
  private client: AcpClient | null = null;
  /**
   * True while the agent speaks, as the gateway reports it.
   *
   * A new store has sent nothing, yet a turn may already run, because the
   * orchestrator is the ACP client of record. The gateway sends this after
   * the replay and on every change.
   */
  private speakingUpstream = false;
  /** The processes that the thread left running, as the gateway reports them. */
  private backgroundUpstream: readonly BackgroundProcess[] = [];
  /** The number for the next approval id. */
  private nextApprovalId = 1;
  /**
   * True from the moment a connection says it is about to replay until the
   * replay has been read.
   *
   * A replay arrives as one notification per chunk. The store builds the
   * model without publishing and publishes it once at the end, so the view
   * renders the conversation once.
   */
  private replaying = false;
  /**
   * The message this store last named as the resume point, or null when it
   * asked for the whole thread.
   *
   * The load carries the point, and a later notification says whether the
   * gateway found it, so the store keeps it until then.
   */
  private resumeAnchor: string | null = null;
  /**
   * True when the model lacks the oldest messages of the thread. Published with
   * the replay that set it.
   */
  private truncated = false;
  /** The number of rebuilds so far. Published with the replay that did it. */
  private rebuilds = 0;

  /** @param deps The client factory and the ids of the thread. */
  constructor(private readonly deps: ThreadStoreDeps) {
    this.snapshot = INITIAL_SNAPSHOT;
  }

  /**
   * Adds a subscriber.
   *
   * @param listener The callback to run on every publish.
   * @returns The function that removes the subscriber.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Reads the published state.
   *
   * @returns The current snapshot.
   */
  getSnapshot = (): ThreadSnapshot => this.snapshot;

  /**
   * Publishes a new snapshot and wakes every subscriber.
   *
   * @param patch The snapshot fields to change. The store computes the derived fields itself.
   */
  private emit(patch: Partial<ThreadSnapshot> = {}): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      isRunning: this.running,
      background: this.backgroundUpstream,
      awaiting: this.awaiting,
    };
    for (const l of this.listeners) l();
  }

  /**
   * True while the agent speaks, as the gateway reports it.
   *
   * A turn blocked on a permission request counts as not running. The
   * runtime shows an open approval only while the thread is not running, so
   * a running thread would hide the question and block the turn.
   */
  private get running(): boolean {
    return this.speakingUpstream && this.approvals.size === 0;
  }

  /**
   * The type of the oldest open request, or null when none is open.
   *
   * The oldest request blocks the turn, and the view brings the reader to it.
   */
  private get awaiting(): Awaiting | null {
    for (const approval of this.approvals.keys()) {
      return isQuestion(this.optionsFor(approval)) ? 'question' : 'permission';
    }
    return null;
  }

  /**
   * Gives the snapshot copies of all messages in the model, with a new copy
   * of `touched`.
   *
   * The model is mutated in place while a message streams. A new copy of the
   * changed message gives the view a new identity to re-render on.
   *
   * @param touched The message that changed, or null.
   * @returns The snapshot copies, in order.
   */
  private messageViews(touched: Message | null): readonly Message[] {
    if (touched) this.views.set(touched, { ...touched, parts: [...touched.parts] });
    return this.model.messages.map((m) => {
      const view = this.views.get(m);
      if (view) return view;
      const fresh = { ...m, parts: [...m.parts] };
      this.views.set(m, fresh);
      return fresh;
    });
  }

  /**
   * Publishes the messages, unless a replay is still being read.
   *
   * @param touched The message that changed, or null.
   */
  private refreshMessages(touched: Message | null): void {
    if (this.replaying) {
      // flushReplay copies every message at the end of a replay.
      return;
    }
    this.emit({ messages: this.messageViews(touched) });
  }

  /** Connects and starts the handshake. */
  start(): void {
    this.client = this.deps.createClient({
      onUpdate: (params) => this.onUpdate(params),
      onPermission: (params, signal) => this.onPermission(params, signal),
      onReady: (modes, configOptions) => {
        this.model.modes = modes;
        this.model.configOptions = configOptions;
        this.emit({ modes, configOptions, error: null });
        // The replay is in the model now, and flushReplay publishes it.
        this.flushReplay();
      },
      // Skips a repeated state, because a publish re-renders the whole thread
      // and the client reports 'reconnecting' twice per attempt.
      onState: (connection) => {
        if (connection !== this.snapshot.connection) this.emit({ connection });
      },
      onError: (message) => this.emit({ error: message }),
      onTurnState: (state) => {
        this.speakingUpstream = state.speaking;
        this.backgroundUpstream = state.background;
        this.emit();
      },
      resumePoint: () => {
        this.resumeAnchor = this.lastNamedMessage();
        return this.resumeAnchor;
      },
      onReplay: (resumed, truncated) => {
        if (resumed) {
          this.resume();
          return;
        }
        // Only a replay of the whole thread tells whether the store lacks old messages.
        this.truncated = truncated;
        this.reset();
      },
    });
    this.client.start();
  }

  /** Closes the connection and answers every open approval as cancelled. */
  dispose(): void {
    this.client?.dispose();
    this.client = null;
    this.failOpenApprovals();
  }

  /**
   * Discards the model, because a replay of the whole thread will rebuild it.
   * Keeping the model would double every message.
   *
   * The published messages stay until the replay has been read, so a
   * reconnect does not blank the conversation.
   *
   * @param opts Holds `keepApprovals`, for a replay on a connection that is
   *   still up, where cancelling an open question would reach the agent and
   *   refuse the tool call. {@link ThreadStore.refetch} uses it.
   */
  private reset(opts: { keepApprovals?: boolean } = {}): void {
    const { modes, configOptions } = this.model;
    this.model = emptyModel();
    this.model.modes = modes;
    this.model.configOptions = configOptions;
    this.views = new Map();
    this.rebuilds++;
    // The gateway states the turn and the background work again after the
    // replay.
    this.speakingUpstream = false;
    this.backgroundUpstream = [];
    if (!opts.keepApprovals) this.failOpenApprovals();
    this.replaying = true;
    // Publishes the derived fields only. The messages, the plan and the
    // commands stay until the replay arrives.
    this.emit();
  }

  /**
   * Finds the last message that the adapter named, where a replay can resume.
   *
   * A message this model numbered itself, such as one that opens with a tool
   * call, has an id the replay never repeats.
   *
   * @returns The id of the message, or null when there is none, and then the
   *   whole thread must come again.
   */
  private lastNamedMessage(): string | null {
    for (let i = this.model.messages.length - 1; i >= 0; i--) {
      const message = this.model.messages[i];
      if (message?.named) return message.id;
    }
    return null;
  }

  /**
   * Cuts the thread back to the resume point, because the replay about to
   * arrive starts there.
   *
   * The store removes the message that the point names, and every message
   * after it. The replay builds them again. The messages before the point
   * stay, because the gateway does not send them again.
   *
   * When no message matches the point, the store resets and rebuilds the
   * thread from the replay.
   */
  private resume(): void {
    const dropped = this.resumeAnchor ? truncateFrom(this.model, this.resumeAnchor) : [];
    if (dropped.length === 0) {
      this.reset();
      return;
    }
    // The questions came over the connection that has gone. The gateway asks
    // the ones still open again after the replay.
    this.failOpenApprovals();
    for (const { part } of this.model.tools.values()) delete part.approval;
    // The gateway states the turn and the background work again after the
    // replay.
    this.speakingUpstream = false;
    this.backgroundUpstream = [];
    this.replaying = true;
    this.emit();
  }

  /**
   * Publishes the result of a replay in one snapshot.
   *
   * The store calls it once session/load has answered, after the last of the
   * history. A replay that never finishes publishes nothing, and the view
   * keeps what it showed before.
   */
  private flushReplay(): void {
    if (!this.replaying) return;
    this.replaying = false;
    this.emit({
      messages: this.messageViews(null),
      plan: this.model.plan,
      commands: this.model.commands,
      promptSuggestion: this.model.promptSuggestion,
      loading: false,
      truncated: this.truncated,
      rebuilds: this.rebuilds,
    });
  }

  /**
   * Answers every open approval as cancelled and forgets it.
   *
   * Every caller has lost its connection, so the answer reaches nobody. The
   * gateway asks a question that still waits again after the replay.
   */
  private failOpenApprovals(): void {
    for (const open of this.approvals.values()) {
      open.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.approvals.clear();
  }

  /**
   * Puts the questions that were open before a refetch back on the tool calls
   * the replay rebuilt.
   *
   * A question whose tool call the replay did not bring back is answered
   * cancelled, so the agent can move on.
   */
  private restoreApprovals(): void {
    for (const [id, open] of [...this.approvals]) {
      const part = findTool(this.model, open.toolCallId);
      if (!part) {
        this.respondToApproval(id, undefined);
        continue;
      }
      part.approval = { id, options: open.options };
    }
  }

  /**
   * Applies one session/update and publishes what changed.
   *
   * @param params The notification params.
   */
  private onUpdate(params: ThreadNotification): void {
    const touched = applyUpdate(this.model, params.update);
    // flushReplay publishes what a replay built.
    if (this.replaying) return;
    if (
      this.snapshot.modes !== this.model.modes ||
      this.snapshot.configOptions !== this.model.configOptions ||
      this.snapshot.plan !== this.model.plan ||
      this.snapshot.commands !== this.model.commands ||
      this.snapshot.promptSuggestion !== this.model.promptSuggestion
    ) {
      this.emit({
        modes: this.model.modes,
        configOptions: this.model.configOptions,
        plan: this.model.plan,
        commands: this.model.commands,
        promptSuggestion: this.model.promptSuggestion,
      });
    }
    this.refreshMessages(touched);
  }

  /**
   * Attaches an incoming permission request to the tool call it is about, so
   * the options render inside that call rather than as a separate prompt.
   *
   * @param params The permission request.
   * @param signal Aborts when the gateway withdraws the request, for example
   *   because another browser answered it. The request then resolves as cancelled.
   * @returns The answer, which resolves when the user picks and unblocks the
   *   agent's turn.
   */
  private onPermission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const toolCallId = params.toolCall?.toolCallId;
    // A request that names no call has no card to show on, so it is answered
    // cancelled.
    if (!toolCallId) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const id = `approval-${this.nextApprovalId++}`;

    // The adapter may not have announced the call yet, so the store makes a
    // placeholder for the question.
    let part = findTool(this.model, toolCallId);
    if (!part) {
      const touched = applyUpdate(this.model, {
        ...params.toolCall,
        sessionUpdate: UPDATE_KIND.toolCallUpdate,
      });
      part = findTool(this.model, toolCallId);
      this.refreshMessages(touched);
    }
    if (!part) return Promise.resolve({ outcome: { outcome: 'cancelled' } });

    const options = params.options ?? [];
    part.approval = { id, options };

    return new Promise<RequestPermissionResponse>((resolve) => {
      this.approvals.set(id, { toolCallId, options, resolve });
      signal.addEventListener('abort', () => this.respondToApproval(id, undefined), {
        once: true,
      });
      this.refreshMessages(this.messageOfTool(toolCallId));
    });
  }

  /**
   * Finds the message holding a tool call, for a targeted snapshot refresh.
   *
   * @param toolCallId The adapter's id for the call.
   * @returns The message, or null when the thread has no such call.
   */
  private messageOfTool(toolCallId: string): Message | null {
    return messageOfTool(this.model, toolCallId);
  }

  /**
   * Shows an error that happened on the way to a send.
   *
   * The composer's own failures, such as a refused upload, never reach the
   * socket, and the send button does not await them.
   *
   * @param message The error message.
   */
  reportError(message: string): void {
    this.emit({ error: message });
  }

  /**
   * Sends a prompt and tracks the turn while it runs.
   *
   * The prompt is a list of content blocks, because an attachment adds a
   * block beside the prose.
   *
   * @param blocks The content blocks of the prompt.
   * @throws {Error} When the store has no connection or no ACP thread, or when the prompt request fails.
   */
  async send(blocks: readonly ContentBlock[]): Promise<void> {
    const client = this.client;
    if (!client) throw new Error('not connected');
    const sessionId = client.sessionId;
    if (!sessionId) throw new Error('no ACP thread yet');
    if (blocks.length === 0) return;

    // The prompt answers the suggestion, so the composer stops showing it.
    this.model.promptSuggestion = null;
    this.emit({ error: null, promptSuggestion: null });
    try {
      await client.request(ACP_METHOD.sessionPrompt, {
        sessionId,
        prompt: blocks,
      });
    } catch (err) {
      this.emit({ error: (err as Error).message });
      throw err;
    } finally {
      // The gateway's turn state decides whether the agent still works.
      this.emit();
    }
  }

  /** Cancels the running turn. The prompt request then resolves by itself. */
  cancel(): void {
    const client = this.client;
    const sessionId = client?.sessionId;
    if (!client || !sessionId) return;
    client.notify(ACP_METHOD.sessionCancel, { sessionId });
    // Stops the spinner without waiting for the gateway, because the turn may
    // be one another browser started. The gateway reports what becomes of the
    // background work.
    this.speakingUpstream = false;
    this.emit();
  }

  /**
   * Switches the adapter into another of its advertised modes.
   *
   * @param modeId The id of the mode.
   */
  async setMode(modeId: string): Promise<void> {
    const client = this.client;
    const sessionId = client?.sessionId;
    if (!client || !sessionId) return;
    // Changes the mode optimistically. A current_mode_update confirms it, and a failure restores it.
    const before = this.model.modes;
    if (before) {
      this.model.modes = { ...before, currentModeId: modeId };
      this.emit({ modes: this.model.modes });
    }
    try {
      await client.request(ACP_METHOD.sessionSetMode, { sessionId, modeId });
    } catch (err) {
      this.model.modes = before;
      this.emit({ modes: before, error: (err as Error).message });
    }
  }

  /**
   * Sets one of the adapter's configuration options, such as the model it
   * answers with.
   *
   * @param configId The id of the option.
   * @param value The new value.
   */
  async setConfigOption(configId: string, value: string): Promise<void> {
    const client = this.client;
    const sessionId = client?.sessionId;
    if (!client || !sessionId) return;
    // Changes the value optimistically. A config_option_update confirms it, and a failure restores it.
    const before = this.model.configOptions;
    this.model.configOptions = before.map((option) =>
      option.id === configId ? { ...option, currentValue: value } : option,
    );
    this.emit({ configOptions: this.model.configOptions });
    try {
      await client.request(ACP_METHOD.sessionSetConfigOption, { sessionId, configId, value });
    } catch (err) {
      this.model.configOptions = before;
      this.emit({ configOptions: before, error: (err as Error).message });
    }
  }

  /**
   * Answers a permission request.
   *
   * @param approvalId The id of the approval.
   * @param optionId One of the offered options. Without it the request is
   *   cancelled, which the adapter expects when the user declines to choose.
   */
  respondToApproval(approvalId: string, optionId: string | undefined): void {
    const open = this.approvals.get(approvalId);
    if (!open) return;
    this.approvals.delete(approvalId);

    const part = findTool(this.model, open.toolCallId);
    if (part?.approval) {
      part.approval = optionId
        ? { ...part.approval, optionId }
        : { ...part.approval, resolution: 'cancelled' };
    }
    this.refreshMessages(this.messageOfTool(open.toolCallId));

    open.resolve(
      optionId
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } },
    );
  }

  /**
   * Gives the options offered for an approval that is still open.
   *
   * @param approvalId The id of the approval.
   * @returns The options, or an empty list when the approval is not open.
   */
  optionsFor(approvalId: string): PermissionOption[] {
    const open = this.approvals.get(approvalId);
    if (!open) return [];
    return findTool(this.model, open.toolCallId)?.approval?.options ?? [];
  }

  /**
   * Asks the adapter to replay the thread, rebuilding the model from what it
   * sends back.
   *
   * The load runs on a connection that is already up, so no `onReady` follows
   * and this method publishes the replay itself. A failed load still
   * publishes what arrived, so the view does not stay frozen.
   */
  async refetch(): Promise<void> {
    const client = this.client;
    const sessionId = client?.sessionId;
    if (!client || !sessionId) return;
    // Keeps the open questions, because a cancel would reach the agent on the
    // live connection. restoreApprovals puts them back on the rebuilt calls.
    this.reset({ keepApprovals: true });
    try {
      await client.request(ACP_METHOD.sessionLoad, loadParams(sessionId));
    } finally {
      this.restoreApprovals();
      this.flushReplay();
    }
  }

  /**
   * Asks for the full history of the thread. The gateway makes the adapter
   * replay the thread again, and the replay replaces the model.
   *
   * The gateway refuses while the thread works. The replay notice of the gateway
   * resets the store, so a refusal leaves the thread as it was. The reason
   * shows as an error.
   */
  async loadFullHistory(): Promise<void> {
    const client = this.client;
    const sessionId = client?.sessionId;
    if (!client || !sessionId || this.snapshot.loadingHistory) return;
    this.emit({ loadingHistory: true, error: null });
    try {
      await client.request(ACP_METHOD.sessionLoad, loadParams(sessionId, null, true));
    } catch (err) {
      this.emit({ error: (err as Error).message });
    } finally {
      this.flushReplay();
      this.emit({ loadingHistory: false });
    }
  }
}

/**
 * Checks if an open request is a question rather than a permission gate.
 *
 * ACP carries both as a permission request, and the options tell them
 * apart. A gate offers at most one allow option of each kind, such as allow
 * once and allow always. A question offers two or more allow options of the
 * same kind, because each is a different course of action. Leaving plan
 * mode is an example.
 *
 * @param options The options of the request.
 * @returns True for a question.
 */
function isQuestion(options: readonly PermissionOption[]): boolean {
  const seen = new Set<string>();
  for (const option of options) {
    if (!option.kind?.startsWith('allow')) continue;
    if (seen.has(option.kind)) return true;
    seen.add(option.kind);
  }
  return false;
}
