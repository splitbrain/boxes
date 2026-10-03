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
 * The Kubernetes side of boximage.test.ts.
 *
 * There is no image roll-forward to test here: `BoxImageRuntime` is
 * entirely no-op for Kubernetes (see runtime/kubernetes-runtime.ts's `images`
 * object, already covered at the adapter level by
 * runtime/kubernetes-runtime.test.ts's "never reports an image roll-forward
 * opportunity"). What this file checks instead is the two things that follow
 * from that no-op-ness in `BoxManager` itself: `ensureBoxImage()`/
 * `refreshBoxImage()` run cleanly against it rather than assuming a
 * Docker-shaped answer, and `rollOntoCurrentImage()`'s `!wanted || !current`
 * early return means a redundant `start()` on an already-running box
 * recreates nothing — Kubernetes has no image tag to have moved.
 */

interface Fake {
  pods: Map<string, { boxId: string; running: boolean }>;
  claims: Set<string>;
  policies: Set<string>;
  podsCreated: string[];
  podsDeleted: string[];
}

function install(fake: Fake): void {
  k8s.setKubernetesForTests({
    core: {
      createNamespacedPod: async (params: { body: { metadata: { name: string } } }) => {
        const name = params.body.metadata.name;
        fake.podsCreated.push(name);
        fake.pods.set(name, { boxId: '', running: true });
        return params.body;
      },
      readNamespacedPod: async (params: { name: string }) => {
        const p = fake.pods.get(params.name);
        if (!p) throw Object.assign(new Error('not found'), { code: 404 });
        return {
          status: { phase: p.running ? 'Running' : 'Succeeded' },
          spec: { containers: [{ name: 'box', volumeMounts: [{ mountPath: '/boxes/agent' }] }] },
        };
      },
      deleteNamespacedPod: async (params: { name: string }) => {
        if (!fake.pods.has(params.name)) throw Object.assign(new Error('not found'), { code: 404 });
        fake.podsDeleted.push(params.name);
        fake.pods.delete(params.name);
      },
      createNamespacedPersistentVolumeClaim: async (params: { body: { metadata: { name: string } } }) => {
        fake.claims.add(params.body.metadata.name);
        return params.body;
      },
      deleteNamespacedPersistentVolumeClaim: async (params: { name: string }) => {
        fake.claims.delete(params.name);
      },
      readNamespace: async () => ({}),
    },
    networking: {
      readNamespacedNetworkPolicy: async (params: { name: string }) => {
        if (!fake.policies.has(params.name)) throw Object.assign(new Error('not found'), { code: 404 });
        return {};
      },
      createNamespacedNetworkPolicy: async (params: { body: { metadata: { name: string } } }) => {
        fake.policies.add(params.body.metadata.name);
      },
      deleteNamespacedNetworkPolicy: async (params: { name: string }) => {
        fake.policies.delete(params.name);
      },
    },
    exec: { exec: async () => { throw new Error('not used'); } },
  } as never);
}

let dir: string;
let db: Db;
let orchestrator: Orchestrator;
let fake: Fake;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-boximage-k8s-'));
  fake = { pods: new Map(), claims: new Set(), policies: new Set(), podsCreated: [], podsDeleted: [] };
  install(fake);
  db = openDb(dir);
  orchestrator = buildApp(loadConfig({ DATA_DIR: dir, RUNTIME: 'kubernetes' }), db);
  await orchestrator.egress.prepare();
});

afterEach(async () => {
  await orchestrator.app.close();
  db.close();
  k8s.setKubernetesForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('the box image, which Kubernetes never asks a daemon about', () => {
  it('ensureBoxImage and refreshBoxImage run cleanly against a runtime that answers every image question with null', async () => {
    await orchestrator.manager.ensureBoxImage();
    await orchestrator.manager.refreshBoxImage();
    // Neither call had anything to pull or compare, and neither threw.
  });

  it('a redundant start on an already-running box recreates nothing, since there is no image id to have moved', async () => {
    const created = await orchestrator.manager.create({ name: 'test' });

    assert.deepEqual(fake.podsCreated, [k8s.podName(created.id)]);
    assert.deepEqual(fake.podsDeleted, []);

    await orchestrator.manager.start(created.id);

    // rollOntoCurrentImage compares runtime().images.imageId() against
    // runtime().images.containerImageId() — both always null for Kubernetes —
    // and returns early rather than treating "both unknown" as "moved".
    assert.deepEqual(fake.podsCreated, [k8s.podName(created.id)]);
    assert.deepEqual(fake.podsDeleted, []);
  });
});
