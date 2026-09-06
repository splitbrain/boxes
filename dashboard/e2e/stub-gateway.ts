import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import { TURN_STATE_METHOD } from '../../shared/types.ts';
import type {
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
} from '../src/stores/thread/acp-types.ts';

/**
 * A stand-in ACP gateway: a WebSocket server speaking the agent side of ACP
 * from canned scripts.
 *
 * It mirrors what the real gateway does rather than what a browser wishes it
 * did — a session owning several threads, each socket pinned to one of them
 * by the thread in its upgrade path, session/new answered with that thread's
 * id, session/load replaying that thread's stored history to that socket
 * alone, and every update going only to the sockets watching the thread it is
 * about.
 */

/** One content block of a prompt, as far as the stub reads it. */
export interface PromptBlock {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
}

/** What the stub streams in answer to one prompt. */
export interface PromptScript {
  /** Matched against the prompt text; the first match wins. */
  match: (text: string) => boolean;
  /** Updates to stream, in order, with a pause between them. */
  updates: SessionUpdate[];
  /** Milliseconds between updates. Zero sends them in one tick. */
  gapMs?: number;
  /** Hold the prompt open until the test releases it. */
  hold?: boolean;
}

/** A permission question the stub raises instead of answering a prompt. */
export interface PermissionScript {
  match: (text: string) => boolean;
  toolCall: { toolCallId: string; title: string; kind?: string };
  options: Array<{ optionId: string; name: string; kind: string }>;
  /** Streamed after the answer arrives, with the chosen option's id. */
  after: (optionId: string | null) => SessionUpdate[];
}

/** How the stub behaves, mutable between tests. */
export interface GatewayScript {
  token: string;
  /** Whether a prompt is echoed back as a user_message_chunk. */
  echoPrompt?: boolean;
  modes: SessionModeState | null;
  /** The options the adapter offers, such as the model. */
  configOptions: SessionConfigOption[];
  prompts: PromptScript[];
  permissions: PermissionScript[];
  /** Delivered to the next socket that attaches, then cleared. */
  queuedPermission: PermissionScript | null;
  /**
   * Hold every session/load until the test releases it, so the window a
   * browser spends waiting for its history is a window assertions fit in.
   */
  holdLoad?: boolean;
}

/** A running stub gateway. */
export interface StubGateway {
  script: GatewayScript;
  /** The default thread's updates, in order. */
  history: SessionUpdate[];
  /** One thread's updates, by its ACP id. */
  historyOf: (threadId: string) => SessionUpdate[];
  /** Prompt texts the stub received, across every thread. */
  prompts: string[];
  /** The content blocks of each prompt, which is what text loses. */
  promptBlocks: PromptBlock[][];
  /** How many sockets are attached right now, across every thread. */
  attached: () => number;
  /** The ACP id a socket naming no thread is pinned to. */
  current: () => string;
  /** Mints an empty thread and makes it the default; returns its ACP id. */
  newThread: () => string;
  /** Mints a thread carrying another's history and makes it the default. */
  forkThread: (from: string) => string;
  /** Makes an existing thread the default. Nobody is dropped. */
  select: (threadId: string) => void;
  /** Releases a held prompt, ending the turn. */
  release: () => void;
  /** Releases every held session/load, replay and all. */
  releaseLoad: () => void;
  /**
   * How many session/loads are parked, waiting to be released.
   *
   * Asked before releasing them, because a browser that has not sent its
   * load yet cannot have it released: the release frees what is parked, and
   * a load arriving a moment later parks behind it and stays there. A test
   * that assumed otherwise waited out its own timeout for a window that had
   * never opened.
   */
  loadsHeld: () => number;
  /** Sends one update to the sockets watching a thread, and records it. */
  emit: (update: SessionUpdate, threadId?: string) => void;
  close: () => void;
}

/** A JSON-RPC frame. */
interface Rpc {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const THREAD_ID = 'acp-thread-1';

/**
 * Attaches a stub gateway to an existing HTTP server at
 * `/ws/sessions/:id/acp` and `/ws/sessions/:id/threads/:threadId/acp`.
 *
 * `resolve` turns the Boxes thread id in the path into the adapter's own id
 * for it, which is the mapping the real gateway does out of the threads
 * table. A path naming no thread resolves to the session's default.
 */
export function attachStubGateway(
  server: Server,
  script: GatewayScript,
  resolve?: (sessionId: string, threadId: string | null) => string | null,
): StubGateway {
  const wss = new WebSocketServer({ noServer: true });
  /** Every attached socket, each recording the thread it is pinned to. */
  const sockets = new Map<WebSocket, string>();
  /** One transcript per thread, which is what session/load replays. */
  const threads = new Map<string, SessionUpdate[]>([[THREAD_ID, []]]);
  /** The thread a socket naming none is pinned to. */
  let current = THREAD_ID;
  let nextThread = 2;
  const prompts: string[] = [];
  const promptBlocks: PromptBlock[][] = [];
  /** Set while a prompt is held open, so the test can end the turn. */
  let releaseHeld: (() => void) | null = null;
  /** Loads waiting for releaseLoad, when the script holds them. */
  const heldLoads: Array<() => void> = [];
  /** Threads with a prompt running, which is what turn state reports. */
  const running = new Set<string>();

  const historyOf = (threadId: string): SessionUpdate[] => {
    let found = threads.get(threadId);
    if (!found) {
      found = [];
      threads.set(threadId, found);
    }
    return found;
  };

  /** The sockets watching one thread. Nobody else is told. */
  const watchers = (threadId: string): WebSocket[] =>
    [...sockets].filter(([, pinned]) => pinned === threadId).map(([ws]) => ws);

  /**
   * The gateway's one ACP extension: whether a turn is running on a thread.
   * Mirrored here because a browser re-opening a thread mid-turn learns it
   * from nothing else — see TURN_STATE_METHOD.
   */
  const turnState = (threadId: string, active: boolean, only?: WebSocket): void => {
    for (const ws of only ? [only] : watchers(threadId)) {
      send(ws, {
        jsonrpc: '2.0',
        method: TURN_STATE_METHOD,
        params: { sessionId: threadId, active },
      });
    }
  };

  const emit = (update: SessionUpdate, threadId: string = current): void => {
    historyOf(threadId).push(update);
    for (const ws of watchers(threadId)) {
      send(ws, {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: threadId, update },
      });
    }
  };

  /** Mints a thread, carrying a source thread's history when forking. */
  const mint = (from: string | null): string => {
    const id = `acp-thread-${nextThread++}`;
    threads.set(id, from ? [...historyOf(from)] : []);
    // The new thread becomes the default, and nobody is moved onto it: a
    // socket already pinned to another thread keeps watching that one.
    current = id;
    return id;
  };

  server.on('upgrade', (req, socket, head) => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    const path = /^\/ws\/sessions\/([^/]+)(?:\/threads\/([^/]+))?\/acp$/.exec(url);
    if (!path) return;
    const sessionId = path[1]!;
    const threadId = path[2] ?? null;

    // The same handshake check the real gateway makes: acp.v1 plus the
    // bearer entry, both offered as subprotocols.
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim());
    if (!offered.includes('acp.v1') || !offered.includes(`bearer.${script.token}`)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Which conversation this socket is for, settled at the handshake and
    // fixed for its whole life, exactly as the real gateway pins it.
    const pinned = (resolve ? resolve(sessionId, threadId) : null) ?? current;
    if (!threads.has(pinned)) threads.set(pinned, []);

    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.set(ws, pinned);
      ws.on('close', () => sockets.delete(ws));
      ws.on('message', (data) => void handle(ws, String(data)));
    });
  });

  async function handle(ws: WebSocket, text: string): Promise<void> {
    /** The thread this socket is about, which is never another's. */
    const pinned = sockets.get(ws) ?? current;
    let msg: Rpc;
    try {
      msg = JSON.parse(text) as Rpc;
    } catch {
      return;
    }
    if (msg.id === undefined || !msg.method) return;
    const reply = (result: unknown): void => send(ws, { jsonrpc: '2.0', id: msg.id, result });

    switch (msg.method) {
      case 'initialize':
        return reply({ protocolVersion: 1, agentCapabilities: {} });

      case 'session/new':
        // The thread this connection is pinned to, whichever it is. A
        // response without modes is how the browser learns to load it rather
        // than treat it as brand new.
        return reply({ sessionId: pinned });

      case 'session/fork':
        // The fork answer carries modes and configOptions, the same as a
        // fresh thread's, and its history starts as the source's. This stub
        // stands in for the gateway and the adapter together: the real
        // adapter writes a fork no transcript until it is prompted, and the
        // orchestrator replays the source's in its place, so what a browser
        // sees when it loads a fresh fork is what is modelled here.
        return reply({
          sessionId: mint(String(params(msg)['sessionId'] ?? current)),
          modes: script.modes,
          configOptions: script.configOptions,
        });

      case 'session/load': {
        const threadId = String(params(msg)['sessionId'] ?? pinned);
        if (script.holdLoad) await new Promise<void>((go) => heldLoads.push(go));
        // Replay is that thread's stored history re-sent as notifications, to
        // this socket only.
        for (const update of historyOf(threadId)) {
          send(ws, {
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: threadId, update },
          });
        }
        // Whether that thread is mid-turn, sent where the real gateway sends
        // it: after the replay the client rebuilds from, never before.
        turnState(threadId, running.has(threadId), ws);
        // After the replay, which is where the real gateway flushes them
        // (orchestrator/src/gateway/downstream.ts). Delivering one earlier
        // means delivering it into a transcript the client is about to throw
        // away, and a queued request is only ever sent once.
        if (script.queuedPermission) {
          const queued = script.queuedPermission;
          script.queuedPermission = null;
          void askPermission(ws, queued, threadId);
        }
        // Answered last, which is the order that matters: the real gateway
        // forwards the adapter's replay as it arrives and returns the result
        // only once the load has finished (orchestrator's downstream.ts). A
        // client is entitled to read the answer as "that is all of it", and
        // this one does — it is where the thread reaches the screen.
        return reply({ modes: script.modes, configOptions: script.configOptions });
      }

      case 'session/set_mode': {
        const modeId = String(params(msg)['modeId'] ?? '');
        if (script.modes) script.modes = { ...script.modes, currentModeId: modeId };
        reply({});
        return void emit(
          { sessionUpdate: 'current_mode_update', currentModeId: modeId },
          pinned,
        );
      }

      case 'session/set_config_option': {
        const configId = String(params(msg)['configId'] ?? '');
        const value = String(params(msg)['value'] ?? '');
        script.configOptions = script.configOptions.map((option) =>
          option.id === configId ? { ...option, currentValue: value } : option,
        );
        reply({ configOptions: script.configOptions });
        return void emit(
          { sessionUpdate: 'config_option_update', configOptions: script.configOptions },
          pinned,
        );
      }

      case 'session/prompt': {
        // The thread the prompt names, which is this socket's own: a turn
        // runs on a conversation, never on whichever is the default.
        const onThread = String(params(msg)['sessionId'] ?? pinned);
        const blocks = (params(msg)['prompt'] ?? []) as PromptBlock[];
        const promptText = blocks.map((b) => b.text ?? '').join('');
        prompts.push(promptText);
        promptBlocks.push(blocks);
        running.add(onThread);
        turnState(onThread, true);
        try {
          return await runPrompt(ws, onThread, blocks, promptText, reply);
        } finally {
          running.delete(onThread);
          turnState(onThread, false);
        }
      }

      default:
        return reply({});
    }
  }

  /** Streams one prompt's script, or its permission question. */
  async function runPrompt(
    ws: WebSocket,
    onThread: string,
    blocks: PromptBlock[],
    promptText: string,
    reply: (result: unknown) => void,
  ): Promise<void> {
    if (script.echoPrompt !== false) {
      // Block by block, as the real gateway echoes it: a prompt carrying an
      // image and a note about what was attached is three blocks, and
      // flattening them to their text is exactly the part a client renders
      // differently.
      for (const content of blocks) {
        emit({ sessionUpdate: 'user_message_chunk', content } as SessionUpdate, onThread);
      }
    }

    const permission = script.permissions.find((p) => p.match(promptText));
    if (permission) {
      await askPermission(ws, permission, onThread);
      return reply({ stopReason: 'end_turn' });
    }

    const found = script.prompts.find((p) => p.match(promptText));
    if (found) {
      for (const update of found.updates) {
        if (found.gapMs) await sleep(found.gapMs);
        emit(update, onThread);
      }
      if (found.hold) {
        await new Promise<void>((resolve) => {
          releaseHeld = resolve;
        });
        releaseHeld = null;
      }
    }
    return reply({ stopReason: 'end_turn' });
  }

  /** Puts a permission question to one socket and streams the aftermath. */
  async function askPermission(
    ws: WebSocket,
    permission: PermissionScript,
    onThread: string,
  ): Promise<void> {
    emit({ sessionUpdate: 'tool_call', ...permission.toolCall } as SessionUpdate, onThread);
    const answer = await request(ws, 'session/request_permission', {
      sessionId: onThread,
      toolCall: { toolCallId: permission.toolCall.toolCallId },
      options: permission.options,
    });
    const outcome = (answer as { outcome?: { outcome?: string; optionId?: string } })?.outcome;
    const optionId = outcome?.outcome === 'selected' ? (outcome.optionId ?? null) : null;
    for (const update of permission.after(optionId)) emit(update, onThread);
  }

  /** Sends a request to a browser and waits for its answer. */
  let nextRequestId = 1000;
  const waiting = new Map<number, (value: unknown) => void>();

  function request(ws: WebSocket, method: string, params: unknown): Promise<unknown> {
    const id = nextRequestId++;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      const onMessage = (data: unknown): void => {
        let msg: Rpc;
        try {
          msg = JSON.parse(String(data)) as Rpc;
        } catch {
          return;
        }
        if (msg.id !== id) return;
        ws.off('message', onMessage);
        waiting.delete(id);
        resolve(msg.result);
      };
      ws.on('message', onMessage);
      send(ws, { jsonrpc: '2.0', id, method, params });
    });
  }

  return {
    script,
    get history() {
      return historyOf(current);
    },
    historyOf,
    prompts,
    promptBlocks,
    attached: () => sockets.size,
    current: () => current,
    newThread: () => mint(null),
    forkThread: (from) => mint(from),
    select: (threadId) => {
      historyOf(threadId);
      // An ordinary write. No socket is pinned to the default, so selecting
      // one moves nobody and drops nothing.
      current = threadId;
    },
    release: () => releaseHeld?.(),
    releaseLoad: () => {
      for (const go of heldLoads.splice(0)) go();
    },
    loadsHeld: () => heldLoads.length,
    emit,
    close: () => {
      for (const ws of sockets.keys()) ws.close();
      wss.close();
    },
  };
}

/** A frame's params as a plain record; an absent or odd payload reads empty. */
function params(msg: Rpc): Record<string, unknown> {
  return typeof msg.params === 'object' && msg.params !== null
    ? (msg.params as Record<string, unknown>)
    : {};
}

function send(ws: WebSocket, msg: Rpc): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
