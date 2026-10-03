import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';
import { loadConfig } from '../config.ts';
import { setKubernetesForTests } from '../kubernetes.ts';
import { kubernetesRuntime } from './kubernetes-runtime.ts';

/**
 * The mapping from the backend-neutral Runtime interface onto kubernetes.ts —
 * the delegation itself, not kubernetes.ts's own behaviour, which
 * kubernetes.test.ts already covers against a faked client.
 */

afterEach(() => setKubernetesForTests(null));

function cfg(env: Record<string, string> = {}): ReturnType<typeof loadConfig> {
  return loadConfig({ DATA_DIR: '/data', RUNTIME: 'kubernetes', ...env });
}

describe('kubernetesRuntime', () => {
  it('ensureNetwork, ensureProxyAttached and isProxyAttached all resolve to the one NetworkPolicy', async () => {
    let created = false;
    setKubernetesForTests({
      core: {},
      networking: {
        readNamespacedNetworkPolicy: async () => { throw Object.assign(new Error('404'), { code: 404 }); },
        createNamespacedNetworkPolicy: async () => { created = true; },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    // ensureNetwork/ensureProxyAttached/isProxyAttached only ever see what
    // row.network_name holds, which is names.network('s1') — the
    // NetworkPolicy's own name, not the bare box id.
    const networkName = kubernetesRuntime(cfg()).boxes.names.network('s1');
    assert.equal(networkName, 'boxes-netpol-s1');
    const runtime = kubernetesRuntime(cfg());
    assert.equal(await runtime.boxes.ensureNetwork(networkName, '10.0.0.0/24', 's1'), true);
    assert.ok(created);
    assert.equal(await runtime.boxes.ensureProxyAttached(networkName), true);

    setKubernetesForTests({
      core: {},
      networking: { readNamespacedNetworkPolicy: async () => ({}) },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    assert.equal(await runtime.boxes.isProxyAttached(networkName), true);
    // A policy that is already there is an attached box, not a missing one.
    assert.equal(await runtime.boxes.ensureProxyAttached(networkName), true);

    setKubernetesForTests({
      core: {},
      networking: {
        readNamespacedNetworkPolicy: async () => { throw Object.assign(new Error('404'), { code: 404 }); },
        createNamespacedNetworkPolicy: async () => { throw Object.assign(new Error('forbidden'), { code: 403 }); },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    assert.equal(await runtime.boxes.ensureProxyAttached(networkName), false);
  });

  it('volumeRefs names the PVC from the box id alone, ignoring the Docker-only arguments', () => {
    const runtime = kubernetesRuntime(cfg());
    const volumes = runtime.boxes.volumeRefs('abcd1234', '/some/host/path', 'a-legacy-volume');
    assert.deepEqual(volumes.workspace, { kind: 'k8s-pvc', claimName: 'boxes-data-abcd1234', subPath: 'workspace' });
    assert.deepEqual(volumes.home, { kind: 'k8s-pvc', claimName: 'boxes-data-abcd1234', subPath: 'home' });
    assert.deepEqual(volumes.agentConfig, { kind: 'k8s-emptydir' });
  });

  it('refuses the Docker-only volume operations rather than silently doing nothing', async () => {
    const runtime = kubernetesRuntime(cfg());
    await assert.rejects(() => runtime.boxes.seedHomeFromImage('/x', 'img', 's1'), /not applicable/);
    await assert.rejects(
      () => runtime.boxes.copyVolumeToDirectory('vol', '/x', 'img', 's1'),
      /not applicable/,
    );
  });

  it('reports no container introspection and an unresolved host mount, since neither concept exists here', async () => {
    const runtime = kubernetesRuntime(cfg());
    assert.equal(runtime.boxes.inContainer(), false);
    assert.equal(await runtime.boxes.resolveHostMountSource('/data'), null);
    assert.equal(runtime.system.selfContainerId(), null);
  });

  it('knows an image by its reference, and a pod by the image its box container runs', async () => {
    setKubernetesForTests({
      core: {
        readNamespacedPod: async (params: { name: string }) => {
          if (params.name !== 'p1') throw Object.assign(new Error('not found'), { code: 404 });
          return { spec: { containers: [{ name: 'box', image: 'reg/box:20261003-abc' }] } };
        },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    const runtime = kubernetesRuntime(cfg());
    assert.equal(await runtime.images.imageId('reg/box:20261003-abc'), 'reg/box:20261003-abc');
    assert.equal(await runtime.images.containerImageId('p1'), 'reg/box:20261003-abc');
    assert.equal(await runtime.images.containerImageId('gone'), null);
    assert.equal(await runtime.images.imageInfo('img'), null);
    assert.equal(await runtime.images.imageUserUid('img'), null);
    assert.deepEqual(await runtime.images.listSupersededBoxImages(), []);
    assert.equal(await runtime.images.removeImage('img'), false);
  });

  it('lists box networks as the NetworkPolicies they now are, and login containers as login pods', async () => {
    let selector: string | undefined;
    setKubernetesForTests({
      core: {
        listNamespacedPod: async (req: { labelSelector: string }) => {
          selector = req.labelSelector;
          return {
            items: [
              {
                metadata: {
                  name: 'boxes-login-ab12',
                  labels: { 'boxes.login': 'claude' },
                  creationTimestamp: new Date(1_000_000),
                },
              },
            ],
          };
        },
      },
      networking: {
        listNamespacedNetworkPolicy: async () => ({
          items: [{ metadata: { name: 'boxes-netpol-s1', labels: { 'boxes.box': 's1' } } }],
        }),
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    const runtime = kubernetesRuntime(cfg());
    assert.deepEqual(await runtime.boxes.listBoxNetworks(), [
      { name: 'boxes-netpol-s1', boxId: 's1' },
    ]);
    assert.deepEqual(await runtime.boxes.listLoginContainers(), [
      { id: 'boxes-login-ab12', credentialId: 'claude', createdAt: 1_000_000 },
    ]);
    assert.equal(selector, 'boxes.login');
  });

  it('removeNetwork deletes the policy listBoxNetworks actually named', async () => {
    // sweepOrphans() passes exactly this — a NetworkPolicy's own name off a
    // listBoxNetworks() row, not a bare box id — so removeNetwork has
    // to recover the box id from it rather than treat the name as one.
    let deletedName: string | undefined;
    setKubernetesForTests({
      core: {},
      networking: {
        deleteNamespacedNetworkPolicy: async (params: { name: string }) => {
          deletedName = params.name;
        },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    const runtime = kubernetesRuntime(cfg());
    await runtime.boxes.removeNetwork('boxes-netpol-s1');
    assert.equal(deletedName, 'boxes-netpol-s1');
  });

  it('provisions and removes only the PVCs that volumeRefs actually named', async () => {
    const created: string[] = [];
    const removed: string[] = [];
    setKubernetesForTests({
      core: {
        createNamespacedPersistentVolumeClaim: async (params: { body: { metadata: { name: string } } }) => {
          created.push(params.body.metadata.name);
          return params.body;
        },
        deleteNamespacedPersistentVolumeClaim: async (params: { name: string }) => {
          removed.push(params.name);
          return {};
        },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);

    const runtime = kubernetesRuntime(cfg());
    const volumes = runtime.boxes.volumeRefs('s1', '/unused', null);
    await runtime.boxes.provisionVolumes('s1', 'img', volumes);
    assert.deepEqual(created, ['boxes-data-s1']);

    await runtime.boxes.removeVolumes('s1', volumes);
    assert.deepEqual(removed, ['boxes-data-s1']);
  });

  it('keeps workspace, home and Nix store on one claim, sized from config', async () => {
    let size: string | undefined;
    setKubernetesForTests({
      core: {
        createNamespacedPersistentVolumeClaim: async (params: {
          body: { spec: { resources: { requests: { storage: string } } } };
        }) => {
          size = params.body.spec.resources.requests.storage;
          return params.body;
        },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);

    const runtime = kubernetesRuntime(cfg({ K8S_VOLUME_SIZE: '50Gi' }));
    const volumes = runtime.boxes.volumeRefs('s1', '/unused', null);
    assert.deepEqual(volumes, {
      workspace: { kind: 'k8s-pvc', claimName: 'boxes-data-s1', subPath: 'workspace' },
      home: { kind: 'k8s-pvc', claimName: 'boxes-data-s1', subPath: 'home' },
      nix: { kind: 'k8s-pvc', claimName: 'boxes-data-s1', subPath: 'nix' },
      agentConfig: { kind: 'k8s-emptydir' },
    });
    await runtime.boxes.provisionVolumes('s1', 'img', volumes);
    assert.equal(size, '50Gi');
  });

  it('creates no claim to stand in for one that has gone', async () => {
    setKubernetesForTests({
      core: {
        createNamespacedPersistentVolumeClaim: async () => {
          throw new Error('ensureAddedVolumes created a claim');
        },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);

    const runtime = kubernetesRuntime(cfg());
    await runtime.boxes.ensureAddedVolumes('s1', runtime.boxes.volumeRefs('s1', '/unused', null));
  });
});
