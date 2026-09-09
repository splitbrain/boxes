import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { buildApp, type Orchestrator } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb, type Db } from './db.ts';
import * as dk from './docker.ts';
import * as ws from './workspaces.ts';

/**
 * Sweeping what a session left behind.
 *
 * Everything Boxes creates carries its session's id as a label, and boot
 * reconciliation reads that one way only — for each row, what Docker has. So
 * a container, network or volume whose row is gone was invisible: no card
 * lists it, no teardown will ever be run for it again, and a home volume of
 * it holds whatever the agent installed at runtime.
 *
 * What makes the rule exact rather than a guess is the order create() works
 * in: the row exists before any Docker object does, so a labelled object with
 * no live row cannot be one on its way up.
 */

/** The daemon this suite pretends to talk to. */
interface Fake {
  containers: Map<string, { sessionId: string; running: boolean }>;
  networks: Map<string, string>;
  volumes: Map<string, string>;
  /** Names of objects the sweep removed, in the order it removed them. */
  removed: string[];
  /** Objects the daemon refuses to remove, by name. */
  stuck: Set<string>;
}

function install(fake: Fake): void {
  const refuse = (name: string): void => {
    if (fake.stuck.has(name)) throw Object.assign(new Error('in use'), { statusCode: 409 });
  };
  dk.setDockerForTests({
    listContainers: async () =>
      [...fake.containers].map(([id, c]) => ({
        Id: id,
        State: c.running ? 'running' : 'exited',
        Labels: { [dk.LABEL]: c.sessionId },
      })),
    listNetworks: async () =>
      [...fake.networks].map(([name, sessionId]) => ({
        Name: name,
        Labels: { [dk.LABEL]: sessionId },
      })),
    listVolumes: async () => ({
      Volumes: [...fake.volumes].map(([name, sessionId]) => ({
        Name: name,
        Labels: { [dk.LABEL]: sessionId },
      })),
    }),
    getContainer: (id: string) => ({
      remove: async () => {
        refuse(id);
        fake.removed.push(id);
        fake.containers.delete(id);
      },
    }),
    getNetwork: (name: string) => ({
      disconnect: async () => {},
      remove: async () => {
        refuse(name);
        fake.removed.push(name);
        fake.networks.delete(name);
      },
    }),
    getVolume: (name: string) => ({
      remove: async () => {
        refuse(name);
        fake.removed.push(name);
        fake.volumes.delete(name);
      },
    }),
  } as unknown as Docker);
}

let dir: string;
let db: Db;
let orchestrator: Orchestrator;
let fake: Fake;

/** A session row, and the objects Boxes would have created for it. */
function insertSession(id: string, status = 'stopped'): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, workspace_dir, status,
       current_thread_id, created_at, last_active_at)
     VALUES (?, 'test', 'DEFAULT', 'img', '["claude-agent-acp"]', ?,
       ?, '10.200.0.0/24', '', ?, ?, ?, NULL, ?, ?)`,
  ).run(id, `c-${id}`, `sn-${id}`, `home-${id}`, `${dir}/workspaces/${id}`, status, now, now);
}

/** The Docker objects and the workspace one session owns. */
function insertObjects(id: string): void {
  fake.containers.set(`c-${id}`, { sessionId: id, running: false });
  fake.networks.set(`sn-${id}`, id);
  fake.volumes.set(`home-${id}`, id);
  const workspace = ws.createWorkspace(orchestrator.cfg.DATA_DIR, id);
  writeFileSync(join(workspace, 'work.txt'), 'the agent was here');
}

function workspaceOf(id: string): string {
  return ws.workspacePath(orchestrator.cfg.DATA_DIR, id);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-orphans-'));
  fake = {
    containers: new Map(),
    networks: new Map(),
    volumes: new Map(),
    removed: [],
    stuck: new Set(),
  };
  install(fake);
  db = openDb(dir);
  orchestrator = buildApp(loadConfig({ DATA_DIR: dir }), db);
});

afterEach(async () => {
  rmSync(ws.workspacesRoot(orchestrator.cfg.DATA_DIR), { recursive: true, force: true });
  await orchestrator.app.close();
  db.close();
  dk.setDockerForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('sweeping objects no session owns', () => {
  it('takes the container, the network, the volume and the workspace', async () => {
    insertSession('live');
    insertObjects('live');
    // A session that was deleted, and whose teardown did not finish.
    insertSession('gone', 'deleted');
    insertObjects('gone');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, ['c-gone', 'sn-gone', 'home-gone']);
    assert.ok(!existsSync(workspaceOf('gone')));
    // And nothing of the session that is still there.
    assert.ok(existsSync(workspaceOf('live')));
    assert.ok(fake.containers.has('c-live'));
    assert.ok(fake.volumes.has('home-live'));
  });

  it('removes the container before the network and the volume it holds', async () => {
    insertSession('keep');
    insertSession('gone', 'deleted');
    insertObjects('gone');

    await orchestrator.manager.sweepOrphans();

    // Docker refuses a network with a container on it, and a volume mounted
    // into one, so the order is the whole of whether this works.
    assert.deepEqual(fake.removed, ['c-gone', 'sn-gone', 'home-gone']);
  });

  it('leaves a session that is still being created alone', async () => {
    // create() inserts the row before it makes anything, so a half-built
    // session always has one. Its objects are not orphans.
    insertSession('newborn', 'creating');
    insertObjects('newborn');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, []);
    assert.ok(existsSync(workspaceOf('newborn')));
  });

  it('keeps going when one object cannot be removed', async () => {
    insertSession('keep');
    insertSession('gone', 'deleted');
    insertObjects('gone');
    fake.stuck.add('sn-gone');

    await orchestrator.manager.sweepOrphans();

    // The network stays for the next sweep; nothing behind it is held up.
    assert.deepEqual(fake.removed, ['c-gone', 'home-gone']);
    assert.ok(fake.networks.has('sn-gone'));
    assert.ok(!existsSync(workspaceOf('gone')));
  });

  it('does nothing at all when every object has a session', async () => {
    insertSession('a');
    insertObjects('a');
    insertSession('b');
    insertObjects('b');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, []);
  });

  it('refuses to sweep for a database that knows of no session at all', async () => {
    // A data volume mounted from the wrong place, or replaced: the rows are
    // gone but the host's sessions are not, and taking their home volumes is
    // the one loss here with nothing to recover it from.
    insertObjects('orphan-by-accident');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, []);
    assert.ok(existsSync(workspaceOf('orphan-by-accident')));
  });

  it('sweeps for a deployment whose sessions have all been deleted', async () => {
    // The tombstone is what tells the two cases apart: this database made
    // these objects, and one of its teardowns did not finish.
    insertSession('gone', 'deleted');
    insertObjects('gone');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, ['c-gone', 'sn-gone', 'home-gone']);
  });
});
