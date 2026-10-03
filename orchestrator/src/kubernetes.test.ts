import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { PassThrough } from 'node:stream';
import { afterEach, describe, it } from 'vitest';
import { loadConfig, type Config } from './config.ts';
import {
  createClaim,
  createPod,
  createBoxNetworkPolicy,
  deleteClaim,
  deletePod,
  deleteBoxNetworkPolicy,
  ensureBoxNetworkPolicy,
  execInPod,
  missingMounts,
  openTerminalExec,
  hasBoxNetworkPolicy,
  healthCheck,
  listBoxClaims,
  listBoxNetworkPolicies,
  listBoxPods,
  LABEL,
  networkPolicyName,
  podName,
  podState,
  setKubernetesForTests,
  setPodGonePollForTests,
  startPod,
  boxClaimName,
  type PodSpec,
} from './kubernetes.ts';
import type { ProvisionedVolumes } from './runtime/types.ts';

/**
 * The pod, PVC and exec surface a box's Kubernetes runtime is built on.
 *
 * Every test drives it against a fake CoreV1Api/Exec pair rather than a real
 * cluster, which is not available in this environment — see the Phase 2
 * report for what that does and does not verify.
 */

afterEach(() => setKubernetesForTests(null));

function cfg(over: Record<string, string> = {}): Config {
  return loadConfig({ DATA_DIR: '/data', RUNTIME: 'kubernetes', ...over });
}

/** An error shaped like the client library's ApiException, for a given HTTP status. */
function apiError(code: number): Error {
  return Object.assign(new Error(`api error ${code}`), { code });
}

const CLAIM = boxClaimName('abcd1234');

const VOLUMES: ProvisionedVolumes = {
  workspace: { kind: 'k8s-pvc', claimName: CLAIM, subPath: 'workspace' },
  home: { kind: 'k8s-pvc', claimName: CLAIM, subPath: 'home' },
  nix: { kind: 'k8s-pvc', claimName: CLAIM, subPath: 'nix' },
  agentConfig: { kind: 'k8s-emptydir' },
};

describe('createPod', () => {
  it('builds a pod with the hardened template and the three mounts', async () => {
    let sent: { namespace: string; body: Record<string, unknown> } | undefined;
    setKubernetesForTests({
      core: {
        createNamespacedPod: async (params: { namespace: string; body: Record<string, unknown> }) => {
          sent = params;
          return params.body;
        },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);

    const spec: PodSpec = {
      boxId: 'abcd1234',
      image: 'ghcr.io/example/box:latest',
      volumes: VOLUMES,
      env: { GH_TOKEN: 'placeholder' },
      caCertificate: '',
    };
    const name = await createPod(spec, cfg());

    assert.equal(name, podName('abcd1234'));
    assert.equal(sent?.namespace, 'boxes-sessions');
    const body = sent!.body as any;
    assert.equal(body.metadata.name, podName('abcd1234'));
    assert.equal(body.metadata.labels[LABEL], 'abcd1234');
    assert.equal(body.spec.restartPolicy, 'Never');

    const container = body.spec.containers[0];
    assert.equal(container.image, spec.image);
    assert.equal(container.workingDir, '/workspace');
    assert.deepEqual(container.securityContext.capabilities, { drop: ['ALL'] });
    assert.equal(container.securityContext.runAsNonRoot, true);
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.equal(container.securityContext.runAsUser, 1020);
    assert.equal(container.securityContext.runAsGroup, 1020);
    // A bare byte count, never a lowercase Kubernetes suffix — see
    // kubernetes.ts's memoryBytes for why 'm' would be misread as milli.
    assert.equal(container.resources.limits.memory, String(4 * 1024 ** 3));
    assert.equal(container.resources.requests.memory, container.resources.limits.memory);
    assert.equal(container.resources.limits.cpu, '2');

    // The three mounts share one claim, named once among the pod's volumes,
    // so a node attaches one block volume for the box rather than three.
    const claimVolumes = (body.spec.volumes as any[]).filter((v) => v.persistentVolumeClaim);
    assert.deepEqual(claimVolumes, [{ name: CLAIM, persistentVolumeClaim: { claimName: CLAIM } }]);

    const mounts = container.volumeMounts as Array<{
      name: string;
      mountPath: string;
      subPath?: string;
      readOnly?: boolean;
    }>;
    const mountAt = (path: string) => mounts.find((m) => m.mountPath === path);
    assert.deepEqual(mountAt('/workspace'), { name: CLAIM, subPath: 'workspace', mountPath: '/workspace' });
    assert.deepEqual(mountAt('/home/agent'), { name: CLAIM, subPath: 'home', mountPath: '/home/agent' });
    assert.deepEqual(mountAt('/nix'), { name: CLAIM, subPath: 'nix', mountPath: '/nix' });
    assert.deepEqual(mountAt('/boxes/agent'), { name: 'agent-config', mountPath: '/boxes/agent', readOnly: true });

    // Every PVC starts empty and owned by the provisioner, so one init
    // container gives each root to the agent and seeds the home; the
    // agent-config emptyDir needs nothing.
    assert.equal(body.spec.initContainers.length, 1);
    const setup = body.spec.initContainers[0];
    assert.equal(setup.securityContext.runAsUser, 0);
    // Root, but with only what cp -a and chown need: reading the agent's
    // 0700 home in the image takes DAC_OVERRIDE.
    assert.deepEqual(setup.securityContext.capabilities, {
      drop: ['ALL'],
      add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
    });
    assert.deepEqual(setup.volumeMounts, [
      { name: CLAIM, subPath: 'workspace', mountPath: '/mnt/workspace' },
      { name: CLAIM, subPath: 'home', mountPath: '/mnt/home' },
      { name: CLAIM, subPath: 'nix', mountPath: '/mnt/nix' },
    ]);
    const script = setup.command[2] as string;
    assert.match(script, /chown 1020:1020 \/mnt\/workspace/);
    assert.match(script, /chown 1020:1020 \/mnt\/nix/);
    // A pod is created at every start, so the seed runs only into a home it
    // has not filled before, and leaves the agent's own dotfiles alone.
    assert.match(script, /if \[ ! -e \/mnt\/home\/\.boxes\/home-seeded \]; then cp -a \/home\/agent\/\. \/mnt\/home\//);
  });

  it('runs no init container when no volume is a PVC', async () => {
    let sent: { body: Record<string, unknown> } | undefined;
    setKubernetesForTests({
      core: {
        createNamespacedPod: async (params: { body: Record<string, unknown> }) => {
          sent = params;
          return params.body;
        },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);

    await createPod(
      {
        boxId: 's1',
        image: 'img',
        volumes: {
          workspace: { kind: 'k8s-emptydir' },
          home: { kind: 'k8s-emptydir' },
          nix: { kind: 'k8s-emptydir' },
          agentConfig: { kind: 'k8s-emptydir' },
        },
        env: {},
        caCertificate: '',
      },
      cfg(),
    );
    const body = sent!.body as any;
    assert.equal(body.spec.initContainers, undefined);
  });

  it('names an image pull secret only when one is configured', async () => {
    let sent: { body: Record<string, unknown> } | undefined;
    setKubernetesForTests({
      core: {
        createNamespacedPod: async (params: { body: Record<string, unknown> }) => {
          sent = params;
          return params.body;
        },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);

    await createPod(
      { boxId: 's1', image: 'img', volumes: VOLUMES, env: {}, caCertificate: '' },
      cfg({ K8S_IMAGE_PULL_SECRET: 'registry-creds' }),
    );
    assert.deepEqual((sent!.body as any).spec.imagePullSecrets, [{ name: 'registry-creds' }]);
  });
});

describe('podState', () => {
  function fakeReadPod(answer: () => Promise<{ status?: { phase?: string } }>) {
    setKubernetesForTests({
      core: { readNamespacedPod: answer },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
  }

  it('maps Pending and Running to running', async () => {
    fakeReadPod(async () => ({ status: { phase: 'Pending' } }));
    assert.equal(await podState('p1', cfg()), 'running');
    fakeReadPod(async () => ({ status: { phase: 'Running' } }));
    assert.equal(await podState('p1', cfg()), 'running');
  });

  it('maps Succeeded and Failed to exited', async () => {
    fakeReadPod(async () => ({ status: { phase: 'Succeeded' } }));
    assert.equal(await podState('p1', cfg()), 'exited');
    fakeReadPod(async () => ({ status: { phase: 'Failed' } }));
    assert.equal(await podState('p1', cfg()), 'exited');
  });

  it('maps a 404 to missing, and anything else to unknown', async () => {
    fakeReadPod(async () => { throw apiError(404); });
    assert.equal(await podState('p1', cfg()), 'missing');
    fakeReadPod(async () => { throw apiError(500); });
    assert.equal(await podState('p1', cfg()), 'unknown');
    fakeReadPod(async () => ({ status: {} }));
    assert.equal(await podState('p1', cfg()), 'unknown');
  });
});

describe('startPod', () => {
  it('resolves when the pod exists, whatever phase it is in', async () => {
    setKubernetesForTests({
      core: { readNamespacedPod: async () => ({ status: { phase: 'Pending' } }) },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    await startPod('p1', cfg());
  });

  it('throws when the pod does not exist, so a real bug stays visible', async () => {
    setKubernetesForTests({
      core: { readNamespacedPod: async () => { throw apiError(404); } },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    await assert.rejects(() => startPod('p1', cfg()), /does not exist/);
  });
});

describe('deletePod', () => {
  it('tolerates a pod that is already gone', async () => {
    let called = false;
    setKubernetesForTests({
      core: {
        deleteNamespacedPod: async () => {
          called = true;
          throw apiError(404);
        },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    await deletePod('p1', cfg());
    assert.ok(called);
  });

  it('returns only once the pod is gone, since a terminating one still reads as running', async () => {
    setPodGonePollForTests(1);
    let reads = 0;
    setKubernetesForTests({
      core: {
        deleteNamespacedPod: async () => ({}),
        readNamespacedPod: async () => {
          reads++;
          if (reads < 3) return { status: { phase: 'Running' } };
          throw apiError(404);
        },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    await deletePod('p1', cfg());
    assert.equal(reads, 3);
    setPodGonePollForTests(500);
  });

  it('gives the pod the same 10 second grace a Docker stop does', async () => {
    let sent: { body: Record<string, unknown> } | undefined;
    setKubernetesForTests({
      core: {
        createNamespacedPod: async (params: { body: Record<string, unknown> }) => {
          sent = params;
          return params.body;
        },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    await createPod({ boxId: 's1', image: 'img', volumes: VOLUMES, env: {}, caCertificate: '' }, cfg());
    assert.equal((sent!.body as any).spec.terminationGracePeriodSeconds, 10);
  });

  it('rethrows anything else', async () => {
    setKubernetesForTests({
      core: { deleteNamespacedPod: async () => { throw apiError(500); } },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    await assert.rejects(() => deletePod('p1', cfg()), /500/);
  });
});

describe('missingMounts', () => {
  it('names the destinations the box container does not mount', async () => {
    setKubernetesForTests({
      core: {
        readNamespacedPod: async () => ({
          spec: {
            containers: [
              { name: 'box', volumeMounts: [{ name: 'agent-config', mountPath: '/boxes/agent' }] },
            ],
          },
        }),
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    assert.deepEqual(await missingMounts('p1', ['/boxes/agent', '/nix'], cfg()), ['/nix']);
    assert.deepEqual(await missingMounts('p1', ['/boxes/agent'], cfg()), []);
  });

  it('reports none missing for a pod that cannot be inspected, same as docker.ts', async () => {
    setKubernetesForTests({
      core: { readNamespacedPod: async () => { throw apiError(500); } },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    assert.deepEqual(await missingMounts('p1', ['/boxes/agent', '/nix'], cfg()), []);
  });
});

describe('claims', () => {
  it('creates a PVC sized and classed from config, labelled with the box', async () => {
    let sent: { namespace: string; body: Record<string, unknown> } | undefined;
    setKubernetesForTests({
      core: {
        createNamespacedPersistentVolumeClaim: async (params: {
          namespace: string;
          body: Record<string, unknown>;
        }) => {
          sent = params;
          return params.body;
        },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);

    await createClaim(boxClaimName('s1'), 's1', '10Gi', cfg({ K8S_STORAGE_CLASS: 'longhorn' }));
    const body = sent!.body as any;
    assert.equal(sent?.namespace, 'boxes-sessions');
    assert.equal(body.metadata.name, boxClaimName('s1'));
    assert.equal(body.metadata.labels[LABEL], 's1');
    assert.deepEqual(body.spec.accessModes, ['ReadWriteOnce']);
    assert.equal(body.spec.resources.requests.storage, '10Gi');
    assert.equal(body.spec.storageClassName, 'longhorn');
  });

  it('leaves storageClassName unset when none is configured', async () => {
    let sent: { body: Record<string, unknown> } | undefined;
    setKubernetesForTests({
      core: {
        createNamespacedPersistentVolumeClaim: async (params: { body: Record<string, unknown> }) => {
          sent = params;
          return params.body;
        },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    await createClaim('c1', 's1', '5Gi', cfg());
    assert.equal((sent!.body as any).spec.storageClassName, undefined);
  });

  it('tolerates deleting a PVC that is already gone', async () => {
    setKubernetesForTests({
      core: { deleteNamespacedPersistentVolumeClaim: async () => { throw apiError(404); } },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    await deleteClaim('c1', cfg());
  });
});

describe('network policy', () => {
  it('creates a deny-all-ingress policy scoped to the proxy and DNS on egress', async () => {
    let sent: { namespace: string; body: Record<string, unknown> } | undefined;
    setKubernetesForTests({
      core: {},
      networking: {
        createNamespacedNetworkPolicy: async (params: {
          namespace: string;
          body: Record<string, unknown>;
        }) => {
          sent = params;
          return params.body;
        },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);

    await createBoxNetworkPolicy('s1', cfg());
    const body = sent!.body as any;
    assert.equal(sent?.namespace, 'boxes-sessions');
    assert.equal(body.metadata.name, networkPolicyName('s1'));
    assert.equal(body.metadata.labels[LABEL], 's1');
    assert.deepEqual(body.spec.podSelector, { matchLabels: { [LABEL]: 's1' } });
    assert.deepEqual(body.spec.policyTypes, ['Ingress', 'Egress']);
    assert.deepEqual(body.spec.ingress, []);
    assert.equal(body.spec.egress.length, 2);
    assert.deepEqual(body.spec.egress[0].to, [
      { podSelector: { matchLabels: { app: 'boxes-egress-proxy' } } },
    ]);
    assert.deepEqual(body.spec.egress[0].ports, [{ protocol: 'TCP', port: 3128 }]);
    assert.deepEqual(body.spec.egress[1].ports, [
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ]);
  });

  it('ensureBoxNetworkPolicy creates one only when the cluster has none', async () => {
    let created = false;
    setKubernetesForTests({
      core: {},
      networking: {
        readNamespacedNetworkPolicy: async () => { throw apiError(404); },
        createNamespacedNetworkPolicy: async () => { created = true; },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    assert.equal(await ensureBoxNetworkPolicy('s1', cfg()), true);
    assert.ok(created);

    created = false;
    setKubernetesForTests({
      core: {},
      networking: {
        readNamespacedNetworkPolicy: async () => ({}),
        createNamespacedNetworkPolicy: async () => { created = true; },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    assert.equal(await ensureBoxNetworkPolicy('s1', cfg()), false);
    assert.ok(!created);
  });

  it('hasBoxNetworkPolicy answers false for a 404 and true otherwise', async () => {
    setKubernetesForTests({
      core: {},
      networking: { readNamespacedNetworkPolicy: async () => { throw apiError(404); } },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    assert.equal(await hasBoxNetworkPolicy('s1', cfg()), false);

    setKubernetesForTests({
      core: {},
      networking: { readNamespacedNetworkPolicy: async () => ({}) },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    assert.equal(await hasBoxNetworkPolicy('s1', cfg()), true);
  });

  it('tolerates deleting a NetworkPolicy that is already gone, and rethrows anything else', async () => {
    setKubernetesForTests({
      core: {},
      networking: { deleteNamespacedNetworkPolicy: async () => { throw apiError(404); } },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    await deleteBoxNetworkPolicy('s1', cfg());

    setKubernetesForTests({
      core: {},
      networking: { deleteNamespacedNetworkPolicy: async () => { throw apiError(500); } },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    await assert.rejects(() => deleteBoxNetworkPolicy('s1', cfg()), /500/);
  });

  it('lists labelled policies by box id, dropping anything unlabelled', async () => {
    setKubernetesForTests({
      core: {},
      networking: {
        listNamespacedNetworkPolicy: async () => ({
          items: [
            { metadata: { name: networkPolicyName('a'), labels: { [LABEL]: 'a' } } },
            { metadata: {} },
          ],
        }),
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    assert.deepEqual(await listBoxNetworkPolicies(cfg()), [
      { name: networkPolicyName('a'), boxId: 'a' },
    ]);
  });
});

describe('listBoxPods and listBoxClaims', () => {
  it('reads the box id off each item\'s label, and drops anything unlabelled', async () => {
    setKubernetesForTests({
      core: {
        listNamespacedPod: async () => ({
          items: [
            { metadata: { name: 'boxes-box-a', labels: { [LABEL]: 'a' } }, status: { phase: 'Running' } },
            { metadata: { name: 'boxes-box-b', labels: { [LABEL]: 'b' } }, status: { phase: 'Pending' } },
            { metadata: { name: 'unlabelled' } },
          ],
        }),
        listNamespacedPersistentVolumeClaim: async () => ({
          items: [
            { metadata: { name: 'boxes-workspace-a', labels: { [LABEL]: 'a' } } },
            { metadata: {} },
          ],
        }),
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);

    const pods = await listBoxPods(cfg());
    assert.deepEqual(
      pods.map((p) => [p.boxId, p.running]),
      [
        ['a', true],
        ['b', false],
      ],
    );
    assert.ok(pods.every((p) => p.helper === false));

    const claims = await listBoxClaims(cfg());
    assert.deepEqual(claims, [{ name: 'boxes-workspace-a', boxId: 'a' }]);
  });
});

describe('healthCheck', () => {
  it('reads the configured namespace, and throws when the cluster refuses', async () => {
    let asked: string | undefined;
    setKubernetesForTests({
      core: {
        readNamespace: async (params: { name: string }) => {
          asked = params.name;
          return {};
        },
      },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    await healthCheck(cfg());
    assert.equal(asked, 'boxes-sessions');

    setKubernetesForTests({
      core: { readNamespace: async () => { throw new Error('unreachable'); } },
      exec: { exec: async () => { throw new Error('not used'); } },
    } as never);
    await assert.rejects(() => healthCheck(cfg()), /unreachable/);
  });
});

describe('execInPod', () => {
  it('runs the command as given and reports its output and exit code', async () => {
    let ranCommand: string | string[] | undefined;
    setKubernetesForTests({
      core: {},
      exec: {
        exec: async (
          _namespace: string,
          _podName: string,
          _containerName: string,
          command: string | string[],
          stdout: NodeJS.WritableStream | null,
          stderr: NodeJS.WritableStream | null,
          _stdin: unknown,
          _tty: boolean,
          statusCallback?: (status: { status?: string }) => void,
        ) => {
          ranCommand = command;
          stdout?.write('hello\n');
          stderr?.write('warned\n');
          const listeners = new Map<string, Array<() => void>>();
          setTimeout(() => {
            statusCallback?.({ status: 'Success' });
            (stdout as NodeJS.WritableStream & { end: () => void })?.end();
            (stderr as NodeJS.WritableStream & { end: () => void })?.end();
            for (const cb of listeners.get('close') ?? []) cb();
          });
          return {
            on: (event: string, cb: () => void) => {
              const arr = listeners.get(event) ?? [];
              arr.push(cb);
              listeners.set(event, arr);
            },
          };
        },
      },
    } as never);

    const result = await execInPod('p1', ['echo', 'hello'], cfg());
    assert.deepEqual(ranCommand, ['echo', 'hello']);
    assert.equal(result.stdout, 'hello\n');
    assert.equal(result.stderr, 'warned\n');
    assert.equal(result.code, 0);
  });

  it('wraps the command with a working directory and env vars as separate argv entries, never as a shell line', async () => {
    let ranCommand: string[] | undefined;
    setKubernetesForTests({
      core: {},
      exec: {
        exec: async (
          _namespace: string,
          _podName: string,
          _containerName: string,
          command: string | string[],
          stdout: NodeJS.WritableStream | null,
          stderr: NodeJS.WritableStream | null,
        ) => {
          ranCommand = command as string[];
          const listeners = new Map<string, Array<() => void>>();
          setTimeout(() => {
            (stdout as NodeJS.WritableStream & { end: () => void })?.end();
            (stderr as NodeJS.WritableStream & { end: () => void })?.end();
            for (const cb of listeners.get('close') ?? []) cb();
          });
          return { on: (event: string, cb: () => void) => {
            const arr = listeners.get(event) ?? [];
            arr.push(cb);
            listeners.set(event, arr);
          } };
        },
      },
    } as never);

    await execInPod('p1', ['git', 'status'], cfg(), {
      workingDir: '/workspace/repo',
      env: { GIT_DIR: '.git' },
    });
    assert.deepEqual(ranCommand, [
      'sh',
      '-c',
      'cd "$1" && shift && exec "$@"',
      '_',
      '/workspace/repo',
      'env',
      'GIT_DIR=.git',
      'git',
      'status',
    ]);
  });
});

describe('openTerminalExec', () => {
  it('keeps the pty output apart from the reader input, and sizes the pty', async () => {
    let args: unknown[] = [];
    const sockets = new EventEmitter();
    setKubernetesForTests({
      core: {},
      exec: {
        exec: async (...a: unknown[]) => {
          args = a;
          return Object.assign(sockets, { close: () => {} });
        },
      },
    } as never);

    const terminal = await openTerminalExec('p1', '/workspace', 120, 40, cfg());
    const [, , , command, stdout, stderr, stdin, tty] = args as [
      string, string, string, string[], PassThrough & { columns: number; rows: number }, unknown, PassThrough, boolean,
    ];
    assert.equal(tty, true);
    // One stream for both would feed the shell its own output.
    assert.notEqual(stdout, stdin);
    assert.equal(stderr, stdout);
    assert.ok(command.includes('TERM=xterm-256color'));

    // The library sizes the pty from the output stream, and follows its resize.
    assert.equal(stdout.columns, 120);
    assert.equal(stdout.rows, 40);
    let resized = false;
    stdout.on('resize', () => {
      resized = true;
    });
    await terminal.resize(90, 20);
    assert.ok(resized);
    assert.equal(stdout.columns, 90);
    assert.equal(stdout.rows, 20);

    // What the reader types reaches stdin and nothing else ...
    const typed = new Promise<string>((resolve) => stdin.once('data', (d: Buffer) => resolve(d.toString())));
    terminal.stream.write('ls\r');
    assert.equal(await typed, 'ls\r');
    // ... and what the pty prints reaches the reader.
    const printed = new Promise<string>((resolve) =>
      terminal.stream.once('data', (d: Buffer) => resolve(d.toString())),
    );
    stdout.write('hello');
    assert.equal(await printed, 'hello');
  });
});
