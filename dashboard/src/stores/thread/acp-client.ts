import { TURN_STATE_METHOD, type TurnStateParams } from '../../../../shared/types.ts';
import type {
  LoadSessionResponse,
  NewSessionResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
} from './acp-types.ts';

/**
 * The browser's ACP connection to the gateway.
 *
 * Plain JSON-RPC 2.0 over a WebSocket, one message per text frame. The
 * gateway is client-agnostic — external ACP clients use the same endpoint —
 * so nothing here is a private arrangement with the orchestrator.
 *
 * There is no $/ping. Some ACP clients send one; it is not part of the
 * protocol, and the gateway drops it.
 */

/** What the header shows about the connection. */
export type ConnectionState = 'connecting' | 'ready' | 'reconnecting' | 'closed';

/** Everything the store hands the client to react to. */
export interface AcpClientHandlers {
  /** A session/update notification, live or from a replay. */
  onUpdate(params: SessionNotification): void;
  /**
   * The adapter asking permission. The promise resolves with the user's
   * answer, which is what unblocks the agent's turn.
   */
  onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  /** The handshake finished; a replay, if any, has been requested. */
  onReady(modes: SessionModeState | null, configOptions: SessionConfigOption[]): void;
  /** The connection state changed. */
  onState(state: ConnectionState): void;
  /**
   * The gateway said what this thread is doing: whether a prompt is open on
   * it, whether the agent is talking, and what it has left running in the
   * background. It says so once after every replay and again on every
   * transition, which is how a browser that did not send the prompt knows
   * there is one — and the only way any browser learns about a monitor
   * somebody started an hour ago.
   */
  onTurnState(state: TurnStateParams): void;
  /**
   * A fresh connection is about to replay the thread, so whatever the store
   * holds is stale and must be thrown away.
   */
  onResetThread(): void;
}

/** A JSON-RPC message, in either direction. */
interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Waits between reconnect attempts, in milliseconds, then holds at the last. */
const BACKOFF_MS = [500, 1000, 2000, 5000, 10_000];

/** An error carrying a JSON-RPC error payload. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** One session's connection, which reconnects on its own until closed. */
export class AcpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private attempt = 0;
  private retryTimer: number | null = null;
  private disposed = false;
  private acpSessionId: string | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly handlers: AcpClientHandlers,
  ) {}

  /** The ACP thread id this connection is talking about, once known. */
  get sessionId(): string | null {
    return this.acpSessionId;
  }

  /** Opens the connection and runs the handshake. Safe to call once. */
  start(): void {
    this.open();
  }

  /** Closes for good: no further reconnect, and every pending call rejects. */
  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.failPending(new Error('client disposed'));
    try {
      this.ws?.close(1000, 'client disposed');
    } catch {
      // already closing
    }
    this.ws = null;
    this.handlers.onState('closed');
  }

  /** Sends a request and resolves with its result. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`not connected (${method})`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Sends a notification, which expects no answer. */
  notify(method: string, params?: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  // --- connection ----------------------------------------------------------

  private open(): void {
    if (this.disposed) return;
    this.handlers.onState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    // The token travels as a subprotocol entry because a browser cannot set
    // an Authorization header on a WebSocket. The gateway selects acp.v1
    // explicitly and reads the bearer entry as credentials.
    const ws = new WebSocket(this.url, ['acp.v1', `bearer.${this.token}`]);
    this.ws = ws;

    ws.onopen = () => {
      void this.handshake();
    };
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      this.receive(event.data);
    };
    ws.onerror = () => {
      // onclose always follows, and carries the reason worth reporting.
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failPending(new Error('connection closed'));
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    this.handlers.onState('reconnecting');
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, wait);
  }

  /**
   * initialize, then either resume the adapter's thread or start one.
   *
   * The gateway answers session/new with the bare `{ sessionId }` once the
   * session already has a thread, so a response without `modes` is how a
   * browser learns it is joining an existing one and has to ask for the
   * replay itself. A fresh thread's response carries the adapter's modes.
   */
  private async handshake(): Promise<void> {
    try {
      await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
      });

      const created = await this.request<NewSessionResponse>('session/new', {
        cwd: '/workspace',
        mcpServers: [],
      });
      this.acpSessionId = created.sessionId;

      // Whatever this connection knew is about to be re-sent from the top.
      this.handlers.onResetThread();

      let modes = created.modes ?? null;
      let configOptions = created.configOptions ?? null;
      if (!created.modes) {
        const loaded = await this.request<LoadSessionResponse>('session/load', {
          sessionId: created.sessionId,
          cwd: '/workspace',
          mcpServers: [],
        });
        modes = loaded?.modes ?? null;
        configOptions = loaded?.configOptions ?? null;
      }

      this.attempt = 0;
      this.handlers.onState('ready');
      this.handlers.onReady(modes, configOptions ?? []);
    } catch {
      // A failed handshake is a failed connection: close and let the
      // backoff bring up a fresh one rather than sitting half-open.
      try {
        this.ws?.close(1011, 'handshake failed');
      } catch {
        // already closing
      }
    }
  }

  // --- messages ------------------------------------------------------------

  private receive(text: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(text) as RpcMessage;
    } catch {
      return;
    }

    // A response to something we sent.
    if (msg.id !== undefined && msg.method === undefined) {
      const waiting = this.pending.get(msg.id);
      if (!waiting) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        waiting.reject(new RpcError(msg.error.message, msg.error.code, msg.error.data));
      } else {
        waiting.resolve(msg.result);
      }
      return;
    }

    // A request from the agent side. Only one is expected, but an unknown
    // method must be answered rather than left blocking the adapter.
    if (msg.id !== undefined && msg.method) {
      void this.answer(msg);
      return;
    }

    if (msg.method === 'session/update') {
      this.handlers.onUpdate(msg.params as SessionNotification);
      return;
    }

    if (msg.method === TURN_STATE_METHOD) {
      const params = msg.params as Partial<TurnStateParams> | undefined;
      // Read defensively: an older orchestrator, or an ACP client of its own,
      // sends the one field this notification used to carry.
      this.handlers.onTurnState({
        sessionId: params?.sessionId ?? '',
        active: params?.active === true,
        speaking: params?.speaking === true,
        // An orchestrator of the version in between sent one boolean about
        // the whole box. It is not knowable here whose work it was, and a bar
        // that says something unnamed is running is what that version could
        // say for itself.
        background: Array.isArray(params?.background)
          ? params.background
          : params?.background === true
            ? [{ id: 'unnamed', command: 'Something is still running', startedAt: null }]
            : [],
      });
    }
  }

  /** Answers a server-bound request, turning a rejection into a JSON-RPC error. */
  private async answer(msg: RpcMessage): Promise<void> {
    const reply = (body: Partial<RpcMessage>): void => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }));
    };

    if (msg.method !== 'session/request_permission') {
      reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } });
      return;
    }

    try {
      const result = await this.handlers.onPermission(msg.params as RequestPermissionRequest);
      reply({ result });
    } catch (err) {
      reply({ error: { code: -32603, message: (err as Error).message } });
    }
  }

  /** Rejects everything in flight, because the connection carrying it is gone. */
  private failPending(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}
