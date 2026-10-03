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
  });

  it('volumeRefs names PVCs from the box id alone, ignoring the Docker-only arguments', () => {
    const runtime = kubernetesRuntime(cfg());
    const volumes = runtime.boxes.volumeRefs('abcd1234', '/some/host/path', 'a-legacy-volume');
    assert.deepEqual(volumes.workspace, { kind: 'k8s-pvc', claimName: 'boxes-workspace-abcd1234' });
    assert.deepEqual(volumes.home, { kind: 'k8s-pvc', claimName: 'boxes-home-abcd1234' });
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

  it('never reports an image roll-forward opportunity, which is how rollOntoCurrentImage becomes a no-op here', async () => {
    const runtime = kubernetesRuntime(cfg());
    assert.equal(await runtime.images.imageId('img'), null);
    assert.equal(await runtime.images.containerImageId('p1'), null);
    assert.equal(await runtime.images.imageInfo('img'), null);
    assert.equal(await runtime.images.imageUserUid('img'), null);
    assert.deepEqual(await runtime.images.listSupersededBoxImages(), []);
    assert.equal(await runtime.images.removeImage('img'), false);
  });

  it('lists box networks as the NetworkPolicies they now are, and no login containers, a Docker-only concept', async () => {
    setKubernetesForTests({
      core: {},
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
    assert.deepEqual(await runtime.boxes.listLoginContainers(), []);
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
    assert.deepEqual(created.sort(), ['boxes-home-s1', 'boxes-nix-s1', 'boxes-workspace-s1'].sort());

    await runtime.boxes.removeVolumes('s1', volumes);
    assert.deepEqual(removed.sort(), ['boxes-home-s1', 'boxes-nix-s1', 'boxes-workspace-s1'].sort());
  });

  it('gives a box from before Nix stores existed its claim, and tolerates one already there', async () => {
    const asked: Array<{ name: string; size: string }> = [];
    let exists = false;
    setKubernetesForTests({
      core: {
        createNamespacedPersistentVolumeClaim: async (params: {
          body: { metadata: { name: string }; spec: { resources: { requests: { storage: string } } } };
        }) => {
          asked.push({
            name: params.body.metadata.name,
            size: params.body.spec.resources.requests.storage,
          });
          if (exists) throw Object.assign(new Error('already exists'), { code: 409 });
          exists = true;
          return params.body;
        },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);

    const runtime = kubernetesRuntime(cfg({ K8S_NIX_SIZE: '7Gi' }));
    const volumes = runtime.boxes.volumeRefs('s1', '/unused', null);
    await runtime.boxes.ensureAddedVolumes('s1', volumes);
    await runtime.boxes.ensureAddedVolumes('s1', volumes);
    assert.deepEqual(asked, [
      { name: 'boxes-nix-s1', size: '7Gi' },
      { name: 'boxes-nix-s1', size: '7Gi' },
    ]);
  });
});
