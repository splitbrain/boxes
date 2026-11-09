import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import { afterEach, beforeEach, test } from 'vitest';
import { buildApp, type Orchestrator } from './app.ts';
import { config, loadConfig } from './config.ts';
import { type Db, openDb, upsertHarnessCatalog } from './db.ts';
import * as dk from './docker.ts';
import { fakeOAuth } from './fake-oauth.ts';
import { setFileServiceSpawnerForTests } from './files.ts';
import { inProcessFileService } from './files-in-process.ts';
import type { LoginExecSpec } from './login.ts';
import type { OAuthFetch } from './mcp-oauth.ts';
import { runtime } from './runtime/runtime.ts';
import * as ws from './workspaces.ts';

/**
 * Makes one stdout frame of a multiplexed Docker stream.
 *
 * @param text The payload of the frame.
 * @returns The frame with its header.
 */
function frame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** The output of `ps` in the fake box, for the stop route that reads it. Each test resets it. */
let insideBox = '';

/** The arguments of each `kill` that the routes ran in a box. */
let killedInBox: string[][] = [];

/** Installs a fake Docker client that answers each call of the routes. */
function fakeDocker(): void {
  const modem = new Docker({ socketPath: '/var/run/docker.sock' }).modem;

  dk.setDockerForTests({
    modem,
    // A box start connects the egress proxy to the network of the box again.
    getNetwork: () => ({
      inspect: async () => ({ Containers: {} }),
      connect: async () => undefined,
    }),
    getContainer: () => ({
      start: async () => undefined,
      stop: async () => undefined,
      inspect: async () => ({ State: { Running: true } }),
      exec: async (opts: { Cmd: string[] }) => {
        // Every short command runs under `timeout`.
        const cmd = opts.Cmd[0] === 'timeout' ? opts.Cmd.slice(3) : opts.Cmd;
        const command = cmd[0];
        // The stop route for the whole box runs `ps` in the container, then `kill`
        // on the processes that `ps` found.
        if (command === 'kill') killedInBox.push(cmd.slice(1));
        const answers = command === 'ps' ? insideBox : null;
        return {
          start: async () => {
            const stream = new PassThrough();
            queueMicrotask(() => {
              // The repository probe is `test -d`, which has no output.
              if (answers === null) return stream.end();
              stream.write(frame(answers));
              stream.end();
            });
            return stream;
          },
          inspect: async () => ({
            // `ps`, `kill` and `boxes-setup` succeed. Each other command fails.
            ExitCode: answers === null && command !== 'kill' && command !== 'boxes-setup' ? 1 : 0,
          }),
        };
      },
    }),
  } as unknown as Docker);
}

/** The temporary directory of each test. */
let dir: string;
/** The database of each test. */
let db: Db;
/** The app and the objects behind it, built for each test. */
let orchestrator: Orchestrator;

/**
 * Inserts a running box row with one thread.
 *
 * @param id The id of the box. The thread gets the id `<id>-t1`.
 * @param owner The owner of the box.
 */
function insertBox(id: string, owner = ''): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO boxes (id, name, owner, profile, status, ws_token, created_at, last_active_at)
     VALUES (?, 'test', ?, 'DEFAULT', 'running', ?, ?, ?)`,
  ).run(id, owner, `token-${id}`, now, now);
  insertThread(id, `${id}-t1`, 1);
}

/**
 * Inserts one thread of a box.
 *
 * @param boxId The id of the box.
 * @param threadId The id of the thread.
 * @param ordinal The position of the thread in the box.
 */
function insertThread(boxId: string, threadId: string, ordinal: number): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO threads (id, box_id, acp_session_id, title, ordinal,
       created_at, last_active_at)
     VALUES (?, ?, NULL, NULL, ?, ?, ?)`,
  ).run(threadId, boxId, ordinal, now, now);
}

beforeEach(async () => {
  insideBox = '';
  killedInBox = [];
  dir = mkdtempSync(join(tmpdir(), 'boxes-app-'));
  // config() reads DATA_DIR once and keeps it for the process, so this line comes first.
  process.env.DATA_DIR = dir;
  db = openDb(dir);
  orchestrator = buildApp(config(), db);
  // The setup of a box writes the CA of the egress proxy into the home.
  await orchestrator.egress.prepare();
  // The file service serves the directories of the box abc123 for each box, so the
  // tests that reach files use the box abc123.
  const data = orchestrator.cfg.DATA_DIR;
  setFileServiceSpawnerForTests(
    inProcessFileService(() => ({
      workspace: ws.workspacePath(data, 'abc123'),
      home: ws.homePath(data, 'abc123'),
      nix: ws.nixPath(data, 'abc123'),
      tmp: ws.workspacePath(data, 'abc123'),
    })),
  );
});

afterEach(async () => {
  // Workspaces and homes are under the DATA_DIR of the config, which can differ
  // from the directory of this test.
  rmSync(ws.workspacesRoot(orchestrator.cfg.DATA_DIR), { recursive: true, force: true });
  rmSync(ws.homesRoot(orchestrator.cfg.DATA_DIR), { recursive: true, force: true });
  await orchestrator.app.close();
  db.close();
  dk.setDockerForTests(null);
  setFileServiceSpawnerForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Inserts a box with its directories on disk, for an attachment or a start,
 * and returns the workspace path. The orchestrator reaches the file service
 * through a started container, so the function also installs the fake Docker.
 *
 * @param id The id of the box.
 * @returns The path of the workspace on the host.
 */
function insertWorkspaceBox(id: string): string {
  insertBox(id);
  fakeDocker();
  // config() is memoised for the process, so the DATA_DIR of the app comes from
  // the first test of the file. It can differ from `dir` of this test, so each
  // disk access uses the DATA_DIR of the app.
  const workspace = ws.createWorkspace(orchestrator.cfg.DATA_DIR, id);
  ws.createHome(orchestrator.cfg.DATA_DIR, id);
  ws.createNix(orchestrator.cfg.DATA_DIR, id);
  return workspace;
}

test('an attachment is stored in the workspace and its path reported back', async () => {
  const workspace = insertWorkspaceBox('abc123');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments?name=shot.png',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('PNGDATA'),
  });

  assert.equal(res.statusCode, 200);
  const stored = res.json() as { name: string; path: string; size: number };
  assert.deepEqual(stored, { name: 'shot.png', path: '.boxes/attachments/shot.png', size: 7 });
  assert.equal(readFileSync(join(workspace, stored.path), 'utf8'), 'PNGDATA');
});

/**
 * Lists boxes until the box reports a size, or gives up after 100 tries.
 * The list never waits for a disk walk, so a test that wants a size asks again.
 *
 * @param id The id of the box.
 * @returns The size in bytes, or null after the last try.
 */
async function measuredSize(id: string): Promise<number | null> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const res = await orchestrator.app.inject({ url: '/api/boxes' });
    const listed = res.json() as Array<{ id: string; diskBytes: number | null }>;
    const size = listed.find((s) => s.id === id)?.diskBytes ?? null;
    if (size !== null) return size;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

test('a running box is measured off the request path and reported on the list', async () => {
  const workspace = insertWorkspaceBox('abc123');
  writeFileSync(join(workspace, 'checkout.bin'), Buffer.alloc(4096));
  // The size includes the home.
  writeFileSync(
    join(ws.homePath(orchestrator.cfg.DATA_DIR, 'abc123'), 'cache.bin'),
    Buffer.alloc(2048),
  );

  // The first list does not wait for the walk that it starts, and answers without a size.
  const first = await orchestrator.app.inject({ url: '/api/boxes' });
  assert.equal((first.json() as Array<{ diskBytes: number | null }>)[0]!.diskBytes, null);

  assert.equal(await measuredSize('abc123'), 4096 + 2048);
});

test('a stop measures the box first, and the list keeps that value with its time', async () => {
  const workspace = insertWorkspaceBox('abc123');
  writeFileSync(join(workspace, 'checkout.bin'), Buffer.alloc(4096));

  const before = Date.now();
  const res = await orchestrator.app.inject({ method: 'POST', url: '/api/boxes/abc123/stop' });
  assert.equal(res.statusCode, 200);

  const row = db
    .prepare('SELECT disk_bytes, disk_measured_at FROM boxes WHERE id = ?')
    .get('abc123') as { disk_bytes: number | null; disk_measured_at: number | null };
  assert.equal(row.disk_bytes, 4096);
  assert.ok((row.disk_measured_at ?? 0) >= before);
  const listed = res.json() as { diskBytes: number | null; diskMeasuredAt: number | null };
  assert.equal(listed.diskBytes, 4096);
  assert.equal(listed.diskMeasuredAt, row.disk_measured_at);
});

test('an attachment name that is a path is reduced to a name', async () => {
  const workspace = insertWorkspaceBox('abc123');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: `/api/boxes/abc123/attachments?name=${encodeURIComponent('../../escape.txt')}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('x'),
  });

  assert.equal((res.json() as { path: string }).path, '.boxes/attachments/escape.txt');
  assert.ok(existsSync(join(workspace, '.boxes/attachments/escape.txt')));
});

test('an attachment upload without a name or a body is refused', async () => {
  insertWorkspaceBox('abc123');
  const headers = { 'content-type': 'application/octet-stream' };

  const nameless = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments',
    headers,
    payload: Buffer.from('x'),
  });
  assert.equal(nameless.statusCode, 400);

  const empty = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments?name=a.txt',
    headers,
    payload: Buffer.alloc(0),
  });
  assert.equal(empty.statusCode, 400);
});

test('an attachment over the size limit is refused, and says so', async () => {
  insertWorkspaceBox('abc123');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments?name=big.bin',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.alloc(config().MAX_ATTACHMENT_MB * 1024 * 1024 + 1),
  });

  // The error handler keeps the status of the refusal from Fastify and does not
  // change it to a 500, because the user can act on the size.
  assert.equal(res.statusCode, 413);
});

test('a stored image is served back as itself, for the thread to show', async () => {
  insertWorkspaceBox('abc123');
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments?name=shot.png',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('PNGDATA'),
  });

  const res = await orchestrator.app.inject({
    url: '/api/boxes/abc123/files/raw?path=/workspace/.boxes/attachments/shot.png',
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.match(res.headers['content-disposition'] as string, /^inline/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  // The agent can change the file, so a later view must load it again.
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body, 'PNGDATA');
});

test('an SVG is served as one, inert, so a diagram can be looked at', async () => {
  insertWorkspaceBox('abc123');
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments?name=diagram.svg',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('<svg onload="alert(1)"></svg>'),
  });

  const res = await orchestrator.app.inject({
    url: '/api/boxes/abc123/files/raw?path=/workspace/.boxes/attachments/diagram.svg',
  });

  assert.equal(res.headers['content-type'], 'image/svg+xml');
  assert.match(res.headers['content-disposition'] as string, /^inline/);
  // The policy makes the inline disposition safe. An SVG opened as a document has
  // no script, no origin and no network access.
  assert.equal(res.headers['content-security-policy'], "default-src 'none'; sandbox");
});

test('a PDF is served as one, unsandboxed, so a tab can show it', async () => {
  insertWorkspaceBox('abc123');
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments?name=report.pdf',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('%PDF-1.4'),
  });

  const res = await orchestrator.app.inject({
    url: '/api/boxes/abc123/files/raw?path=/workspace/.boxes/attachments/report.pdf',
  });

  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'] as string, /^inline/);
  // The policy has no `sandbox`, because a browser can refuse to give a sandboxed
  // document to its PDF viewer and offer a download.
  assert.equal(res.headers['content-security-policy'], "default-src 'none'; media-src 'self'");
});

test('a video is served as one, unsandboxed, so the player can load it', async () => {
  insertWorkspaceBox('abc123');
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments?name=clip.mp4',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('x'),
  });

  const res = await orchestrator.app.inject({
    url: '/api/boxes/abc123/files/raw?path=/workspace/.boxes/attachments/clip.mp4',
  });

  assert.equal(res.headers['content-type'], 'video/mp4');
  assert.match(res.headers['content-disposition'] as string, /^inline/);
  // A sandboxed document has no origin, so the player that the browser makes for
  // the file could not load it.
  assert.equal(res.headers['content-security-policy'], "default-src 'none'; media-src 'self'");
});

test('a format nothing renders is served as a download of unknown type', async () => {
  insertWorkspaceBox('abc123');
  // HTML served with its own type runs as this origin, and no policy makes it
  // safe to show.
  for (const name of ['page.html', 'notes.txt', 'data.bin']) {
    await orchestrator.app.inject({
      method: 'POST',
      url: `/api/boxes/abc123/attachments?name=${name}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });

    const res = await orchestrator.app.inject({
      url: `/api/boxes/abc123/files/raw?path=/workspace/.boxes/attachments/${name}`,
    });
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.match(res.headers['content-disposition'] as string, /^attachment/);
    assert.equal(res.headers['content-security-policy'], "default-src 'none'; sandbox");
  }
});

test('a format an app opens is served as a download of its own type', async () => {
  insertWorkspaceBox('abc123');
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments?name=sheet.xlsx',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('x'),
  });

  const res = await orchestrator.app.inject({
    url: '/api/boxes/abc123/files/raw?path=/workspace/.boxes/attachments/sheet.xlsx',
  });
  assert.equal(
    res.headers['content-type'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  assert.match(res.headers['content-disposition'] as string, /^attachment/);
  assert.equal(res.headers['content-security-policy'], "default-src 'none'; sandbox");
});

test('a link planted in the attachments directory serves nothing', async () => {
  const workspace = insertWorkspaceBox('abc123');
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments?name=real.png',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('x'),
  });
  // An agent can plant a link in its workspace. The file service must not follow it
  // out of the workspace.
  const secret = join(dir, 'secret.txt');
  writeFileSync(secret, 'a gateway token');
  symlinkSync(secret, join(workspace, '.boxes/attachments/escape.png'));

  const res = await orchestrator.app.inject({
    url: '/api/boxes/abc123/files/raw?path=/workspace/.boxes/attachments/escape.png',
  });
  assert.equal(res.statusCode, 404);
});

test('a workspace file outside the attachments is served too', async () => {
  const workspace = insertWorkspaceBox('abc123');
  mkdirSync(join(workspace, 'docs'));
  writeFileSync(join(workspace, 'docs/chart.png'), 'PNGDATA');

  const res = await orchestrator.app.inject({
    url: `/api/boxes/abc123/files/raw?path=${encodeURIComponent('/workspace/docs/chart.png')}`,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.body, 'PNGDATA');
});

test('a path that is not a served file is a 404, however it is spelled', async () => {
  const workspace = insertWorkspaceBox('abc123');
  mkdirSync(join(workspace, 'sub'));
  for (const path of [
    '/workspace/../../../etc/passwd',
    '/etc/passwd',
    '/workspace/sub',
    '/workspace/nope.png',
    'docs/chart.png',
  ]) {
    const res = await orchestrator.app.inject({
      url: `/api/boxes/abc123/files/raw?path=${encodeURIComponent(path)}`,
    });
    assert.equal(res.statusCode, 404, path);
  }
});

test('a file request without a path is a 400', async () => {
  insertWorkspaceBox('abc123');
  const res = await orchestrator.app.inject({ url: '/api/boxes/abc123/files/raw' });
  assert.equal(res.statusCode, 400);
});

/**
 * Writes a minimal bundle at the path where the static handler looks, with
 * the layout of the dashboard build in the runtime image.
 *
 * @returns The path of the bundle directory.
 */
function writeBundle(): string {
  // The handler resolves the bundle relative to its own module, which is
  // src/ in a checkout and dist/ in the image. Both sit one level under the
  // package root, so the fixture goes where each of them would find it.
  const bundle = resolve(import.meta.dirname, '../dashboard');
  mkdirSync(join(bundle, 'assets'), { recursive: true });
  writeFileSync(
    join(bundle, 'index.html'),
    '<!doctype html><html><body><div id="app"></div></body></html>',
  );
  writeFileSync(join(bundle, 'assets', 'index-abc.js'), 'console.log(1)');
  writeFileSync(join(bundle, 'assets', 'index-abc.css'), 'body{}');
  // Vite copies public/ to the bundle root, where these two must stay.
  writeFileSync(join(bundle, 'sw.js'), 'self.addEventListener("push", () => {})');
  writeFileSync(join(bundle, 'manifest.webmanifest'), '{"name":"Boxes"}');
  return bundle;
}

test('the dashboard bundle is served, with a single-page fallback', async () => {
  const bundle = writeBundle();
  try {
    // A real file comes back with its content type.
    const js = await orchestrator.app.inject({ url: '/assets/index-abc.js' });
    assert.equal(js.statusCode, 200);
    assert.match(js.headers['content-type'] as string, /text\/javascript/);

    const css = await orchestrator.app.inject({ url: '/assets/index-abc.css' });
    assert.match(css.headers['content-type'] as string, /text\/css/);

    // A client-side route is not a file, and must work after a reload.
    for (const url of ['/', '/new', '/boxes/abc123', '/boxes/abc123/info']) {
      const res = await orchestrator.app.inject({ url });
      assert.equal(res.statusCode, 200, url);
      assert.match(res.headers['content-type'] as string, /text\/html/, url);
      assert.match(res.body, /id="app"/, url);
    }

    // The API and the gateway do not get the fallback, so a wrong endpoint is a
    // 404 and not a page.
    for (const url of ['/api/nope', '/ws/nope']) {
      const res = await orchestrator.app.inject({ url });
      assert.equal(res.statusCode, 404, url);
    }

    // A traversal cannot reach a file outside the bundle.
    for (const url of ['/../package.json', '/assets/../../package.json']) {
      const res = await orchestrator.app.inject({ url });
      assert.match(res.headers['content-type'] as string, /text\/html/, url);
    }
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
});

test('the service worker and the manifest are served from the bundle root', async () => {
  const bundle = writeBundle();
  try {
    // A service worker controls only the scope it is served from, so it must
    // be /sw.js. If the fallback answered here, push would break without an error.
    const sw = await orchestrator.app.inject({ url: '/sw.js' });
    assert.equal(sw.statusCode, 200);
    assert.match(sw.headers['content-type'] as string, /text\/javascript/);
    assert.match(sw.body, /addEventListener\("push"/);

    // An iPhone needs the manifest to install the page, and only an installed
    // page has the Push API.
    const manifest = await orchestrator.app.inject({ url: '/manifest.webmanifest' });
    assert.equal(manifest.statusCode, 200);
    assert.match(manifest.headers['content-type'] as string, /application\/manifest\+json/);
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
});

test('a POST that matches no route is a 404 rather than the page', async () => {
  const bundle = writeBundle();
  try {
    const res = await orchestrator.app.inject({ method: 'POST', url: '/nope' });
    assert.equal(res.statusCode, 404);
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
});

test('the hashed assets are cached for good and the page never is', async () => {
  const bundle = writeBundle();
  try {
    // The name has the content hash, so a changed file has a changed name, and
    // a cached copy is always correct.
    const asset = await orchestrator.app.inject({ url: '/assets/index-abc.js' });
    assert.match(asset.headers['cache-control'] as string, /immutable/);

    // index.html names the current assets, so a cached copy would continue to
    // name the old assets.
    const page = await orchestrator.app.inject({ url: '/boxes/abc123' });
    assert.equal(page.headers['cache-control'], 'no-cache');
    // The same rule applies to each other file that keeps its name across builds.
    const worker = await orchestrator.app.inject({ url: '/sw.js' });
    assert.equal(worker.headers['cache-control'], 'no-cache');
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
});

test('the page is served under a policy that pins every fetch to this origin', async () => {
  const bundle = writeBundle();
  try {
    const res = await orchestrator.app.inject({
      url: '/',
      headers: { host: 'boxes.example:8443' },
    });
    const csp = res.headers['content-security-policy'] as string;

    // The policy blocks a remote image in the markdown of the agent.
    assert.match(csp, /img-src 'self' data: blob:/);
    assert.match(csp, /default-src 'none'/);
    // The policy names the gateway socket on this host only.
    assert.match(csp, /connect-src 'self' ws:\/\/boxes\.example:8443 wss:\/\/boxes\.example:8443/);
    // The policy allows the one inline script of the page by its hash.
    assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);

    // A Host header that is not a plain host does not get into the policy.
    const odd = await orchestrator.app.inject({
      url: '/',
      headers: { host: 'evil; script-src *' },
    });
    const oddCsp = odd.headers['content-security-policy'] as string;
    assert.ok(!oddCsp.includes('script-src *'), 'the header is not writable from outside');
    assert.match(oddCsp, /connect-src 'self';/);
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
});

test('a bundle worth compressing is compressed', async () => {
  const bundle = writeBundle();
  try {
    writeFileSync(join(bundle, 'assets', 'big-abc.js'), `// ${'x'.repeat(20_000)}\n`);
    const res = await orchestrator.app.inject({
      url: '/assets/big-abc.js',
      headers: { 'accept-encoding': 'gzip' },
    });
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.ok(res.rawPayload.length < 2000, `${res.rawPayload.length} bytes on the wire`);
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
});

test('a deployment that cannot serve boxes is live but not ready', async () => {
  // This test pushes no egress policy, so a box created now would get no egress.
  const ready = await orchestrator.app.inject({ url: '/readyz' });
  assert.equal(ready.statusCode, 503);
  const body = ready.json() as { ready: boolean; checks: Record<string, boolean> };
  assert.equal(body.ready, false);
  // Of the three checks, only the database passes here.
  assert.equal(body.checks.database, true);
  assert.equal(body.checks.egress, false);

  // The liveness probe passes, because a probe must not restart an orchestrator
  // that only lacks configuration.
  const live = await orchestrator.app.inject({ url: '/healthz' });
  assert.equal(live.statusCode, 200);
});

test('every response is logged with what was asked and what came back', async () => {
  const lines: string[] = [];
  const written = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await orchestrator.app.inject({ url: '/api/boxes?name=secret' });
    await orchestrator.app.inject({ url: '/api/boxes/nope' });
  } finally {
    process.stderr.write = written;
  }

  const logged = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.msg === 'request');

  const ok = logged.find((line) => line.status === 200);
  assert.equal(ok?.method, 'GET');
  // The log leaves out the query string, because it holds what the user typed.
  assert.equal(ok?.path, '/api/boxes');
  assert.equal(typeof ok?.ms, 'number');

  // A refusal is a problem of the caller and not of the deployment, so the log
  // level is a warning.
  const refused = logged.find((line) => line.status === 404);
  assert.equal(refused?.level, 'warn');
});

/**
 * Makes a subscription in the form that toJSON() of the browser makes.
 *
 * @param endpoint The push endpoint.
 * @returns The subscription.
 */
function subscription(endpoint = 'https://push.example.net/x/abc'): Record<string, unknown> {
  return {
    endpoint,
    keys: {
      // A real P-256 point decodes to 65 bytes, and an auth secret to 16 bytes.
      p256dh: Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString('base64url'),
      auth: Buffer.alloc(16, 9).toString('base64url'),
    },
  };
}

/**
 * Reads every stored subscription.
 *
 * @returns The rows of the push_subscriptions table.
 */
function subscriptions(): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM push_subscriptions').all() as Array<Record<string, unknown>>;
}

test('the VAPID public key is served and stays the same across reads', async () => {
  const first = await orchestrator.app.inject({ url: '/api/push/key' });
  const second = await orchestrator.app.inject({ url: '/api/push/key' });

  assert.equal(first.statusCode, 200);
  const key = (first.json() as { publicKey: string }).publicKey;
  // A browser accepts only an uncompressed P-256 key here.
  assert.equal(Buffer.from(key, 'base64url').length, 65);
  // A key that changed between reads would invalidate every subscription
  // made against the previous one.
  assert.equal((second.json() as { publicKey: string }).publicKey, key);
});

test('a browser registers once however many times it subscribes', async () => {
  const first = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    payload: subscription(),
  });
  assert.equal(first.statusCode, 204);

  // A new subscribe sends the same endpoint with new keys. The route must update
  // the row and not add a row.
  const rotated = subscription();
  (rotated.keys as Record<string, string>).auth = Buffer.alloc(16, 1).toString('base64url');
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    payload: rotated,
  });

  const rows = subscriptions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.auth, (rotated.keys as Record<string, string>).auth);
});

test('the health probe counts subscribed browsers', async () => {
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    payload: subscription(),
  });
  const res = await orchestrator.app.inject({ url: '/healthz' });
  assert.equal((res.json() as { pushSubscriptions: number }).pushSubscriptions, 1);
});

test('an endpoint the orchestrator must not be aimed at is refused', async () => {
  const refused = [
    'http://push.example.net/x', // not https
    'https://127.0.0.1/x', // an IP address
    'https://localhost/x',
    'https://[::1]/x',
  ];
  for (const endpoint of refused) {
    const res = await orchestrator.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: subscription(endpoint),
    });
    assert.equal(res.statusCode, 400, `${endpoint} should be refused`);
  }
  assert.equal(subscriptions().length, 0);
});

test('a subscription with keys of the wrong size is refused', async () => {
  const bad = subscription();
  (bad.keys as Record<string, string>).p256dh = Buffer.alloc(32).toString('base64url');
  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    payload: bad,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(subscriptions().length, 0);
});

test('a browser can unsubscribe itself', async () => {
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    payload: subscription(),
  });
  const res = await orchestrator.app.inject({
    method: 'DELETE',
    url: '/api/push/subscribe',
    payload: { endpoint: 'https://push.example.net/x/abc' },
  });
  assert.equal(res.statusCode, 204);
  assert.equal(subscriptions().length, 0);
});

test('a set is created, filled and read back over the API', async () => {
  const created = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/agent-sets',
    payload: { name: 'Go projects' },
  });
  assert.equal(created.statusCode, 201);
  const set = created.json() as { id: string; global: boolean };
  assert.equal(set.global, false);

  const put = await orchestrator.app.inject({
    method: 'PUT',
    url: `/api/agent-sets/${set.id}/items`,
    payload: { name: 'bench', content: 'Run the benchmarks.' },
  });
  assert.equal(put.statusCode, 200);
  // Each change answers with the whole set, so the editor needs one request.
  assert.deepEqual(
    (put.json() as { items: Array<{ name: string }> }).items.map((i) => i.name),
    ['bench'],
  );

  const listed = await orchestrator.app.inject({ url: '/api/agent-sets' });
  assert.deepEqual(
    (listed.json() as Array<{ id: string }>).map((s) => s.id),
    ['global', set.id],
  );
});

test('the preview shows the merge, overrides named', async () => {
  await orchestrator.app.inject({
    method: 'PATCH',
    url: '/api/agent-sets/global',
    payload: { agentsMd: 'House rules.' },
  });
  await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/agent-sets/global/items',
    payload: { name: 'review', content: 'global' },
  });
  const set = (
    await orchestrator.app.inject({
      method: 'POST',
      url: '/api/agent-sets',
      payload: { name: 'Go' },
    })
  ).json() as { id: string };
  await orchestrator.app.inject({
    method: 'PATCH',
    url: `/api/agent-sets/${set.id}`,
    payload: { agentsMd: 'Go rules.' },
  });
  await orchestrator.app.inject({
    method: 'PUT',
    url: `/api/agent-sets/${set.id}/items`,
    payload: { name: 'review', content: 'go' },
  });

  const preview = (
    await orchestrator.app.inject({ url: `/api/agent-sets/${set.id}/preview` })
  ).json() as {
    agentsMd: string;
    skills: Array<{ name: string; repo: string | null }>;
    overrides: string[];
  };
  assert.equal(preview.agentsMd, 'House rules.\n\nGo rules.');
  assert.deepEqual(preview.skills, [{ name: 'review', repo: null }]);
  assert.deepEqual(preview.overrides, ['review']);
});

test('an MCP server is written, refused and removed over the API', async () => {
  const server = {
    name: 'github',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'bearer',
    headers: [{ name: 'Authorization', value: 'Bearer ghp_0123456789abcdef', secret: true }],
  };

  const put = await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/agent-sets/global/mcp-servers',
    payload: server,
  });
  assert.equal(put.statusCode, 200);
  assert.deepEqual((put.json() as { mcpServers: unknown[] }).mcpServers, [
    {
      ...server,
      headers: [{ name: 'Authorization', value: '', secret: true }],
      status: null,
      lastError: null,
      upstreamCa: null,
    },
  ]);
  assert.ok(!put.body.includes('ghp_'));

  const literal = await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/agent-sets/global/mcp-servers',
    payload: {
      ...server,
      auth: 'headers',
      headers: [{ name: 'Authorization', value: 'Bearer ghp_literal' }],
    },
  });
  assert.equal(literal.statusCode, 400);
  const moved = await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/agent-sets/global/mcp-servers',
    payload: { ...server, url: 'https://api.githubcopilot.com/v2/' },
  });
  assert.equal(moved.statusCode, 400);
  assert.match(moved.body, /fixed/);

  const preview = (
    await orchestrator.app.inject({ url: '/api/agent-sets/global/preview' })
  ).json() as { mcpServers: unknown[]; mcpOverrides: string[] };
  assert.deepEqual(preview.mcpServers, [{ name: 'github', url: server.url }]);
  assert.deepEqual(preview.mcpOverrides, []);

  const removed = await orchestrator.app.inject({
    method: 'DELETE',
    url: '/api/agent-sets/global/mcp-servers?name=github',
  });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual((removed.json() as { mcpServers: unknown[] }).mcpServers, []);
});

test('the global set is refused deletion, and an unknown set is a 404', async () => {
  const global = await orchestrator.app.inject({
    method: 'DELETE',
    url: '/api/agent-sets/global',
  });
  assert.equal(global.statusCode, 400);

  const unknown = await orchestrator.app.inject({ url: '/api/agent-sets/nope' });
  assert.equal(unknown.statusCode, 404);
});

test('creating a box against an unknown set is refused before anything is built', async () => {
  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes',
    payload: { name: 'a box', agentSet: 'nope' },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /Unknown agent set/);
  // The check runs before the insert, so the table has no row.
  const rows = db.prepare('SELECT COUNT(*) AS n FROM boxes').get() as { n: number };
  assert.equal(rows.n, 0);
});

/**
 * Gives the egress profiles of the user over the API.
 *
 * @param headers The headers of the request, for a user in multi-user mode.
 * @returns The id, the name, the default flag and the box count of each profile.
 */
async function listProfiles(
  headers: Record<string, string> = {},
): Promise<Array<{ id: string; name: string; isDefault: boolean; boxCount: number }>> {
  return (await orchestrator.app.inject({ url: '/api/egress-profiles', headers })).json();
}

test('an egress profile is created, read, changed and deleted over the API', async () => {
  const created = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/egress-profiles',
    payload: { name: 'Work', hosts: ['GitHub.com', '*.npmjs.org'] },
  });
  assert.equal(created.statusCode, 201);
  const work = created.json() as { id: string; open: boolean; hosts: string[] };
  assert.equal(work.open, false);
  assert.deepEqual(work.hosts, ['github.com', '*.npmjs.org']);

  assert.deepEqual(
    (await listProfiles()).map((p) => [p.name, p.isDefault]),
    [
      ['Default', true],
      ['Work', false],
    ],
  );

  const changed = await orchestrator.app.inject({
    method: 'PATCH',
    url: `/api/egress-profiles/${work.id}`,
    payload: { open: true },
  });
  assert.equal(changed.statusCode, 200);
  const read = await orchestrator.app.inject({ url: `/api/egress-profiles/${work.id}` });
  assert.deepEqual((read.json() as { open: boolean; hosts: string[] }).hosts, [
    'github.com',
    '*.npmjs.org',
  ]);
  assert.equal((read.json() as { open: boolean }).open, true);

  const bad = await orchestrator.app.inject({
    method: 'PATCH',
    url: `/api/egress-profiles/${work.id}`,
    payload: { hosts: ['*'] },
  });
  assert.equal(bad.statusCode, 400);
  assert.match((bad.json() as { error: string }).error, /bare \*/);

  const deleted = await orchestrator.app.inject({
    method: 'DELETE',
    url: `/api/egress-profiles/${work.id}`,
  });
  assert.equal(deleted.statusCode, 204);
  const gone = await orchestrator.app.inject({ url: `/api/egress-profiles/${work.id}` });
  assert.equal(gone.statusCode, 404);

  const defaultId = (await listProfiles())[0]!.id;
  const refused = await orchestrator.app.inject({
    method: 'DELETE',
    url: `/api/egress-profiles/${defaultId}`,
  });
  assert.equal(refused.statusCode, 400);
});

test('creating a box with an unknown egress profile is refused before anything is built', async () => {
  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes',
    payload: { name: 'a box', egressProfile: 'epnope' },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /Unknown egress profile/);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM boxes').get() as { n: number };
  assert.equal(rows.n, 0);
});

test('a box changes its egress profile, and moves to the default when its profile is deleted', async () => {
  insertBox('abc123');
  fakeDocker();
  const work = (
    await orchestrator.app.inject({
      method: 'POST',
      url: '/api/egress-profiles',
      payload: { name: 'Work' },
    })
  ).json() as { id: string };
  const defaultId = (await listProfiles())[0]!.id;

  // A box without a selected profile uses the default profile.
  const before = await orchestrator.app.inject({ url: '/api/boxes/abc123' });
  assert.deepEqual(
    [before.json().egressProfileId, before.json().egressProfileName],
    [defaultId, 'Default'],
  );

  const selected = await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/boxes/abc123/egress-profile',
    payload: { egressProfile: work.id },
  });
  assert.equal(selected.statusCode, 200);
  assert.deepEqual(
    [selected.json().egressProfileId, selected.json().egressProfileName],
    [work.id, 'Work'],
  );
  assert.deepEqual(
    (await listProfiles()).map((p) => [p.name, p.boxCount]),
    [
      ['Default', 0],
      ['Work', 1],
    ],
  );

  const unknown = await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/boxes/abc123/egress-profile',
    payload: { egressProfile: 'epnope' },
  });
  assert.equal(unknown.statusCode, 400);
  const missingBox = await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/boxes/nope/egress-profile',
    payload: { egressProfile: null },
  });
  assert.equal(missingBox.statusCode, 404);

  await orchestrator.app.inject({ method: 'DELETE', url: `/api/egress-profiles/${work.id}` });
  const after = await orchestrator.app.inject({ url: '/api/boxes/abc123' });
  assert.deepEqual(
    [after.json().egressProfileId, after.json().egressProfileName],
    [defaultId, 'Default'],
  );
  assert.deepEqual(
    (await listProfiles()).map((p) => [p.name, p.boxCount]),
    [['Default', 1]],
  );
});

/** The fields of a pushed policy that the tests read. */
interface PushedPolicy {
  /** The policy of each box. */
  boxes: Array<{ box: string; open: boolean; hosts: string[] }>;
  /** The credentials, with the fields that the tests read. */
  credentials: Array<{
    id: string;
    hosts: string[];
    headers: string[];
    placeholder: string;
    secret: string;
    oauth?: boolean;
  }>;
}

/**
 * Builds the app of the test again with a fake egress proxy on its control
 * channel. The fake records each policy push and answers each denials read.
 *
 * @param denials The answer to a read of the refused hosts of a box.
 * @param refusedTokens Gives the refused OAuth tokens for the answer to a push.
 * @param mcpFetch The fetch function of the OAuth client.
 * @returns The bodies of the policy pushes and the URLs of the denials reads.
 */
async function withFakeProxy(
  denials: unknown[],
  refusedTokens: () => unknown[] = () => [],
  mcpFetch?: OAuthFetch,
): Promise<{ policies: PushedPolicy[]; reads: string[] }> {
  const policies: PushedPolicy[] = [];
  const reads: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url?.startsWith('/denials')) {
        reads.push(req.url);
        res.end(JSON.stringify(denials));
        return;
      }
      policies.push(JSON.parse(body));
      res.end(
        JSON.stringify({
          applied: true,
          policyHash: 'x',
          boxCount: 0,
          credentialIds: [],
          denials: {},
          uptimeSeconds: 1,
          refusedTokens: refusedTokens(),
        }),
      );
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  await orchestrator.app.close();
  orchestrator = buildApp(
    loadConfig({
      ...process.env,
      DATA_DIR: orchestrator.cfg.DATA_DIR,
      EGRESS_CONTROL_URL: `http://127.0.0.1:${port}`,
    }),
    db,
    { mcpFetch },
  );
  orchestrator.app.addHook('onClose', async () => {
    server.close();
  });
  await orchestrator.egress.prepare();
  return { policies, reads };
}

test('a new egress profile of a box reaches the proxy without a restart', async () => {
  insertBox('abc123');
  fakeDocker();
  const { policies } = await withFakeProxy([]);
  const work = (
    await orchestrator.app.inject({
      method: 'POST',
      url: '/api/egress-profiles',
      payload: { name: 'Work' },
    })
  ).json() as { id: string };

  await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/boxes/abc123/egress-profile',
    payload: { egressProfile: work.id },
  });

  await untilTrue('the push of the closed profile', () =>
    policies.some((p) => p.boxes.some((b) => b.box === 'abc123' && !b.open)),
  );
});

test('a removed MCP server leaves the policy, also before the next start of the box', async () => {
  insertBox('abc123');
  // The adapters still have the server from the last start of the box.
  db.prepare("UPDATE boxes SET mcp_servers = ? WHERE id = 'abc123'").run(
    JSON.stringify([
      {
        setId: 'global',
        name: 'docs',
        url: 'https://docs.example.com/mcp',
        auth: 'none',
        headers: [],
      },
    ]),
  );
  const { policies } = await withFakeProxy([]);
  const hostsOfBox = (): string[] | undefined =>
    policies.at(-1)?.boxes.find((b) => b.box === 'abc123')?.hosts;

  await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/agent-sets/global/mcp-servers',
    payload: { name: 'docs', url: 'https://docs.example.com/mcp', auth: 'none', headers: [] },
  });
  await untilTrue(
    'the push with the server',
    () => hostsOfBox()?.includes('docs.example.com:443') === true,
  );

  await orchestrator.app.inject({
    method: 'DELETE',
    url: '/api/agent-sets/global/mcp-servers?name=docs',
  });
  await untilTrue(
    'the push without the server',
    () => hostsOfBox()?.includes('docs.example.com:443') === false,
  );
});

test('an OAuth login runs through the connect and the callback routes, and its token reaches the policy', async () => {
  const fake = fakeOAuth();
  const { policies } = await withFakeProxy([], () => [], fake.fetch);
  const origin = 'https://boxes.example.com';
  await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/agent-sets/global/mcp-servers',
    payload: { name: 'docs', url: fake.mcpUrl, auth: 'oauth', headers: [] },
  });

  const noOrigin = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/agent-sets/global/mcp-servers/docs/connect',
    payload: { origin },
  });
  assert.equal(noOrigin.statusCode, 400);

  const connect = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/agent-sets/global/mcp-servers/docs/connect',
    headers: { origin },
    payload: { origin },
  });
  assert.equal(connect.statusCode, 200);
  const { authorizationUrl } = connect.json() as { authorizationUrl: string };
  const params = fake.authorize(authorizationUrl);

  const callback = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/mcp-oauth/callback',
    payload: { state: params.get('state'), code: params.get('code'), iss: params.get('iss') },
  });
  assert.equal(callback.statusCode, 200);
  const setId = orchestrator.agents.globalId('');
  assert.deepEqual(callback.json(), { setId });

  const set = (await orchestrator.app.inject({ url: '/api/agent-sets/global' })).json() as {
    mcpServers: Array<{ status: string | null }>;
  };
  assert.equal(set.mcpServers[0]?.status, 'ok');
  assert.ok(!JSON.stringify(set).includes('at-3'));

  const id = `mcp/${setId}/docs/authorization`;
  await untilTrue('the push with the token', () =>
    (policies.at(-1)?.credentials ?? []).some((c) => c.id === id),
  );
  const credential = policies.at(-1)?.credentials.find((c) => c.id === id);
  assert.deepEqual(
    [credential?.hosts, credential?.headers, credential?.secret, credential?.oauth],
    [['mcp.example.com:443'], ['authorization'], 'Bearer at-3', true],
  );

  const replay = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/mcp-oauth/callback',
    payload: { state: params.get('state'), code: params.get('code'), iss: params.get('iss') },
  });
  assert.equal(replay.statusCode, 400);
});

test('a token that the proxy reports as refused gets a refresh', async () => {
  const fake = fakeOAuth();
  let reports: unknown[] = [];
  await withFakeProxy(
    [],
    () => {
      const taken = reports;
      reports = [];
      return taken;
    },
    fake.fetch,
  );
  const origin = 'https://boxes.example.com';
  await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/agent-sets/global/mcp-servers',
    payload: { name: 'docs', url: fake.mcpUrl, auth: 'oauth', headers: [] },
  });
  const connect = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/agent-sets/global/mcp-servers/docs/connect',
    headers: { origin },
    payload: { origin },
  });
  const params = fake.authorize((connect.json() as { authorizationUrl: string }).authorizationUrl);
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/mcp-oauth/callback',
    payload: { state: params.get('state'), code: params.get('code'), iss: params.get('iss') },
  });
  // The token is older than the minimum age for a refresh after a refused token.
  db.prepare('UPDATE agent_mcp_secrets SET refreshed_at = 0').run();

  const setId = orchestrator.agents.globalId('');
  reports = [
    {
      credentialId: `mcp/${setId}/docs/authorization`,
      status: 401,
      error: 'invalid_token',
      scope: null,
    },
  ];
  await orchestrator.egress.sync();
  /**
   * Reads the stored secret of the server.
   *
   * @returns The secret.
   */
  const secret = (): string =>
    (db.prepare('SELECT secret FROM agent_mcp_secrets').get() as { secret: string }).secret;
  await untilTrue('the refresh', () => secret() === 'Bearer at-4');
});

test('the refused hosts of a box come from the proxy', async () => {
  insertBox('abc123');
  const denial = {
    host: 'evil.example.com',
    port: 443,
    category: 'allowlist',
    count: 2,
    lastAt: 1,
  };
  const { reads } = await withFakeProxy([denial]);

  const res = await orchestrator.app.inject({ url: '/api/boxes/abc123/denials' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), [denial]);
  assert.deepEqual(reads, ['/denials?box=abc123']);

  const missing = await orchestrator.app.inject({ url: '/api/boxes/nope/denials' });
  assert.equal(missing.statusCode, 404);
});

test('the refused hosts of a box are a 502 when the proxy does not answer', async () => {
  insertBox('abc123');
  await orchestrator.app.close();
  orchestrator = buildApp(
    loadConfig({
      ...process.env,
      DATA_DIR: orchestrator.cfg.DATA_DIR,
      EGRESS_CONTROL_URL: 'http://127.0.0.1:1',
    }),
    db,
  );

  const res = await orchestrator.app.inject({ url: '/api/boxes/abc123/denials' });
  assert.equal(res.statusCode, 502);
  assert.match((res.json() as { error: string }).error, /did not answer/);
});

test('starting a container to reach into installs the current configuration first', async () => {
  // A thread or a terminal starts a stopped box without /start. The file service
  // installs the configuration of that time.
  insertWorkspaceBox('abc123');
  fakeDocker();
  await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/agent-sets/global/items',
    payload: { name: 'ship', content: 'Open a PR.' },
  });

  await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/agent-sets/global/mcp-servers',
    payload: { name: 'docs', url: 'https://docs.example.com/mcp', auth: 'none', headers: [] },
  });

  await orchestrator.manager.execTarget('abc123');

  // The adapters read the MCP servers that the box got at this start.
  assert.deepEqual(
    JSON.parse(
      (
        db.prepare("SELECT mcp_servers FROM boxes WHERE id = 'abc123'").get() as {
          mcp_servers: string;
        }
      ).mcp_servers,
    ),
    [
      {
        setId: orchestrator.agents.globalId(''),
        name: 'docs',
        url: 'https://docs.example.com/mcp',
        auth: 'none',
        headers: [],
      },
    ],
  );

  // config() is cached for the process, so the test uses the DATA_DIR of the
  // orchestrator and not `dir` of this test.
  assert.equal(
    readFileSync(
      join(
        ws.homePath(orchestrator.cfg.DATA_DIR, 'abc123'),
        '.claude',
        'skills',
        'ship',
        'SKILL.md',
      ),
      'utf8',
    ),
    'Open a PR.\n',
  );
});

test('stopping background work names a thread, and 404s for one that is not there', async () => {
  insertBox('abc123');

  const missing = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/threads/nope/background/stop',
    payload: {},
  });
  assert.equal(missing.statusCode, 404);

  // This thread has no session id in the adapter, so it has no task. The route
  // answers without a call to Docker.
  const now = Date.now();
  db.prepare(
    `INSERT INTO threads (id, box_id, acp_session_id, title, ordinal,
       created_at, last_active_at)
     VALUES ('t1', 'abc123', NULL, NULL, 1, ?, ?)`,
  ).run(now, now);

  const unminted = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/threads/t1/background/stop',
    payload: { processId: 'task-1' },
  });
  assert.equal(unminted.statusCode, 200);
  assert.deepEqual(unminted.json(), { stopped: 0 });
});

test('stopping everything in a box signals the work and nothing of Boxes own', async () => {
  // The stop for the whole box is for work that no thread can name. After an
  // adapter restart, the task bars are empty, but a build can still run in the box.
  insertBox('abc123');
  fakeDocker();
  insideBox = [
    '  PID  PPID ELAPSED COMMAND',
    '    1     0      60 /sbin/docker-init -- /usr/local/bin/entrypoint.sh',
    '    7     1      60 sleep infinity',
    '   12     1      60 node /usr/local/bin/claude-agent-acp',
    '   13    12      60 claude --output-format stream-json --session-id=acp-1',
    "   14    13      60 /bin/bash -c eval 'npm run build'",
    '   20     1      60 node /usr/local/bin/codex-acp',
    '   21    20      60 codex app-server',
    '   22    21      60 bash -lc npm run watch',
    '   30     1      60 ps -eo pid,ppid,etimes,args',
  ].join('\n');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/background/stop',
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { stopped: 2 });
  // Only the two shells get the signal. The adapters, the agents, the entrypoint
  // processes and the `ps` do not.
  assert.deepEqual(killedInBox, [['-TERM', '14', '22']]);
});

test('stopping everything in a box that is not there is a 404', async () => {
  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/nope/background/stop',
    payload: {},
  });
  assert.equal(res.statusCode, 404);
});

test('marking a thread done is remembered, reversible, and 404s for a thread that is not there', async () => {
  insertBox('abc123');
  const before = db.prepare("SELECT last_active_at FROM threads WHERE id = 'abc123-t1'").get() as {
    last_active_at: number;
  };

  const missing = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/threads/nope/done',
    payload: { done: true },
  });
  assert.equal(missing.statusCode, 404);

  // The body must hold a boolean, so an empty body cannot remove the mark.
  const empty = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/threads/abc123-t1/done',
    payload: {},
  });
  assert.equal(empty.statusCode, 400);

  const marked = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/threads/abc123-t1/done',
    payload: { done: true },
  });
  assert.equal(marked.statusCode, 200);
  assert.equal((marked.json() as { done: boolean }).done, true);

  // The dashboard reads the mark from the list route.
  const threads = await orchestrator.app.inject({
    method: 'GET',
    url: '/api/boxes/abc123/threads',
  });
  assert.deepEqual(
    (threads.json() as Array<{ id: string; done: boolean }>).map((t) => [t.id, t.done]),
    [['abc123-t1', true]],
  );

  // The same route removes the mark.
  const unmarked = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/threads/abc123-t1/done',
    payload: { done: false },
  });
  assert.equal((unmarked.json() as { done: boolean }).done, false);

  // The activity time stays the same, because the mark is not activity in the
  // thread.
  const after = db.prepare("SELECT last_active_at FROM threads WHERE id = 'abc123-t1'").get() as {
    last_active_at: number;
  };
  assert.equal(after.last_active_at, before.last_active_at);
});

test('a listed box carries its own WebSocket token', async () => {
  insertBox('abc123');
  insertBox('def456');

  const res = await orchestrator.app.inject({ url: '/api/boxes' });
  const listed = res.json() as Array<{ id: string; wsToken: string }>;

  // Each summary has only the token of its own box, so a reader of one box cannot
  // get the token of another box.
  assert.deepEqual(listed.map((s) => [s.id, s.wsToken]).sort(), [
    ['abc123', 'token-abc123'],
    ['def456', 'token-def456'],
  ]);
});

test('a body missing a required field is refused, and the answer names it', async () => {
  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes',
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /^name: /);
});

test('a field of the wrong type is refused rather than read as one', async () => {
  insertBox('abc123');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/threads/abc123-t1/done',
    payload: { done: 'yes' },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /^done: /);

  // Nothing was written before the refusal.
  const row = db.prepare("SELECT done FROM threads WHERE id = 'abc123-t1'").get() as {
    done: number;
  };
  assert.equal(row.done, 0);
});

test('a body that leaves out an optional field is taken as it is', async () => {
  await orchestrator.app.inject({
    method: 'PATCH',
    url: '/api/agent-sets/global',
    payload: { name: 'Everywhere', agentsMd: 'House rules.' },
  });

  // An empty body names no field, so each field keeps its value.
  const res = await orchestrator.app.inject({
    method: 'PATCH',
    url: '/api/agent-sets/global',
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  const set = res.json() as { name: string; agentsMd: string };
  assert.equal(set.name, 'Everywhere');
  assert.equal(set.agentsMd, 'House rules.');
});

test('a pasted credential is stored, shown by its last four, and never read back', async () => {
  const put = await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/credentials/claude',
    payload: { method: 'token', secret: 'sk-ant-oat01-abcdefgh1234' },
  });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json(), {
    id: 'claude',
    method: 'token',
    account: '1234',
    status: 'ok',
    lastError: null,
    expiresAt: null,
    refreshedAt: null,
    updatedAt: (put.json() as { updatedAt: number }).updatedAt,
  });

  const list = await orchestrator.app.inject({ url: '/api/credentials' });
  // The secret is in the database and in the proxy, but in no answer of the API.
  assert.ok(!list.payload.includes('sk-ant-oat01-abcdefgh1234'));
  assert.deepEqual(
    (list.json() as Array<{ id: string }>).map((c) => c.id),
    ['claude'],
  );

  const removed = await orchestrator.app.inject({
    method: 'DELETE',
    url: '/api/credentials/claude',
  });
  assert.equal(removed.statusCode, 204);
  assert.deepEqual((await orchestrator.app.inject({ url: '/api/credentials' })).json(), []);
});

test('a credential nobody can use is refused rather than stored', async () => {
  const unknown = await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/credentials/bitbucket',
    payload: { method: 'token', secret: 'x' },
  });
  assert.equal(unknown.statusCode, 400);

  const method = await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/credentials/claude',
    payload: { method: 'magic', secret: 'x' },
  });
  assert.equal(method.statusCode, 400);

  const empty = await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/credentials/claude',
    payload: { method: 'token', secret: '   ' },
  });
  assert.equal(empty.statusCode, 400);

  assert.deepEqual((await orchestrator.app.inject({ url: '/api/credentials' })).json(), []);
});

/**
 * Installs a fake login runtime and returns the commands that it ran and the
 * containers that it removed. The container and the exec are fakes, so the
 * tests check only the routes that the settings page calls.
 *
 * @returns The record of each command that the fake ran, and the list of removed containers.
 */
function fakeLogins(): {
  execs: Array<{ spec: LoginExecSpec; output: PassThrough; input: string }>;
  removed: string[];
} {
  const execs: Array<{ spec: LoginExecSpec; output: PassThrough; input: string }> = [];
  const removed: string[] = [];
  // The rest of the runtime stays as buildApp set it.
  runtime().startLogin = async () => ({
    spawn: async (cmd, opts = {}) => {
      const spec: LoginExecSpec = { cmd, ...(opts.tty ? { tty: true } : {}) };
      const output = new PassThrough();
      const record = { spec, output, input: '' };
      execs.push(record);
      const stdin = new PassThrough();
      stdin.on('data', (chunk: Buffer) => {
        record.input += chunk.toString('utf8');
      });
      return {
        stdout: output,
        stderr: new PassThrough().end() as PassThrough,
        stdin,
        exited: new Promise<number | null>(() => {}),
        resize: async () => undefined,
        kill: () => output.destroy(),
      };
    },
    remove: async () => {
      removed.push('login-container');
    },
  });
  return { execs, removed };
}

/**
 * Waits until `ready` returns true, or fails the test after a timeout.
 *
 * @param what The awaited event, for the failure message.
 * @param ready The check to repeat.
 */
async function untilTrue(what: string, ready: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('a login is started, polled, and cancelled over its own routes', async () => {
  const fake = fakeLogins();

  const started = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/credentials/openai/login',
  });
  assert.equal(started.statusCode, 200);
  const { loginId } = started.json() as { loginId: string };
  assert.ok(loginId);

  const first = await orchestrator.app.inject({
    url: `/api/credentials/openai/login/${loginId}`,
  });
  assert.deepEqual(first.json(), { state: 'starting' });

  await untilTrue('the CLI to be running', () => fake.execs.length === 1);
  fake.execs[0]!.output.write('Open https://auth.openai.com/codex/device and enter WXYZ-1234\n');

  let state = { state: 'starting' } as Record<string, unknown>;
  await untilTrue('the poll to move', async () => {
    const res = await orchestrator.app.inject({
      url: `/api/credentials/openai/login/${loginId}`,
    });
    state = res.json() as Record<string, unknown>;
    return state.state === 'awaiting_browser';
  });
  assert.deepEqual(state, {
    state: 'awaiting_browser',
    url: 'https://auth.openai.com/codex/device',
    code: 'WXYZ-1234',
  });

  const cancelled = await orchestrator.app.inject({
    method: 'DELETE',
    url: `/api/credentials/openai/login/${loginId}`,
  });
  assert.equal(cancelled.statusCode, 204);
  await untilTrue('the container to go', () => fake.removed.length === 1);

  // After the cancel, the id is unknown, so a page that polls the login gets a 404.
  const gone = await orchestrator.app.inject({
    url: `/api/credentials/openai/login/${loginId}`,
  });
  assert.equal(gone.statusCode, 404);
});

test("a code is posted back into Claude's flow, and refused where none is wanted", async () => {
  const fake = fakeLogins();
  const started = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/credentials/claude/login',
  });
  const { loginId } = started.json() as { loginId: string };

  await untilTrue('the CLI to be running', () => fake.execs.length === 1);
  const cli = fake.execs[0]!;
  // Nothing waits for a code yet, so the route refuses it.
  const early = await orchestrator.app.inject({
    method: 'POST',
    url: `/api/credentials/claude/login/${loginId}/code`,
    payload: { code: 'x' },
  });
  assert.equal(early.statusCode, 409);

  cli.output.write('Visit: https://claude.ai/oauth/authorize\nPaste code here if prompted > ');
  await untilTrue('the prompt', async () => {
    const res = await orchestrator.app.inject({
      url: `/api/credentials/claude/login/${loginId}`,
    });
    return (res.json() as { state: string }).state === 'awaiting_code';
  });

  const posted = await orchestrator.app.inject({
    method: 'POST',
    url: `/api/credentials/claude/login/${loginId}/code`,
    payload: { code: 'from-the-page' },
  });
  assert.equal(posted.statusCode, 204);
  await untilTrue('the code to be entered', () => cli.input.endsWith('\r'));
  // The code ends with a carriage return, which is the byte of the Enter key. The
  // CLI reads a raw terminal and needs this byte.
  assert.equal(cli.input, 'from-the-page\r');

  const missing = await orchestrator.app.inject({
    method: 'POST',
    url: `/api/credentials/claude/login/${loginId}/code`,
    payload: {},
  });
  assert.equal(missing.statusCode, 400);
});

test('GitHub has no login flow, and neither has anything else unknown', async () => {
  const fake = fakeLogins();
  const github = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/credentials/github/login',
  });
  assert.equal(github.statusCode, 400);
  assert.match((github.json() as { error: string }).error, /no login flow/);

  const unknown = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/credentials/gitlab/login',
  });
  assert.equal(unknown.statusCode, 400);
  assert.deepEqual(fake.removed, []);
});

test('an account credential is reported, and says why it cannot run a box yet', async () => {
  const document = JSON.stringify({
    tokens: { access_token: 'a.b.c', refresh_token: 'r' },
    last_refresh: '2026-09-12T10:00:00Z',
  });
  orchestrator.credentials.put('', 'openai', 'oauth', document, { account: 'someone@example.com' });

  const health = (await orchestrator.app.inject({ url: '/healthz' })).json() as {
    harnesses: Array<{
      id: string;
      runnable: boolean;
      credential: { account: string; status: string; lastError: string | null } | null;
    }>;
  };
  const codex = health.harnesses.find((h) => h.id === 'codex');
  assert.equal(codex?.credential?.account, 'someone@example.com');
  assert.equal(codex?.credential?.status, 'ok');
  // The proxy replaces a header value, but this document authenticates traffic
  // that the proxy does not intercept.
  assert.equal(codex?.runnable, false);
  assert.match(codex?.credential?.lastError ?? '', /cannot hand a subscription login to a box/);
});

test('the git identity round-trips, and defaults where nobody has set it', async () => {
  const initial = await orchestrator.app.inject({ url: '/api/settings' });
  assert.deepEqual(initial.json(), {
    gitName: 'boxes-bot',
    gitEmail: 'boxes-bot@users.noreply.github.com',
    dialogs: {},
  });

  const patched = await orchestrator.app.inject({
    method: 'PATCH',
    url: '/api/settings',
    payload: { gitEmail: 'bot@example.com' },
  });
  assert.deepEqual(patched.json(), {
    gitName: 'boxes-bot',
    gitEmail: 'bot@example.com',
    dialogs: {},
  });
  assert.equal(
    ((await orchestrator.app.inject({ url: '/api/settings' })).json() as { gitEmail: string })
      .gitEmail,
    'bot@example.com',
  );

  const bad = await orchestrator.app.inject({
    method: 'PATCH',
    url: '/api/settings',
    payload: { gitName: 42 },
  });
  assert.equal(bad.statusCode, 400);
});

test('the health probe says which harness can run, and on what', async () => {
  const before = await orchestrator.app.inject({ url: '/healthz' });
  const empty = before.json() as {
    harnesses: Array<{ id: string; runnable: boolean; credential: unknown }>;
    credentials: unknown[];
  };
  // The list has each harness, because a box can get a placeholder for each
  // credential. Claude and Codex cannot run yet, because no credential is stored.
  // opencode can always run, because it has models that need no key.
  assert.deepEqual(
    empty.harnesses.map((h) => [h.id, h.runnable]),
    [
      ['claude', false],
      ['codex', false],
      ['opencode', true],
    ],
  );
  assert.equal(empty.harnesses[0]!.credential, null);
  assert.equal(empty.harnesses[1]!.credential, null);
  assert.equal(empty.harnesses[2]!.credential, null);
  assert.deepEqual(empty.credentials, []);

  await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/credentials/claude',
    payload: { method: 'token', secret: 'sk-ant-oat01-abcdefgh1234' },
  });

  const after = (await orchestrator.app.inject({ url: '/healthz' })).json() as {
    harnesses: Array<{ id: string; runnable: boolean; credential: { account: string } | null }>;
    credentials: Array<{ id: string }>;
  };
  assert.equal(after.harnesses[0]!.runnable, true);
  assert.equal(after.harnesses[0]!.credential?.account, '1234');
  // Each harness needs its own credential, so Codex cannot run yet.
  assert.equal(after.harnesses[1]!.runnable, false);
  // The probe reports each stored credential.
  assert.deepEqual(
    after.credentials.map((c) => c.id),
    ['claude'],
  );
});

test('an OpenAI key entered on the settings page is what makes Codex runnable', async () => {
  const put = await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/credentials/openai',
    payload: { method: 'api_key', secret: 'sk-proj-abcdefgh5678' },
  });
  assert.equal(put.statusCode, 200);
  // The answer names the key by its last four characters and never holds the key.
  assert.deepEqual(put.json(), {
    id: 'openai',
    method: 'api_key',
    account: '5678',
    status: 'ok',
    lastError: null,
    expiresAt: null,
    refreshedAt: null,
    updatedAt: (put.json() as { updatedAt: number }).updatedAt,
  });

  const health = (await orchestrator.app.inject({ url: '/healthz' })).json() as {
    harnesses: Array<{ id: string; runnable: boolean }>;
  };
  assert.deepEqual(
    health.harnesses.map((h) => [h.id, h.runnable]),
    [
      ['claude', false],
      ['codex', true],
      ['opencode', true],
    ],
  );

  const harnesses = (await orchestrator.app.inject({ url: '/api/harnesses' })).json() as Array<{
    id: string;
    runnable: boolean;
  }>;
  assert.equal(harnesses.find((h) => h.id === 'codex')?.runnable, true);
});

test('opencode can run without a credential and without an API key', async () => {
  const health = (await orchestrator.app.inject({ url: '/healthz' })).json() as {
    harnesses: Array<{ id: string; runnable: boolean; credential: unknown }>;
  };
  // opencode has models that need no key, so it does not wait for a key of the user.
  assert.deepEqual(
    health.harnesses.find((h) => h.id === 'opencode'),
    { id: 'opencode', label: 'opencode', credential: null, runnable: true },
  );
});

test('a credential that is failing is still offered, and says it is not runnable', async () => {
  await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/credentials/claude',
    payload: { method: 'token', secret: 'sk-ant-oat01-abcdefgh1234' },
  });
  orchestrator.credentials.markStatus('', 'claude', 'expired', 'a year is up');

  const health = (await orchestrator.app.inject({ url: '/healthz' })).json() as {
    harnesses: Array<{ runnable: boolean; credential: { status: string; lastError: string } }>;
  };
  assert.equal(health.harnesses[0]!.runnable, false);
  assert.equal(health.harnesses[0]!.credential.status, 'expired');
  assert.equal(health.harnesses[0]!.credential.lastError, 'a year is up');
});

test('the harness list carries the registry, the catalogue and the health', async () => {
  const res = await orchestrator.app.inject({ url: '/api/harnesses' });
  assert.equal(res.statusCode, 200);
  const fresh = res.json() as Array<{
    id: string;
    runnable: boolean;
    defaultModeId: string;
    forkModeId: string;
    defaultConfig: Record<string, string>;
    catalog: unknown;
  }>;
  // The list has each harness, by the same rule as the health probe. It offers
  // each harness that can get a credential in this deployment, stored or not.
  assert.deepEqual(
    fresh.map((h) => h.id),
    ['claude', 'codex', 'opencode'],
  );
  assert.equal(fresh[0]!.defaultModeId, 'auto');
  assert.equal(fresh[0]!.forkModeId, 'plan');
  assert.deepEqual(fresh[0]!.defaultConfig, { model: 'opus' });
  // The defaults of Codex fill the dialog. The container is the security boundary,
  // so a new thread has full access. The adapter selects the model.
  assert.equal(fresh[1]!.defaultModeId, 'agent-full-access');
  assert.equal(fresh[1]!.forkModeId, 'read-only');
  assert.deepEqual(fresh[1]!.defaultConfig, {});
  assert.equal(fresh[1]!.catalog, null);
  // No adapter ran here, so no catalogue is cached, and the route starts no box to
  // get one. The dialog then shows only the agent choice.
  assert.equal(fresh[0]!.catalog, null);
  assert.equal(fresh[0]!.runnable, false);

  // The gateway caches the last catalogue of an adapter, and the route reads it.
  upsertHarnessCatalog(
    db,
    'claude',
    { currentModeId: 'auto', availableModes: [{ id: 'auto' }, { id: 'plan' }] },
    [{ id: 'model', category: 'model', currentValue: 'opus' }],
  );
  await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/credentials/claude',
    payload: { method: 'token', secret: 'sk-ant-oat01-abcd1234' },
  });

  const after = (await orchestrator.app.inject({ url: '/api/harnesses' })).json() as Array<{
    runnable: boolean;
    catalog: { modes: { availableModes: Array<{ id: string }> } } | null;
  }>;
  assert.equal(after[0]!.runnable, true);
  assert.deepEqual(after[0]!.catalog?.modes.availableModes, [{ id: 'auto' }, { id: 'plan' }]);
});

test('a thread reports the agent it runs and what it is configured with', async () => {
  insertBox('harn01');
  db.prepare(`UPDATE threads SET mode_id = 'plan', config = '{"model":"opus"}' WHERE id = ?`).run(
    'harn01-t1',
  );

  const res = await orchestrator.app.inject({ url: '/api/boxes/harn01/threads' });
  assert.deepEqual(res.json(), [
    {
      id: 'harn01-t1',
      // Claude is the default for a row and for a request without a harness.
      harness: 'claude',
      acpSessionId: null,
      title: null,
      ordinal: 1,
      turnActive: false,
      speaking: false,
      backgroundBusy: false,
      pendingCount: 0,
      modeId: 'plan',
      config: { model: 'opus' },
      // No adapter answered yet, so canFork is false.
      canFork: false,
      done: false,
      createdAt: (res.json() as Array<{ createdAt: number }>)[0]!.createdAt,
      lastActiveAt: (res.json() as Array<{ lastActiveAt: number }>)[0]!.lastActiveAt,
    },
  ]);
});

test('a thread for an agent nobody has is refused before anything is started', async () => {
  insertBox('harn02');
  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/harn02/threads',
    payload: { options: { harness: 'gemini' } },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /Unknown harness/);
  // The refusal created nothing, so the box has only its first thread.
  const threads = (
    await orchestrator.app.inject({ url: '/api/boxes/harn02/threads' })
  ).json() as unknown[];
  assert.equal(threads.length, 1);

  // A new box with an unknown harness gets the same answer, before any image pull,
  // network or container.
  const created = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes',
    payload: { name: 'a box on nothing', thread: { harness: 'gemini' } },
  });
  assert.equal(created.statusCode, 400);
  assert.match((created.json() as { error: string }).error, /Unknown harness/);
});

/**
 * Builds the app of the test again in multi-user mode, on the same database.
 * The reverse proxy sends the username in `Remote-User`.
 */
async function multiUser(): Promise<void> {
  await orchestrator.app.close();
  orchestrator = buildApp(
    loadConfig({
      ...process.env,
      DATA_DIR: orchestrator.cfg.DATA_DIR,
      AUTH_USER_HEADER: 'Remote-User',
    }),
    db,
  );
  await orchestrator.egress.prepare();
}

/**
 * Gives the headers that the reverse proxy sends for a user.
 *
 * @param user The username.
 * @returns The headers.
 */
function as(user: string): Record<string, string> {
  return { 'remote-user': user };
}

/**
 * Gives the owner of a box row.
 *
 * @param id The id of the box.
 * @returns The owner.
 */
function ownerOf(id: string): string | undefined {
  return (
    db.prepare('SELECT owner FROM boxes WHERE id = ?').get(id) as { owner: string } | undefined
  )?.owner;
}

test('in multi-user mode a request without a username is refused, and a page tells why', async () => {
  await multiUser();

  const api = await orchestrator.app.inject({ url: '/api/boxes' });
  assert.equal(api.statusCode, 401);
  assert.match((api.json() as { error: string }).error, /no username/);

  const blank = await orchestrator.app.inject({ url: '/api/boxes', headers: as('   ') });
  assert.equal(blank.statusCode, 401);

  // The browser gets a page that tells why, and not the dashboard.
  const page = await orchestrator.app.inject({ url: '/', headers: { accept: 'text/html' } });
  assert.equal(page.statusCode, 401);
  assert.match(page.headers['content-type'] as string, /text\/html/);
  assert.match(page.payload, /No user/);

  // The probes answer without a username.
  const health = await orchestrator.app.inject({ url: '/healthz' });
  assert.equal(health.statusCode, 200);
  assert.equal((health.json() as { user: string | null }).user, null);
});

test('the first user with a name gets the data without an owner, and a probe claims nothing', async () => {
  insertBox('abc123');
  orchestrator.credentials.put('', 'github', 'token', 'ghp_0123456789abcdef');
  await multiUser();

  const health = await orchestrator.app.inject({ url: '/healthz', headers: as('alice') });
  assert.equal((health.json() as { user: string }).user, 'alice');
  assert.equal(ownerOf('abc123'), '');

  // The username is not case-sensitive.
  const alice = await orchestrator.app.inject({ url: '/api/boxes', headers: as('Alice') });
  assert.deepEqual(
    (alice.json() as Array<{ id: string }>).map((b) => b.id),
    ['abc123'],
  );
  assert.equal(ownerOf('abc123'), 'alice');
  assert.equal(orchestrator.credentials.get('alice', 'github')?.secret, 'ghp_0123456789abcdef');

  // The data went to the first user, so the next user starts empty.
  const bob = await orchestrator.app.inject({ url: '/api/boxes', headers: as('bob') });
  assert.deepEqual(bob.json(), []);
  const bobCredentials = await orchestrator.app.inject({
    url: '/api/credentials',
    headers: as('bob'),
  });
  assert.deepEqual(bobCredentials.json(), []);
});

test('a box of another user is a 404, as a box that does not exist', async () => {
  await multiUser();
  insertBox('abc123', 'alice');

  const own = await orchestrator.app.inject({
    url: '/api/boxes/abc123/threads',
    headers: as('alice'),
  });
  assert.equal(own.statusCode, 200);

  for (const [method, url] of [
    ['GET', '/api/boxes/abc123'],
    ['GET', '/api/boxes/abc123/threads'],
    ['POST', '/api/boxes/abc123/stop'],
    ['DELETE', '/api/boxes/abc123'],
    ['GET', '/api/boxes/abc123/review/dir'],
  ] as const) {
    const res = await orchestrator.app.inject({ method, url, headers: as('bob') });
    assert.equal(res.statusCode, 404, `${method} ${url}`);
    assert.deepEqual(res.json(), { error: 'Box not found' });
  }
  assert.equal(ownerOf('abc123'), 'alice');

  const listed = await orchestrator.app.inject({ url: '/api/boxes', headers: as('bob') });
  assert.deepEqual(listed.json(), []);
});

test('each user has their own credentials, settings and agent sets', async () => {
  await multiUser();
  for (const [user, secret] of [
    ['alice', 'ghp_alice0123456789'],
    ['bob', 'ghp_bob00123456789'],
  ] as const) {
    const put = await orchestrator.app.inject({
      method: 'PUT',
      url: '/api/credentials/github',
      headers: as(user),
      payload: { method: 'token', secret },
    });
    assert.equal(put.statusCode, 200);
  }
  assert.equal(orchestrator.credentials.get('alice', 'github')?.secret, 'ghp_alice0123456789');
  assert.equal(orchestrator.credentials.get('bob', 'github')?.secret, 'ghp_bob00123456789');

  await orchestrator.app.inject({
    method: 'PATCH',
    url: '/api/settings',
    headers: as('alice'),
    payload: { gitName: 'Alice' },
  });
  const aliceSettings = await orchestrator.app.inject({
    url: '/api/settings',
    headers: as('alice'),
  });
  const bobSettings = await orchestrator.app.inject({ url: '/api/settings', headers: as('bob') });
  assert.equal((aliceSettings.json() as { gitName: string }).gitName, 'Alice');
  assert.notEqual((bobSettings.json() as { gitName: string }).gitName, 'Alice');

  // Each user gets their own global set.
  const aliceSets = (
    await orchestrator.app.inject({ url: '/api/agent-sets', headers: as('alice') })
  ).json() as Array<{ id: string; global: boolean }>;
  const bobSets = (
    await orchestrator.app.inject({ url: '/api/agent-sets', headers: as('bob') })
  ).json() as Array<{ id: string; global: boolean }>;
  assert.equal(aliceSets.length, 1);
  assert.equal(bobSets.length, 1);
  assert.ok(aliceSets[0]?.global && bobSets[0]?.global);
  assert.notEqual(aliceSets[0]?.id, bobSets[0]?.id);

  const foreign = await orchestrator.app.inject({
    url: `/api/agent-sets/${aliceSets[0]?.id}`,
    headers: as('bob'),
  });
  assert.equal(foreign.statusCode, 404);

  // A user cannot write or remove the MCP servers of the set of another user.
  const foreignMcp = await orchestrator.app.inject({
    method: 'PUT',
    url: `/api/agent-sets/${aliceSets[0]?.id}/mcp-servers`,
    headers: as('bob'),
    payload: { name: 'docs', url: 'https://docs.example.com/mcp', auth: 'none', headers: [] },
  });
  assert.equal(foreignMcp.statusCode, 404);
  const foreignConnect = await orchestrator.app.inject({
    method: 'POST',
    url: `/api/agent-sets/${aliceSets[0]?.id}/mcp-servers/docs/connect`,
    headers: { ...as('bob'), origin: 'https://boxes.example.com' },
    payload: { origin: 'https://boxes.example.com' },
  });
  assert.equal(foreignConnect.statusCode, 404);
  const foreignDelete = await orchestrator.app.inject({
    method: 'DELETE',
    url: `/api/agent-sets/${aliceSets[0]?.id}/mcp-servers?name=docs`,
    headers: as('bob'),
  });
  assert.equal(foreignDelete.statusCode, 404);
});

test('each user has their own egress profiles, and a box cannot use the profile of another user', async () => {
  await multiUser();
  insertBox('abc123', 'bob');
  const work = (
    await orchestrator.app.inject({
      method: 'POST',
      url: '/api/egress-profiles',
      headers: as('alice'),
      payload: { name: 'Work' },
    })
  ).json() as { id: string };

  assert.deepEqual(
    (await listProfiles(as('bob'))).map((p) => p.name),
    ['Default'],
  );
  for (const [method, payload] of [
    ['GET', undefined],
    ['PATCH', { name: 'Mine' }],
    ['DELETE', undefined],
  ] as const) {
    const res = await orchestrator.app.inject({
      method,
      url: `/api/egress-profiles/${work.id}`,
      headers: as('bob'),
      payload,
    });
    assert.equal(res.statusCode, 404, method);
  }

  const created = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers: as('bob'),
    payload: { name: 'a box', egressProfile: work.id },
  });
  assert.equal(created.statusCode, 400);
  assert.match((created.json() as { error: string }).error, /Unknown egress profile/);

  const selected = await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/boxes/abc123/egress-profile',
    headers: as('bob'),
    payload: { egressProfile: work.id },
  });
  assert.equal(selected.statusCode, 400);
  const foreignBox = await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/boxes/abc123/egress-profile',
    headers: as('alice'),
    payload: { egressProfile: work.id },
  });
  assert.equal(foreignBox.statusCode, 404);
  assert.equal(
    (
      db.prepare('SELECT COUNT(*) AS n FROM boxes WHERE egress_profile_id IS NOT NULL').get() as {
        n: number;
      }
    ).n,
    0,
  );
});

test('in single user mode every box is listed, whatever its owner', async () => {
  insertBox('abc123', 'alice');
  insertBox('def456');
  const res = await orchestrator.app.inject({ url: '/api/boxes' });
  assert.deepEqual((res.json() as Array<{ id: string }>).map((b) => b.id).sort(), [
    'abc123',
    'def456',
  ]);
  const health = await orchestrator.app.inject({ url: '/healthz' });
  assert.equal((health.json() as { user: string | null }).user, null);
});
