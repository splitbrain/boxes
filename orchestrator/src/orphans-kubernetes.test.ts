import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { buildApp, type Orchestrator } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb, type Db } from './db.ts';
import * as k8s from './kubernetes.ts';

/**
 * Sweeping what a box left behind, and boot reconciliation — the
 * Kubernetes side of orphans.test.ts.
 *
 * `sweepOrphans()`/`reconcile()` themselves are backend-neutral (see
 * boxes.ts): they read whatever `runtime().boxes.listBoxContainers/
 * Networks/Volumes()` answers and act on it without knowing whether that
 * came from dockerode or from a Kubernetes list call. What is Kubernetes-
 * specific is only what those three calls return here — pods, PVCs and
 * NetworkPolicies instead of containers, volumes and networks — and, in
 * particular, that a NetworkPolicy's `name` a listing hands back is not the
 * bare box id the way a Docker network's row conveniently is. That
 * mismatch was a real bug (removeNetwork double-prefixed the name it was
 * given), now fixed in kubernetes-runtime.ts; the first test below is its
 * regression guard.
 */

/** The cluster this suite pretends to talk to. */
interface Fake {
  pods: Map<string, { boxId: string; running: boolean }>;
  claims: Map<string, string>;
  policies: Map<string, string>;
  /** Names of objects the sweep removed, in the order it removed them. */
  removed: string[];
  /** Objects the cluster refuses to remove, by name. */
  stuck: Set<string>;
  /** Run as the cluster answers a PVC listing, for what happens mid-sweep. */
  whileListing?: () => void;
}

function install(fake: Fake): void {
  const refuse = (name: string): void => {
    if (fake.stuck.has(name)) throw Object.assign(new Error('in use'), { code: 409 });
  };
  k8s.setKubernetesForTests({
    core: {
      listNamespacedPod: async () => ({
        items: [...fake.pods].map(([name, p]) => ({
          metadata: { name, labels: { [k8s.LABEL]: p.boxId } },
          status: { phase: p.running ? 'Running' : 'Succeeded' },
        })),
      }),
      readNamespacedPod: async (params: { name: string }) => {
        const p = fake.pods.get(params.name);
        if (!p) throw Object.assign(new Error('not found'), { code: 404 });
        return { status: { phase: p.running ? 'Running' : 'Succeeded' } };
      },
      deleteNamespacedPod: async (params: { name: string }) => {
        refuse(params.name);
        if (!fake.pods.has(params.name)) throw Object.assign(new Error('not found'), { code: 404 });
        fake.removed.push(params.name);
        fake.pods.delete(params.name);
      },
      listNamespacedPersistentVolumeClaim: async () => {
        fake.whileListing?.();
        return {
          items: [...fake.claims].map(([name, boxId]) => ({
            metadata: { name, labels: { [k8s.LABEL]: boxId } },
          })),
        };
      },
      deleteNamespacedPersistentVolumeClaim: async (params: { name: string }) => {
        refuse(params.name);
        if (!fake.claims.has(params.name)) throw Object.assign(new Error('not found'), { code: 404 });
        fake.removed.push(params.name);
        fake.claims.delete(params.name);
      },
    },
    networking: {
      listNamespacedNetworkPolicy: async () => ({
        items: [...fake.policies].map(([name, boxId]) => ({
          metadata: { name, labels: { [k8s.LABEL]: boxId } },
        })),
      }),
      readNamespacedNetworkPolicy: async (params: { name: string }) => {
        if (!fake.policies.has(params.name)) throw Object.assign(new Error('not found'), { code: 404 });
        return {};
      },
      deleteNamespacedNetworkPolicy: async (params: { name: string }) => {
        refuse(params.name);
        if (!fake.policies.has(params.name)) throw Object.assign(new Error('not found'), { code: 404 });
        fake.removed.push(params.name);
        fake.policies.delete(params.name);
      },
      createNamespacedNetworkPolicy: async (params: { body: { metadata: { name: string } } }) => {
        fake.policies.set(params.body.metadata.name, '');
      },
    },
    exec: { exec: async () => { throw new Error('not used'); } },
  } as never);
}

let dir: string;
let db: Db;
let orchestrator: Orchestrator;
let fake: Fake;

/** A box row, and the Kubernetes objects Boxes would have created for it. */
function insertBox(id: string, status = 'stopped'): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO boxes (id, name, profile, image, container_id,
       network_name, subnet, ws_volume, home_volume, workspace_dir, home_dir,
       status, created_at, last_active_at)
     VALUES (?, 'test', 'DEFAULT', 'img', ?,
       ?, '10.200.0.0/24', '', '', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    k8s.podName(id),
    k8s.networkPolicyName(id),
    `${dir}/workspaces/${id}`,
    `${dir}/homes/${id}`,
    status,
    now,
    now,
  );
}

/** The Kubernetes objects one box owns — no local directories, unlike a Docker box. */
function insertObjects(id: string): void {
  fake.pods.set(k8s.podName(id), { boxId: id, running: false });
  fake.claims.set(k8s.workspaceClaimName(id), id);
  fake.claims.set(k8s.homeClaimName(id), id);
  fake.claims.set(k8s.nixClaimName(id), id);
  fake.policies.set(k8s.networkPolicyName(id), id);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-orphans-k8s-'));
  fake = {
    pods: new Map(),
    claims: new Map(),
    policies: new Map(),
    removed: [],
    stuck: new Set(),
  };
  install(fake);
  db = openDb(dir);
  orchestrator = buildApp(loadConfig({ DATA_DIR: dir, RUNTIME: 'kubernetes' }), db);
});

afterEach(async () => {
  await orchestrator.app.close();
  db.close();
  k8s.setKubernetesForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('sweeping objects no box owns', () => {
  it('takes the pod, every PVC and the NetworkPolicy, under their real names', async () => {
    insertBox('live');
    insertObjects('live');
    // A box that was deleted, and whose teardown did not finish.
    insertBox('gone', 'deleted');
    insertObjects('gone');

    await orchestrator.manager.sweepOrphans();

    // The regression this file exists for: removeNetwork used to be handed
    // this exact name and double-prefix it (`boxes-netpol-boxes-netpol-gone`),
    // so the policy was never actually found and removed.
    assert.ok(
      fake.removed.includes(k8s.networkPolicyName('gone')),
      `expected ${k8s.networkPolicyName('gone')} among removed: ${fake.removed.join(', ')}`,
    );
    assert.ok(fake.removed.includes(k8s.podName('gone')));
    assert.ok(fake.removed.includes(k8s.workspaceClaimName('gone')));
    assert.ok(fake.removed.includes(k8s.homeClaimName('gone')));
    assert.ok(fake.removed.includes(k8s.nixClaimName('gone')));
    // And nothing of the box that is still there.
    assert.ok(fake.pods.has(k8s.podName('live')));
    assert.ok(fake.claims.has(k8s.workspaceClaimName('live')));
    assert.ok(fake.claims.has(k8s.homeClaimName('live')));
    assert.ok(fake.claims.has(k8s.nixClaimName('live')));
    assert.ok(fake.policies.has(k8s.networkPolicyName('live')));
  });

  it('removes the pod before the NetworkPolicy and the PVCs it holds', async () => {
    insertBox('keep');
    insertBox('gone', 'deleted');
    insertObjects('gone');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, [
      k8s.podName('gone'),
      k8s.networkPolicyName('gone'),
      k8s.workspaceClaimName('gone'),
      k8s.homeClaimName('gone'),
      k8s.nixClaimName('gone'),
    ]);
  });

  it('leaves a box that is still being created alone', async () => {
    insertBox('newborn', 'creating');
    insertObjects('newborn');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, []);
    assert.ok(fake.pods.has(k8s.podName('newborn')));
  });

  it('leaves a box created while it was reading the cluster alone', async () => {
    insertBox('keep');
    fake.whileListing = (): void => {
      insertBox('newborn', 'creating');
      insertObjects('newborn');
    };

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, []);
    assert.ok(fake.pods.has(k8s.podName('newborn')));
  });

  it('keeps going when one object cannot be removed', async () => {
    insertBox('keep');
    insertBox('gone', 'deleted');
    insertObjects('gone');
    fake.stuck.add(k8s.networkPolicyName('gone'));

    await orchestrator.manager.sweepOrphans();

    // The policy stays for the next sweep; nothing behind it is held up.
    assert.deepEqual(fake.removed, [
      k8s.podName('gone'),
      k8s.workspaceClaimName('gone'),
      k8s.homeClaimName('gone'),
      k8s.nixClaimName('gone'),
    ]);
    assert.ok(fake.policies.has(k8s.networkPolicyName('gone')));
  });

  it('does nothing at all when every object has a box', async () => {
    insertBox('a');
    insertObjects('a');
    insertBox('b');
    insertObjects('b');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, []);
  });

  it('refuses to sweep for a database that knows of no box at all', async () => {
    insertObjects('orphan-by-accident');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, []);
    assert.ok(fake.pods.has(k8s.podName('orphan-by-accident')));
  });

  it('refuses when the host holds far more boxes than the database knows of', async () => {
    insertBox('created-against-the-wrong-database');
    for (const id of ['a', 'b', 'c', 'd']) insertObjects(id);

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, []);
    assert.ok(fake.claims.has(k8s.workspaceClaimName('a')));
  });

  it('still sweeps a handful of strays beside a database that knows its boxes', async () => {
    for (const id of ['live-1', 'live-2', 'live-3']) insertBox(id);
    insertBox('gone', 'deleted');
    insertObjects('gone');

    await orchestrator.manager.sweepOrphans();

    assert.ok(fake.removed.includes(k8s.networkPolicyName('gone')));
  });

  it('sweeps for a deployment whose boxes have all been deleted', async () => {
    insertBox('gone', 'deleted');
    insertObjects('gone');

    await orchestrator.manager.sweepOrphans();

    assert.deepEqual(fake.removed, [
      k8s.podName('gone'),
      k8s.networkPolicyName('gone'),
      k8s.workspaceClaimName('gone'),
      k8s.homeClaimName('gone'),
      k8s.nixClaimName('gone'),
    ]);
  });
});

describe('boot reconciliation', () => {
  it('fails a create that the last orchestrator did not finish', async () => {
    insertBox('newborn', 'creating');
    insertObjects('newborn');
    fake.pods.delete(k8s.podName('newborn'));

    await orchestrator.manager.reconcile();

    const row = db.prepare('SELECT status FROM boxes WHERE id = ?').get('newborn') as {
      status: string;
    };
    assert.equal(row.status, 'error');
  });

  it('adopts a half-created box whose pod is up', async () => {
    insertBox('newborn', 'creating');
    insertObjects('newborn');
    fake.pods.set(k8s.podName('newborn'), { boxId: 'newborn', running: true });

    await orchestrator.manager.reconcile();

    const row = db.prepare('SELECT status FROM boxes WHERE id = ?').get('newborn') as {
      status: string;
    };
    assert.equal(row.status, 'running');
  });

  it('leaves an already-stopped box alone when its pod is simply gone', async () => {
    // The common Kubernetes case reconcile() has to get right: stop() deletes
    // the pod, so most rows a real deployment reconciles at boot are already
    // 'stopped' and have no pod at all — that is not the missing-container
    // warning a 'running' row with no pod gets (see the other two tests in
    // this describe block), just the ordinary rest state.
    insertBox('idle', 'stopped');

    await orchestrator.manager.reconcile();

    const row = db.prepare('SELECT status FROM boxes WHERE id = ?').get('idle') as {
      status: string;
    };
    assert.equal(row.status, 'stopped');
  });
});
