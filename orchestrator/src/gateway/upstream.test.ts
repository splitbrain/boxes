import assert from 'node:assert/strict';
import { afterEach, beforeEach, expect, test } from 'vitest';
import Docker from 'dockerode';
import { Duplex, Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.ts';
import { openDb, type Db } from '../db.ts';
import * as dk from '../docker.ts';
import { EgressManager } from '../egress.ts';
import { Notifier, type NotifyEvent } from '../notify.ts';
import { AgentStore } from '../agents.ts';
import { SessionManager } from '../sessions.ts';
import { processId } from './background.ts';
import type { DownstreamHandle } from './upstream.ts';
import type { TurnStateParams } from '../../../shared/types.ts';

// A turn is announced when the thread it ran on has gone quiet, not when the
// prompt comes back — so these tests have to wait one out. Turned down to the
// shortest the config allows, before anything reads it.
process.env['AGENT_QUIET_SECONDS'] = '1';
process.env['AGENT_SETTLE_SECONDS'] = '1';

/**
 * The upstream's spawn path against an adapter that answers for real, with
 * only the Docker socket faked.
 *
 * What matters here is what happens to the stored threads when the adapter no
 * longer holds one. The agent SDK writes a transcript only once a prompt has
 * run, so a thread minted and never prompted does not survive the adapter
 * restarting — and that must cost the session only that one thread.
 */

/** One frame of a Docker-multiplexed stream, on stdout. */
function frame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** A JSON-RPC frame, in either direction. */
interface Rpc {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * A stand-in adapter on the hijacked exec stream: the orchestrator's
 * newline-delimited JSON-RPC comes in as writes, and answers go back out as
 * Docker frames.
 */
class FakeAdapter extends Duplex {
  private buffer = '';
  /** Methods the orchestrator sent, in order. */
  readonly seen: string[] = [];

  constructor(private readonly answer: (msg: Rpc) => unknown | Promise<unknown>) {
    super();
  }

  override _read(): void {
    // Answers are pushed as they are produced.
  }

  override _write(chunk: Buffer, _enc: string, done: (err?: Error) => void): void {
    this.buffer += chunk.toString('utf8');
    let cut = this.buffer.indexOf('\n');
    while (cut !== -1) {
      const line = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut + 1);
      if (line) this.handle(line);
      cut = this.buffer.indexOf('\n');
    }
    done();
  }

  /** Sends a notification, the way an adapter's replay does. */
  notify(method: string, params: unknown): void {
    this.push(frame(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`));
  }

  private handle(line: string): void {
    const msg = JSON.parse(line) as Rpc;
    if (msg.id === undefined || !msg.method) return;
    this.seen.push(msg.method);
    // An answer may be a promise, which is how a test holds one call open
    // while asserting on what is true meanwhile.
    void Promise.resolve(this.answer(msg)).then((result) => {
      const body =
        result instanceof Error
          ? { error: { code: -32002, message: result.message } }
          : { result };
      this.push(frame(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body })}\n`));
    });
  }
}

/**
 * Installs a fake Docker whose adapter exec is the given stand-in.
 *
 * A function rather than an instance builds a fresh one per exec, which is
 * what a respawn needs: killing an exec destroys its stream, so an adapter
 * that has been torn down cannot answer the connection that replaces it.
 */
/**
 * What `docker top` reports for the fake box, which is how the gateway learns
 * whether anything is still running in it. Written parent-first: the adapter
 * Boxes launched, an agent under it, and whatever the agent is running.
 */
const BASE_PROCESSES: string[][] = [
  ['1', '0', '/sbin/docker-init'],
  ['19', '1', 'node /usr/local/bin/claude-agent-acp'],
  // The agent process says which conversation it is running, which is how
  // work found under it reaches that thread and no other.
  ['100', '19', 'claude --output-format stream-json --session-id=acp-gone'],
];

/** The box as this test is pretending to find it. Reset for every one. */
let processes: string[][] = [...BASE_PROCESSES];

/**
 * What the box's own `ps` would print, which is not what `docker top` prints:
 * the pids are the container's own numbering. Only the command lines are the
 * same in both, which is why they are what a stop is asked for.
 */
let insideProcesses: string[][] = [];

/** Every `kill` the orchestrator ran in the box, as its arguments. */
let killed: string[][] = [];

/** One hijacked exec stream carrying `text` on stdout, framed as Docker frames it. */
function execStream(text: string): Readable {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Readable.from([Buffer.concat([header, payload])]);
}

/** Whether the box this test is pretending to have is up. */
let containerRunning = true;

function fakeDocker(adapter: FakeAdapter | (() => FakeAdapter)): void {
  const spawn = typeof adapter === 'function' ? adapter : () => adapter;
  const modem = new Docker({ socketPath: '/var/run/docker.sock' }).modem;
  dk.setDockerForTests({
    modem,
    getContainer: () => ({
      start: async () => undefined,
      inspect: async () => ({ State: { Running: containerRunning } }),
      top: async () => ({ Titles: ['PID', 'PPID', 'COMMAND'], Processes: processes }),
      exec: async (opts: { Cmd?: string[] }) => {
        const cmd = opts?.Cmd ?? [];
        // The stop's two calls. Everything else is the adapter, which is a
        // long-lived stream rather than a command with an answer.
        if (cmd[0] === 'ps') {
          const rows = insideProcesses.map(([pid, ppid, args]) => `${pid} ${ppid} ${args}`);
          return {
            start: async () => execStream(['  PID  PPID COMMAND', ...rows].join('\n')),
            inspect: async () => ({ ExitCode: 0 }),
          };
        }
        if (cmd[0] === 'kill') {
          killed.push(cmd.slice(1));
          return {
            start: async () => execStream(''),
            inspect: async () => ({ ExitCode: 0 }),
          };
        }
        return {
          start: async () => spawn(),
          inspect: async () => ({ ExitCode: 0 }),
        };
      },
    }),
    getNetwork: () => ({
      inspect: async () => ({ Containers: {} }),
      connect: async () => undefined,
    }),
    listContainers: async () => [],
  } as unknown as Docker);
}

let dir: string;
let db: Db;
let manager: SessionManager;
/** Every event the gateway announced, in order; see notifications below. */
let announced: NotifyEvent[];

/** A notifier that records instead of sending. */
class RecordingNotifier extends Notifier {
  override async notify(event: NotifyEvent): Promise<void> {
    announced.push(event);
  }
}

/** A running session with two threads, the first of which is current. */
function seed(): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       created_at, last_active_at)
     VALUES ('s1', 'test', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       'sn-s1', '10.200.0.0/24', 'ws-s1', 'home-s1', 'running', 't1', ?, ?)`,
  ).run(now, now);
  for (const [id, acp, ordinal] of [
    ['t1', 'acp-gone', 1],
    ['t2', 'acp-kept', 2],
  ] as const) {
    db.prepare(
      `INSERT INTO threads (id, session_id, acp_session_id, title, ordinal,
         created_at, last_active_at)
       VALUES (?, 's1', ?, NULL, ?, ?, ?)`,
    ).run(id, acp, ordinal, now, now);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-upstream-'));
  process.env['DATA_DIR'] = dir;
  db = openDb(dir);
  const cfg = config();
  announced = [];
  processes = [...BASE_PROCESSES];
  insideProcesses = [];
  killed = [];
  containerRunning = true;
  manager = new SessionManager(
    db,
    cfg,
    new EgressManager(cfg),
    new RecordingNotifier(db, cfg),
    new AgentStore(db, cfg.DATA_DIR),
  );
  seed();
});

afterEach(() => {
  manager.closeAll();
  db.close();
  dk.setDockerForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

/** One thread row as stored. */
function thread(id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Record<string, unknown>;
}

/** A browser watching one thread, recording what it was asked and told. */
function fakeHandle(
  id: number,
  acpThreadId: string | null,
): DownstreamHandle & { asked: unknown[]; told: unknown[]; closed: number } {
  return {
    id,
    acpThreadId,
    lastActiveAt: Date.now(),
    asked: [] as unknown[],
    told: [] as unknown[],
    closed: 0,
    notify(this: { told: unknown[] }, _method, params) {
      this.told.push(params);
    },
    request(this: { asked: unknown[] }, _method, params) {
      this.asked.push(params);
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    },
    close(this: { closed: number }) {
      this.closed++;
    },
  };
}

/** A session/request_permission from the adapter, about one thread. */
function permissionFrame(acpThreadId: string): Buffer {
  return frame(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 9000,
      method: 'session/request_permission',
      params: {
        sessionId: acpThreadId,
        toolCall: { toolCallId: 'tc-1' },
        options: [{ optionId: 'yes', kind: 'allow_once' }],
      },
    })}\n`,
  );
}

test('a thread the adapter has forgotten is re-minted, and the others are left alone', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    // The stored thread has no transcript on disk, which is what the adapter
    // reports as a missing resource.
    if (msg.method === 'session/load') return new Error('Session not found');
    if (msg.method === 'session/new') return { sessionId: 'acp-fresh' };
    return {};
  });
  fakeDocker(adapter);

  await manager.upstream('s1').ensureStarted();

  // The current thread keeps its row and its ordinal, and gets the freshly
  // minted conversation.
  assert.equal(thread('t1')['acp_session_id'], 'acp-fresh');
  assert.equal(thread('t1')['ordinal'], 1);
  // The session's other thread has a transcript of its own and is untouched.
  assert.equal(thread('t2')['acp_session_id'], 'acp-kept');
  const count = db.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number };
  assert.equal(count.n, 2);
  // Still the same current thread: a re-mint is not a switch.
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as Record<
    string,
    unknown
  >;
  assert.equal(session['current_thread_id'], 't1');
});

test('a thread the adapter still holds is replayed rather than replaced', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);

  await manager.upstream('s1').ensureStarted();

  assert.equal(thread('t1')['acp_session_id'], 'acp-gone');
  assert.ok(adapter.seen.includes('session/load'));
  assert.ok(!adapter.seen.includes('session/new'));
});

test('a session with no thread yet gets its first one recorded', async () => {
  db.prepare('DELETE FROM threads').run();
  db.prepare('UPDATE sessions SET current_thread_id = NULL WHERE id = ?').run('s1');

  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    if (msg.method === 'session/new') return { sessionId: 'acp-first' };
    return {};
  });
  fakeDocker(adapter);

  await manager.upstream('s1').ensureStarted();

  const rows = db.prepare('SELECT * FROM threads').all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!['acp_session_id'], 'acp-first');
  assert.equal(rows[0]!['ordinal'], 1);
  assert.ok(!adapter.seen.includes('session/load'));
});

test('every conversation is created asking for readable thinking', async () => {
  /** The `_meta` each session-creating call carried. */
  const meta: Array<{ method: string; meta: unknown }> = [];
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    if (msg.method === 'session/load' || msg.method === 'session/new') {
      meta.push({
        method: msg.method,
        meta: (msg.params as { _meta?: unknown } | undefined)?._meta,
      });
    }
    // The stored thread is gone, so both paths run: a load that fails and
    // the fresh conversation that replaces it.
    if (msg.method === 'session/load') return new Error('Session not found');
    if (msg.method === 'session/new') return { sessionId: 'acp-fresh' };
    return {};
  });
  fakeDocker(adapter);

  await manager.upstream('s1').ensureStarted();

  // Without `display`, a current model streams thinking blocks with no text
  // in them and the dashboard has no reasoning to show.
  const wanted = {
    claudeCode: {
      options: {
        thinking: { type: 'enabled', budgetTokens: 10_000, display: 'summarized' },
      },
    },
  };
  assert.ok(meta.length >= 2);
  for (const call of meta) assert.deepEqual(call.meta, wanted, call.method);
});

test('forking is offered only when the adapter advertises the capability', async () => {
  const withFork = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') {
      return {
        protocolVersion: 1,
        // ACP spells a supported capability as an object, `{}` included.
        agentCapabilities: { sessionCapabilities: { fork: {} } },
      };
    }
    return {};
  });
  fakeDocker(withFork);

  const up = manager.upstream('s1');
  assert.equal(up.canFork, false, 'nothing is claimed before the adapter is reached');
  await up.ensureStarted();
  assert.equal(up.canFork, true);
});

test('a title the adapter reports lands on the thread it is about', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);
  await manager.upstream('s1').ensureStarted();

  // A session_info_update for the thread that is not current, to show the
  // title is routed by the update's own ACP id rather than by what is current.
  adapter.push(
    frame(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'acp-kept',
          update: { sessionUpdate: 'session_info_update', title: 'Refactor the proxy' },
        },
      })}\n`,
    ),
  );

  await expect.poll(() => thread('t2')['title']).toBe('Refactor the proxy');
  assert.equal(thread('t1')['title'], null);
});

test('a thread with no title is named after the prompt sent on it', async () => {
  fakeDocker(plainAdapter());
  const up = manager.upstream('s1');
  await up.ensureStarted();

  await up.forwardRequest('session/prompt', {
    sessionId: 'acp-gone',
    prompt: [
      // The dashboard's own words about an attached file, passed over for
      // what the user typed under them.
      { type: 'text', text: '<attachments>\nThe user attached these files\n</attachments>' },
      { type: 'text', text: '  Make the proxy stop\nlogging bodies  ' },
    ],
  });
  assert.equal(thread('t1')['title'], 'Make the proxy stop');
  assert.equal(thread('t2')['title'], null, 'only the thread prompted is named');

  // What comes next says nothing about what the thread is called: a name it
  // already has is the agent's to replace, not the next prompt's.
  await up.forwardRequest('session/prompt', {
    sessionId: 'acp-gone',
    prompt: [{ type: 'text', text: 'and the headers' }],
  });
  assert.equal(thread('t1')['title'], 'Make the proxy stop');
});

test('a prompt with nothing to name a thread after leaves it on its ordinal', async () => {
  fakeDocker(plainAdapter());
  const up = manager.upstream('s1');
  await up.ensureStarted();

  await up.forwardRequest('session/prompt', {
    sessionId: 'acp-gone',
    prompt: [{ type: 'image', data: 'x', mimeType: 'image/png' }],
  });
  assert.equal(thread('t1')['title'], null);
});

test('a new thread is minted, recorded and made current', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    if (msg.method === 'session/new') return { sessionId: 'acp-third' };
    return {};
  });
  fakeDocker(adapter);

  const created = await manager.createThread('s1', undefined);

  assert.equal(created.acpSessionId, 'acp-third');
  // Past the highest the session has used, so "Thread 2" stays that thread's.
  assert.equal(created.ordinal, 3);
  assert.equal(created.title, null);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as Record<
    string,
    unknown
  >;
  assert.equal(session['current_thread_id'], created.id);
  assert.deepEqual(
    manager.threads('s1').map((t) => t.ordinal),
    [1, 2, 3],
  );
});

test('a fork asks the adapter to branch the named thread', async () => {
  let forkedFrom: unknown = null;
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    if (msg.method === 'session/fork') {
      forkedFrom = msg.params?.['sessionId'];
      return { sessionId: 'acp-branch' };
    }
    return {};
  });
  fakeDocker(adapter);

  const created = await manager.createThread('s1', { from: 't2' });

  // The adapter's own id for the source, not the row id Boxes uses.
  assert.equal(forkedFrom, 'acp-kept');
  assert.equal(created.acpSessionId, 'acp-branch');
  // The source is left exactly as it was; a fork branches rather than moves.
  assert.equal(thread('t2')['acp_session_id'], 'acp-kept');
});

test('forking a thread of another session is a 404 rather than a fork', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);

  await assert.rejects(
    () => manager.createThread('s1', { from: 'someone-elses-thread' }),
    (err: Error & { statusCode?: number }) => err.statusCode === 404,
  );
});

test('selecting a thread moves the default without disturbing anyone watching', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);
  const up = manager.upstream('s1');
  await up.ensureStarted();

  const watcher = fakeHandle(1, 'acp-gone');
  up.attach(watcher);

  const selected = manager.selectThread('s1', 't2');

  assert.equal(selected.id, 't2');
  assert.equal(up.current?.id, 't2');
  // No live connection is pinned to the default, so selecting one is an
  // ordinary write: the browser on the other thread keeps its socket, its
  // transcript and its place.
  assert.equal(watcher.closed, 0);
  assert.equal(watcher.acpThreadId, 'acp-gone');
});

/**
 * Threads in parallel: what has to be true for one thread to keep working
 * while another is used to explore it.
 */

test('a prompt sets the running-turn flag on its own thread and no other', async () => {
  let releasePrompt = (): void => {};
  const held = new Promise<Record<string, never>>((resolve) => {
    releasePrompt = () => resolve({});
  });
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    // The turn does not end until the test lets it, which is what "one thread
    // keeps working" looks like from here.
    if (msg.method === 'session/prompt') return held;
    return {};
  });
  fakeDocker(adapter);
  const up = manager.upstream('s1');
  await up.ensureStarted();

  const inFlight = up.forwardRequest('session/prompt', {
    sessionId: 'acp-gone',
    prompt: [{ type: 'text', text: 'a long job' }],
  });
  await expect.poll(() => thread('t1')['turn_active']).toBe(1);
  // The session's other conversation is not running anything.
  assert.equal(thread('t2')['turn_active'], 0);
  // And the session's own answer is derived from its threads.
  const summary = await manager.detail('s1');
  assert.equal(summary.turnActive, true);
  assert.deepEqual(
    summary.threads.map((t) => t.turnActive),
    [true, false],
  );

  releasePrompt();
  await inFlight;
  await expect.poll(() => thread('t1')['turn_active']).toBe(0);
  assert.equal((await manager.detail('s1')).turnActive, false);
});

test('a permission request goes to a browser watching the thread that asked', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);
  const up = manager.upstream('s1');
  await up.ensureStarted();

  const working = fakeHandle(1, 'acp-gone');
  const exploring = fakeHandle(2, 'acp-kept');
  up.attach(working);
  up.attach(exploring);
  // The most recently active browser overall is on the other thread, which is
  // exactly the case that used to pick the wrong one.
  exploring.lastActiveAt = Date.now() + 1000;

  adapter.push(permissionFrame('acp-gone'));

  await expect.poll(() => working.asked.length).toBe(1);
  assert.equal(exploring.asked.length, 0);
  assert.equal(manager.pending.countForSession('s1'), 0);
});

test('a permission request queues when only another thread has a browser', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);
  const up = manager.upstream('s1');
  await up.ensureStarted();

  const elsewhere = fakeHandle(1, 'acp-kept');
  up.attach(elsewhere);

  adapter.push(permissionFrame('acp-gone'));

  // Nobody is looking at the thread that asked, so it waits, exactly as it
  // does with no browser attached at all. A question about one conversation
  // cannot be answered from another's transcript.
  await expect.poll(() => manager.pending.countForSession('s1')).toBe(1);
  assert.equal(elsewhere.asked.length, 0);
  // And it is counted against the thread that asked, which is what the badge
  // on that thread's row reads.
  assert.deepEqual(
    (await manager.detail('s1')).threads.map((t) => t.pendingCount),
    [1, 0],
  );
});

test('a queued request is delivered only to a browser on its own thread', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);
  const up = manager.upstream('s1');
  await up.ensureStarted();

  adapter.push(permissionFrame('acp-kept'));
  await expect.poll(() => manager.pending.countForSession('s1')).toBe(1);

  const wrongThread = fakeHandle(1, 'acp-gone');
  up.attach(wrongThread);
  up.flushPendingTo(wrongThread);
  assert.equal(wrongThread.asked.length, 0);

  const rightThread = fakeHandle(2, 'acp-kept');
  up.attach(rightThread);
  up.flushPendingTo(rightThread);
  await expect.poll(() => rightThread.asked.length).toBe(1);
});

test('a respawn re-issues session/load for every watched thread', async () => {
  const loaded: string[] = [];
  // A fresh stand-in per spawn, because the first one's stream is destroyed
  // when the adapter it stands in for goes away.
  fakeDocker(
    () =>
      new FakeAdapter((msg) => {
        if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
        if (msg.method === 'session/load') {
          loaded.push(String(msg.params?.['sessionId']));
          return {};
        }
        return {};
      }),
  );
  const up = manager.upstream('s1');
  await up.ensureStarted();
  assert.deepEqual(loaded, ['acp-gone']);

  // A browser on the thread that is not the session's default. Without the
  // reload below, its next prompt would name a thread the adapter has never
  // heard of.
  up.attach(fakeHandle(1, 'acp-kept'));

  // The adapter dies and comes back. The browsers' own sockets are to the
  // gateway, not to it, so nothing on their side notices or re-handshakes.
  up.stop();
  await up.ensureStarted();

  assert.deepEqual(loaded, ['acp-gone', 'acp-gone', 'acp-kept']);
});

test('a respawn that cannot bring a watched thread back drops its browsers', async () => {
  let firstLoadDone = false;
  fakeDocker(
    () =>
      new FakeAdapter((msg) => {
        if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
        if (msg.method === 'session/load') {
          // The default thread always comes back; the watched one is gone by
          // the time the adapter restarts.
          if (msg.params?.['sessionId'] === 'acp-kept' && firstLoadDone) {
            return new Error('Session not found');
          }
          return {};
        }
        if (msg.method === 'session/new') return { sessionId: 'acp-fresh' };
        return {};
      }),
  );
  const up = manager.upstream('s1');
  await up.ensureStarted();
  firstLoadDone = true;

  const stranded = fakeHandle(1, 'acp-kept');
  up.attach(stranded);

  up.stop();
  await up.ensureStarted();

  // Its pinned id is one the adapter would now reject, so its socket is
  // closed: the browser reconnects and pins whatever that thread is next.
  assert.equal(stranded.closed, 1);
  assert.equal(thread('t2')['acp_session_id'], null);
});

test('a connection pins the thread it named, and a bare one gets the default', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);
  const up = manager.upstream('s1');

  const named = fakeHandle(1, null);
  const bare = fakeHandle(2, null);
  up.attach(named);
  up.attach(bare);

  assert.equal(await up.pin(named, 't2'), 'acp-kept');
  assert.equal(await up.pin(bare, null), 'acp-gone');
  assert.equal(named.acpThreadId, 'acp-kept');
  assert.equal(bare.acpThreadId, 'acp-gone');
});

test('pinning to a thread the adapter has forgotten mints one for it', async () => {
  // A thread minted and never prompted: the row exists, the conversation
  // behind it did not survive the adapter restarting.
  db.prepare('UPDATE threads SET acp_session_id = NULL WHERE id = ?').run('t2');

  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    if (msg.method === 'session/new') return { sessionId: 'acp-minted' };
    return {};
  });
  fakeDocker(adapter);
  const up = manager.upstream('s1');

  const handle = fakeHandle(1, null);
  up.attach(handle);

  // There is no transcript to lose, so a fresh conversation in that row is
  // the whole repair — and the id the connection pins is a live one.
  assert.equal(await up.pin(handle, 't2'), 'acp-minted');
  assert.equal(thread('t2')['acp_session_id'], 'acp-minted');
});

test('a fork starts in plan mode where a fresh thread starts in auto', async () => {
  const modeSet: Array<{ session: unknown; mode: unknown }> = [];
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') {
      return {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { fork: {} } },
      };
    }
    const modes = {
      currentModeId: 'default',
      availableModes: [{ id: 'auto' }, { id: 'plan' }, { id: 'default' }],
    };
    if (msg.method === 'session/new') return { sessionId: 'acp-fresh', modes };
    if (msg.method === 'session/fork') return { sessionId: 'acp-branch', modes };
    if (msg.method === 'session/set_mode') {
      modeSet.push({ session: msg.params?.['sessionId'], mode: msg.params?.['modeId'] });
      return {};
    }
    return {};
  });
  fakeDocker(adapter);

  await manager.createThread('s1', undefined);
  await manager.createThread('s1', { from: 't2' });

  // The fork shares the source's checkout, so it starts somewhere that reads
  // rather than writes. It is the user's choice from then on.
  assert.deepEqual(modeSet, [
    { session: 'acp-fresh', mode: 'auto' },
    { session: 'acp-branch', mode: 'plan' },
  ]);
});

/**
 * An adapter whose mode and model are per-process, the way a real one's are.
 *
 * Every spawn starts in `default` on `sonnet` and records what it is asked
 * for, so a test can say what the orchestrator put a thread back into after
 * the process that was holding the answer went away. `notify` speaks as the
 * live one, which is how an adapter reports a change it made itself.
 */
function forgetfulAdapter(asked: string[]): {
  spawn: () => FakeAdapter;
  notify: (update: unknown) => void;
} {
  let live: FakeAdapter | null = null;
  const state = () => ({
    modes: {
      currentModeId: 'default',
      availableModes: [{ id: 'default' }, { id: 'auto' }, { id: 'plan' }],
    },
    configOptions: [
      {
        id: 'model',
        category: 'model',
        currentValue: 'sonnet',
        options: [{ value: 'sonnet' }, { value: 'opus' }],
      },
    ],
  });
  return {
    spawn: () => {
      live = new FakeAdapter((msg) => {
        if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
        if (msg.method === 'session/new') return { sessionId: 'acp-gone', ...state() };
        if (msg.method === 'session/load') return state();
        if (msg.method === 'session/set_mode') {
          asked.push(`mode ${String(msg.params?.['modeId'])}`);
          return {};
        }
        if (msg.method === 'session/set_config_option') {
          asked.push(`model ${String(msg.params?.['value'])}`);
          return {};
        }
        return {};
      });
      return live;
    },
    notify: (update) => live?.notify('session/update', { sessionId: 'acp-gone', update }),
  };
}

test('a respawn puts a loaded thread back in the mode it was left in', async () => {
  const asked: string[] = [];
  const adapter = forgetfulAdapter(asked);
  fakeDocker(adapter.spawn);
  const up = manager.upstream('s1');
  await up.ensureStarted();

  // t1 is stored with an adapter id, so the spawn loads it rather than
  // minting it — and a load used to be where the mode was lost.
  assert.deepEqual(asked, ['mode auto', 'model opus']);

  // The user switches to plan, the way the header does: a request the adapter
  // accepts, naming the thread it is about.
  asked.length = 0;
  await up.forwardRequest('session/set_mode', { sessionId: 'acp-gone', modeId: 'plan' });
  assert.deepEqual(asked, ['mode plan']);
  assert.equal(thread('t1')['mode_id'], 'plan');

  // The idle reaper stops the session, and returning to it starts it again.
  // The adapter is a fresh process in `default`; the thread is put back.
  asked.length = 0;
  up.stop();
  await up.ensureStarted();
  assert.deepEqual(asked, ['mode plan', 'model opus']);
});

test("a respawn honours the adapter's own mode change over the last one asked for", async () => {
  const asked: string[] = [];
  const adapter = forgetfulAdapter(asked);
  fakeDocker(adapter.spawn);
  const up = manager.upstream('s1');
  await up.ensureStarted();
  await up.forwardRequest('session/set_mode', { sessionId: 'acp-gone', modeId: 'plan' });

  // An adapter leaves plan mode by itself once a plan is accepted, and says
  // so. Where the thread comes back is where it actually ended up.
  adapter.notify({ sessionUpdate: 'current_mode_update', currentModeId: 'auto' });
  await expect.poll(() => thread('t1')['mode_id']).toBe('auto');

  asked.length = 0;
  up.stop();
  await up.ensureStarted();
  // `auto`, not the `plan` that was the last thing anybody requested.
  assert.deepEqual(asked, ['mode auto', 'model opus']);
});

test('a respawn puts a loaded thread back on the model it was left on', async () => {
  const asked: string[] = [];
  const adapter = forgetfulAdapter(asked);
  fakeDocker(adapter.spawn);
  const up = manager.upstream('s1');
  await up.ensureStarted();

  // Which option is the model is its category, never the adapter's id for
  // it, so this is a change reported the way a real one is.
  adapter.notify({
    sessionUpdate: 'config_option_update',
    configOptions: [{ id: 'model', category: 'model', currentValue: 'sonnet' }],
  });
  await expect.poll(() => thread('t1')['model_id']).toBe('sonnet');

  // Left on sonnet, so it comes back on sonnet: the deployment's default is
  // for a thread nobody has chosen for, not an answer that overrides one.
  asked.length = 0;
  up.stop();
  await up.ensureStarted();
  assert.deepEqual(asked, ['mode auto']);
});

/** The threads each session/fork named as its source, in order. */
let forkedFrom: unknown[] = [];
/** The threads each session/load asked for, in order. */
let loaded: string[] = [];

/**
 * An adapter that forks, and replays a thread's history when it is loaded.
 *
 * It behaves the way the real one does about a fork: branching answers with a
 * new id, but nothing is written for it until it is prompted, so loading it
 * replays nothing. Only the source has a transcript.
 */
function forkingAdapter(history: Record<string, string>): FakeAdapter {
  let branches = 0;
  forkedFrom = [];
  loaded = [];
  const adapter: FakeAdapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') {
      return {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { fork: {} } },
      };
    }
    if (msg.method === 'session/fork') {
      branches += 1;
      forkedFrom.push(msg.params?.['sessionId']);
      return { sessionId: `acp-branch-${branches}` };
    }
    if (msg.method === 'session/new') return { sessionId: 'acp-fresh' };
    if (msg.method === 'session/load') {
      const of = String(msg.params?.['sessionId']);
      loaded.push(of);
      const said = history[of];
      if (said) {
        adapter.notify('session/update', {
          sessionId: of,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: said } },
        });
      }
      return {};
    }
    return {};
  });
  return adapter;
}

test('a fork with no transcript of its own is shown the one it came from', async () => {
  fakeDocker(forkingAdapter({ 'acp-kept': 'what was said before the fork' }));
  const created = await manager.createThread('s1', { from: 't2' });
  const up = manager.upstream('s1');
  const reader = fakeHandle(1, 'acp-branch-1');
  up.attach(reader);

  // What the spawn loaded on its way up is not what this is about.
  loaded.length = 0;
  await up.forwardRequest(
    'session/load',
    { sessionId: 'acp-branch-1', cwd: '/workspace', mcpServers: [] },
    reader,
  );

  // Its own load replays nothing, so the source's is sent in its place --
  // re-tagged as this thread's, because that is the conversation the browser
  // reading it is pinned to.
  assert.deepEqual(reader.told, [
    {
      sessionId: 'acp-branch-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'what was said before the fork' },
      },
    },
  ]);
  assert.deepEqual(loaded, ['acp-branch-1', 'acp-kept']);
  assert.equal(thread(created.id)['inherits_from'], 't2');
});

test('a fork stops borrowing the moment it is prompted', async () => {
  fakeDocker(forkingAdapter({ 'acp-kept': 'what was said before the fork' }));
  const created = await manager.createThread('s1', { from: 't2' });
  const up = manager.upstream('s1');
  const reader = fakeHandle(1, 'acp-branch-1');
  up.attach(reader);

  await up.forwardRequest('session/prompt', {
    sessionId: 'acp-branch-1',
    prompt: [{ type: 'text', text: 'and now something of my own' }],
  });
  reader.told.length = 0;
  loaded.length = 0;
  await up.forwardRequest(
    'session/load',
    { sessionId: 'acp-branch-1', cwd: '/workspace', mcpServers: [] },
    reader,
  );

  // The adapter writes the fork a transcript at its first prompt, and that
  // transcript opens with everything the source had said. Replaying the
  // source as well would say all of it twice.
  assert.equal(thread(created.id)['inherits_from'], null);
  assert.deepEqual(loaded, ['acp-branch-1']);
  assert.deepEqual(reader.told, []);
});

test('a fork the adapter has forgotten is branched again rather than started empty', async () => {
  fakeDocker(forkingAdapter({}));
  const created = await manager.createThread('s1', { from: 't2' });
  const up = manager.upstream('s1');

  // What an adapter restart leaves behind: the fork was never prompted, so it
  // has no transcript and its id is gone.
  db.prepare('UPDATE threads SET acp_session_id = NULL WHERE id = ?').run(created.id);
  const handle = fakeHandle(1, null);
  up.attach(handle);

  // Branched again, not started empty: the thread exists to carry the
  // source's context, and a restart is not the user changing their mind.
  assert.equal(await up.pin(handle, created.id), 'acp-branch-2');
  assert.deepEqual(forkedFrom, ['acp-kept', 'acp-kept']);
  assert.equal(thread(created.id)['inherits_from'], 't2');
});

test('a fork whose source is gone too is started empty rather than left unpinnable', async () => {
  let branches = 0;
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') {
      return {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { fork: {} } },
      };
    }
    if (msg.method === 'session/fork') {
      branches += 1;
      // The first branch is the fork itself. By the second the adapter has
      // restarted, and the source turns out to have had no transcript either.
      return branches === 1 ? { sessionId: 'acp-branch' } : new Error('Session not found');
    }
    if (msg.method === 'session/new') return { sessionId: 'acp-fresh' };
    return {};
  });
  fakeDocker(adapter);
  const created = await manager.createThread('s1', { from: 't2' });
  const up = manager.upstream('s1');
  db.prepare('UPDATE threads SET acp_session_id = NULL WHERE id = ?').run(created.id);
  const handle = fakeHandle(1, null);
  up.attach(handle);

  // A thread with nothing to say is better than one the browser cannot pin
  // to anything at all.
  assert.equal(await up.pin(handle, created.id), 'acp-fresh');
});

// --- notifications ----------------------------------------------------------

/**
 * What the gateway announces, and when.
 *
 * Both events are gated on the same thing — nobody is watching that thread —
 * because both exist for the same moment: the browser is gone and the box
 * still wants something. A notification for a turn you are looking at is
 * noise, and noise is what gets notifications turned off.
 */

/** An adapter that answers everything, with prompts finishing immediately. */
function plainAdapter(): FakeAdapter {
  return new FakeAdapter((msg) =>
    msg.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} } : {},
  );
}

test('a turn that finishes with nobody watching is announced, naming the thread', async () => {
  fakeDocker(plainAdapter());
  const up = manager.upstream('s1');
  await up.ensureStarted();

  await up.forwardRequest('session/prompt', {
    sessionId: 'acp-gone',
    prompt: [{ type: 'text', text: 'go' }],
  });

  // Not on the prompt coming back: that says the request is over, which is
  // not the same as the agent having finished — see gateway/activity.ts.
  assert.deepEqual(announced, []);
  await expect.poll(() => announced.length, { timeout: 5000 }).toBe(1);
  assert.deepEqual(announced, [
    {
      kind: 'idle',
      sessionId: 's1',
      sessionName: 'test',
      // The dashboard's own id, so the notification can link straight at the
      // conversation rather than at the box.
      threadId: 't1',
      // The agent's own title lands at the end of the turn, so what names
      // the thread here is the prompt that started it — the same name the
      // session list shows.
      threadName: 'go',
      // Nothing was left running, which is what makes this a turn somebody
      // can come back to at their leisure.
      background: false,
    },
  ]);
});

test('a turn that finishes in front of a browser is not announced', async () => {
  fakeDocker(plainAdapter());
  const up = manager.upstream('s1');
  await up.ensureStarted();
  up.attach(fakeHandle(1, 'acp-gone'));

  await up.forwardRequest('session/prompt', {
    sessionId: 'acp-gone',
    prompt: [{ type: 'text', text: 'go' }],
  });
  // Long enough for the quiet window to have passed twice over.
  await new Promise((r) => setTimeout(r, 2500));
  assert.deepEqual(announced, []);
});

test('a browser on another thread does not count as watching this one', async () => {
  fakeDocker(plainAdapter());
  const up = manager.upstream('s1');
  await up.ensureStarted();
  // Watching the session's other conversation: this turn still finished with
  // nobody on it.
  up.attach(fakeHandle(1, 'acp-kept'));

  await up.forwardRequest('session/prompt', {
    sessionId: 'acp-gone',
    prompt: [{ type: 'text', text: 'go' }],
  });
  await expect.poll(() => announced.length, { timeout: 5000 }).toBe(1);
  assert.deepEqual(
    announced.map((e) => [e.kind, e.threadId]),
    [['idle', 't1']],
  );
});

test('a queued permission request is announced as one', async () => {
  const adapter = plainAdapter();
  fakeDocker(adapter);
  const up = manager.upstream('s1');
  await up.ensureStarted();

  // Nobody is attached, so the request is queued rather than delivered.
  adapter.push(permissionFrame('acp-kept'));
  await expect.poll(() => announced.length).toBe(1);
  assert.deepEqual(announced[0], {
    kind: 'approval',
    sessionId: 's1',
    sessionName: 'test',
    threadId: 't2',
    threadName: 'Thread 2',
    background: false,
  });
});

test('a tapped image block is logged without its base64 payload', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    if (msg.method === 'session/new') return { sessionId: 'acp-fresh' };
    return {};
  });
  fakeDocker(adapter);
  const up = manager.upstream('s1');
  await up.ensureStarted();

  const data = 'A'.repeat(100_000);
  adapter.notify('session/update', {
    sessionId: 'acp-gone',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-shot',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'image', mimeType: 'image/png', data } },
        // A terminal's output lives under `data` too, and is exactly what
        // somebody reads this log for.
        { type: 'terminal', terminalId: 'term-1' },
      ],
      _meta: { terminal_output: { terminal_id: 'term-1', data: 'ok 1\nok 2' } },
    },
  });

  const tapped = (): string | undefined =>
    (
      db
        .prepare("SELECT payload FROM acp_log WHERE payload LIKE '%tc-shot%' ORDER BY id DESC")
        .get() as { payload?: string } | undefined
    )?.payload;
  await expect.poll(tapped).toBeDefined();
  const logged = tapped()!;

  // The bytes are gone, their size is not, and the row is nowhere near the
  // 64,000-character truncation that would otherwise have eaten it.
  assert.ok(!logged.includes(data.slice(0, 200)), 'the payload is not in the log');
  assert.ok(logged.includes('[100000 base64 chars omitted]'), 'its size is');
  assert.ok(logged.includes('image/png'), 'and so is its type');
  assert.ok(logged.length < 2000, `the row stays small (${logged.length})`);
  // The terminal output under the same key survived.
  assert.ok(logged.includes('ok 1\\nok 2'), "a terminal's output is untouched");
});

test('work the agent leaves running in the background holds the reaper off', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);

  const up = manager.upstream('s1');
  await up.ensureStarted();
  await up.refreshBackgroundForTests();
  assert.equal(up.backgroundActive, false);

  // The turn backgrounds a command and ends. Nothing else about the session
  // says so: no browser is attached and no turn is running, and the harness
  // tells the orchestrator nothing either. What says so is the shell, which
  // is still there.
  processes = [
    ...processes,
    ['200', '100', "/bin/bash -c source ~/.claude/shell-snapshots/s.sh && eval 'npm run build'"],
  ];
  await up.refreshBackgroundForTests();
  assert.equal(up.backgroundActive, true);

  // An hour later the build is over. Nothing reported it — this is the case
  // the old tally could not see, because it waited to be told — and the box
  // is idle again on the next reading.
  processes = processes.filter((p) => p[0] !== '200');
  await up.refreshBackgroundForTests();
  assert.equal(up.backgroundActive, false);
});

/** The shell a tool call runs in, as the harness wraps one. */
function shell(command: string, token = 'cfec'): string {
  return (
    `/bin/bash -c source ~/.claude/shell-snapshots/s.sh 2>/dev/null || true && ` +
    `eval '${command}' < /dev/null && pwd -P >| /tmp/claude-${token}-cwd`
  );
}

test('a thread is told what it is running, and not what another thread is', async () => {
  // The bug this is here for: one boolean about the whole box, sent to every
  // conversation in it. A command left running by one thread said "something
  // is still running" on a thread opened a minute later, with a stop button
  // beside it that could not have reached the work.
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);

  const up = manager.upstream('s1');
  await up.ensureStarted();
  // A second conversation, with the other thread's id on it.
  processes = [
    ...processes,
    ['300', '19', 'claude --output-format stream-json --session-id=acp-kept'],
    ['200', '100', shell('npm run build')],
  ];
  await up.refreshBackgroundForTests();

  assert.deepEqual(
    up.threadState('acp-gone').background.map((p) => p.command),
    ['npm run build'],
  );
  assert.deepEqual(up.threadState('acp-kept').background, []);
});

test('the session list says which thread is holding the box awake', async () => {
  // The list shows every conversation of a box at once, and until now the
  // only thing it could say was that the box had something running. Which one
  // to open was left to the reader.
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);

  const up = manager.upstream('s1');
  await up.ensureStarted();
  processes = [
    ...processes,
    ['300', '19', 'claude --output-format stream-json --session-id=acp-kept'],
    ['200', '100', shell('npm run build')],
  ];
  await up.refreshBackgroundForTests();

  const [session] = await manager.list();
  assert.equal(session?.backgroundBusy, true);
  assert.deepEqual(
    session?.threads.map((t) => [t.id, t.backgroundBusy]),
    [
      ['t1', true],
      ['t2', false],
    ],
  );
});

test('a thread learns its work has finished without anything reporting it', async () => {
  // Nothing tells Boxes a build is over, so a reading is the only news there
  // is. Without this the bar above a composer appeared and stayed for as long
  // as the thread was open — including after the work had been stopped.
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);

  const up = manager.upstream('s1');
  await up.ensureStarted();
  const watcher = fakeHandle(1, 'acp-gone');
  up.attach(watcher);

  processes = [...processes, ['200', '100', shell('npm run build')]];
  await up.refreshBackgroundForTests();
  const started = watcher.told.filter(
    (params) => Array.isArray((params as TurnStateParams).background),
  ) as TurnStateParams[];
  assert.deepEqual(started.at(-1)?.background.map((p) => p.command), ['npm run build']);

  processes = processes.filter((p) => p[0] !== '200');
  await up.refreshBackgroundForTests();
  const ended = watcher.told.filter(
    (params) => Array.isArray((params as TurnStateParams).background),
  ) as TurnStateParams[];
  assert.deepEqual(ended.at(-1)?.background, []);
});

test('a box nobody has opened is idle, so the reaper can have it', async () => {
  // Boxes keeps no adapter in a container between connections, so this is
  // what an untouched running box looks like: the entrypoint and nothing
  // else. It read as a shape that could not be understood, which counted as
  // busy — a badge on the card and a session the reaper would never stop.
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);
  processes = [
    ['1', '0', '/sbin/docker-init -- /usr/local/bin/entrypoint.sh'],
    ['7', '1', 'sleep infinity'],
  ];

  const up = manager.upstream('s1');
  await up.refreshBackgroundForTests();
  assert.equal(up.backgroundActive, false);
});

test('a box that is not up has nothing running in it, and says so', async () => {
  // The two ways of having nothing to read arrived here as the same empty
  // process table: a box that is down, and a box that would not answer. The
  // second counts as busy, so every stopped session that the orchestrator
  // still had in memory said "still running" — on the card, forever, with no
  // thread able to say what was.
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);

  const up = manager.upstream('s1');
  await up.ensureStarted();
  processes = [...processes, ['200', '100', shell('npm run build')]];
  await up.refreshBackgroundForTests();
  assert.equal(up.backgroundActive, true);

  containerRunning = false;
  await up.refreshBackgroundForTests();
  assert.equal(up.backgroundActive, false);
  const [session] = await manager.list();
  assert.equal(session?.backgroundBusy, false);
  assert.deepEqual(
    session?.threads.map((t) => t.backgroundBusy),
    [false, false],
  );
});

test('stopping a session stops it claiming work, without waiting for a reading', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);

  const up = manager.upstream('s1');
  await up.ensureStarted();
  processes = [...processes, ['200', '100', shell('npm run build')]];
  await up.refreshBackgroundForTests();
  assert.equal(up.backgroundActive, true);

  // The box is going away and what was in it goes with it, so the answer is
  // known without asking. Waiting for the next reading would leave the badge
  // on a session that has just been shut down.
  up.stop();
  assert.equal(up.backgroundActive, false);
});

test('stopping work kills its tree, by the pids the box knows it by', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);

  const up = manager.upstream('s1');
  await up.ensureStarted();
  const build = shell('npm run build');
  processes = [...processes, ['200', '100', build]];
  await up.refreshBackgroundForTests();

  // The same box, read from inside: the same commands under numbers of its
  // own. `docker top` reports the host's pids, and a kill in here would
  // otherwise be aimed at whatever the host happens to run at 200.
  insideProcesses = [
    ['1', '0', '/sbin/docker-init'],
    ['12', '1', 'node /usr/local/bin/claude-agent-acp'],
    ['13', '12', 'claude --output-format stream-json --session-id=acp-gone'],
    ['14', '13', build],
    ['15', '14', 'node .../vite build'],
  ];

  const stopped = await up.stopBackgroundWork('acp-gone', processId(build));
  assert.equal(stopped, 2);
  // Leaves first: a parent killed first hands its children to init, still
  // running and no longer in any reading.
  assert.deepEqual(killed, [['-TERM', '15', '14']]);
});

test('a stop reaches nothing but the work it was asked about', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);

  const up = manager.upstream('s1');
  await up.ensureStarted();
  insideProcesses = [
    ['12', '1', 'node /usr/local/bin/claude-agent-acp'],
    ['13', '12', 'claude --output-format stream-json --session-id=acp-gone'],
    ['14', '13', shell('npm run build')],
    ['20', '12', 'claude --output-format stream-json --session-id=acp-kept'],
    ['21', '20', shell('npm run watch', 'aa')],
  ];

  // Everything one thread is running, and nothing of the other's.
  assert.equal(await up.stopBackgroundWork('acp-kept'), 1);
  assert.deepEqual(killed, [['-TERM', '21']]);

  // And a thread whose work has already ended kills nothing at all.
  killed = [];
  assert.equal(await up.stopBackgroundWork('acp-kept', processId(shell('npm run watch', 'aa'))), 1);
  killed = [];
  insideProcesses = insideProcesses.filter((p) => p[0] !== '21');
  assert.equal(await up.stopBackgroundWork('acp-kept'), 0);
  assert.deepEqual(killed, []);
});

test('a prompt held open for background work is not the agent still talking', async () => {
  // The shape this whole distinction exists for: the adapter defers the
  // prompt's result until what the turn started settles, so the request stays
  // open long after the agent has said its piece.
  let finish!: (result: unknown) => void;
  const held = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    if (msg.method === 'session/prompt') return held;
    return {};
  });
  fakeDocker(adapter);

  const up = manager.upstream('s1');
  await up.ensureStarted();
  const watcher = fakeHandle(1, 'acp-gone');
  up.attach(watcher);

  const prompt = up.forwardRequest('session/prompt', {
    sessionId: 'acp-gone',
    prompt: [{ type: 'text', text: 'build it' }],
  });
  // Forwarding one is enough to say the agent is working: the browser that
  // sent it should not have to wait out the model's first token. (Polled
  // rather than read: forwarding starts by awaiting the connection, so the
  // prompt reaches the adapter a microtask after the call returns.)
  await expect.poll(() => up.threadState('acp-gone').speaking).toBe(true);

  adapter.notify('session/update', {
    sessionId: 'acp-gone',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Started the build. I will report back.' },
    },
  });
  adapter.notify('session/update', {
    sessionId: 'acp-gone',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'toolu_1',
      title: 'npm run build',
      status: 'in_progress',
      rawInput: { command: 'npm run build', run_in_background: true },
      _meta: { claudeCode: { toolName: 'Bash' } },
    },
  });

  // And then it stops. The request is still open, and nothing about it says
  // so — which is the entire bug: silence, and a bit that reads "running".
  await expect.poll(() => up.threadState('acp-gone').speaking, { timeout: 5000 }).toBe(false);
  const state = up.threadState('acp-gone');
  assert.equal(state.active, true);
  // Nothing was read out of a box — there is no container under this test —
  // so nothing is claimed to be running in one.
  assert.deepEqual(state.background, []);

  // The browser watching was told all of it, without asking.
  const told = watcher.told.filter(
    (params) => typeof (params as { speaking?: unknown }).speaking === 'boolean',
  ) as TurnStateParams[];
  assert.equal(told.at(-1)?.speaking, false);
  assert.deepEqual(told.at(-1)?.background, []);
  // Nobody was notified: somebody is looking at this thread.
  assert.deepEqual(announced, []);

  finish({ stopReason: 'end_turn' });
  await prompt;
});

test("the adapter's own end-of-cycle update ends the turn without waiting", async () => {
  const adapter = new FakeAdapter((msg) =>
    msg.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} } : {},
  );
  fakeDocker(adapter);

  const up = manager.upstream('s1');
  await up.ensureStarted();
  const watcher = fakeHandle(1, 'acp-gone');
  up.attach(watcher);

  adapter.notify('session/update', {
    sessionId: 'acp-gone',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'here you go' },
    },
  });
  await expect.poll(() => up.threadState('acp-gone').speaking).toBe(true);

  // The one the adapter sends while a message streams says nothing about the
  // end: tokens and a window, no cost.
  adapter.notify('session/update', {
    sessionId: 'acp-gone',
    update: { sessionUpdate: 'usage_update', used: 12_000, size: 200_000 },
  });
  assert.equal(up.threadState('acp-gone').speaking, true);

  // The one it sends at the end of a cycle carries the cycle's cost, and is
  // taken at its word — no quiet window waited out.
  adapter.notify('session/update', {
    sessionId: 'acp-gone',
    update: {
      sessionUpdate: 'usage_update',
      used: 12_400,
      size: 200_000,
      cost: { amount: 0.03, currency: 'USD' },
    },
  });
  await expect.poll(() => up.threadState('acp-gone').speaking).toBe(false);
});

test('a replayed transcript is history, not work to wait for', async () => {
  // The adapter re-sends the thread on load, which is how replay works
  // everywhere else in the gateway. Among it is a command backgrounded in
  // some earlier life of the container, and it is not running now.
  const adapter: FakeAdapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    if (msg.method === 'session/load') {
      adapter.notify('session/update', {
        sessionId: 'acp-gone',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'toolu_old',
          title: 'npm run build',
          status: 'completed',
          rawInput: { command: 'npm run build', run_in_background: true },
          _meta: { claudeCode: { toolName: 'Bash' } },
        },
      });
    }
    return {};
  });
  fakeDocker(adapter);

  const up = manager.upstream('s1');
  await up.ensureStarted();
  assert.equal(up.backgroundActive, false);
});
