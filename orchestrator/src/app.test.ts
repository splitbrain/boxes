import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp, type Orchestrator } from './app.ts';
import { config } from './config.ts';
import { openDb, type Db } from './db.ts';
import * as dk from './docker.ts';
import * as ws from './workspaces.ts';

/**
 * The exec endpoint over its real routes, real database and real session
 * lookup, with only the Docker socket faked.
 */

/** One frame of a demuxable Docker stream. */
function frame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** Installs a fake Docker client that answers everything the routes touch. */
function fakeDocker(output: string, exitCode = 0): { execs: string[][] } {
  const execs: string[][] = [];
  const modem = new Docker({ socketPath: '/var/run/docker.sock' }).modem;

  dk.setDockerForTests({
    modem,
    getContainer: () => ({
      start: async () => undefined,
      inspect: async () => ({ State: { Running: true } }),
      exec: async (opts: { Cmd: string[] }) => {
        execs.push(opts.Cmd);
        return {
          start: async () => {
            const stream = new PassThrough();
            queueMicrotask(() => {
              // The repo probe is a plain `test -d`, which produces nothing.
              if (opts.Cmd[0] !== 'bash') return stream.end();
              stream.write(frame(output));
              stream.end();
            });
            return stream;
          },
          inspect: async () => ({ ExitCode: opts.Cmd[0] === 'bash' ? exitCode : 1 }),
        };
      },
    }),
  } as unknown as Docker);

  return { execs };
}

let dir: string;
let db: Db;
let orchestrator: Orchestrator;

/** A running session row, which is all the exec routes need to exist. */
function insertSession(id: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       created_at, last_active_at)
     VALUES (?, 'test', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       ?, '10.200.0.0/24', ?, ?, 'running', NULL, ?, ?)`,
  ).run(id, `sn-${id}`, `ws-${id}`, `home-${id}`, now, now);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-app-'));
  // Before config(), which generates and writes the WS token on first read.
  process.env['DATA_DIR'] = dir;
  db = openDb(dir);
  orchestrator = buildApp(config(), db);
});

afterEach(async () => {
  // See insertWorkspaceSession: workspaces are written under the config's
  // DATA_DIR, which outlives this test's own directory.
  rmSync(ws.workspacesRoot(orchestrator.cfg.DATA_DIR), { recursive: true, force: true });
  rmSync(ws.homesRoot(orchestrator.cfg.DATA_DIR), { recursive: true, force: true });
  await orchestrator.app.close();
  db.close();
  dk.setDockerForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A directory-backed session: what an attachment needs, and what the exec
 * routes above do not — those reach the container, this reaches the disk.
 */
function insertWorkspaceSession(id: string): string {
  insertSession(id);
  // config() is memoised for the process, so the app's DATA_DIR is whatever
  // the first test in this file set — not necessarily this test's `dir`.
  // Everything that reaches the disk has to go through the app's own copy.
  const workspace = ws.createWorkspace(orchestrator.cfg.DATA_DIR, id);
  const home = ws.createHome(orchestrator.cfg.DATA_DIR, id);
  db.prepare('UPDATE sessions SET workspace_dir = ?, home_dir = ? WHERE id = ?').run(
    workspace,
    home,
    id,
  );
  return workspace;
}

test('an attachment is stored in the workspace and its path reported back', async () => {
  const workspace = insertWorkspaceSession('abc123');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/attachments?name=shot.png',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('PNGDATA'),
  });

  assert.equal(res.statusCode, 200);
  const stored = res.json() as { name: string; path: string; size: number };
  assert.deepEqual(stored, { name: 'shot.png', path: '.boxes/attachments/shot.png', size: 7 });
  assert.equal(readFileSync(join(workspace, stored.path), 'utf8'), 'PNGDATA');
});

/**
 * Lists sessions until one reports a workspace size, or gives up.
 *
 * A measurement happens off the request path on purpose — the list must never
 * wait for a disk walk — so a test that wants one has to ask again. See
 * diskusage.ts.
 */
async function measuredSize(id: string): Promise<number | null> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const res = await orchestrator.app.inject({ url: '/api/sessions' });
    const listed = res.json() as Array<{ id: string; diskBytes: number | null }>;
    const size = listed.find((s) => s.id === id)?.diskBytes ?? null;
    if (size !== null) return size;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

test('a session is measured off the request path and reported on the list', async () => {
  const workspace = insertWorkspaceSession('abc123');
  writeFileSync(join(workspace, 'checkout.bin'), Buffer.alloc(4096));
  // The home counts too, and on a box that has been working it is the larger
  // half: the thread history, the tool caches, whatever the agent installed.
  writeFileSync(
    join(ws.homePath(orchestrator.cfg.DATA_DIR, 'abc123'), 'cache.bin'),
    Buffer.alloc(2048),
  );

  // The first list answers with no size rather than waiting for the walk it
  // starts. A card shows nothing; a zero would be a claim.
  const first = await orchestrator.app.inject({ url: '/api/sessions' });
  assert.equal(
    (first.json() as Array<{ diskBytes: number | null }>)[0]!.diskBytes,
    null,
  );

  assert.equal(await measuredSize('abc123'), 4096 + 2048);
});

test('an upload is what says a workspace grew, since nothing else can say it', async () => {
  const workspace = insertWorkspaceSession('abc123');
  writeFileSync(join(workspace, 'checkout.bin'), Buffer.alloc(4096));
  assert.equal(await measuredSize('abc123'), 4096);

  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/attachments?name=shot.png',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.alloc(2048),
  });

  // A measurement stands for a quarter of an hour, and a stopped box's stands
  // for as long as it is stopped — so the one thing that puts bytes in a
  // workspace from out here has to drop it rather than wait for it to expire.
  const after = await measuredSize('abc123');
  assert.ok(after !== null && after >= 4096 + 2048, `grew to ${String(after)}`);
});

test('an attachment name that is a path is reduced to a name', async () => {
  const workspace = insertWorkspaceSession('abc123');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: `/api/sessions/abc123/attachments?name=${encodeURIComponent('../../escape.txt')}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('x'),
  });

  assert.equal((res.json() as { path: string }).path, '.boxes/attachments/escape.txt');
  assert.ok(existsSync(join(workspace, '.boxes/attachments/escape.txt')));
});

test('an attachment upload without a name or a body is refused', async () => {
  insertWorkspaceSession('abc123');
  const headers = { 'content-type': 'application/octet-stream' };

  const nameless = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/attachments',
    headers,
    payload: Buffer.from('x'),
  });
  assert.equal(nameless.statusCode, 400);

  const empty = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/attachments?name=a.txt',
    headers,
    payload: Buffer.alloc(0),
  });
  assert.equal(empty.statusCode, 400);
});

test('an attachment to a session that has no workspace is a 404', async () => {
  // Inserted, but never given a workspace directory: nothing to write into.
  insertSession('abc123');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/attachments?name=a.txt',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('x'),
  });
  assert.equal(res.statusCode, 404);
});

test('an attachment over the size limit is refused, and says so', async () => {
  insertWorkspaceSession('abc123');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/attachments?name=big.bin',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.alloc(config().MAX_ATTACHMENT_MB * 1024 * 1024 + 1),
  });

  // Fastify's own refusal, passed through with its status rather than
  // flattened into a 500 — the size is the one thing the user can act on.
  assert.equal(res.statusCode, 413);
});

test('a stored image is served back as itself, for the thread to show', async () => {
  insertWorkspaceSession('abc123');
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/attachments?name=shot.png',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('PNGDATA'),
  });

  const res = await orchestrator.app.inject({ url: '/api/sessions/abc123/attachments/shot.png' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.match(res.headers['content-disposition'] as string, /^inline/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.body, 'PNGDATA');
});

test('an SVG is served as one, inert, so a diagram can be looked at', async () => {
  insertWorkspaceSession('abc123');
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/attachments?name=diagram.svg',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('<svg onload="alert(1)"></svg>'),
  });

  const res = await orchestrator.app.inject({
    url: '/api/sessions/abc123/attachments/diagram.svg',
  });

  assert.equal(res.headers['content-type'], 'image/svg+xml');
  assert.match(res.headers['content-disposition'] as string, /^inline/);
  // This is what makes the line above safe: an SVG opened as a document has
  // no script, no origin and no network. Behind the <img> the thread uses it
  // is inert regardless.
  assert.equal(res.headers['content-security-policy'], "default-src 'none'; sandbox");
});

test('a PDF is served as one, unsandboxed, so a tab can show it', async () => {
  insertWorkspaceSession('abc123');
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/attachments?name=report.pdf',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('%PDF-1.4'),
  });

  const res = await orchestrator.app.inject({
    url: '/api/sessions/abc123/attachments/report.pdf',
  });

  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'] as string, /^inline/);
  // No `sandbox`: a sandboxed document is one a browser may decline to hand
  // to its PDF viewer, which would make opening it a download again. The
  // rest of the policy still applies.
  assert.equal(res.headers['content-security-policy'], "default-src 'none'");
});

test('a format nothing renders is served as a download of unknown type', async () => {
  insertWorkspaceSession('abc123');
  // HTML above all: served as itself it would run as this origin, and unlike
  // an SVG there is no way to show it that does not.
  for (const name of ['page.html', 'notes.txt', 'archive.zip']) {
    await orchestrator.app.inject({
      method: 'POST',
      url: `/api/sessions/abc123/attachments?name=${name}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });

    const res = await orchestrator.app.inject({
      url: `/api/sessions/abc123/attachments/${name}`,
    });
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.match(res.headers['content-disposition'] as string, /^attachment/);
    assert.equal(res.headers['content-security-policy'], "default-src 'none'; sandbox");
  }
});

test('a link planted in the attachments directory serves nothing', async () => {
  const workspace = insertWorkspaceSession('abc123');
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/attachments?name=real.png',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('x'),
  });
  // What an agent with a foothold in its own workspace would try: the
  // orchestrator's own uid can read the database and the gateway token.
  const secret = join(dir, 'secret.txt');
  writeFileSync(secret, 'ws-auth-token');
  symlinkSync(secret, join(workspace, '.boxes/attachments/escape.png'));

  const res = await orchestrator.app.inject({
    url: '/api/sessions/abc123/attachments/escape.png',
  });
  assert.equal(res.statusCode, 404);
});

test('an attachment name that is a path fetches nothing', async () => {
  insertWorkspaceSession('abc123');
  const res = await orchestrator.app.inject({
    url: `/api/sessions/abc123/attachments/${encodeURIComponent('../../../etc/passwd')}`,
  });
  assert.equal(res.statusCode, 404);
});

test('an attachment that was never stored is a 404', async () => {
  insertWorkspaceSession('abc123');
  const res = await orchestrator.app.inject({ url: '/api/sessions/abc123/attachments/nope.png' });
  assert.equal(res.statusCode, 404);
});

test('a command runs in the container and streams its output with a trailer', async () => {
  insertSession('abc123');
  const { execs } = fakeDocker('hello\n');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/exec',
    payload: { command: 'echo hello' },
  });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/plain/);
  assert.equal(res.body, 'hello\n\n[exit 0]\n');
  // The command travels as an argument to bash inside the container; nothing
  // is assembled into a host command line.
  assert.deepEqual(execs.at(-1), ['bash', '-lc', 'echo hello']);
});

test('a non-zero exit is reported in the trailer', async () => {
  insertSession('abc123');
  fakeDocker('bash: nope: command not found\n', 127);

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/exec',
    payload: { command: 'nope' },
  });
  assert.match(res.body, /\[exit 127\]/);
});

test('a finished run is stored and listed', async () => {
  insertSession('abc123');
  fakeDocker('clean\n');

  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/exec',
    payload: { command: 'git status' },
  });

  const res = await orchestrator.app.inject({ url: '/api/sessions/abc123/exec' });
  assert.equal(res.statusCode, 200);
  const { records } = res.json() as { records: Array<Record<string, unknown>> };
  assert.equal(records.length, 1);
  assert.equal(records[0]!['command'], 'git status');
  assert.equal(records[0]!['output'], 'clean\n');
  assert.equal(records[0]!['exitCode'], 0);
  assert.equal(records[0]!['truncated'], false);
});

test('running a command holds off the reaper', async () => {
  insertSession('abc123');
  fakeDocker('ok\n');
  db.prepare('UPDATE sessions SET last_active_at = 0 WHERE id = ?').run('abc123');

  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/exec',
    payload: { command: 'true' },
  });

  const row = db.prepare('SELECT last_active_at FROM sessions WHERE id = ?').get('abc123') as {
    last_active_at: number;
  };
  assert.ok(row.last_active_at > 0);
});

test('an empty command is rejected before anything runs', async () => {
  insertSession('abc123');
  const { execs } = fakeDocker('');

  for (const payload of [{ command: '' }, { command: '   ' }, {}]) {
    const res = await orchestrator.app.inject({
      method: 'POST',
      url: '/api/sessions/abc123/exec',
      payload,
    });
    assert.equal(res.statusCode, 400);
  }
  assert.deepEqual(execs, []);
});

test('an absurdly long command is rejected', async () => {
  insertSession('abc123');
  fakeDocker('');
  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/exec',
    payload: { command: 'x'.repeat(9000) },
  });
  assert.equal(res.statusCode, 400);
});

test('an unknown session is a 404 on both exec routes', async () => {
  fakeDocker('');
  const post = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/nosuch/exec',
    payload: { command: 'ls' },
  });
  assert.equal(post.statusCode, 404);

  const get = await orchestrator.app.inject({ url: '/api/sessions/nosuch/exec' });
  assert.equal(get.statusCode, 404);
});

test('a deleted session is a 404 too', async () => {
  insertSession('gone');
  db.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('gone');
  fakeDocker('');

  const res = await orchestrator.app.inject({ url: '/api/sessions/gone/exec' });
  assert.equal(res.statusCode, 404);
});

test('a session with no container cannot run a command', async () => {
  insertSession('abc123');
  db.prepare('UPDATE sessions SET container_id = NULL WHERE id = ?').run('abc123');
  fakeDocker('');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/exec',
    payload: { command: 'ls' },
  });
  assert.equal(res.statusCode, 409);
});

test('one session cannot see another session commands', async () => {
  insertSession('aaa');
  insertSession('bbb');
  fakeDocker('mine\n');

  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/aaa/exec',
    payload: { command: 'whoami' },
  });

  const res = await orchestrator.app.inject({ url: '/api/sessions/bbb/exec' });
  assert.deepEqual((res.json() as { records: unknown[] }).records, []);
});

/**
 * The static handler, over a fixture bundle laid out the way the runtime
 * image lays out the dashboard's build output.
 */

/** Writes a minimal bundle next to where the handler looks for one. */
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
  // Vite copies public/ to the bundle root, which is where these two have to
  // stay: see the service worker test below.
  writeFileSync(join(bundle, 'sw.js'), 'self.addEventListener("push", () => {})');
  writeFileSync(join(bundle, 'manifest.webmanifest'), '{"name":"Boxes"}');
  return bundle;
}

test('the dashboard bundle is served, with a single-page fallback', async () => {
  const bundle = writeBundle();
  try {
    // Real files come back as themselves, with the right content type.
    const js = await orchestrator.app.inject({ url: '/assets/index-abc.js' });
    assert.equal(js.statusCode, 200);
    assert.match(js.headers['content-type'] as string, /text\/javascript/);

    const css = await orchestrator.app.inject({ url: '/assets/index-abc.css' });
    assert.match(css.headers['content-type'] as string, /text\/css/);

    // A client-side route is not a file, and must survive a reload.
    for (const url of ['/', '/new', '/sessions/abc123', '/sessions/abc123/info']) {
      const res = await orchestrator.app.inject({ url });
      assert.equal(res.statusCode, 200, url);
      assert.match(res.headers['content-type'] as string, /text\/html/, url);
      assert.match(res.body, /id="app"/, url);
    }

    // The API and the gateway do not get the fallback: a mistyped endpoint
    // must be a 404, not a page.
    for (const url of ['/api/nope', '/ws/nope']) {
      const res = await orchestrator.app.inject({ url });
      assert.equal(res.statusCode, 404, url);
    }

    // Nothing outside the bundle is reachable through a traversal.
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
    // A service worker may only control the scope it is served from, so this
    // has to be /sw.js and not an asset path — and it must be the file rather
    // than the single-page fallback, which would register an HTML document as
    // a worker and take push out silently.
    const sw = await orchestrator.app.inject({ url: '/sw.js' });
    assert.equal(sw.statusCode, 200);
    assert.match(sw.headers['content-type'] as string, /text\/javascript/);
    assert.match(sw.body, /addEventListener\("push"/);

    // Without the manifest an iPhone cannot install the page, and without
    // installing it, it has no Push API at all.
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

// --- Web Push registration --------------------------------------------------

/** A subscription shaped the way the browser's own toJSON() produces one. */
function subscription(endpoint = 'https://push.example.net/x/abc'): Record<string, unknown> {
  return {
    endpoint,
    keys: {
      // 65 and 16 bytes: what a real P-256 point and auth secret decode to.
      p256dh: Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString('base64url'),
      auth: Buffer.alloc(16, 9).toString('base64url'),
    },
  };
}

/** Every stored subscription, as rows. */
function subscriptions(): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM push_subscriptions').all() as Array<
    Record<string, unknown>
  >;
}

test('the VAPID public key is served and stays the same across reads', async () => {
  const first = await orchestrator.app.inject({ url: '/api/push/key' });
  const second = await orchestrator.app.inject({ url: '/api/push/key' });

  assert.equal(first.statusCode, 200);
  const key = (first.json() as { publicKey: string }).publicKey;
  // Uncompressed P-256, which is the only form a browser accepts here.
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

  // Re-subscribing hands back the same endpoint with fresh keys, which has to
  // update the row rather than add one.
  const rotated = subscription();
  (rotated['keys'] as Record<string, string>)['auth'] = Buffer.alloc(16, 1).toString(
    'base64url',
  );
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    payload: rotated,
  });

  const rows = subscriptions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!['auth'], (rotated['keys'] as Record<string, string>)['auth']);
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
    'https://127.0.0.1/x', // an address literal in the owner's own space
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
  (bad['keys'] as Record<string, string>)['p256dh'] = Buffer.alloc(32).toString('base64url');
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

// --- agent configuration over its real routes ---------------------------------

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
    payload: { kind: 'command', name: 'bench', content: 'Run the benchmarks.' },
  });
  assert.equal(put.statusCode, 200);
  // Every mutation answers with the whole set, so the editor needs one call.
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
    payload: { kind: 'skill', name: 'review', content: 'global' },
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
    payload: { kind: 'skill', name: 'review', content: 'go' },
  });

  const preview = (
    await orchestrator.app.inject({ url: `/api/agent-sets/${set.id}/preview` })
  ).json() as {
    agentsMd: string;
    items: Array<{ name: string; content: string }>;
    overrides: Array<{ name: string }>;
  };
  assert.equal(preview.agentsMd, 'House rules.\n\nGo rules.');
  assert.equal(preview.items.length, 1);
  assert.equal(preview.items[0]!.content, 'go');
  assert.deepEqual(preview.overrides, [{ kind: 'skill', name: 'review' }]);
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

test('creating a session against an unknown set is refused before anything is built', async () => {
  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { name: 'a box', agentSet: 'nope' },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /Unknown agent set/);
  // Nothing was inserted: the check runs before the row does.
  const rows = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
  assert.equal(rows.n, 0);
});

test('starting a container for a command writes the current configuration first', async () => {
  // Opening a thread and running a command both start a stopped box without
  // going through /start, and the entrypoint installs whatever is on disk at
  // that moment — so the box must not be started against a stale set.
  insertSession('abc123');
  fakeDocker('hi\n');
  await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/agent-sets/global/items',
    payload: { kind: 'command', name: 'ship', content: 'Open a PR.' },
  });

  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/exec',
    payload: { command: 'echo hi' },
  });

  // config() caches process-wide, so the data directory in force is the
  // orchestrator's own rather than this test's fresh one.
  assert.equal(
    readFileSync(
      join(orchestrator.cfg.DATA_DIR, 'agents', 'abc123', 'commands', 'ship.md'),
      'utf8',
    ),
    'Open a PR.\n',
  );
});

test('stopping background work names a thread, and 404s for one that is not there', async () => {
  insertSession('abc123');

  const missing = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/threads/nope/background/stop',
    payload: {},
  });
  assert.equal(missing.statusCode, 404);

  // A thread with no conversation upstream cannot have left anything in the
  // box, and says so without reaching Docker at all.
  const now = Date.now();
  db.prepare(
    `INSERT INTO threads (id, session_id, acp_session_id, title, ordinal,
       created_at, last_active_at)
     VALUES ('t1', 'abc123', NULL, NULL, 1, ?, ?)`,
  ).run(now, now);

  const unminted = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/threads/t1/background/stop',
    payload: { processId: 'aabbccdd' },
  });
  assert.equal(unminted.statusCode, 200);
  assert.deepEqual(unminted.json(), { stopped: 0 });
});
