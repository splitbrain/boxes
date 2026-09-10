import { agent as acpAgent, type AgentConnection, type Stream } from '@agentclientprotocol/sdk';
import type { WebSocket } from 'ws';
import type { Config } from '../config.ts';
import { log } from '../log.ts';
import type { SessionManager } from '../sessions.ts';
import type { DownstreamHandle, UpstreamSession } from './upstream.ts';

/**
 * The browser-facing half of the gateway. Toward browsers the orchestrator
 * speaks ACP as an agent and forwards nearly everything on.
 *
 * JSON-RPC terminates on both sides, so each connection runs its own id space
 * and the SDK correlates request and response within it.
 */

/** Pass-through parser, leaving params and their _meta untouched. */
const raw = <T = unknown>(params: unknown): T => params as T;

/** The subprotocol the server negotiates; the rest of the offer is credentials. */
export const ACP_SUBPROTOCOL = 'acp.v1';

/** Methods forwarded to the adapter verbatim, _meta intact. */
const FORWARDED_REQUESTS = [
  'session/load',
  'session/prompt',
  'session/list',
  'session/set_mode',
  'session/set_model',
  'session/set_config_option',
  'session/fork',
  'session/resume',
  'session/close',
  'session/delete',
  'session/select_provider',
  'authenticate',
] as const;

/** Notifications forwarded to the adapter verbatim. */
const FORWARDED_NOTIFICATIONS = ['session/cancel'] as const;

/** Source of handle ids, unique within the process. */
let nextHandleId = 1;

/**
 * Validates a WebSocket upgrade, saying why when it refuses.
 *
 * A browser cannot set an Authorization header on a WebSocket, so a client
 * offers the token as a bearer.<token> subprotocol entry alongside acp.v1.
 * The gateway checks it here, on the upgrade itself. Which subprotocol is
 * negotiated is decided by the server's own `handleProtocols`.
 */
export function checkUpgrade(
  protocolHeader: string | undefined,
  cfg: Config,
): { ok: true } | { ok: false; reason: string } {
  const offered = (protocolHeader ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!offered.includes(ACP_SUBPROTOCOL)) {
    return { ok: false, reason: 'missing acp.v1 subprotocol' };
  }
  const expected = `bearer.${cfg.WS_AUTH_TOKEN}`;
  const presented = offered.find((p) => p.startsWith('bearer.'));
  if (!presented) return { ok: false, reason: 'missing bearer token subprotocol' };
  if (!timingSafeEqualStr(presented, expected)) {
    return { ok: false, reason: 'invalid bearer token' };
  }
  return { ok: true };
}

/** Constant-time compare that does not leak length via early return. */
function timingSafeEqualStr(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** An ACP Stream over a WebSocket: one JSON-RPC message per text frame. */
function wsStream(ws: WebSocket, sessionId: string): Stream {
  const slog = log.session(sessionId);

  const readable = new ReadableStream<unknown>({
    start(c) {
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          slog.warn('rejecting binary WS frame');
          return;
        }
        const text = data.toString('utf8');
        let msg: unknown;
        try {
          msg = JSON.parse(text);
        } catch {
          slog.warn('rejecting non-JSON WS frame');
          return;
        }
        // Some ACP clients send a $/ping notification every 25s. JSON-RPC
        // forbids a reply to a notification, so drop it before the SDK logs
        // an unknown method. The dashboard sends none.
        if (
          typeof msg === 'object' &&
          msg !== null &&
          (msg as { method?: string }).method === '$/ping' &&
          !('id' in (msg as object))
        ) {
          return;
        }
        try {
          c.enqueue(msg);
        } catch {
          // stream already closed
        }
      });
      const finish = (): void => {
        try {
          c.close();
        } catch {
          // already closed
        }
      };
      ws.on('close', finish);
      ws.on('error', finish);
    },
  });

  const writable = new WritableStream<unknown>({
    write(msg) {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(msg));
    },
    close() {
      if (ws.readyState === ws.OPEN) ws.close(1000, 'gateway closed');
    },
  });

  return { readable, writable } as Stream;
}

/**
 * Wires one browser connection to the session's persistent upstream, pinned
 * to one of its threads.
 *
 * `threadId` is the thread the URL named, or null when it named none, as an
 * external ACP client does, which pins to the session's current thread
 * instead. Either way the pinning happens here rather than in the browser,
 * and the ACP contract stays a `session/new` that hands back an id the client
 * did not choose.
 *
 * Disconnecting drops the handle from the broadcast set and touches nothing
 * else.
 */
export function attachDownstream(
  ws: WebSocket,
  sessionId: string,
  threadId: string | null,
  manager: SessionManager,
): void {
  const slog = log.session(sessionId);
  const up: UpstreamSession = manager.upstream(sessionId);
  // Declared before the handle, so the closures below never read it in its
  // temporal dead zone.
  let conn: AgentConnection | null = null;

  const handle: DownstreamHandle = {
    id: nextHandleId++,
    // Settled by the pin below, which has to wait for the adapter.
    acpThreadId: null,
    lastActiveAt: Date.now(),
    notify: (method, params) => {
      void conn?.client.notify(method, params).catch((err: Error) => {
        slog.debug('downstream notify failed', { error: err.message });
      });
    },
    request: (method, params) => {
      if (!conn) return Promise.reject(new Error('downstream closed'));
      return conn.client.request(method, params);
    },
    // 1012 is "service restart": the browser's own backoff brings it back,
    // and its fresh handshake pins whatever its thread is now. The only
    // caller is a respawn that could not bring this thread back under the id
    // the connection holds.
    close: () => {
      try {
        ws.close(1012, 'thread reloaded');
      } catch {
        // already closing
      }
    },
  };

  // Attached before the thread is settled: the socket is open and holding the
  // session up, which is what the reaper counts, and nothing is routed to a
  // handle that has no thread yet. Attaching is also what brings a stopped
  // session back up, because pinning needs the adapter to answer for the
  // thread.
  up.attach(handle);
  const pinned = up.pin(handle, threadId);
  pinned.catch((err: Error) => {
    slog.error('could not pin the connection to a thread', { error: err.message });
    try {
      ws.close(1011, 'upstream unavailable');
    } catch {
      // already closing
    }
  });

  const app = acpAgent({ name: `boxes-downstream-${sessionId}` })
    // Answered from the cached upstream response, so its _meta extensions
    // reach the browser intact.
    .onRequest('initialize' as string, raw, async () => {
      handle.lastActiveAt = Date.now();
      await up.ensureStarted();
      const cached = up.cachedInitialize;
      if (!cached) throw new Error('Upstream initialize unavailable');
      return cached;
    })
    // This connection is about one thread of the session — the one the URL
    // named, or the session's current one — so hand back that thread's ACP
    // id rather than starting a second conversation on every reconnect.
    // Which thread that is, is decided outside ACP, so the contract a client
    // speaks does not change.
    .onRequest('session/new' as string, raw, async () => {
      handle.lastActiveAt = Date.now();
      const acpThreadId = await pinned;
      slog.info('session/new answered with the pinned thread', { acpThreadId });
      return { sessionId: acpThreadId };
    });

  for (const method of FORWARDED_REQUESTS) {
    app.onRequest(method as string, raw, async ({ params }) => {
      handle.lastActiveAt = Date.now();
      // The handle goes with the request: a replay belongs to the browser
      // that asked for it, and a prompt is echoed on that browser's behalf.
      const result = await up.forwardRequest(method, params, handle);
      // Queued permission requests wait for the replay rather than going out
      // the moment the socket opens. A client rebuilds its whole thread from
      // the replay, so a question delivered before it lands is thrown away
      // with everything else that was on screen, and it is sent only once.
      if (method === 'session/load') up.flushPendingTo(handle);
      // An empty answer is not an error: session/load delivers the replay as
      // session/update notifications rather than as its result.
      return result ?? {};
    });
  }

  for (const method of FORWARDED_NOTIFICATIONS) {
    app.onNotification(method as string, raw, async ({ params }) => {
      handle.lastActiveAt = Date.now();
      await up.forwardNotification(method, params);
    });
  }

  conn = app.connect(wsStream(ws, sessionId));
  const active = conn;

  const detach = (): void => {
    up.detach(handle);
    try {
      active.close();
    } catch {
      // already closed
    }
  };
  ws.on('close', detach);
  ws.on('error', detach);
}
