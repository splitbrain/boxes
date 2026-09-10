import Fastify from 'fastify';
import type { FastifyReply, RouteHandlerMethod } from 'fastify';
import { createReadStream, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AcpLogEntry,
  AcpLogPage,
  AgentItemBody,
  CreateAgentSetBody,
  CreateSessionBody,
  CreateThreadBody,
  ExecLogPage,
  ExecRequest,
  HealthResponse,
  PushKeyResponse,
  PushSubscribeBody,
  ReviewAnnotationBody,
  ReviewAnnotationsResponse,
  ReviewBaseBody,
  StoredAttachment,
  ThreadDoneBody,
  UpdateAgentSetBody,
} from '../../shared/types.ts';
import { AgentStore } from './agents.ts';
import { ATTACHMENTS_DIR, servedTypeFor, storeAttachment } from './attachments.ts';
import type { config } from './config.ts';
import {
  countPushSubscriptions,
  deletePushSubscription,
  upsertPushSubscription,
  type openDb,
} from './db.ts';
import { EgressManager } from './egress.ts';
import * as execs from './exec.ts';
import { HttpError } from './http-error.ts';
import { deploymentImages } from './images.ts';
import { log } from './log.ts';
import { Notifier } from './notify.ts';
import { resolveInRoot } from './review/fs.ts';
import { ReviewService } from './review/service.ts';
import { SessionManager } from './sessions.ts';
import { setSessionOwner } from './workspaces.ts';

/** The HTTP surface: the REST API, the exec endpoint and the static bundle. */

/** Version reported by the health endpoint. */
const VERSION = '1.0.0';

const here = dirname(fileURLToPath(import.meta.url));

/** Dashboard bundle, copied into the image by the Dockerfile's build stage. */
const DASHBOARD_DIR = resolve(here, '../dashboard');

/** Everything one orchestrator process owns, wired together. */
export interface Orchestrator {
  app: ReturnType<typeof Fastify>;
  db: ReturnType<typeof openDb>;
  manager: SessionManager;
  cfg: ReturnType<typeof config>;
  /** Owns the egress policy and keeps the proxy holding it. */
  egress: EgressManager;
  /** Where "a thread wants you" goes. */
  notifier: Notifier;
  /** Reads and writes review data over the sessions' workspace directories. */
  review: ReviewService;
  /** The AGENTS.md, skills and commands sessions are configured with. */
  agents: AgentStore;
  /** Session ids whose network is missing the egress proxy. */
  setProxyWarnings(warnings: string[]): void;
}

/**
 * Builds the HTTP app and the objects behind it, without listening or
 * touching Docker.
 *
 * Boot lives in main(); this is separate so a test can drive the real routes
 * over a real database without a Docker socket or an open port.
 */
export function buildApp(
  cfg: ReturnType<typeof config>,
  db: ReturnType<typeof openDb>,
): Orchestrator {
  // Before anything creates a workspace directory or a container: everything
  // that writes files for the agent, or runs a process as it, reads this.
  setSessionOwner(cfg.SESSION_UID, cfg.SESSION_GID);

  const egress = new EgressManager(cfg);
  const notifier = new Notifier(db, cfg);
  const agents = new AgentStore(db, cfg.DATA_DIR);
  const manager = new SessionManager(db, cfg, egress, notifier, agents);
  // The review surface reaches the files through the manager, which is the one
  // thing that knows whether a session is directory-backed yet.
  const review = new ReviewService(db, (id) => manager.workspacePathOf(id));

  let proxyWarnings: string[] = [];

  const app = Fastify({ logger: false });

  /**
   * Attachment uploads arrive as raw bytes, which Fastify has no parser for
   * until it is given one. `parseAs: 'buffer'` is the whole of it: the route
   * sets the size limit, and what the bytes are is the client's business.
   */
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  // --- REST: unauthenticated here, the deployment puts auth in front ----------

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    // Fastify's own refusals — a body over the route's limit, a content type
    // with no parser — already carry both the status and the sentence worth
    // showing, so they are passed through as they are.
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as Error).message });
    }
    log.error('unhandled request error', { error: (err as Error).message });
    return reply.code(500).send({ error: 'Internal error' });
  });

  app.get('/healthz', async (): Promise<HealthResponse> => {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE status != 'deleted'")
      .get() as { n: number };
    return {
      ok: true,
      version: VERSION,
      sessions: row.n,
      proxyWarnings,
      egress: egress.status(),
      claudeTokenConfigured: cfg.PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN !== '',
      pushSubscriptions: countPushSubscriptions(db),
      // The one thing here that asks the daemon anything. Cached for a minute
      // and null on every failure, so the probe answers at the same speed and
      // stays green on a host whose Docker socket is not there.
      images: await deploymentImages(cfg),
    };
  });

  app.get('/api/sessions', async () => manager.list());

  app.post('/api/sessions', async (req, reply) => {
    const created = await manager.create(req.body as CreateSessionBody);
    return reply.code(201).send(created);
  });

  app.get('/api/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    return manager.detail(id);
  });

  app.post('/api/sessions/:id/start', async (req) => {
    const { id } = req.params as { id: string };
    return manager.start(id);
  });

  app.post('/api/sessions/:id/stop', async (req) => {
    const { id } = req.params as { id: string };
    return manager.stop(id);
  });

  app.delete('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await manager.remove(id);
    // The review service caches per session; a deleted one has nothing to cache.
    review.forget(id);
    return reply.code(204).send();
  });

  /**
   * The conversations a session owns. A session shares its container, its
   * volumes and its egress policy across all of them, so an extra one costs
   * nothing but its own transcript.
   */
  app.get('/api/sessions/:id/threads', async (req) => {
    const { id } = req.params as { id: string };
    return manager.threads(id);
  });

  /**
   * Adds a conversation and makes it current: empty, or carrying the context of
   * the thread named by `from`.
   */
  app.post('/api/sessions/:id/threads', async (req, reply) => {
    const { id } = req.params as { id: string };
    const created = await manager.createThread(id, req.body as CreateThreadBody | undefined);
    return reply.code(201).send(created);
  });

  /**
   * Makes one of a session's threads current: what a connection naming no
   * thread gets. An ordinary write — every live connection is pinned to its
   * own thread, so nobody is dropped and nothing reconnects.
   */
  app.post('/api/sessions/:id/threads/:threadId/select', async (req) => {
    const { id, threadId } = req.params as { id: string; threadId: string };
    return manager.selectThread(id, threadId);
  });

  /**
   * Marks a conversation done, or takes the mark off again.
   *
   * A note the reader keeps about which of a box's conversations they are
   * finished with. It changes how the thread is drawn in a list, and the
   * thread still runs, still answers, and can be marked undone.
   */
  app.post('/api/sessions/:id/threads/:threadId/done', async (req) => {
    const { id, threadId } = req.params as { id: string; threadId: string };
    const done = (req.body as ThreadDoneBody | undefined)?.done;
    if (typeof done !== 'boolean') throw new HttpError(400, 'done must be true or false');
    return manager.setThreadDone(id, threadId, done);
  });

  /**
   * Kills one thing that conversation left running, or everything it has.
   *
   * A kill and not a cancel: a background command is a child of the agent's
   * own process that outlives the turn which started it, and interrupting the
   * conversation does not reach it. The `processId` is the one the thread
   * state carried; without one, everything that thread is running stops.
   *
   * The answer says how many processes were signalled, and zero is an
   * ordinary one — the work can end between a browser being told about it and
   * somebody pressing stop.
   */
  app.post('/api/sessions/:id/threads/:threadId/background/stop', async (req) => {
    const { id, threadId } = req.params as { id: string; threadId: string };
    const body = req.body as { processId?: unknown } | undefined;
    const processId = typeof body?.processId === 'string' ? body.processId : undefined;
    return manager.stopBackgroundWork(id, threadId, processId);
  });

  app.get('/api/sessions/:id/log', async (req): Promise<AcpLogPage> => {
    const { id } = req.params as { id: string };
    const { after, limit } = req.query as { after?: string; limit?: string };
    const afterId = Number(after ?? 0) || 0;
    const max = Math.min(Math.max(Number(limit ?? 200) || 200, 1), 1000);
    const entries = db
      .prepare(
        `SELECT id, direction, ts, payload FROM acp_log
         WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(id, afterId, max) as AcpLogEntry[];
    return { entries, cursor: entries.at(-1)?.id ?? afterId };
  });

  /**
   * Runs a local command in the session container and streams its combined
   * output back as it arrives.
   *
   * The response is chunked text rather than JSON so the browser can render
   * the output growing; the last line is a trailer carrying the exit code and
   * whether either limit was hit. Both limits live in exec.ts: 120 seconds of
   * wall clock and 256 KiB of output, after which the exec is killed.
   *
   * The command runs inside the session's own isolation, as the non-root agent
   * user, and never reaches a command line on the host.
   *
   * It is logged against the thread it was typed in, which the path names —
   * or, on the short path, whichever thread the session has current.
   */
  const runExec: RouteHandlerMethod = async (req, reply) => {
    const { id, threadId } = req.params as { id: string; threadId?: string };
    const command = (req.body as ExecRequest | undefined)?.command?.trim();
    if (!command) throw new HttpError(400, 'command is required');
    if (command.length > 8000) throw new HttpError(400, 'command is too long');

    const thread = manager.resolveThread(id, threadId);
    const target = await manager.execTarget(id);
    manager.touch(id);
    const startedAt = Date.now();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      // Nothing may buffer this: the point is that output appears as it is
      // produced.
      'X-Accel-Buffering': 'no',
    });

    const outcome = await execs.runCommand(target, command, (chunk) => {
      reply.raw.write(chunk);
    });
    reply.raw.end(execs.trailer(outcome));

    execs.record(db, id, thread, command, outcome, startedAt);
    manager.touch(id);
    return reply;
  };
  app.post('/api/sessions/:id/exec', runExec);
  app.post('/api/sessions/:id/threads/:threadId/exec', runExec);

  /**
   * Stores one file the user attached to a prompt, in the session's own
   * workspace.
   *
   * Raw bytes rather than a multipart form: there is one file per request and
   * its name is in the query, and octet-stream is a body Fastify hands over
   * as a Buffer without a dependency that parses envelopes.
   *
   * The upload happens before the prompt that mentions it, and is what makes
   * the mention true. It needs no container: a workspace is a directory this
   * process owns, so a session that is stopped — or has never been started —
   * takes attachments the same way a running one does.
   */
  app.post(
    '/api/sessions/:id/attachments',
    { bodyLimit: cfg.MAX_ATTACHMENT_MB * 1024 * 1024 },
    async (req): Promise<StoredAttachment> => {
      const { id } = req.params as { id: string };
      const { name } = req.query as { name?: string };
      if (!name) throw new HttpError(400, 'name is required');

      const body = req.body;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        throw new HttpError(400, 'an attachment body is required');
      }

      const workspace = manager.workspacePathOf(id);
      if (!workspace) throw new HttpError(404, 'Session not found');

      const stored = storeAttachment(workspace, name, body);
      // The same touch every other thing a user does to a session makes: an
      // upload is somebody working here, and the reaper counts idleness.
      manager.touch(id);
      // And the one way a workspace grows with nothing running in it, which
      // is the case the size cache stops measuring.
      manager.workspaceChanged(id);
      log.session(id).info('attachment stored', { path: stored.path, size: stored.size });
      return stored;
    },
  );

  /**
   * Serves one stored attachment back, which is how the thread shows the
   * picture the user attached.
   *
   * This reads out of a tree the agent controls, so a link planted in the
   * attachments directory could otherwise serve whatever the orchestrator's
   * own uid can read. `resolveInRoot` holds the containment.
   *
   * What a browser can show — images, SVG, PDF — is served as itself, and
   * everything else as a download of unknown type. `sandbox` and
   * `default-src 'none'` leave an SVG opened as a document with no script and
   * no origin, and an SVG behind an `<img>` is inert. A PDF is served
   * unsandboxed so the browser's viewer takes it.
   */
  app.get('/api/sessions/:id/attachments/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    // Stored names are a single path component by construction, so anything
    // shaped otherwise is not looked for.
    if (name.includes('/') || name.includes('\\')) {
      throw new HttpError(404, 'Attachment not found');
    }

    const workspace = manager.workspacePathOf(id);
    if (!workspace) throw new HttpError(404, 'Session not found');

    const resolved = resolveInRoot(join(workspace, ATTACHMENTS_DIR), name);
    if (!resolved.ok) throw new HttpError(404, 'Attachment not found');
    const stat = statSync(resolved.path);
    if (!stat.isFile()) throw new HttpError(404, 'Attachment not found');

    const served = servedTypeFor(name);
    void reply.headers({
      'Content-Type': served.contentType,
      'Content-Length': String(stat.size),
      'Content-Disposition': `${served.inline ? 'inline' : 'attachment'}; filename="${name}"`,
      // The type is decided here rather than sniffed from the bytes, so a
      // download is never treated as a document.
      'X-Content-Type-Options': 'nosniff',
      // What lets an SVG be served as an SVG: nothing in one may run or
      // fetch anything.
      'Content-Security-Policy': served.sandbox ? "default-src 'none'; sandbox" : "default-src 'none'",
      // Short, rather than immutable: the name is stable but the file under
      // it belongs to a workspace the agent can rewrite.
      'Cache-Control': 'private, max-age=60',
    });
    return createReadStream(resolved.path);
  });

  /**
   * Every command already run in one thread.
   *
   * The browser appends these after the adapter's replay: ACP replay carries no
   * timestamps, so where they belong in the transcript is not recoverable.
   */
  const listExec: RouteHandlerMethod = async (req): Promise<ExecLogPage> => {
    const { id, threadId } = req.params as { id: string; threadId?: string };
    const thread = manager.resolveThread(id, threadId);
    return { records: thread ? execs.history(db, id, thread) : [] };
  };
  app.get('/api/sessions/:id/exec', listExec);
  app.get('/api/sessions/:id/threads/:threadId/exec', listExec);

  // --- Code review over a session's workspace ---------------------------------

  /**
   * The review surface. None of these routes starts or touches a session
   * container: the workspace is a directory this process can read, which is what
   * makes reviewing a stopped session — the natural moment, once the agent is
   * done — cost nothing.
   *
   * The responses are batched so a client gets one round trip per screen:
   * the tree endpoint carries the whole left panel, the file endpoint the
   * whole file view.
   *
   * None of them touches a session's activity timestamp. Reviewing is not the
   * agent working, so reading a review must not hold off the reaper.
   *
   * Every one reads the filesystem on the spot, so a fetch is the freshness
   * and there is nothing to poll.
   */

  app.get('/api/sessions/:id/review/tree', async (req) => {
    const { id } = req.params as { id: string };
    return review.tree(id);
  });

  app.get('/api/sessions/:id/review/file', async (req) => {
    const { id } = req.params as { id: string };
    const { path } = req.query as { path?: string };
    if (!path) throw new HttpError(400, 'path is required');
    return review.file(id, path);
  });

  /**
   * Creates or replaces the comment on one line. The same route for both,
   * because REVIEW.md holds at most one comment per line and the reviewer
   * editing one is not a different operation from writing it.
   */
  app.put('/api/sessions/:id/review/annotations', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as ReviewAnnotationBody | undefined;
    if (!body?.path) throw new HttpError(400, 'path is required');
    const annotations = await review.setAnnotation(
      id,
      body.path,
      Number(body.line),
      String(body.comment ?? ''),
    );
    return { path: body.path, annotations } satisfies ReviewAnnotationsResponse;
  });

  app.delete('/api/sessions/:id/review/annotations', async (req) => {
    const { id } = req.params as { id: string };
    const { path, line } = req.query as { path?: string; line?: string };
    if (!path) throw new HttpError(400, 'path is required');
    const annotations = await review.deleteAnnotation(id, path, Number(line));
    return { path, annotations } satisfies ReviewAnnotationsResponse;
  });

  /**
   * Sets the revision the whole review is compared against, or clears it back
   * to each repository's working tree. The answer says where it landed, since
   * one expression resolves separately in every repository.
   */
  app.put('/api/sessions/:id/review/base', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as ReviewBaseBody | undefined;
    const rev = body?.rev ?? null;
    if (rev !== null && typeof rev !== 'string') throw new HttpError(400, 'rev must be a string');
    return review.setBase(id, rev);
  });

  /** Deletes REVIEW.md — the "New review" button. The file is the review. */
  app.delete('/api/sessions/:id/review', async (req, reply) => {
    const { id } = req.params as { id: string };
    await review.deleteReview(id);
    return reply.code(204).send();
  });

  // --- Agent configuration ----------------------------------------------------

  /**
   * The AGENTS.md, skills and slash commands a session is given.
   *
   * `global` is applied to every session and always exists; any other set is
   * chosen when a session is created and merged over it. Every mutation
   * answers with the whole set rather than the piece that changed.
   *
   * What is written here reaches a box when that box next starts.
   */

  app.get('/api/agent-sets', async () => agents.listSets());

  app.post('/api/agent-sets', async (req, reply) => {
    const body = req.body as CreateAgentSetBody | undefined;
    return reply.code(201).send(agents.createSet(body?.name as string));
  });

  app.get('/api/agent-sets/:setId', async (req) => {
    const { setId } = req.params as { setId: string };
    return agents.getSet(setId);
  });

  app.patch('/api/agent-sets/:setId', async (req) => {
    const { setId } = req.params as { setId: string };
    return agents.updateSet(setId, (req.body ?? {}) as UpdateAgentSetBody);
  });

  app.delete('/api/agent-sets/:setId', async (req, reply) => {
    const { setId } = req.params as { setId: string };
    agents.deleteSet(setId);
    return reply.code(204).send();
  });

  /** Creates a skill or command, or replaces the one already under that name. */
  app.put('/api/agent-sets/:setId/items', async (req) => {
    const { setId } = req.params as { setId: string };
    return agents.putItem(setId, req.body as AgentItemBody | undefined);
  });

  app.delete('/api/agent-sets/:setId/items', async (req) => {
    const { setId } = req.params as { setId: string };
    const { kind, name } = req.query as { kind?: string; name?: string };
    return agents.deleteItem(setId, kind, name);
  });

  /**
   * What a session selecting this set gets, global set included.
   *
   * A merge of two sets is not obvious from either half, so the editor shows
   * the result.
   */
  app.get('/api/agent-sets/:setId/preview', async (req) => {
    const { setId } = req.params as { setId: string };
    agents.getSet(setId);
    return agents.bundle(setId);
  });

  // --- Web Push --------------------------------------------------------------

  /**
   * The deployment's VAPID public key, which a browser needs before it can
   * subscribe at all.
   *
   * Not a secret: it is the identity a push service checks the signature
   * against, and it is meant to be handed to every browser.
   */
  app.get('/api/push/key', async (): Promise<PushKeyResponse> => ({
    publicKey: notifier.publicKey,
  }));

  /**
   * Checks a push endpoint before the orchestrator will ever POST to it.
   *
   * https only, and never an address literal: a push service is always a named
   * host, and accepting a literal would turn this route into a way to aim the
   * orchestrator at the LAN it can see. A hostname that resolves into private
   * space is not caught here — the API is root-equivalent either way, and
   * whatever authenticates it is the real boundary.
   */
  function validEndpoint(value: unknown): string {
    if (typeof value !== 'string' || value.length > 2000) {
      throw new HttpError(400, 'endpoint is required');
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new HttpError(400, 'endpoint must be a URL');
    }
    if (url.protocol !== 'https:') throw new HttpError(400, 'endpoint must be https');
    if (/^\[|^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname === 'localhost') {
      throw new HttpError(400, 'endpoint must name a host, not an address');
    }
    return value;
  }

  /** Checks one base64url key from a subscription decodes to the expected size. */
  function validKey(value: unknown, bytes: number, name: string): string {
    if (typeof value !== 'string' || Buffer.from(value, 'base64url').length !== bytes) {
      throw new HttpError(400, `${name} must be ${bytes} base64url-encoded bytes`);
    }
    return value;
  }

  /**
   * Registers a browser for push, or refreshes what is stored for it.
   *
   * There is no user to attach this to, since Boxes has no accounts, so a
   * subscription is one more browser this deployment notifies and whatever
   * authenticates the rest of `/api` decides who may add one.
   */
  app.post('/api/push/subscribe', async (req, reply) => {
    const body = req.body as PushSubscribeBody | undefined;
    const endpoint = validEndpoint(body?.endpoint);
    const p256dh = validKey(body?.keys?.p256dh, 65, 'p256dh');
    const auth = validKey(body?.keys?.auth, 16, 'auth');
    const label = typeof body?.label === 'string' ? body.label.slice(0, 100) : null;

    upsertPushSubscription(db, endpoint, p256dh, auth, label);
    log.info('registered a push subscription', { endpoint: new URL(endpoint).origin });
    return reply.code(204).send();
  });

  /** Forgets a browser's subscription, on its own way out. */
  app.delete('/api/push/subscribe', async (req, reply) => {
    const body = req.body as { endpoint?: unknown } | undefined;
    if (typeof body?.endpoint !== 'string') throw new HttpError(400, 'endpoint is required');
    deletePushSubscription(db, body.endpoint);
    return reply.code(204).send();
  });

  // --- Static bundles with a single-page fallback -----------------------------

  /** Content types served from the bundles, by file extension. */
  const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.map': 'application/json',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
  };

  /**
   * Serves the dashboard bundle: a real file when the path names one, else its
   * index.html so client-side routes survive a reload.
   *
   * The path is resolved under the bundle directory and has to stay there, with
   * the separator in the prefix check so a sibling directory whose name merely
   * starts the same way is not inside it.
   */
  function sendBundle(reply: FastifyReply, path: string): FastifyReply {
    const candidate = resolve(DASHBOARD_DIR, `.${normalize(path)}`);
    if (
      candidate.startsWith(`${DASHBOARD_DIR}/`) &&
      path !== '/' &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    ) {
      const ext = candidate.slice(candidate.lastIndexOf('.'));
      return reply
        .type(CONTENT_TYPES[ext] ?? 'application/octet-stream')
        .send(readFileSync(candidate));
    }
    const index = join(DASHBOARD_DIR, 'index.html');
    if (!existsSync(index)) return reply.code(404).send({ error: 'Dashboard not built' });
    return reply.type('text/html; charset=utf-8').send(readFileSync(index));
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET') return reply.code(404).send({ error: 'Not found' });
    const url = req.url.split('?')[0] ?? '/';
    if (url.startsWith('/api') || url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return sendBundle(reply, url);
  });

  return {
    app,
    db,
    manager,
    cfg,
    egress,
    notifier,
    review,
    agents,
    setProxyWarnings: (warnings) => {
      proxyWarnings = warnings;
    },
  };
}
