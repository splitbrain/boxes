import compress from '@fastify/compress';
import Fastify from 'fastify';
import type { FastifyReply } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type {
  CredentialSummary,
  HarnessHealth,
  HarnessInfo,
  HealthResponse,
  LoginState,
  PushKeyResponse,
  ReadyResponse,
  ReviewAnnotationsResponse,
  Settings,
  StoredAttachment,
} from '../../shared/types.ts';
import { AgentStore } from './agents.ts';
import { ATTACHMENTS_DIR, servedTypeFor, storeAttachment } from './attachments.ts';
import {
  agentItemBody,
  backgroundStopBody,
  createAgentSetBody,
  createBoxBody,
  createThreadBody,
  loginCodeBody,
  parseBody,
  patchSettingsBody,
  pushSubscribeBody,
  pushUnsubscribeBody,
  putCredentialBody,
  reviewAnnotationBody,
  reviewBaseBody,
  reviewFileBody,
  threadDoneBody,
  updateAgentSetBody,
} from './bodies.ts';
import type { Config } from './config.ts';
import {
  CredentialStore,
  deliverableSecret,
  isCredentialId,
  undeliverableReason,
  type CredentialId,
} from './credentials.ts';
import {
  countLiveBoxes,
  countPushSubscriptions,
  deletePushSubscription,
  readHarnessCatalog,
  upsertPushSubscription,
  type Db,
} from './db.ts';
import { EgressManager } from './egress.ts';
import { HARNESSES } from './harness.ts';
import { HttpError } from './http-error.ts';
import { deploymentImages } from './images.ts';
import { dockerLoginRuntime, LoginManager } from './login.ts';
import { log } from './log.ts';
import { Notifier } from './notify.ts';
import { MAX_FILE_BYTES, resolveInRoot } from './review/fs.ts';
import { ReviewService } from './review/service.ts';
import { runtime } from './runtime.ts';
import { BoxManager } from './boxes.ts';
import { deploymentId, patchSettings, readSettings } from './settings.ts';
import { devTunnelsApi, TunnelReconciler } from './tunnels.ts';
import { setBoxOwner } from './workspaces.ts';

/** The HTTP surface: the REST API and the static bundle. */

/** Version reported by the health endpoint. */
const VERSION = '1.0.0';

/** Directory of this module. */
const here = dirname(fileURLToPath(import.meta.url));

/** Dashboard bundle, where the orchestrator image puts it. */
const DASHBOARD_DIR = resolve(here, '../dashboard');

/**
 * The bundle directory whose filenames carry a content hash, which is Vite's
 * `build.assetsDir`.
 */
const HASHED_ASSETS = '/assets/';

/** How long a content-hashed asset may be held, in seconds. A year. */
const ASSET_MAX_AGE = 31_536_000;

/**
 * The Cache-Control value for one file of the bundle.
 *
 * A name under the hashed-asset directory changes whenever its bytes change,
 * so a cached copy is never stale. Every other name, index.html above all,
 * stays the same across builds and is revalidated on every load.
 */
function cacheControlFor(path: string): string {
  return path.startsWith(HASHED_ASSETS)
    ? `public, max-age=${ASSET_MAX_AGE}, immutable`
    : 'no-cache';
}

/**
 * SHA-256 of the one inline script of index.html, base64.
 *
 * The theme switch that runs before first paint. It is the page's only inline
 * script and it is stated here rather than allowed wholesale, so the policy
 * still refuses every script it does not know. Editing that script means
 * editing this.
 */
const THEME_SCRIPT_HASH = "'sha256-4AdoNi/wvSpHLY3qRCPU3bCPtiW7L8VuMIcRP0Slv5s='";

/** A Host header worth putting in a header this process writes. */
const SAFE_HOST = /^[A-Za-z0-9.\-[\]]+(:\d+)?$/;

/**
 * The content security policy the dashboard document is served under.
 *
 * The thread renders markdown the agent wrote. A remote `<img>` in it would
 * carry data out through the reader's browser and past the egress proxy, so
 * every fetch the page makes is pinned to this origin.
 *
 * Styles allow `'unsafe-inline'`, because the overlay primitives and the code
 * pane set the style attribute, and a style attribute cannot be hashed.
 *
 * The socket is named as well as covered by `'self'`, because some browsers
 * do not read `'self'` as including the ws and wss forms of the origin. A Host
 * header that is not a plain host is left out.
 */
function documentCsp(host: string | undefined): string {
  const origin = host !== undefined && SAFE_HOST.test(host) ? host : null;
  return [
    "default-src 'none'",
    `script-src 'self' ${THEME_SCRIPT_HASH}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${origin ? ` ws://${origin} wss://${origin}` : ''}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Smallest body that is compressed, in bytes. Below it the encoding headers
 * cost more than the saving.
 */
const COMPRESS_THRESHOLD_BYTES = 1024;

/**
 * Sends one file out of a workspace, typed by its name rather than its bytes.
 *
 * {@link servedTypeFor} decides the type and the policy. The caller has
 * already resolved the path inside the workspace and made sure it is a file,
 * or opened it through fileAccess() and hands over its stream.
 */
function sendWorkspaceFile(
  reply: FastifyReply,
  file: string | Readable,
  name: string,
  size: number,
) {
  const served = servedTypeFor(name);
  void reply.headers({
    'Content-Type': served.contentType,
    'Content-Length': String(size),
    // The name is percent-encoded: it comes from a directory the agent
    // writes to, and a quote or a newline in it must not reach the header.
    'Content-Disposition': `${served.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    // The browser must not sniff the bytes and treat a download as a document.
    'X-Content-Type-Options': 'nosniff',
    // Lets an SVG be served as itself: nothing in it may run or fetch.
    'Content-Security-Policy': served.csp,
    // Short, because the agent can rewrite the file under a stable name.
    'Cache-Control': 'private, max-age=60',
  });
  return typeof file === 'string' ? createReadStream(file) : file;
}

/** Whether the database answers a query, for the readiness probe. */
function databaseAnswers(db: Db): boolean {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch (err) {
    log.warn('the database did not answer', { error: (err as Error).message });
    return false;
  }
}

/** Whether the Docker daemon answers, for the readiness probe. */
async function dockerAnswers(): Promise<boolean> {
  try {
    await runtime().system.healthCheck();
    return true;
  } catch (err) {
    log.warn('the Docker daemon did not answer', { error: (err as Error).message });
    return false;
  }
}

/** What a caller may put in place of a default when it builds the app. */
export interface BuildOptions {
  /** Where the dashboard bundle is, for a caller serving one it built itself. */
  bundleDir?: string;
}

/** What one orchestrator process hands its boot and its tests, wired together. */
export interface Orchestrator {
  /** The HTTP app, not yet listening. */
  app: ReturnType<typeof Fastify>;
  /** The box lifecycle behind the routes. */
  manager: BoxManager;
  /** The config the app was built with. */
  cfg: Config;
  /** Owns the egress policy and keeps the proxy holding it. */
  egress: EgressManager;
  /** The deployment's credentials, as the settings page manages them. */
  credentials: CredentialStore;
  /** The logins in flight, one per credential at most. */
  logins: LoginManager;
  /** Which dev tunnels each box hosts, and the removal of unserved ones. */
  tunnels: TunnelReconciler;
  /** Box ids whose network is missing the egress proxy. */
  setProxyWarnings(warnings: string[]): void;
}

/**
 * Builds the HTTP app and the objects behind it, without listening or
 * touching Docker, so a test can drive the real routes over a real database.
 */
export function buildApp(cfg: Config, db: Db, opts: BuildOptions = {}): Orchestrator {
  const bundleDir = opts.bundleDir ?? DASHBOARD_DIR;
  // Before anything creates a workspace directory or a container: everything
  // that writes files for the agent, or runs a process as it, reads this.
  setBoxOwner(cfg.BOX_UID, cfg.BOX_GID);

  // The store and the egress manager need each other: the policy is composed
  // from the store's rows, and every write to the store re-pushes it. The
  // hoisted function below lets the store be built first.
  const credentials = new CredentialStore(db, () => repushPolicy());
  const egress = new EgressManager(cfg, credentials);
  const notifier = new Notifier(db, cfg);

  /**
   * Pushes the policy again because a credential changed.
   *
   * Best effort and never awaited, so the settings page does not fail while
   * the proxy restarts. The reconciler pushes it again every minute.
   */
  function repushPolicy(): void {
    void egress.sync().catch((err: Error) => {
      log.warn('could not push the egress policy after a credential changed; will retry', {
        error: err.message,
      });
    });
  }
  // A login runs the harness's own CLI in a throwaway container built from
  // the box image, so the one thing it needs from the deployment is which
  // image that is.
  const logins = new LoginManager(credentials, dockerLoginRuntime(cfg.BOX_IMAGE));
  const agents = new AgentStore(db, cfg.DATA_DIR);
  // The closure lets the reconciler be built before the manager it reads.
  const tunnels = new TunnelReconciler(
    db,
    devTunnelsApi(() => {
      const row = credentials.get('devtunnels');
      return row ? deliverableSecret(row) : null;
    }),
    deploymentId(db),
    () => manager.processReadings(),
  );
  const manager = new BoxManager(db, cfg, egress, notifier, agents, (id) => tunnels.forBox(id));
  // The manager knows where a box's files are and how to get its container
  // running.
  const review = new ReviewService(db, {
    workspacePath: (id) => manager.workspacePathOf(id),
    execTarget: (id) => manager.execTarget(id),
    reviewable: (id) => manager.reviewable(id),
    ensureFilesReachable: (id) => manager.ensureFilesReachable(id),
  });

  let proxyWarnings: string[] = [];

  const app = Fastify({ logger: false });

  /**
   * Hands attachment uploads to the route as a Buffer. The route sets the
   * size limit.
   */
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  /**
   * The request log: one line per response, through the structured logger.
   *
   * The path is logged without its query string, which can carry a filename
   * or a path the reader typed. A 4xx logs as a warning and a 5xx as an error.
   */
  app.addHook('onResponse', async (req, reply) => {
    const status = reply.statusCode;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    log[level]('request', {
      method: req.method,
      path: req.url.split('?')[0],
      status,
      ms: Math.round(reply.elapsedTime),
    });
  });

  // --- REST: unauthenticated here, the deployment puts auth in front ----------

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    // Fastify's own refusals, such as a body over the route's limit, already
    // carry a status and a message worth showing.
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as Error).message });
    }
    log.error('unhandled request error', { error: (err as Error).message });
    return reply.code(500).send({ error: 'Internal error' });
  });

  /**
   * Liveness: this process is serving requests. Always 200, so a probe does
   * not restart a deployment that is only misconfigured. The body says what
   * is wrong.
   */
  app.get('/healthz', async (): Promise<HealthResponse> => {
    const boxes = countLiveBoxes(db);
    return {
      ok: true,
      version: VERSION,
      boxes,
      proxyWarnings,
      egress: egress.status(),
      harnesses: harnessHealth(),
      credentials: credentials.list().map((row) => credentials.summarize(row)),
      pushSubscriptions: countPushSubscriptions(db),
      // The one thing here that asks the daemon anything. Cached for a minute
      // and null on every failure, so the probe answers at the same speed and
      // stays green on a host whose Docker socket is not there.
      images: await deploymentImages(cfg),
    };
  });

  /**
   * Readiness: whether this deployment can serve boxes, as a status code.
   *
   * The database has to answer, the proxy has to hold the current egress
   * policy, and the Docker daemon has to be reachable. A box started against
   * a stale policy reaches hosts the deployment has stopped allowing.
   *
   * Missing harness credentials and proxy warnings do not count, because
   * they concern single boxes rather than the instance.
   */
  app.get('/readyz', async (_req, reply): Promise<ReadyResponse> => {
    const checks = {
      database: databaseAnswers(db),
      egress: egress.status()?.inSync === true,
      docker: await dockerAnswers(),
    };
    const ready = Object.values(checks).every(Boolean);
    return reply.code(ready ? 200 : 503).send({ ready, version: VERSION, checks });
  });

  /**
   * What each harness needs, and whether it has it.
   *
   * Lists only the harnesses whose credential is in the config's credential
   * set, because a box holds a placeholder for those credentials alone.
   */
  function harnessHealth(): HarnessHealth[] {
    const deliverable = new Set(cfg.credentialSet.map((spec) => spec.id));
    return Object.values(HARNESSES)
      .filter((h) => deliverable.has(h.credentialId))
      .map((h) => {
        const row = credentials.get(h.credentialId);
        // A valid credential may still not reach a box: a subscription
        // obtained by logging in is a document rather than a header value.
        // The reason goes in the field the dashboard shows beside the harness.
        const blocked = row ? undeliverableReason(row) : null;
        const summary = row ? credentials.summarize(row) : null;
        return {
          id: h.id,
          label: h.label,
          credential:
            summary && blocked ? { ...summary, lastError: summary.lastError ?? blocked } : summary,
          // An expired or failing credential keeps the harness listed, so the
          // dashboard can say what is wrong with it.
          runnable: row?.status === 'ok' && blocked === null,
        };
      });
  }

  /**
   * Every harness this deployment can run, for the dialogs: what the registry
   * says about it, what its adapter last advertised, and whether it can run
   * now.
   *
   * The catalogue is a cache written by the adapter that last answered a
   * `session/new`, `session/load` or `session/fork`. It is null until an
   * adapter of that harness has answered one, and the dialog then offers the
   * agent choice alone.
   */
  app.get('/api/harnesses', async (): Promise<HarnessInfo[]> =>
    harnessHealth().map((health) => {
      const entry = HARNESSES[health.id];
      return {
        ...health,
        defaultModeId: entry.defaultModeId,
        forkModeId: entry.forkModeId,
        defaultConfig: { ...entry.defaultConfig },
        catalog: readHarnessCatalog(db, health.id),
      };
    }),
  );

  app.get('/api/boxes', async () => manager.list());

  app.post('/api/boxes', async (req, reply) => {
    const created = await manager.create(parseBody(createBoxBody, req.body));
    return reply.code(201).send(created);
  });

  app.get('/api/boxes/:id', async (req) => {
    const { id } = req.params as { id: string };
    return manager.detail(id);
  });

  app.post('/api/boxes/:id/start', async (req) => {
    const { id } = req.params as { id: string };
    return manager.start(id);
  });

  app.post('/api/boxes/:id/stop', async (req) => {
    const { id } = req.params as { id: string };
    return manager.stop(id);
  });

  app.delete('/api/boxes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await manager.remove(id);
    // The review service caches per box; a deleted one has nothing to cache.
    review.forget(id);
    return reply.code(204).send();
  });

  /**
   * The conversations a box owns. They share the box's container, files and
   * egress policy.
   */
  app.get('/api/boxes/:id/threads', async (req) => {
    const { id } = req.params as { id: string };
    return manager.threads(id);
  });

  /** Adds a conversation: empty, or carrying the context of the thread named by `from`. */
  app.post('/api/boxes/:id/threads', async (req, reply) => {
    const { id } = req.params as { id: string };
    const created = await manager.createThread(id, parseBody(createThreadBody, req.body));
    return reply.code(201).send(created);
  });

  /**
   * Marks a conversation done, or takes the mark off again. The mark changes
   * how the thread is drawn in a list, and the thread still runs and answers.
   */
  app.post('/api/boxes/:id/threads/:threadId/done', async (req) => {
    const { id, threadId } = req.params as { id: string; threadId: string };
    const { done } = parseBody(threadDoneBody, req.body);
    return manager.setThreadDone(id, threadId, done);
  });

  /**
   * Stops one task that conversation left running, or every task it has.
   *
   * A stop and not a cancel: a background command outlives the turn that
   * started it, and a cancel does not reach it. `processId` is the adapter's
   * own id for the task, as the thread state carried it. Without one, every
   * task of the thread stops.
   *
   * The answer says how many tasks the adapter stopped. Zero is normal for a
   * task that had already finished, and the thread's state is sent again
   * either way.
   */
  app.post('/api/boxes/:id/threads/:threadId/background/stop', async (req) => {
    const { id, threadId } = req.params as { id: string; threadId: string };
    const { processId } = parseBody(backgroundStopBody, req.body);
    return manager.stopBackgroundWork(id, threadId, processId);
  });

  /**
   * Kills every process in a box that Boxes did not start itself, and
   * answers how many were signalled.
   *
   * This reaches work no adapter can name any more. Neither adapter announces
   * the tasks of a process that has died again, so after a restart a build
   * can run with no task to stop.
   */
  app.post('/api/boxes/:id/background/stop', async (req) => {
    const { id } = req.params as { id: string };
    return manager.stopBoxWork(id);
  });

  /**
   * Stores one file the user attached to a prompt, in the box's own
   * workspace.
   *
   * The body is the raw bytes of one file, and its name is in the query. The
   * upload comes before the prompt that mentions it. It needs no container,
   * because the workspace is a directory this process writes, so a stopped
   * box takes attachments as well.
   */
  app.post(
    '/api/boxes/:id/attachments',
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
      if (!workspace) throw new HttpError(404, 'Box not found');

      const stored = await storeAttachment(workspace, name, body);
      // An upload is somebody working in the box, so the reaper leaves it.
      manager.touch(id);
      // An upload can grow the workspace of a stopped box, which the size
      // cache does not measure again on its own.
      manager.workspaceChanged(id);
      log.box(id).info('attachment stored', { path: stored.path, size: stored.size });
      return stored;
    },
  );

  /**
   * Serves one stored attachment back, which is how the thread shows the
   * picture the user attached.
   *
   * The agent controls this tree, so a link planted in the attachments
   * directory could point at anything the orchestrator's uid can read.
   * `resolveInRoot` keeps the read inside the directory.
   */
  app.get('/api/boxes/:id/attachments/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    // A stored name is always a single path component.
    if (name.includes('/') || name.includes('\\')) {
      throw new HttpError(404, 'Attachment not found');
    }

    const workspace = manager.workspacePathOf(id);
    if (!workspace) throw new HttpError(404, 'Box not found');

    const resolved = resolveInRoot(join(workspace, ATTACHMENTS_DIR), name);
    if (!resolved.ok) throw new HttpError(404, 'Attachment not found');
    const stat = statSync(resolved.path);
    if (!stat.isFile()) throw new HttpError(404, 'Attachment not found');

    return sendWorkspaceFile(reply, resolved.path, name, stat.size);
  });

  // --- Code review over a box's workspace ---------------------------------
  // Files come from the workspace directory. Git runs in the box's container,
  // so a route that asks git starts a stopped box and marks it active.

  /**
   * One directory of the review, with the facts the whole view needs.
   *
   * `path` is workspace-relative and empty for the root. `fresh` is the browser
   * saying it has arrived rather than opened a folder: it takes git's answer
   * for the workspace again and runs the drift check.
   */
  app.get('/api/boxes/:id/review/dir', async (req) => {
    const { id } = req.params as { id: string };
    const { path, fresh } = req.query as { path?: string; fresh?: string };
    return review.dir(id, path ?? '', fresh === '1');
  });

  app.get('/api/boxes/:id/review/file', async (req) => {
    const { id } = req.params as { id: string };
    const { path } = req.query as { path?: string };
    if (!path) throw new HttpError(400, 'path is required');
    return review.file(id, path);
  });

  /**
   * One file of the workspace as its bytes, for a file the view cannot show
   * as text. Served the way an attachment is.
   */
  app.get('/api/boxes/:id/review/raw', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path } = req.query as { path?: string };
    if (!path) throw new HttpError(400, 'path is required');
    const file = await review.rawFile(id, path);
    return sendWorkspaceFile(reply, file.stream, basename(path), file.size);
  });

  /**
   * Saves one file of the workspace, as edited in the review, and answers
   * with the file view.
   *
   * The body carries the hash the file was read at, so a save over an edit
   * the agent made in the meantime is refused.
   */
  app.put(
    '/api/boxes/:id/review/file',
    // Twice the display limit, because JSON encoding grows the file and the
    // service's own size check has to be reached.
    { bodyLimit: 2 * MAX_FILE_BYTES },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = parseBody(reviewFileBody, req.body);
      return review.writeFile(id, body.path, body.content, body.hash ?? '');
    },
  );

  /**
   * Creates or replaces the comment on one line. REVIEW.md holds at most one
   * comment per line.
   */
  app.put('/api/boxes/:id/review/annotations', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(reviewAnnotationBody, req.body);
    const annotations = await review.setAnnotation(id, body.path, body.line, body.comment);
    return { path: body.path, annotations } satisfies ReviewAnnotationsResponse;
  });

  app.delete('/api/boxes/:id/review/annotations', async (req) => {
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
  app.put('/api/boxes/:id/review/base', async (req) => {
    const { id } = req.params as { id: string };
    const { rev } = parseBody(reviewBaseBody, req.body);
    return review.setBase(id, rev ?? null);
  });

  /** Deletes REVIEW.md — the "New review" button. The file is the review. */
  app.delete('/api/boxes/:id/review', async (req, reply) => {
    const { id } = req.params as { id: string };
    await review.deleteReview(id);
    return reply.code(204).send();
  });

  // --- Agent configuration ----------------------------------------------------

  app.get('/api/agent-sets', async () => agents.listSets());

  app.post('/api/agent-sets', async (req, reply) => {
    const body = parseBody(createAgentSetBody, req.body);
    return reply.code(201).send(agents.createSet(body.name));
  });

  app.get('/api/agent-sets/:setId', async (req) => {
    const { setId } = req.params as { setId: string };
    return agents.getSet(setId);
  });

  app.patch('/api/agent-sets/:setId', async (req) => {
    const { setId } = req.params as { setId: string };
    return agents.updateSet(setId, parseBody(updateAgentSetBody, req.body));
  });

  app.delete('/api/agent-sets/:setId', async (req, reply) => {
    const { setId } = req.params as { setId: string };
    agents.deleteSet(setId);
    return reply.code(204).send();
  });

  /** Creates a skill or command, or replaces the one already under that name. */
  app.put('/api/agent-sets/:setId/items', async (req) => {
    const { setId } = req.params as { setId: string };
    return agents.putItem(setId, parseBody(agentItemBody, req.body));
  });

  app.delete('/api/agent-sets/:setId/items', async (req) => {
    const { setId } = req.params as { setId: string };
    const { kind, name } = req.query as { kind?: string; name?: string };
    return agents.deleteItem(setId, kind, name);
  });

  /** What a box selecting this set gets, global set included, for the editor to show. */
  app.get('/api/agent-sets/:setId/preview', async (req) => {
    const { setId } = req.params as { setId: string };
    agents.getSet(setId);
    return agents.bundle(setId);
  });

  // --- Credentials and settings ------------------------------------------------

  /**
   * The deployment's credentials. A secret goes in through PUT and never
   * comes back out: this lists only an account and a status for each.
   */
  app.get('/api/credentials', async (): Promise<CredentialSummary[]> =>
    credentials.list().map((row) => credentials.summarize(row)),
  );

  app.put('/api/credentials/:id', async (req) => {
    const id = credentialId(req.params as { id: string });
    const { method, secret } = parseBody(putCredentialBody, req.body);
    return credentials.summarize(credentials.put(id, method, secret));
  });

  app.delete('/api/credentials/:id', async (req, reply) => {
    credentials.remove(credentialId(req.params as { id: string }));
    return reply.code(204).send();
  });

  /**
   * Starts a login, for a credential that cannot be pasted.
   *
   * Only the harness's own CLI can obtain a ChatGPT or Claude subscription,
   * so Boxes runs it in a throwaway container and drives it. Dev Tunnels
   * takes only a token from GitHub's device flow, which the orchestrator runs
   * itself. The page polls the routes below for the state, sends the code
   * Claude's CLI asks for, and cancels. `github` and `gitlab` have no flow and
   * answer a 400.
   */
  app.post('/api/credentials/:id/login', async (req) => {
    const id = credentialId(req.params as { id: string });
    return { loginId: logins.start(id) };
  });

  app.get('/api/credentials/:id/login/:loginId', async (req): Promise<LoginState> => {
    const { loginId } = req.params as { loginId: string };
    return logins.state(credentialId(req.params as { id: string }), loginId);
  });

  app.post('/api/credentials/:id/login/:loginId/code', async (req, reply) => {
    const { loginId } = req.params as { loginId: string };
    const { code } = parseBody(loginCodeBody, req.body);
    logins.submitCode(credentialId(req.params as { id: string }), loginId, code);
    // The poll above reports where the login goes next.
    return reply.code(204).send();
  });

  app.delete('/api/credentials/:id/login/:loginId', async (req, reply) => {
    const { loginId } = req.params as { loginId: string };
    logins.cancel(credentialId(req.params as { id: string }), loginId);
    return reply.code(204).send();
  });

  /** The credential a route names, or a 400 rather than a row nobody can use. */
  function credentialId(params: { id: string }): CredentialId {
    if (!isCredentialId(params.id)) {
      throw new HttpError(400, `Unknown credential: ${params.id}`);
    }
    return params.id;
  }

  app.get('/api/settings', async (): Promise<Settings> => readSettings(db));

  /** Writes the settings a body names and answers with all of them. */
  app.patch('/api/settings', async (req): Promise<Settings> =>
    patchSettings(db, parseBody(patchSettingsBody, req.body)),
  );

  // --- Web Push --------------------------------------------------------------

  /**
   * The deployment's VAPID public key, which a browser needs before it can
   * subscribe. It is public by design.
   */
  app.get('/api/push/key', async (): Promise<PushKeyResponse> => ({
    publicKey: notifier.publicKey,
  }));

  /**
   * Checks a push endpoint before the orchestrator ever POSTs to it.
   *
   * It must be https and name a host. An address literal or localhost is
   * refused, so the route cannot aim the orchestrator at the LAN it can see.
   * A hostname that resolves to a private address still passes; whatever
   * authenticates the API is the real boundary.
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
   * Boxes has no accounts, so a subscription belongs to the deployment.
   * Whatever authenticates `/api` decides who may add one.
   */
  app.post('/api/push/subscribe', async (req, reply) => {
    const body = parseBody(pushSubscribeBody, req.body);
    const endpoint = validEndpoint(body.endpoint);
    const p256dh = validKey(body.keys.p256dh, 65, 'p256dh');
    const auth = validKey(body.keys.auth, 16, 'auth');
    const label = typeof body.label === 'string' ? body.label.slice(0, 100) : null;

    // Stored with the current key, because after a key rotation the
    // subscription can no longer be delivered to.
    upsertPushSubscription(db, endpoint, p256dh, auth, label, notifier.publicKey);
    log.info('registered a push subscription', { endpoint: new URL(endpoint).origin });
    return reply.code(204).send();
  });

  /** Forgets a browser's subscription, on its own way out. */
  app.delete('/api/push/subscribe', async (req, reply) => {
    const { endpoint } = parseBody(pushUnsubscribeBody, req.body);
    deletePushSubscription(db, endpoint);
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
   * The path has to stay under the bundle directory. The prefix check
   * includes the separator, so a sibling directory with the same prefix does
   * not count as inside.
   *
   * Every file is streamed, because the entry chunk is over a megabyte and a
   * synchronous read would block the event loop.
   */
  function sendBundle(reply: FastifyReply, path: string, host: string | undefined): FastifyReply {
    const candidate = resolve(bundleDir, `.${normalize(path)}`);
    if (
      candidate.startsWith(`${bundleDir}/`) &&
      path !== '/' &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    ) {
      const ext = candidate.slice(candidate.lastIndexOf('.'));
      return reply
        .type(CONTENT_TYPES[ext] ?? 'application/octet-stream')
        .header('Cache-Control', cacheControlFor(path))
        .send(createReadStream(candidate));
    }
    const index = join(bundleDir, 'index.html');
    if (!existsSync(index)) return reply.code(404).send({ error: 'Dashboard not built' });
    return reply
      .headers({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': cacheControlFor('/index.html'),
        'Content-Security-Policy': documentCsp(host),
      })
      .send(createReadStream(index));
  }

  /**
   * The bundle, served compressed.
   *
   * The compression plugin attaches to each route as the route is declared,
   * so it is registered first and the route is declared inside it. For the
   * same reason the bundle is a route rather than the not-found handler,
   * which the plugin never sees.
   */
  void app.register(async (bundle) => {
    await bundle.register(compress, { global: true, threshold: COMPRESS_THRESHOLD_BYTES });
    /**
     * Every GET that is not the API or the gateway is the dashboard: a file
     * of the bundle where the path names one, and index.html where it names a
     * client-side route.
     */
    bundle.get('/*', async (req, reply) => {
      const url = req.url.split('?')[0] ?? '/';
      if (url.startsWith('/api') || url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return sendBundle(reply, url, req.headers.host);
    });
  });

  /** Anything the routes above did not match, which is never the dashboard. */
  app.setNotFoundHandler(async (_req, reply) => reply.code(404).send({ error: 'Not found' }));

  return {
    app,
    manager,
    cfg,
    egress,
    credentials,
    logins,
    tunnels,
    setProxyWarnings: (warnings) => {
      proxyWarnings = warnings;
    },
  };
}
