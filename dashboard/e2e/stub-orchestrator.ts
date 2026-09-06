import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type {
  AgentItem,
  AgentSetDetail,
  CreateThreadBody,
  ExecRecord,
  HealthResponse,
  ReviewAnnotation,
  ReviewAnnotationBody,
  ReviewFileResponse,
  ReviewRepo,
  ReviewTreeResponse,
  SessionDetail,
  SessionSummary,
  StoredAttachment,
  ThreadSummary,
} from '../../shared/types.ts';
import { attachStubGateway, type GatewayScript, type StubGateway } from './stub-gateway.ts';

/**
 * A stand-in orchestrator for the browser tests: it serves the built
 * dashboard exactly as the real one does — real file or index.html fallback,
 * 404 under /api and /ws — and answers the REST calls from canned data.
 *
 * Serving the real bundle is the point. A test that ran against the dev
 * server would not prove the shipped output works.
 */

/** Content types served from the bundle, by file extension. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  // The install: the manifest and the icons it names, with the types the
  // orchestrator gives them (app.ts, CONTENT_TYPES).
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/** A thread the stub reports, matching the stub gateway's own first thread. */
export function stubThread(over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: 'th1',
    acpSessionId: 'acp-thread-1',
    title: null,
    ordinal: 1,
    turnActive: false,
    speaking: false,
    pendingCount: 0,
    createdAt: Date.parse('2026-08-01T10:00:00Z'),
    lastActiveAt: Date.parse('2026-08-30T09:30:00Z'),
    ...over,
  };
}

/** A session the stub reports, with the detail fields filled in. */
export function stubSession(over: Partial<SessionDetail> = {}): SessionDetail {
  const id = over.id ?? 'a1b2c3d4';
  return {
    id,
    name: 'refactor auth',
    profile: 'DEFAULT',
    status: 'running',
    dockerState: 'running',
    turnActive: false,
    speaking: false,
    backgroundBusy: false,
    pendingCount: 0,
    attachedCount: 0,
    wsToken: 'stub-token-0123456789abcdef',
    threads: [stubThread()],
    currentThreadId: 'th1',
    canFork: true,
    agentSetId: null,
    agentSetName: null,
    createdAt: Date.parse('2026-08-01T10:00:00Z'),
    lastActiveAt: Date.parse('2026-08-30T09:30:00Z'),
    image: 'boxes-session:latest',
    containerId: 'c0ffee1234567890',
    networkName: `sn-${id}`,
    subnet: '10.200.0.0/24',
    wsVolume: '',
    workspaceDir: `/data/workspaces/${id}`,
    homeVolume: `home-${id}`,
    acpSessionId: 'acp-thread-1',
    proxyAttached: true,
    ...over,
  };
}

/**
 * A session's review, as the stub keeps it.
 *
 * Enough of a model to answer all six endpoints consistently — a comment
 * written through the API comes back in the next tree and file fetch — without
 * duplicating the orchestrator's own store, whose byte-level behaviour is
 * proven against the desktop tool's fixtures in the orchestrator's tests.
 *
 * The review is over the *workspace*, so `files` is keyed by
 * workspace-relative path and `repos` says which repository each path belongs
 * to. The default fixture holds two of them side by side plus a loose
 * directory no repository claims, because that is the shape the single-root
 * design could not show at all.
 */
export interface StubReview {
  /** Files, by workspace-relative path, with their content. */
  files: Record<string, string>;
  statuses: ReviewTreeResponse['statuses'];
  /** Diff markers per file path. Absent means no change. */
  diffs: Record<string, ReviewFileResponse['diff']>;
  /** Comments per file path, by line. */
  annotations: Record<string, Record<number, ReviewAnnotation>>;
  /** The repositories the workspace holds, sorted by path. */
  repos: ReviewRepo[];
  base: ReviewTreeResponse['base'];
  /** True once a comment has been written, as REVIEW.md existing. */
  hasReview: boolean;
  started: string;
  truncated: boolean;
  /** A status to answer every review request with instead, for the error path. */
  fail: { status: number; error: string } | null;
}

/**
 * A review with two small projects in it and a loose note beside them, which
 * is what the tests browse.
 */
export function stubReview(over: Partial<StubReview> = {}): StubReview {
  return {
    files: {
      'app/src/app.ts': 'import { boot } from "./boot";\n\nboot();\n',
      'app/src/boot.ts':
        'export function boot(): void {\n  // TODO: wire the router\n  console.log("up");\n}\n',
      'app/README.md': '# demo\n\nA project the agent cloned.\n',
      'lib/index.ts': 'export const version = "1.0.0";\n',
      // Outside every repository: no .gitignore has said what is noise here,
      // so it shows, and it has no status and no diff.
      'notes/todo.txt': 'plain text, no grammar\n',
    },
    statuses: { 'app/src/boot.ts': 'modified', 'lib/index.ts': 'untracked' },
    diffs: {
      'app/src/boot.ts': {
        lines: { 2: 'added', 3: 'modified' },
        hunks: [
          {
            startLine: 1,
            endLine: 4,
            diff: ' export function boot(): void {\n+  // TODO: wire the router\n-  console.log("boot");\n+  console.log("up");\n }\n',
          },
        ],
        deletions: [{ afterLine: 1, hunkIndex: 0 }],
      },
    },
    annotations: {},
    repos: [
      { path: 'app', name: 'app', head: 'a'.repeat(40), baseCommit: '' },
      { path: 'lib', name: 'lib', head: 'b'.repeat(40), baseCommit: '' },
    ],
    base: { rev: '' },
    hasReview: false,
    started: '2026-08-31',
    truncated: false,
    fail: null,
    ...over,
  };
}

/**
 * An agent set the stub reports. Defaults to the global one, which every
 * deployment has from its first boot.
 */
export function stubAgentSet(over: Partial<AgentSetDetail> = {}): AgentSetDetail {
  const items = over.items ?? [];
  return {
    id: 'global',
    name: 'Global',
    global: true,
    agentsMd: '',
    items,
    hasAgentsMd: (over.agentsMd ?? '').trim() !== '',
    skillCount: items.filter((i) => i.kind === 'skill').length,
    commandCount: items.filter((i) => i.kind === 'command').length,
    sessionCount: 0,
    createdAt: Date.parse('2026-08-01T10:00:00Z'),
    updatedAt: Date.parse('2026-08-01T10:00:00Z'),
    ...over,
  };
}

/** What the stub answers with, mutable between navigations. */
export interface StubState {
  sessions: SessionDetail[];
  /**
   * The agent sets, global first, exactly as the orchestrator would answer.
   * Held whole rather than summarized so the stub can serve the list, the
   * detail and the merge from one place.
   */
  agentSets: AgentSetDetail[];
  /** What the health probe reports about the deployment's Claude token. */
  claudeTokenConfigured: boolean;
  /**
   * The cookie an authenticating reverse proxy in front of this deployment
   * would be checking, or null for the loopback default that has none.
   *
   * Boxes has no auth of its own, so anything past a single-user machine is
   * behind one (README, "Behind a reverse proxy"). Named here because that
   * changes what the browser sees: a request the proxy does not recognize is
   * bounced to a login page rather than answered, and not every request the
   * page makes carries credentials.
   */
  requireCookie: string | null;
  /** Review data per session id. A session without one has no review at all. */
  reviews: Record<string, StubReview>;
}

/** A running stub, with the base URL to point a browser at. */
export interface StubOrchestrator {
  url: string;
  state: StubState;
  /** The ACP gateway attached to the same server, on the same origin. */
  gateway: StubGateway;
  /** Files uploaded to the attachments endpoint, in order. */
  attachmentUploads: Array<{ sessionId: string; name: string; bytes: Buffer }>;
  /** Bodies posted to the exec endpoint, in order. */
  execCalls: Array<{ sessionId: string; command: string }>;
  /** Combined output the exec endpoint streams back, by command. */
  execOutput: (command: string) => { output: string; exitCode: number };
  /** What GET /exec reports, as if from a previous session. */
  execLog: ExecRecord[];
  /** Every review mutation the browser made, in order. */
  reviewCalls: Array<{ method: string; sessionId: string; body: unknown }>;
  server: Server;
  close(): Promise<void>;
}

/** Starts the stub on an ephemeral port, serving distDir as the dashboard. */
export async function startStubOrchestrator(
  distDir: string,
  initial: SessionDetail[] = [stubSession()],
  gatewayScript?: Partial<GatewayScript>,
): Promise<StubOrchestrator> {
  const dir = resolve(distDir);
  const state: StubState = {
    sessions: initial,
    claudeTokenConfigured: true,
    reviews: Object.fromEntries(initial.map((s) => [s.id, stubReview()])),
    agentSets: [stubAgentSet()],
    requireCookie: null,
  };
  const reviewCalls: StubOrchestrator['reviewCalls'] = [];
  const attachmentUploads: StubOrchestrator['attachmentUploads'] = [];
  const execCalls: StubOrchestrator['execCalls'] = [];
  const execLog: ExecRecord[] = [];
  let execOutput: StubOrchestrator['execOutput'] = (command) => ({
    output: `${command}\n`,
    exitCode: 0,
  });

  const summary = (s: SessionDetail): SessionSummary => s;

  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/';

    // The proxy, when the test asked for one: anything without the cookie is
    // redirected to a login page that answers 200, which is what
    // oauth2-proxy, Authelia and a Caddy forward_auth all do.
    if (state.requireCookie && !(req.headers.cookie ?? '').includes(`${state.requireCookie}=`)) {
      if (url === '/login') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>Sign in</title>');
        return;
      }
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }

    if (url === '/healthz' && req.method === 'GET') {
      const health: HealthResponse = {
        ok: true,
        version: 'stub',
        sessions: state.sessions.length,
        proxyWarnings: [],
        egress: null,
        claudeTokenConfigured: state.claudeTokenConfigured,
        pushSubscriptions: 0,
      };
      return json(res, 200, health);
    }
    if (url === '/api/sessions' && req.method === 'GET') {
      return json(res, 200, state.sessions.map(summary));
    }
    const detail = /^\/api\/sessions\/([^/]+)$/.exec(url);
    if (detail && req.method === 'GET') {
      const found = state.sessions.find((s) => s.id === detail[1]);
      return found ? json(res, 200, found) : json(res, 404, { error: 'Not found' });
    }
    const threads = /^\/api\/sessions\/([^/]+)\/threads$/.exec(url);
    if (threads) {
      const found = state.sessions.find((s) => s.id === threads[1]);
      if (!found) return json(res, 404, { error: 'Not found' });
      if (req.method === 'GET') return json(res, 200, found.threads);
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString('utf8')));
        req.on('end', () => {
          const from = (JSON.parse(body || '{}') as CreateThreadBody).from;
          // The orchestrator mints upstream and records what came back, so
          // the stub does the same rather than inventing an id of its own.
          const source = from ? found.threads.find((t) => t.id === from) : undefined;
          if (from && !source) return json(res, 404, { error: 'Thread not found' });
          const acpSessionId = source?.acpSessionId
            ? gateway.forkThread(source.acpSessionId)
            : gateway.newThread();
          const created = stubThread({
            id: `th${found.threads.length + 1}`,
            acpSessionId,
            ordinal: found.threads.length + 1,
          });
          found.threads = [...found.threads, created];
          found.currentThreadId = created.id;
          found.acpSessionId = acpSessionId;
          return json(res, 201, created);
        });
        return undefined;
      }
    }
    const select = /^\/api\/sessions\/([^/]+)\/threads\/([^/]+)\/select$/.exec(url);
    if (select && req.method === 'POST') {
      const found = state.sessions.find((s) => s.id === select[1]);
      const thread = found?.threads.find((t) => t.id === select[2]);
      if (!found || !thread) return json(res, 404, { error: 'Not found' });
      found.currentThreadId = thread.id;
      found.acpSessionId = thread.acpSessionId;
      if (thread.acpSessionId) gateway.select(thread.acpSessionId);
      return json(res, 200, thread);
    }
    const attach = /^\/api\/sessions\/([^/]+)\/attachments$/.exec(url);
    if (attach && req.method === 'POST') {
      // `url` above has had its query cut off; the name is in the raw one.
      const name = new URL(req.url ?? '/', 'http://stub').searchParams.get('name') ?? '';
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const bytes = Buffer.concat(chunks);
        attachmentUploads.push({ sessionId: attach[1]!, name, bytes });
        // The real endpoint sanitises the name and reports where it landed;
        // the paths a test reads are the ones the prompt will carry.
        const stored: StoredAttachment = {
          name,
          path: `.boxes/attachments/${name}`,
          size: bytes.byteLength,
        };
        json(res, 200, stored);
      });
      return undefined;
    }

    const attached = /^\/api\/sessions\/([^/]+)\/attachments\/([^/]+)$/.exec(url);
    if (attached && req.method === 'GET') {
      const name = decodeURIComponent(attached[2]!);
      const found = attachmentUploads.find(
        (a) => a.sessionId === attached[1] && a.name === name,
      );
      if (!found) return json(res, 404, { error: 'Not found' });
      // The real endpoint serves images as themselves and everything else as
      // a download; the thread only ever asks for the former, which is the
      // part a test is checking. The CSP goes with it, because it is what
      // makes serving an SVG as an SVG safe there.
      const types: Record<string, string> = {
        png: 'image/png',
        svg: 'image/svg+xml',
        pdf: 'application/pdf',
      };
      res.writeHead(200, {
        'Content-Type': types[name.split('.').pop() ?? ''] ?? 'application/octet-stream',
        'Content-Length': String(found.bytes.byteLength),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      res.end(found.bytes);
      return undefined;
    }

    const exec = /^\/api\/sessions\/([^/]+)\/exec$/.exec(url);
    if (exec && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const command = (JSON.parse(body || '{}') as { command?: string }).command ?? '';
        execCalls.push({ sessionId: exec[1]!, command });
        const { output, exitCode } = execOutput(command);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.write(output);
        res.end(`\n[exit ${exitCode}]\n`);
      });
      return undefined;
    }
    if (exec && req.method === 'GET') return json(res, 200, { records: execLog });

    const review = /^\/api\/sessions\/([^/]+)\/review(?:\/(tree|file|annotations|base))?$/.exec(
      url,
    );
    if (review) {
      return answerReview(req, res, state, reviewCalls, review[1]!, review[2] ?? '');
    }

    const agentSets = /^\/api\/agent-sets(?:\/([^/]+))?(?:\/(items|preview))?$/.exec(url);
    if (agentSets) {
      return answerAgentSets(req, res, state, agentSets[1], agentSets[2] ?? '');
    }

    if (url.startsWith('/api') || url.startsWith('/ws')) {
      return json(res, 404, { error: 'Not found' });
    }
    return sendBundle(res, dir, url);
  });

  // Same origin as the dashboard, which is how the deployment serves it and
  // why the browser can derive the WebSocket URL from its own location.
  const gateway = attachStubGateway(
    server,
    {
      token: initial[0]?.wsToken ?? 'stub-token',
      modes: null,
      configOptions: [],
      prompts: [],
      permissions: [],
      queuedPermission: null,
      ...gatewayScript,
    },
    // The mapping the real gateway does out of the threads table: the path
    // carries a Boxes thread id, the adapter knows its own.
    (sessionId, threadId) => {
      const session = state.sessions.find((s) => s.id === sessionId);
      if (!session) return null;
      const wanted = threadId ?? session.currentThreadId;
      return session.threads.find((t) => t.id === wanted)?.acpSessionId ?? null;
    },
  );

  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    gateway,
    attachmentUploads,
    execCalls,
    execLog,
    reviewCalls,
    get execOutput() {
      return execOutput;
    },
    set execOutput(fn: StubOrchestrator['execOutput']) {
      execOutput = fn;
    },
    server,
    close: () =>
      new Promise<void>((ok) => {
        gateway.close();
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

function json(res: import('node:http').ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/** A real file when the path names one, else index.html, as the orchestrator does. */
function sendBundle(res: import('node:http').ServerResponse, dir: string, path: string): void {
  const candidate = resolve(dir, `.${normalize(path)}`);
  if (candidate.startsWith(dir) && path !== '/' && existsSync(candidate) && statSync(candidate).isFile()) {
    const ext = candidate.slice(candidate.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream' });
    res.end(readFileSync(candidate));
    return;
  }
  const index = join(dir, 'index.html');
  if (!existsSync(index)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Dashboard not built' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(readFileSync(index));
}

// --- the review endpoints ---------------------------------------------------

/**
 * Answers the six review routes from the stub's in-memory review.
 *
 * The point of keeping real state rather than canned bodies: a comment written
 * through the API has to come back in the next tree and file fetch, because
 * that loop is what the browser tests are about.
 */
function answerReview(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  state: StubState,
  calls: Array<{ method: string; sessionId: string; body: unknown }>,
  sessionId: string,
  endpoint: string,
): void {
  const review = state.reviews[sessionId];
  if (!review) return json(res, 404, { error: 'Session not found' });
  if (review.fail) return json(res, review.fail.status, { error: review.fail.error });

  const query = new URL(req.url ?? '/', 'http://stub').searchParams;

  /** One file's comments, in line order, as the API reports them. */
  const annotationsOf = (path: string): ReviewAnnotation[] =>
    Object.values(review.annotations[path] ?? {}).sort((a, b) => a.line - b.line);

  /** Reads a JSON body and hands it over. */
  const withBody = (fn: (body: unknown) => void): void => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => fn(JSON.parse(raw || '{}')));
  };

  /** The repository a workspace-relative path belongs to, longest prefix first. */
  const repoFor = (path: string): ReviewRepo | null =>
    review.repos
      .filter((repo) => repo.path === '' || path.startsWith(`${repo.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null;

  if (endpoint === 'tree' && req.method === 'GET') {
    const body: ReviewTreeResponse = {
      repos: review.repos,
      hasGit: review.repos.length > 0,
      // Files, plus the ones a status reports as deleted — they are on no
      // disk, and the real service puts them back the same way.
      entries: markStubRepos(
        buildStubTree([
          ...Object.keys(review.files),
          ...Object.entries(review.statuses)
            .filter(([path, status]) => status === 'deleted' && !review.files[path])
            .map(([path]) => path),
        ]),
        review.repos,
      ),
      truncated: review.truncated,
      statuses: review.statuses,
      counts: Object.fromEntries(
        Object.entries(review.annotations)
          .map(([path, lines]) => [path, Object.keys(lines).length] as const)
          .filter(([, count]) => count > 0),
      ),
      base: review.base,
      hasReview: review.hasReview,
      started: review.hasReview ? review.started : '',
    };
    return json(res, 200, body);
  }

  if (endpoint === 'file' && req.method === 'GET') {
    const path = query.get('path') ?? '';
    const content = review.files[path];
    // A file the change deleted is listed by its status and has no content:
    // the real service answers for it rather than 404ing, so the stub does.
    if (content === undefined && review.statuses[path] === 'deleted') {
      return json(res, 200, {
        path,
        repo: repoFor(path)?.path ?? null,
        content: '',
        truncated: false,
        binary: false,
        deleted: true,
        size: 0,
        lines: 0,
        language: languageOf(path),
        status: 'deleted',
        diff: { lines: {}, hunks: [], deletions: [] },
        annotations: [],
      } satisfies ReviewFileResponse);
    }
    if (content === undefined) return json(res, 404, { error: 'File not found' });
    const body: ReviewFileResponse = {
      path,
      repo: repoFor(path)?.path ?? null,
      content,
      truncated: false,
      binary: false,
      deleted: false,
      size: content.length,
      lines: content.split('\n').filter((_, i, all) => i < all.length - 1 || all[i] !== '').length,
      language: languageOf(path),
      status: review.statuses[path] ?? null,
      diff: review.diffs[path] ?? { lines: {}, hunks: [], deletions: [] },
      annotations: annotationsOf(path),
    };
    return json(res, 200, body);
  }

  if (endpoint === 'annotations' && req.method === 'PUT') {
    return withBody((body) => {
      calls.push({ method: 'PUT', sessionId, body });
      const { path, line, comment } = body as ReviewAnnotationBody;
      if (!review.files[path]) return json(res, 404, { error: 'File not found' });
      review.annotations[path] = {
        ...review.annotations[path],
        [line]: { line, comment: comment.trim(), outdated: false },
      };
      review.hasReview = true;
      return json(res, 200, { path, annotations: annotationsOf(path) });
    });
  }

  if (endpoint === 'annotations' && req.method === 'DELETE') {
    const path = query.get('path') ?? '';
    const line = Number(query.get('line'));
    calls.push({ method: 'DELETE', sessionId, body: { path, line } });
    const lines = { ...review.annotations[path] };
    delete lines[line];
    if (Object.keys(lines).length > 0) review.annotations[path] = lines;
    else delete review.annotations[path];
    return json(res, 200, { path, annotations: annotationsOf(path) });
  }

  if (endpoint === 'base' && req.method === 'PUT') {
    return withBody((body) => {
      calls.push({ method: 'PUT base', sessionId, body });
      const { rev } = body as { rev: string | null };
      if (rev === 'nope') return json(res, 400, { error: `unknown revision: ${rev}` });
      const wanted = rev === null ? '' : rev.trim();
      review.base = { rev: wanted };
      // One expression, resolved separately in each repository: `only-app`
      // names a branch in the first and nothing in the second, which is the
      // soft failure the picker has to report rather than refuse.
      review.repos = review.repos.map((repo, index) => ({
        ...repo,
        baseCommit:
          wanted === '' || (wanted === 'only-app' && index > 0)
            ? ''
            : `${index}`.repeat(8) + 'c'.repeat(32),
      }));
      return json(res, 200, { rev: wanted, repos: review.repos });
    });
  }

  if (endpoint === '' && req.method === 'DELETE') {
    calls.push({ method: 'DELETE review', sessionId, body: null });
    review.annotations = {};
    review.hasReview = false;
    res.writeHead(204);
    res.end();
    return;
  }

  return json(res, 404, { error: 'Not found' });
}

/** The same shape the orchestrator's tree builder produces, from a path list. */
function buildStubTree(paths: string[]): ReviewTreeResponse['entries'] {
  type Node = { entry: ReviewTreeResponse['entries'][number]; children: Map<string, Node> };
  const root: Node = { entry: { name: '', path: '', isDir: true }, children: new Map() };

  for (const path of paths.toSorted()) {
    const parts = path.split('/');
    let current = root;
    parts.forEach((part, i) => {
      const isLeaf = i === parts.length - 1;
      let next = current.children.get(part);
      if (!next) {
        next = {
          entry: {
            name: part,
            path: isLeaf ? path : parts.slice(0, i + 1).join('/'),
            isDir: !isLeaf,
          },
          children: new Map(),
        };
        current.children.set(part, next);
      }
      current = next;
    });
  }

  const collect = (node: Node): ReviewTreeResponse['entries'] =>
    [...node.children.values()]
      .map((child) => {
        if (!child.entry.isDir) return child.entry;
        return { ...child.entry, children: collect(child) };
      })
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));

  return collect(root);
}

/** Marks the directories the repositories are rooted at, the way the API does. */
function markStubRepos(
  entries: ReviewTreeResponse['entries'],
  repos: ReviewRepo[],
): ReviewTreeResponse['entries'] {
  const roots = new Set(repos.map((repo) => repo.path));
  const mark = (level: ReviewTreeResponse['entries']): ReviewTreeResponse['entries'] =>
    level.map((entry) =>
      entry.isDir
        ? {
            ...entry,
            ...(roots.has(entry.path) ? { repo: true } : {}),
            children: mark(entry.children ?? []),
          }
        : entry,
    );
  return mark(entries);
}

/** The language the real API would report, for the handful the stub serves. */
function languageOf(path: string): string {
  if (path.endsWith('.ts')) return 'typescript';
  if (path.endsWith('.md')) return 'markdown';
  return '';
}

/**
 * The agent-set endpoints, over an in-memory list.
 *
 * Enough of a model for the editor to be exercised end to end: a written item
 * comes back in the next read, and the preview merges the global set with the
 * one asked for, which is the behaviour the view actually renders.
 */
function answerAgentSets(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  state: StubState,
  setId: string | undefined,
  endpoint: string,
): void {
  const summarize = (set: AgentSetDetail): AgentSetDetail => ({
    ...set,
    hasAgentsMd: set.agentsMd.trim() !== '',
    skillCount: set.items.filter((i) => i.kind === 'skill').length,
    commandCount: set.items.filter((i) => i.kind === 'command').length,
  });

  const withBody = (fn: (body: Record<string, unknown>) => void): void => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => fn(JSON.parse(raw || '{}') as Record<string, unknown>));
  };

  if (setId === undefined) {
    if (req.method === 'GET') return json(res, 200, state.agentSets.map(summarize));
    if (req.method === 'POST') {
      return withBody((body) => {
        const created = stubAgentSet({
          id: `as${state.agentSets.length}`,
          name: String(body['name'] ?? ''),
          global: false,
          items: [],
        });
        state.agentSets.push(created);
        return json(res, 201, summarize(created));
      });
    }
  }

  const set = state.agentSets.find((s) => s.id === setId);
  if (!set) return json(res, 404, { error: 'Agent set not found' });

  if (endpoint === '' && req.method === 'GET') return json(res, 200, summarize(set));
  if (endpoint === '' && req.method === 'PATCH') {
    return withBody((body) => {
      if (typeof body['name'] === 'string') set.name = body['name'];
      if (typeof body['agentsMd'] === 'string') set.agentsMd = body['agentsMd'];
      return json(res, 200, summarize(set));
    });
  }
  if (endpoint === '' && req.method === 'DELETE') {
    state.agentSets = state.agentSets.filter((s) => s.id !== setId);
    res.writeHead(204).end();
    return undefined;
  }
  if (endpoint === 'items' && req.method === 'PUT') {
    return withBody((body) => {
      const kind = body['kind'] as AgentItem['kind'];
      const name = String(body['name'] ?? '').toLowerCase();
      const content = String(body['content'] ?? '');
      set.items = [
        ...set.items.filter((i) => !(i.kind === kind && i.name === name)),
        { kind, name, content, updatedAt: Date.now() },
      ].sort((a, b) => b.kind.localeCompare(a.kind) || a.name.localeCompare(b.name));
      return json(res, 200, summarize(set));
    });
  }
  if (endpoint === 'items' && req.method === 'DELETE') {
    const query = new URL(req.url ?? '', 'http://stub').searchParams;
    set.items = set.items.filter(
      (i) => !(i.kind === query.get('kind') && i.name === query.get('name')),
    );
    return json(res, 200, summarize(set));
  }
  if (endpoint === 'preview' && req.method === 'GET') {
    const global = state.agentSets.find((s) => s.global);
    const byKey = new Map<string, AgentItem>();
    for (const item of global?.items ?? []) byKey.set(`${item.kind}/${item.name}`, item);
    const overrides: Array<{ kind: AgentItem['kind']; name: string }> = [];
    if (!set.global) {
      for (const item of set.items) {
        const key = `${item.kind}/${item.name}`;
        if (byKey.has(key)) overrides.push({ kind: item.kind, name: item.name });
        byKey.set(key, item);
      }
    }
    return json(res, 200, {
      agentsMd: [global?.agentsMd ?? '', set.global ? '' : set.agentsMd]
        .map((p) => p.trim())
        .filter((p) => p !== '')
        .join('\n\n'),
      items: [...byKey.values()],
      overrides,
    });
  }
  return json(res, 404, { error: 'Not found' });
}
