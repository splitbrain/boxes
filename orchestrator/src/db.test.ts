import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, openDb, type Db } from './db.ts';

/**
 * The migrations that moved a session's conversation onto its threads.
 *
 * A deployment upgrading in place has live sessions whose conversation is a
 * single `sessions.acp_session_id`, and that conversation has to survive as
 * the session's first thread. What was session-wide about a running turn then
 * moves onto the thread it is about.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-db-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Builds a database at the version just before threads existed. */
function atVersion3(withAcpSessionId: string | null): void {
  const db = new Database(join(dir, 'boxes.db'));
  for (const sql of MIGRATIONS.slice(0, 3)) db.exec(sql);
  db.pragma('user_version = 3');
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, acp_session_id,
       turn_active, created_at, last_active_at)
     VALUES ('s1', 'old session', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       'sn-s1', '10.200.0.0/24', 'ws-s1', 'home-s1', 'running', ?, 0, 1000, 2000)`,
  ).run(withAcpSessionId);
  db.close();
}

/** The columns a table has, by name. */
function columns(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

test('an existing conversation becomes the session first thread', () => {
  atVersion3('acp-abc');
  const db = openDb(dir);
  try {
    const threads = db.prepare('SELECT * FROM threads').all() as Array<Record<string, unknown>>;
    assert.equal(threads.length, 1);
    assert.equal(threads[0]!['session_id'], 's1');
    assert.equal(threads[0]!['acp_session_id'], 'acp-abc');
    assert.equal(threads[0]!['ordinal'], 1);
    // The session's own timestamps carry over: the thread is that session's
    // conversation, not a new one made today.
    assert.equal(threads[0]!['created_at'], 1000);
    assert.equal(threads[0]!['last_active_at'], 2000);

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as Record<
      string,
      unknown
    >;
    assert.equal(session['current_thread_id'], threads[0]!['id']);
    // The column it replaces is gone, so nothing can keep writing to it.
    assert.ok(!columns(db, 'sessions').includes('acp_session_id'));
  } finally {
    db.close();
  }
});

test('a session that never had a conversation gets no thread', () => {
  atVersion3(null);
  const db = openDb(dir);
  try {
    const count = db.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number };
    assert.equal(count.n, 0);
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as Record<
      string,
      unknown
    >;
    // The orchestrator mints one on the next spawn, exactly as it did before.
    assert.equal(session['current_thread_id'], null);
  } finally {
    db.close();
  }
});

/** Builds a database at the version just before turns moved onto threads. */
function atVersion4(turnActive: number): void {
  const db = new Database(join(dir, 'boxes.db'));
  for (const sql of MIGRATIONS.slice(0, 4)) db.exec(sql);
  db.pragma('user_version = 4');
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       turn_active, created_at, last_active_at)
     VALUES ('s1', 'busy session', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       'sn-s1', '10.200.0.0/24', 'ws-s1', 'home-s1', 'running', 't1', ?, 1000, 2000)`,
  ).run(turnActive);
  db.prepare(
    `INSERT INTO threads (id, session_id, acp_session_id, title, ordinal,
       created_at, last_active_at)
     VALUES ('t1', 's1', 'acp-abc', NULL, 1, 1000, 2000)`,
  ).run();
  db.close();
}

test('a running turn moves onto the threads, starting cleared', () => {
  // Mid-turn when the orchestrator went down, which is the state the upgrade
  // actually meets.
  atVersion4(1);
  const db = openDb(dir);
  try {
    // Not a loss of state but the truth: a turn cannot survive the restart
    // that applies the migration, so every thread starts at 0.
    const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get('t1') as Record<
      string,
      unknown
    >;
    assert.equal(thread['turn_active'], 0);
    // The column it replaces is gone, so nothing can keep writing to it.
    assert.ok(!columns(db, 'sessions').includes('turn_active'));
    // And the thread's conversation and identity are untouched by the move.
    assert.equal(thread['acp_session_id'], 'acp-abc');
    assert.equal(thread['ordinal'], 1);
  } finally {
    db.close();
  }
});

test('a queued permission request gains the thread that asked', () => {
  atVersion4(0);
  const db = openDb(dir);
  try {
    // Nullable and unbackfilled on purpose: clearStale drops every row left
    // by a previous process at boot, so no existing row outlives the change.
    assert.ok(columns(db, 'pending_requests').includes('acp_session_id'));
  } finally {
    db.close();
  }
});

/**
 * Builds a database at the version before push subscriptions, workspace
 * directories and the review columns — the last state a deployment could be in
 * without any of the three.
 */
function atVersion5(): void {
  const db = new Database(join(dir, 'boxes.db'));
  for (const sql of MIGRATIONS.slice(0, 5)) db.exec(sql);
  db.pragma('user_version = 5');
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       created_at, last_active_at)
     VALUES ('s1', 'volume session', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       'sn-s1', '10.200.0.0/24', 'ws-s1', 'home-s1', 'stopped', NULL, 1000, 2000)`,
  ).run();
  db.close();
}

test('a volume-backed session keeps its volume and gains no directory', () => {
  atVersion5();
  const db = openDb(dir);
  try {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as Record<
      string,
      unknown
    >;
    // Nothing is moved by the migration itself: the files are in a named
    // volume this process has no path to, and only a start can recreate the
    // container with the new mount.
    assert.equal(session['ws_volume'], 'ws-s1');
    assert.equal(session['workspace_dir'], null);
    assert.ok(columns(db, 'sessions').includes('workspace_dir'));
  } finally {
    db.close();
  }
});

/**
 * A deployment already running the push-notification release, upgrading to
 * this one.
 *
 * The two features were built on separate branches and both added a migration
 * at the same index. Whichever shipped first has to keep its index, or a
 * database that already applied it skips it and runs the wrong statement in
 * its place — so this asserts the order rather than trusting the merge that
 * chose it.
 */
test('a deployment on the previous release upgrades cleanly', () => {
  const db = new Database(join(dir, 'boxes.db'));
  for (const sql of MIGRATIONS.slice(0, 6)) db.exec(sql);
  db.pragma('user_version = 6');
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       created_at, last_active_at)
     VALUES ('live', 'on the old release', 'DEFAULT', 'img', '[]', 'c1',
       'sn-live', '10.200.0.0/24', 'ws-live', 'home-live', 'stopped', NULL, 1000, 2000)`,
  ).run();
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label,
       created_at, last_used_at)
     VALUES ('https://push.example/x', 'key', 'auth', 'phone', 1000, 2000)`,
  ).run();
  db.close();

  const upgraded = openDb(dir);
  try {
    const sessions = columns(upgraded, 'sessions');
    assert.ok(sessions.includes('workspace_dir'));
    // The review's base revision survives as the expression it always was.
    assert.ok(sessions.includes('review_base_rev'));
    // Its root and its resolved commit do not: the review is over the whole
    // workspace now, and one expression resolves separately in every
    // repository the workspace holds, so neither can mean anything.
    assert.ok(!sessions.includes('review_root'));
    assert.ok(!sessions.includes('review_base_commit'));

    // The migration that shipped first kept its index, so what it created is
    // still there and still holds its rows.
    assert.ok(columns(upgraded, 'push_subscriptions').includes('endpoint'));
    const push = upgraded
      .prepare('SELECT COUNT(*) AS n FROM push_subscriptions')
      .get() as { n: number };
    assert.equal(push.n, 1);

    // And the session that predates workspace directories is untouched: it
    // migrates at its next start, not here.
    const row = upgraded
      .prepare("SELECT ws_volume, workspace_dir FROM sessions WHERE id = 'live'")
      .get() as { ws_volume: string; workspace_dir: string | null };
    assert.deepEqual(row, { ws_volume: 'ws-live', workspace_dir: null });
  } finally {
    upgraded.close();
  }
});

test('threads from before the mode column upgrade to the deployment default', () => {
  const db = new Database(join(dir, 'boxes.db'));
  const before = MIGRATIONS.length - 1;
  for (const sql of MIGRATIONS.slice(0, before)) db.exec(sql);
  db.pragma(`user_version = ${before}`);
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       created_at, last_active_at)
     VALUES ('live', 'from before modes were kept', 'DEFAULT', 'img', '[]', 'c1',
       'sn-live', '10.200.0.0/24', '', 'home-live', 'running', 't1', 1000, 2000)`,
  ).run();
  db.prepare(
    `INSERT INTO threads (id, session_id, acp_session_id, title, ordinal,
       created_at, last_active_at)
     VALUES ('t1', 'live', 'acp-1', NULL, 1, 1000, 2000)`,
  ).run();
  db.close();

  const upgraded = openDb(dir);
  try {
    assert.ok(columns(upgraded, 'threads').includes('mode_id'));
    assert.ok(columns(upgraded, 'threads').includes('model_id'));

    // No backfill, because null already says the right thing: this thread is
    // in whatever the deployment starts one in. Nothing has to guess what a
    // conversation from before the column was in.
    const row = upgraded
      .prepare("SELECT mode_id, model_id FROM threads WHERE id = 't1'")
      .get() as { mode_id: string | null; model_id: string | null };
    assert.deepEqual(row, { mode_id: null, model_id: null });
  } finally {
    upgraded.close();
  }
});

test('the agent tables arrive with a global set, and existing sessions select none', () => {
  const db = new Database(join(dir, 'boxes.db'));
  for (const sql of MIGRATIONS.slice(0, 8)) db.exec(sql);
  db.pragma('user_version = 8');
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       created_at, last_active_at)
     VALUES ('live', 'from before agent sets', 'DEFAULT', 'img', '[]', 'c1',
       'sn-live', '10.200.0.0/24', '', 'home-live', 'stopped', NULL, 1000, 2000)`,
  ).run();
  db.close();

  const upgraded = openDb(dir);
  try {
    // Seeded by the migration rather than created on demand: a deployment has
    // exactly one always-applied set from the moment it has any.
    const sets = upgraded.prepare('SELECT id, name FROM agent_sets').all();
    assert.deepEqual(sets, [{ id: 'global', name: 'Global' }]);

    // A session that predates the feature gets the global set and nothing
    // else, which is what a null column means.
    assert.ok(columns(upgraded, 'sessions').includes('agent_set_id'));
    const row = upgraded
      .prepare("SELECT agent_set_id FROM sessions WHERE id = 'live'")
      .get() as { agent_set_id: string | null };
    assert.equal(row.agent_set_id, null);
  } finally {
    upgraded.close();
  }
});
