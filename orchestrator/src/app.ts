/** The HTTP app of the orchestrator, with the REST API and the dashboard bundle. */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import compress from '@fastify/compress';
import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import type {
  ApiKeySummary,
  BootResponse,
  CredentialSummary,
  EgressDenial,
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
import { ApiKeyStore } from './api-keys.ts';
import { servedTypeFor, storeAttachment } from './attachments.ts';
import {
  agentItemBody,
  agentMcpServerBody,
  agentRepoBody,
  backgroundStopBody,
  boxEgressProfileBody,
  createAgentSetBody,
  createBoxBody,
  createEgressProfileBody,
  createThreadBody,
  loginCodeBody,
  mcpCallbackBody,
  mcpConnectBody,
  parseBody,
  patchSettingsBody,
  pushSubscribeBody,
  pushUnsubscribeBody,
  putApiKeyBody,
  putCredentialBody,
  reviewAnnotationBody,
  reviewBaseBody,
  reviewFileBody,
  threadDoneBody,
  updateAgentSetBody,
  updateEgressProfileBody,
} from './bodies.ts';
import { BOOT_PAGE, BOOT_PAGE_CSP, BootState } from './boot.ts';
import { BoxManager } from './boxes.ts';
import { builtinSkills } from './builtin-skills.ts';
import type { Config } from './config.ts';
import {
  type CredentialId,
  CredentialStore,
  deliverableSecret,
  isCredentialId,
  undeliverableReason,
} from './credentials.ts';
import {
  type BoxRow,
  countLiveBoxes,
  countPushSubscriptions,
  type Db,
  deleteOwnPushSubscription,
  readHarnessCatalog,
  upsertPushSubscription,
} from './db.ts';
import { type EgressBoxInput, EgressManager } from './egress.ts';
import { EgressProfileStore } from './egress-profiles.ts';
import { type FileStream, fileService, isRefusedPath } from './files.ts';
import { HARNESSES } from './harness.ts';
import { HttpError } from './http-error.ts';
import { deploymentImages } from './images.ts';
import { log } from './log.ts';
import { LoginManager } from './login.ts';
import { McpOAuth, type OAuthFetch } from './mcp-oauth.ts';
import { McpSecretStore } from './mcp-secrets.ts';
import { mcpHostPattern } from './mcp-servers.ts';
import { Notifier } from './notify.ts';
import { MAX_FILE_BYTES } from './review/fs.ts';
import { ReviewService } from './review/service.ts';
import { createRuntime } from './runtime/index.ts';
import { runtime, setRuntime } from './runtime/runtime.ts';
import { deploymentId, patchSettings, readSettings } from './settings.ts';
import { fetchRepo } from './skill-repos.ts';
import { devTunnelsApi, TunnelReconciler } from './tunnels.ts';
import { UpstreamCaStore } from './upstream-cas.ts';
import {
  boxScope,
  claimUnownedData,
  hasUnownedData,
  isMultiUser,
  NO_USER_PAGE,
  NO_USER_PAGE_CSP,
  requestUser,
} from './users.ts';
import { setBoxOwner } from './workspaces.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The user of the request, which the onRequest hook reads from the headers.
     * Null when the request has no valid username. The empty user in single
     * user mode.
     */
    user: string | null;
  }
}

/** The version that the health endpoint reports. */
const VERSION = '1.0.0';

/** The directory of this module. */
const here = dirname(fileURLToPath(import.meta.url));

/** The directory of the dashboard bundle in the orchestrator image. */
const DASHBOARD_DIR = resolve(here, '../dashboard');

/**
 * The URL path of the bundle directory with a content hash in each filename. It
 * is the `build.assetsDir` of the Vite build.
 */
const HASHED_ASSETS = '/assets/';

/** The maximum cache time of an asset with a content hash, in seconds (one year). */
const ASSET_MAX_AGE = 31_536_000;

/**
 * Gives the Cache-Control value for one file of the bundle.
 *
 * A name under {@link HASHED_ASSETS} changes when its bytes change, so a
 * cached copy is never stale. Each other name, for example index.html, stays
 * the same across builds, so the browser validates it again on each load.
 *
 * @param path The URL path of the file.
 * @returns The Cache-Control value.
 */
function cacheControlFor(path: string): string {
  return path.startsWith(HASHED_ASSETS)
    ? `public, max-age=${ASSET_MAX_AGE}, immutable`
    : 'no-cache';
}

/**
 * The SHA-256 hash, in base64, of the inline script of index.html.
 *
 * The script sets the theme before the first paint. The policy allows only
 * this hash, so it refuses each other inline script. A change to the script
 * needs a change to this hash.
 */
const THEME_SCRIPT_HASH = "'sha256-CnZHNPAF6WOocb4/bNl9c3BRy4DGumb4xxVfhF7huZc='";

/** The paths that are served while the orchestrator starts. */
const BOOT_OPEN_PATHS = new Set(['/api/boot', '/healthz', '/readyz']);

/** The pattern of a Host header that is safe to copy into a response header. */
const SAFE_HOST = /^[A-Za-z0-9.\-[\]]+(:\d+)?$/;

/**
 * Makes the content security policy of the dashboard document.
 *
 * The thread shows markdown that the agent wrote. A remote `<img>` in it could
 * send data out through the browser of the reader, past the egress proxy. So
 * the policy limits each fetch of the page to this origin.
 *
 * Styles allow `'unsafe-inline'`, because the overlay primitives and the code
 * pane set the style attribute, and a style attribute cannot be hashed.
 *
 * The policy names the socket origins in addition to `'self'`, because some
 * browsers do not include the ws and wss forms of the origin in `'self'`. A
 * Host header that does not match {@link SAFE_HOST} is left out.
 *
 * @param host The Host header of the request.
 * @returns The value of the Content-Security-Policy header.
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
 * The smallest body that is compressed, in bytes. For a smaller body, the
 * encoding headers cost more than the compression saves.
 */
const COMPRESS_THRESHOLD_BYTES = 1024;

/**
 * Sends one file of a box, with a content type from its name and not
 * from its bytes.
 *
 * {@link servedTypeFor} gives the type and the policy. The stream comes from
 * the file service and goes to the browser, so a large file stays out of memory.
 *
 * @param reply The reply to set the headers on.
 * @param stream The content of the file.
 * @param name The name of the file.
 * @param size The size of the file in bytes.
 * @returns The stream, for the route to send.
 */
function sendBoxFile(reply: FastifyReply, stream: Readable, name: string, size: number) {
  const served = servedTypeFor(name);
  void reply.headers({
    'Content-Type': served.contentType,
    'Content-Length': String(size),
    // The name is percent-encoded, because it comes from a directory that the
    // agent writes to. A quote or a newline in it must not reach the header.
    'Content-Disposition': `${served.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    // The browser must not sniff the bytes and treat a download as a document.
    'X-Content-Type-Options': 'nosniff',
    // The policy lets the browser show an SVG, but nothing in it can run or fetch.
    'Content-Security-Policy': served.csp,
    // The agent can rewrite the file under the same name, and the dashboard
    // never reloads its page, so the browser must not keep a copy.
    'Cache-Control': 'no-store',
  });
  return stream;
}

/**
 * Checks if the database answers a query, for the readiness probe.
 *
 * @param db The database.
 * @returns True when the query succeeds.
 */
function databaseAnswers(db: Db): boolean {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch (err) {
    log.warn('the database did not answer', { error: (err as Error).message });
    return false;
  }
}

/**
 * Checks if the runtime answers, for the readiness probe.
 *
 * @returns True when the health check of the runtime succeeds.
 */
async function runtimeAnswers(): Promise<boolean> {
  try {
    await runtime().health();
    return true;
  } catch (err) {
    log.warn('the runtime did not answer', { error: (err as Error).message });
    return false;
  }
}

/** The options that replace the defaults of {@link buildApp}. */
export interface BuildOptions {
  /** The directory of the dashboard bundle. */
  bundleDir?: string;
  /**
   * The start state of the orchestrator. Until the start is complete, the app
   * serves only the starting page, the boot endpoint and the probes. Without
   * it, the app serves everything at once.
   */
  boot?: BootState;
  /** The function that sends the requests of the OAuth client of the MCP servers. */
  mcpFetch?: OAuthFetch;
}

/** The connected objects of one orchestrator process, for its start code and its tests. */
export interface Orchestrator {
  /** The HTTP app, not yet listening. */
  app: ReturnType<typeof Fastify>;
  /** The box lifecycle behind the routes. */
  manager: BoxManager;
  /** The agent sets, and the pulls of their repositories. */
  agents: AgentStore;
  /** The config the app was built with. */
  cfg: Config;
  /** The manager of the egress policy, which keeps the policy in the proxy. */
  egress: EgressManager;
  /** The credentials of each user, which the settings page manages. */
  credentials: CredentialStore;
  /** The logins that run now, at most one for each user and credential. */
  logins: LoginManager;
  /** The OAuth client of the MCP servers, which refreshes their tokens. */
  mcpOAuth: McpOAuth;
  /** The dev tunnels of each box, and the removal of tunnels that no box uses. */
  tunnels: TunnelReconciler;
  /**
   * Sets the box ids whose network isolation the repair loop could not complete.
   *
   * @param warnings The box ids, for the health endpoint.
   */
  setIsolationWarnings(warnings: string[]): void;
}

/**
 * Builds the HTTP app and the objects behind it, and sets the runtime of the
 * boxes. The function does not listen and does not call the runtime, so a
 * test can use the real routes with a real database.
 *
 * @param cfg The config of the orchestrator.
 * @param db The database.
 * @param opts The options that replace the defaults.
 * @returns The app and the objects behind it.
 */
export function buildApp(cfg: Config, db: Db, opts: BuildOptions = {}): Orchestrator {
  const bundleDir = opts.bundleDir ?? DASHBOARD_DIR;
  const boot = opts.boot ?? new BootState(true);
  // This call comes before the first workspace directory or container, because each part
  // that writes files for the agent or runs a process as the agent reads the owner.
  setBoxOwner(cfg.BOX_UID, cfg.BOX_GID);
  setRuntime(createRuntime(cfg));

  // The stores and the egress manager need each other. The manager makes the policy from
  // the rows of the stores, and each write to a store pushes the policy again. The hoisted
  // functions below let the stores be built first.
  const credentials = new CredentialStore(db, () => repushPolicy(), cfg.credentialSet);
  const upstreamCas = new UpstreamCaStore(db, () => repushPolicy());
  const apiKeys = new ApiKeyStore(db, () => repushPolicy(), upstreamCas);
  const profiles = new EgressProfileStore(db, () => repushPolicy());
  const mcpSecrets = new McpSecretStore(db, () => repushPolicy());
  const egress = new EgressManager(
    cfg,
    credentials,
    apiKeys,
    db,
    () => egressBoxes(),
    () => mcpSecrets.listAll(),
    (tokens) => {
      void mcpOAuth.handleRefused(tokens).catch((err: Error) => {
        log.warn('could not handle the refused tokens of MCP servers', { error: err.message });
      });
    },
    () => upstreamCas.listAll(),
  );
  const notifier = new Notifier(db, cfg);

  /**
   * Pushes the policy again after a write that can change it.
   *
   * The push is best effort and not awaited, so the settings page does not
   * fail while the proxy restarts. The reconciler pushes the policy again
   * every minute.
   */
  function repushPolicy(): void {
    void egress.sync().catch((err: Error) => {
      log.warn('could not push the egress policy after a change; will retry', {
        error: err.message,
      });
    });
  }

  /**
   * Lists the boxes that are not deleted, with the egress profile and the MCP
   * hosts of each, for the egress policy. The MCP hosts are those of the
   * current agent sets, so a removed server loses its host at once.
   *
   * @returns The boxes.
   */
  function egressBoxes(): EgressBoxInput[] {
    const rows = db.prepare("SELECT * FROM boxes WHERE status != 'deleted'").all() as BoxRow[];
    return rows.map((row) => {
      const profile = profiles.forBox(row.owner, row.egress_profile_id);
      const servers = agents.mcpSnapshot(row.owner, row.agent_set_id);
      return {
        id: row.id,
        owner: row.owner,
        token: row.proxy_token,
        open: profile.open,
        hosts: profile.hosts,
        mcpHosts: servers.flatMap((server) => mcpHostPattern(server.url) ?? []),
      };
    });
  }
  const logins = new LoginManager(credentials);
  // The pull of a private repository on github.com uses the GitHub credential
  // of the owner of the set.
  const agents = new AgentStore(
    db,
    cfg.DATA_DIR,
    (dir, url, ref, keep, owner) => {
      const row = credentials.get(owner, 'github');
      return fetchRepo(dir, url, ref, row ? deliverableSecret(row) : null, keep);
    },
    (owner) => builtinSkills({ hasCredential: (id) => credentials.get(owner, id) !== undefined }),
    mcpSecrets,
    upstreamCas,
  );
  const mcpOAuth = new McpOAuth(
    mcpSecrets,
    (owner, setId, name) => agents.mcpServer(owner, setId, name),
    (owner, url) => {
      const host = mcpHostPattern(url);
      return host === null ? null : upstreamCas.shared(owner, [host]);
    },
    opts.mcpFetch,
  );
  // The closure lets the reconciler be built before the manager it reads.
  const tunnels = new TunnelReconciler(
    db,
    devTunnelsApi((owner) => {
      const row = credentials.get(owner, 'devtunnels');
      return row ? deliverableSecret(row) : null;
    }),
    deploymentId(db),
    (owners) => manager.processReadings(owners),
  );
  const manager = new BoxManager(db, cfg, egress, notifier, agents, profiles, (id) =>
    tunnels.forBox(id),
  );
  // The manager finds the files of a box and starts its container when it is stopped.
  const review = new ReviewService(db, {
    execTarget: (id) => manager.execTarget(id),
  });

  let isolationWarnings: string[] = [];

  /** True while rows of the empty user wait for the first user. */
  let unowned = isMultiUser(cfg) && hasUnownedData(db);

  /**
   * Gives the user of a request. The onRequest hook refuses each request
   * without a valid username, except the boot endpoint and the probes.
   *
   * @param req The request.
   * @returns The username, or the empty user in single user mode.
   * @throws {HttpError} A 401 when the request has no valid username.
   */
  function userOf(req: FastifyRequest): string {
    if (req.user === null) throw new HttpError(401, 'The reverse proxy sent no username');
    return req.user;
  }

  const app = Fastify({ logger: false });
  app.decorateRequest('user', null);

  /**
   * Gives each octet-stream body, for example an attachment upload, to the
   * route as a Buffer. The route sets the size limit.
   */
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  /**
   * Writes one line to the request log for each response.
   *
   * The log line has the path without its query string, because the query
   * can hold a filename or a path that the user typed. A 4xx logs as a warning
   * and a 5xx as an error.
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

  /**
   * Holds back every request until the orchestrator has started, except the
   * boot endpoint and the probes.
   *
   * A browser that asks for a page gets the starting page, which loads the
   * dashboard when the start is complete. Each other request gets a 503.
   */
  app.addHook('onRequest', async (req, reply) => {
    if (boot.ready) return;
    const path = req.url.split('?')[0] ?? '/';
    if (BOOT_OPEN_PATHS.has(path)) return;
    if (
      req.method === 'GET' &&
      !path.startsWith('/api') &&
      req.headers.accept?.includes('text/html')
    ) {
      return reply
        .headers({
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': BOOT_PAGE_CSP,
        })
        .send(BOOT_PAGE);
    }
    return reply.code(503).header('Retry-After', '5').send({ error: 'Boxes is starting' });
  });

  /**
   * Refuses each request without a valid username in multi-user mode, except
   * the boot endpoint and the probes. A browser that asks for a page gets a
   * page that tells why.
   *
   * The first request with a username gets the rows of the empty user. The
   * probes cannot claim them, so a health check does not take the data.
   */
  app.addHook('onRequest', async (req, reply) => {
    req.user = requestUser(req.headers, cfg.AUTH_USER_HEADER);
    const path = req.url.split('?')[0] ?? '/';
    if (BOOT_OPEN_PATHS.has(path)) return;
    const user = req.user;
    if (user === null) {
      if (
        req.method === 'GET' &&
        !path.startsWith('/api') &&
        req.headers.accept?.includes('text/html')
      ) {
        return reply
          .code(401)
          .headers({
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': NO_USER_PAGE_CSP,
          })
          .send(NO_USER_PAGE);
      }
      return reply.code(401).send({ error: 'The reverse proxy sent no username' });
    }
    if (unowned && user !== '') {
      const moved = claimUnownedData(db, user);
      unowned = false;
      // The ids of the moved credentials in the egress policy change.
      if (moved > 0) repushPolicy();
    }
  });

  /**
   * Answers 404 for each box route that names a box the user cannot see. A
   * box of another user gets the same answer as a box that does not exist, so
   * a user cannot find the box ids of other users.
   */
  app.addHook('preHandler', async (req) => {
    if (!req.routeOptions.url?.startsWith('/api/boxes/:id')) return;
    const { id } = req.params as { id: string };
    if (!manager.visibleRow(id, boxScope(cfg, userOf(req)))) {
      throw new HttpError(404, 'Box not found');
    }
  });

  // --- REST API, without authentication (the reverse proxy in front authenticates) ---

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    // A refusal from Fastify, for example a body over the limit of the route,
    // has a status and a message for the client.
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as Error).message });
    }
    log.error('unhandled request error', { error: (err as Error).message });
    return reply.code(500).send({ error: 'Internal error' });
  });

  /**
   * The liveness probe. It always answers 200, so a probe does not restart a
   * deployment that only has a wrong configuration. The body tells what is
   * wrong.
   *
   * The credentials, the harnesses, the push subscriptions and the credential
   * ids of the egress policy are those of the user of the request. A request
   * without a username gets those of the empty user. The number of boxes is
   * that of the whole deployment.
   */
  app.get('/healthz', async (req): Promise<HealthResponse> => {
    const boxes = countLiveBoxes(db);
    const user = req.user ?? '';
    return {
      ok: true,
      version: VERSION,
      user: isMultiUser(cfg) ? req.user : null,
      boxes,
      isolationWarnings,
      egress: egress.statusFor(user),
      harnesses: harnessHealth(user),
      credentials: credentials.list(user).map((row) => credentials.summarize(row)),
      pushSubscriptions: countPushSubscriptions(db, user),
      // Only this field asks the runtime. The reading is cached for a minute, and an
      // image that cannot be read is null, so the probe stays green without the runtime.
      images: await deploymentImages(),
    };
  });

  /**
   * The readiness probe. It answers 200 when this deployment can serve boxes,
   * and 503 when it cannot.
   *
   * The database has to answer, the proxy has to hold the current egress
   * policy, and the runtime has to be reachable. A box started against
   * a stale policy reaches hosts the deployment has stopped allowing.
   *
   * Missing harness credentials and proxy warnings do not count, because
   * they concern single boxes rather than the instance.
   */
  app.get('/readyz', async (_req, reply): Promise<ReadyResponse> => {
    const checks = {
      database: databaseAnswers(db),
      egress: egress.status()?.inSync === true,
      runtime: await runtimeAnswers(),
    };
    const ready = Object.values(checks).every(Boolean);
    return reply.code(ready ? 200 : 503).send({ ready, version: VERSION, checks });
  });

  /** The start state of the orchestrator, and the progress of the pull of the box image. */
  app.get('/api/boot', async (): Promise<BootResponse> => boot.status());

  /**
   * The credential state of each harness for a user.
   *
   * The list holds only the harnesses with a credential in the credential set
   * of the config, because the orchestrator gives a box a placeholder only for
   * those credentials. A harness without a credential is always in the list,
   * and it can always run, because it has models that need no key.
   *
   * @param user The user.
   * @returns The state of each harness.
   */
  function harnessHealth(user: string): HarnessHealth[] {
    const deliverable = new Set(cfg.credentialSet.map((spec) => spec.id));
    return Object.values(HARNESSES)
      .filter((h) => h.credentialId === null || deliverable.has(h.credentialId))
      .map((h) => {
        if (h.credentialId === null) {
          return {
            id: h.id,
            label: h.label,
            credential: null,
            runnable: true,
          };
        }
        const row = credentials.get(user, h.credentialId);
        // A valid credential can fail to reach a box, because a subscription from
        // a login is a document and not a header value. The reason goes in the
        // field that the dashboard shows next to the harness.
        const blocked = row ? undeliverableReason(row) : null;
        const summary = row ? credentials.summarize(row) : null;
        return {
          id: h.id,
          label: h.label,
          credential:
            summary && blocked ? { ...summary, lastError: summary.lastError ?? blocked } : summary,
          // A harness with an expired or failed credential stays in the list, so
          // the dashboard can show what is wrong.
          runnable: row?.status === 'ok' && blocked === null,
        };
      });
  }

  /**
   * Every harness that this deployment can run, for the dialogs. Each entry
   * has the registry data, the catalogue that its adapter last sent, and the
   * state of the harness.
   *
   * The catalogue is a cache of what the adapter sent. It is null until an
   * adapter of that harness answers. While it is null, the dialog offers only
   * the agent choice.
   */
  app.get(
    '/api/harnesses',
    async (req): Promise<HarnessInfo[]> =>
      harnessHealth(userOf(req)).map((health) => {
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

  app.get('/api/boxes', async (req) => manager.list(boxScope(cfg, userOf(req))));

  app.post('/api/boxes', async (req, reply) => {
    const created = await manager.create(parseBody(createBoxBody, req.body), userOf(req));
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
    // The review service caches data for each box, so it forgets the deleted box.
    review.forget(id);
    return reply.code(204).send();
  });

  app.put('/api/boxes/:id/egress-profile', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(boxEgressProfileBody, req.body);
    return manager.setEgressProfile(id, body.egressProfile);
  });

  /** The targets that the egress profile of the box refused, from the memory of the proxy. */
  app.get('/api/boxes/:id/denials', async (req): Promise<EgressDenial[]> => {
    const { id } = req.params as { id: string };
    manager.mustGet(id);
    try {
      return await egress.denials(id);
    } catch (err) {
      throw new HttpError(502, `The egress proxy did not answer: ${(err as Error).message}`);
    }
  });

  /**
   * Lists the threads of a box. The threads of a box share its container,
   * files and egress policy.
   */
  app.get('/api/boxes/:id/threads', async (req) => {
    const { id } = req.params as { id: string };
    return manager.threads(id);
  });

  /** Adds a thread, empty or with the context of the thread that `from` names. */
  app.post('/api/boxes/:id/threads', async (req, reply) => {
    const { id } = req.params as { id: string };
    const created = await manager.createThread(id, parseBody(createThreadBody, req.body));
    return reply.code(201).send(created);
  });

  /**
   * Marks a thread done, or removes the mark. The mark changes how a list shows
   * the thread. The thread continues to run and answer.
   */
  app.post('/api/boxes/:id/threads/:threadId/done', async (req) => {
    const { id, threadId } = req.params as { id: string; threadId: string };
    const { done } = parseBody(threadDoneBody, req.body);
    return manager.setThreadDone(id, threadId, done);
  });

  /**
   * Stops one background task of a thread, or every task of the thread.
   *
   * The route stops and does not cancel, because a background command continues
   * after the turn that started it, and a cancel does not reach it.
   * `processId` is the id of the task in the adapter, from the thread state.
   * Without it, every task of the thread stops.
   *
   * The answer gives the number of tasks that the adapter stopped. Zero is
   * normal for a task that is already finished. When an adapter holds the
   * thread, the gateway sends the thread state again after the stop.
   */
  app.post('/api/boxes/:id/threads/:threadId/background/stop', async (req) => {
    const { id, threadId } = req.params as { id: string; threadId: string };
    const { processId } = parseBody(backgroundStopBody, req.body);
    return manager.stopBackgroundWork(id, threadId, processId);
  });

  /**
   * Kills every process in a box that Boxes did not start, and answers the
   * number of signalled processes.
   *
   * The route reaches work that no adapter can name. An adapter does not
   * announce again the tasks of a process that died, so after a restart a build
   * can run without a task to stop.
   */
  app.post('/api/boxes/:id/background/stop', async (req) => {
    const { id } = req.params as { id: string };
    return manager.stopBoxWork(id);
  });

  /**
   * Stores one file that the user attached to a prompt, in the workspace of
   * the box.
   *
   * The body is the raw bytes of one file, and the query holds its name. The
   * upload comes before the prompt that mentions it. The file service in the
   * box writes the file, so the orchestrator starts a stopped box for the upload.
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

      // The call marks the box active, because an upload is work in the box. So
      // the reaper does not stop the box.
      const target = await manager.execTarget(id);
      const stored = await storeAttachment(fileService(target.boxId), name, body);
      log.box(id).info('attachment stored', { path: stored.path, size: stored.size });
      return stored;
    },
  );

  /**
   * Sends one file of the box as its bytes. The path is absolute in the box.
   * The thread uses the route for the attachments and for the images and links
   * in a message, and the review uses it for a file that it cannot show as
   * text. The file service in the box reads the file, so the orchestrator
   * starts a stopped box for the request.
   */
  app.get('/api/boxes/:id/files/raw', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path } = req.query as { path?: string };
    if (!path) throw new HttpError(400, 'path is required');

    const target = await manager.execTarget(id);
    let file: FileStream;
    try {
      file = await fileService(target.boxId).readStream(path);
    } catch (err) {
      if (isRefusedPath(err)) throw new HttpError(404, 'File not found');
      throw err;
    }
    return sendBoxFile(reply, file.stream, basename(path), file.size);
  });

  // --- Code review over the workspace of a box ---------------------------
  // The file service and git run in the box, so each review route starts a stopped box.

  /**
   * One directory of the review, with the facts the whole view needs.
   *
   * `path` is relative to the workspace, and empty for the root. The browser
   * sets `fresh` when it arrives at the view, and not when it opens a folder.
   * Then the service reads the git state again and runs the drift check.
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
   * Saves one file of the workspace after an edit in the review, and answers
   * with the file view.
   *
   * The body holds the hash of the file at the time of the read, so the
   * service refuses a save over a later edit by the agent.
   */
  app.put(
    '/api/boxes/:id/review/file',
    // Twice the display limit, because JSON encoding makes the file larger, and
    // the size check of the service must get the request.
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
   * Sets the revision that the whole review compares against, or clears it
   * back to the HEAD of each repository. The answer gives the result
   * for each repository, because one expression resolves separately in each
   * repository.
   */
  app.put('/api/boxes/:id/review/base', async (req) => {
    const { id } = req.params as { id: string };
    const { rev } = parseBody(reviewBaseBody, req.body);
    return review.setBase(id, rev ?? null);
  });

  /** Deletes REVIEW.md, for the "New review" button. The file holds the whole review. */
  app.delete('/api/boxes/:id/review', async (req, reply) => {
    const { id } = req.params as { id: string };
    await review.deleteReview(id);
    return reply.code(204).send();
  });

  // --- Agent configuration ----------------------------------------------------

  app.get('/api/agent-sets', async (req) => agents.listSets(userOf(req)));

  app.post('/api/agent-sets', async (req, reply) => {
    const body = parseBody(createAgentSetBody, req.body);
    return reply.code(201).send(agents.createSet(userOf(req), body.name));
  });

  app.get('/api/agent-sets/:setId', async (req) => {
    const { setId } = req.params as { setId: string };
    return agents.getSet(userOf(req), setId);
  });

  app.patch('/api/agent-sets/:setId', async (req) => {
    const { setId } = req.params as { setId: string };
    return agents.updateSet(userOf(req), setId, parseBody(updateAgentSetBody, req.body));
  });

  app.delete('/api/agent-sets/:setId', async (req, reply) => {
    const { setId } = req.params as { setId: string };
    agents.deleteSet(userOf(req), setId);
    // The set can hold MCP servers, whose hosts are in the policy of its boxes.
    repushPolicy();
    return reply.code(204).send();
  });

  /** Creates a skill, or replaces the one already under that name. */
  app.put('/api/agent-sets/:setId/items', async (req) => {
    const { setId } = req.params as { setId: string };
    return agents.putItem(userOf(req), setId, parseBody(agentItemBody, req.body));
  });

  app.delete('/api/agent-sets/:setId/items', async (req) => {
    const { setId } = req.params as { setId: string };
    const { name } = req.query as { name?: string };
    return agents.deleteItem(userOf(req), setId, name);
  });

  /** Creates an MCP server, or changes the headers of the one already under that name. */
  app.put('/api/agent-sets/:setId/mcp-servers', async (req) => {
    const { setId } = req.params as { setId: string };
    const set = agents.putMcpServer(userOf(req), setId, parseBody(agentMcpServerBody, req.body));
    repushPolicy();
    return set;
  });

  app.delete('/api/agent-sets/:setId/mcp-servers', async (req) => {
    const { setId } = req.params as { setId: string };
    const { name } = req.query as { name?: string };
    const set = agents.deleteMcpServer(userOf(req), setId, name);
    repushPolicy();
    return set;
  });

  /** Starts the OAuth login of an MCP server. */
  app.post('/api/agent-sets/:setId/mcp-servers/:name/connect', async (req) => {
    const { setId, name } = req.params as { setId: string; name: string };
    const body = parseBody(mcpConnectBody, req.body);
    return mcpOAuth.connect(userOf(req), setId, name, body, req.headers.origin);
  });

  /** Ends an OAuth login with the parameters of the redirect to the dashboard. */
  app.post('/api/mcp-oauth/callback', async (req) =>
    mcpOAuth.callback(userOf(req), parseBody(mcpCallbackBody, req.body)),
  );

  /** Adds a repository to take skills from, and pulls it. */
  app.post('/api/agent-sets/:setId/repos', async (req, reply) => {
    const { setId } = req.params as { setId: string };
    const body = parseBody(agentRepoBody, req.body);
    return reply.code(201).send(await agents.addRepo(userOf(req), setId, body));
  });

  app.delete('/api/agent-sets/:setId/repos/:repoId', async (req) => {
    const { setId, repoId } = req.params as { setId: string; repoId: string };
    return agents.deleteRepo(userOf(req), setId, repoId);
  });

  /** Pulls one repository now, before its daily pull. */
  app.post('/api/agent-sets/:setId/repos/:repoId/pull', async (req) => {
    const { setId, repoId } = req.params as { setId: string; repoId: string };
    return agents.refreshRepo(userOf(req), setId, repoId);
  });

  /** The merged set, with the global set, for a box with this set. The editor shows it. */
  app.get('/api/agent-sets/:setId/preview', async (req) => {
    const { setId } = req.params as { setId: string };
    const user = userOf(req);
    agents.getSet(user, setId);
    return agents.bundle(user, setId);
  });

  // --- Egress profiles ----------------------------------------------------------

  app.get('/api/egress-profiles', async (req) => profiles.list(userOf(req)));

  app.post('/api/egress-profiles', async (req, reply) => {
    const body = parseBody(createEgressProfileBody, req.body);
    return reply.code(201).send(profiles.create(userOf(req), body));
  });

  app.get('/api/egress-profiles/:profileId', async (req) => {
    const { profileId } = req.params as { profileId: string };
    return profiles.get(userOf(req), profileId);
  });

  app.patch('/api/egress-profiles/:profileId', async (req) => {
    const { profileId } = req.params as { profileId: string };
    return profiles.update(userOf(req), profileId, parseBody(updateEgressProfileBody, req.body));
  });

  app.delete('/api/egress-profiles/:profileId', async (req, reply) => {
    const { profileId } = req.params as { profileId: string };
    profiles.delete(userOf(req), profileId);
    return reply.code(204).send();
  });

  // --- Credentials and settings ------------------------------------------------

  /**
   * Lists the credentials of the user, without the secrets. A secret goes in
   * through PUT and never comes back out.
   */
  app.get(
    '/api/credentials',
    async (req): Promise<CredentialSummary[]> =>
      credentials.list(userOf(req)).map((row) => credentials.summarize(row)),
  );

  app.put('/api/credentials/:id', async (req) => {
    const id = credentialId(req.params as { id: string });
    const { method, secret } = parseBody(putCredentialBody, req.body);
    return credentials.summarize(credentials.put(userOf(req), id, method, secret));
  });

  app.delete('/api/credentials/:id', async (req, reply) => {
    credentials.remove(userOf(req), credentialId(req.params as { id: string }));
    return reply.code(204).send();
  });

  /**
   * Starts a login, for a credential that cannot be pasted.
   *
   * Only the CLI of a harness can get a ChatGPT or Claude subscription, so
   * the orchestrator runs the CLI in a temporary container. Dev Tunnels takes
   * only a token from the GitHub device flow, which the orchestrator runs. The
   * page uses the routes below to poll the state, to send the code that the
   * Claude CLI asks for, and to cancel. `github` and `gitlab` have no login
   * and answer a 400.
   */
  app.post('/api/credentials/:id/login', async (req) => {
    const id = credentialId(req.params as { id: string });
    return { loginId: logins.start(userOf(req), id) };
  });

  app.get('/api/credentials/:id/login/:loginId', async (req): Promise<LoginState> => {
    const { loginId } = req.params as { loginId: string };
    return logins.state(userOf(req), credentialId(req.params as { id: string }), loginId);
  });

  app.post('/api/credentials/:id/login/:loginId/code', async (req, reply) => {
    const { loginId } = req.params as { loginId: string };
    const { code } = parseBody(loginCodeBody, req.body);
    logins.submitCode(userOf(req), credentialId(req.params as { id: string }), loginId, code);
    // The state route above reports the next state of the login.
    return reply.code(204).send();
  });

  app.delete('/api/credentials/:id/login/:loginId', async (req, reply) => {
    const { loginId } = req.params as { loginId: string };
    logins.cancel(userOf(req), credentialId(req.params as { id: string }), loginId);
    return reply.code(204).send();
  });

  /**
   * Lists the API keys of the user, with the hosts and the last four
   * characters of each key. A key goes in through PUT and never comes back out.
   */
  app.get(
    '/api/api-keys',
    async (req): Promise<ApiKeySummary[]> =>
      apiKeys.list(userOf(req)).map((row) => apiKeys.summarize(row)),
  );

  app.put('/api/api-keys/:name', async (req) => {
    const { name } = req.params as { name: string };
    const { hosts, secret, upstreamCa } = parseBody(putApiKeyBody, req.body);
    return apiKeys.summarize(apiKeys.put(userOf(req), name, hosts, secret, upstreamCa));
  });

  app.delete('/api/api-keys/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    apiKeys.remove(userOf(req), name);
    return reply.code(204).send();
  });

  /**
   * Reads the credential id from the route parameters.
   *
   * @param params The route parameters.
   * @returns The credential id.
   * @throws {HttpError} A 400 for an unknown id.
   */
  function credentialId(params: { id: string }): CredentialId {
    if (!isCredentialId(params.id)) {
      throw new HttpError(400, `Unknown credential: ${params.id}`);
    }
    return params.id;
  }

  app.get('/api/settings', async (req): Promise<Settings> => readSettings(db, userOf(req)));

  /** Writes the settings in the body for the user, and answers with all settings of the user. */
  app.patch(
    '/api/settings',
    async (req): Promise<Settings> =>
      patchSettings(db, userOf(req), parseBody(patchSettingsBody, req.body)),
  );

  // --- Web Push --------------------------------------------------------------

  /**
   * The VAPID public key of the deployment. A browser needs it before it can
   * subscribe.
   */
  app.get(
    '/api/push/key',
    async (): Promise<PushKeyResponse> => ({
      publicKey: notifier.publicKey,
    }),
  );

  /**
   * Checks a push endpoint before the orchestrator sends a POST to it.
   *
   * The endpoint must be an https URL with a hostname. An IP address or
   * localhost is refused, so the route cannot point the orchestrator at the
   * local network. A hostname that resolves to a private address passes. The
   * authentication in front of the API is the security boundary.
   *
   * @param value The endpoint from the request.
   * @returns The endpoint.
   * @throws {HttpError} A 400 when the endpoint is not valid.
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

  /**
   * Checks that one base64url key of a subscription decodes to the expected size.
   *
   * @param value The key from the request.
   * @param bytes The expected size in bytes.
   * @param name The name of the key, for the error message.
   * @returns The key.
   * @throws {HttpError} A 400 when the key has the wrong size.
   */
  function validKey(value: unknown, bytes: number, name: string): string {
    if (typeof value !== 'string' || Buffer.from(value, 'base64url').length !== bytes) {
      throw new HttpError(400, `${name} must be ${bytes} base64url-encoded bytes`);
    }
    return value;
  }

  /**
   * Registers a browser for push, or refreshes what is stored for it.
   *
   * The subscription belongs to the user of the request. A browser that
   * subscribes again for another user moves to that user.
   */
  app.post('/api/push/subscribe', async (req, reply) => {
    const body = parseBody(pushSubscribeBody, req.body);
    const endpoint = validEndpoint(body.endpoint);
    const p256dh = validKey(body.keys.p256dh, 65, 'p256dh');
    const auth = validKey(body.keys.auth, 16, 'auth');
    const label = typeof body.label === 'string' ? body.label.slice(0, 100) : null;

    // The row keeps the current VAPID key, because after a key rotation the
    // subscription cannot get messages.
    upsertPushSubscription(db, userOf(req), endpoint, p256dh, auth, label, notifier.publicKey);
    log.info('registered a push subscription', { endpoint: new URL(endpoint).origin });
    return reply.code(204).send();
  });

  /** Removes the subscription of a browser of the user, when the browser unsubscribes. */
  app.delete('/api/push/subscribe', async (req, reply) => {
    const { endpoint } = parseBody(pushUnsubscribeBody, req.body);
    deleteOwnPushSubscription(db, userOf(req), endpoint);
    return reply.code(204).send();
  });

  // --- Dashboard bundle with a single-page fallback -----------------------------

  /** The content types of the files of the bundle, by file extension. */
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
   * Sends a file of the dashboard bundle when the path names one. Otherwise
   * sends index.html, so a client-side route works after a reload.
   *
   * The path has to stay under the bundle directory. The prefix check
   * includes the separator, so a sibling directory with the same prefix does
   * not count as inside.
   *
   * Each file is streamed, because some chunks are larger than a megabyte, and
   * a synchronous read blocks the event loop.
   *
   * @param reply The reply to send on.
   * @param path The URL path without the query string.
   * @param host The Host header of the request.
   * @returns The reply.
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
   * The dashboard bundle, sent compressed.
   *
   * The compression plugin attaches to each route when the route is declared.
   * So the plugin is registered first, and the route is declared in it. For
   * the same reason, the bundle is a route and not the not-found handler,
   * because the plugin does not see that handler.
   */
  void app.register(async (bundle) => {
    await bundle.register(compress, { global: true, threshold: COMPRESS_THRESHOLD_BYTES });
    /**
     * Sends the dashboard for each GET outside the API and the gateway.
     */
    bundle.get('/*', async (req, reply) => {
      const url = req.url.split('?')[0] ?? '/';
      if (url.startsWith('/api') || url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return sendBundle(reply, url, req.headers.host);
    });
  });

  /** Answers 404 to each request that no route matched. */
  app.setNotFoundHandler(async (_req, reply) => reply.code(404).send({ error: 'Not found' }));

  return {
    app,
    manager,
    agents,
    cfg,
    egress,
    credentials,
    logins,
    mcpOAuth,
    tunnels,
    setIsolationWarnings: (warnings) => {
      isolationWarnings = warnings;
    },
  };
}
