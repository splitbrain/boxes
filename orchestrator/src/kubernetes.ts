import { randomBytes } from 'node:crypto';
import { Duplex, PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import {
  CoreV1Api,
  Exec,
  KubeConfig,
  NetworkingV1Api,
  type V1Container,
  type V1NetworkPolicy,
  type V1PersistentVolumeClaim,
  type V1Pod,
  type V1Status,
  type V1Volume,
} from '@kubernetes/client-node';
import type { DockerState } from '../../shared/types.ts';
import type {
  AdapterExec,
  ContainerProcess,
  ExecOptions,
  ExecOutput,
  TerminalExec,
} from './docker.ts';
import { AGENT_CONFIG_DIR, HOME_DIR, NIX_DIR, WORKSPACE_DIR } from './docker.ts';
import type { Config } from './config.ts';
import { log } from './log.ts';
import type { ProvisionedVolumes, VolumeRef } from './runtime/types.ts';

/**
 * Pod, PVC and exec lifecycle for boxes run as Kubernetes pods.
 *
 * Same grain as docker.ts: raw @kubernetes/client-node calls, and no
 * knowledge of the Runtime abstraction sitting above it. What in docker.ts is
 * a fixed HostConfig template is here a fixed Pod spec, built the same way —
 * from a server-generated box id and the values a box holds in place
 * of the deployment's credentials.
 */

/** Kubernetes label carrying the box id on every object Boxes creates here. */
export const LABEL = 'boxes.box';

/** The pod's one real container. Named so exec calls have something fixed to address. */
const CONTAINER_NAME = 'box';

export function podName(boxId: string): string {
  return `boxes-box-${boxId}`;
}

export function workspaceClaimName(boxId: string): string {
  return `boxes-workspace-${boxId}`;
}

export function homeClaimName(boxId: string): string {
  return `boxes-home-${boxId}`;
}

export function nixClaimName(boxId: string): string {
  return `boxes-nix-${boxId}`;
}

const NETWORK_POLICY_PREFIX = 'boxes-netpol-';

export function networkPolicyName(boxId: string): string {
  return `${NETWORK_POLICY_PREFIX}${boxId}`;
}

/**
 * Recovers the box id encoded in a NetworkPolicy's own name.
 *
 * `BoxRuntime.removeNetwork`/`ensureProxyAttached`/`isProxyAttached` take
 * only the object's name, on the same terms Docker's own network functions
 * do — but creating or looking one up here needs the box id `networkPolicyName`
 * built it from, which nothing but this reversal recovers. Safe because
 * Boxes names every one of these itself; nothing from a client ever reaches
 * this string.
 */
export function boxIdFromNetworkPolicyName(name: string): string {
  if (!name.startsWith(NETWORK_POLICY_PREFIX)) {
    throw new Error(`not a box NetworkPolicy name: ${name}`);
  }
  return name.slice(NETWORK_POLICY_PREFIX.length);
}

interface Clients {
  core: CoreV1Api;
  networking: NetworkingV1Api;
  /** Narrowed to what this file calls, so a test can fake one without a real WebSocketHandler. */
  exec: Pick<Exec, 'exec'>;
}

let clients: Clients | null = null;
let testClients: Clients | null = null;

function buildKubeConfig(cfg: Config): KubeConfig {
  const kc = new KubeConfig();
  if (cfg.K8S_IN_CLUSTER) kc.loadFromCluster();
  else if (cfg.K8S_KUBECONFIG) kc.loadFromFile(cfg.K8S_KUBECONFIG);
  else kc.loadFromDefault();
  return kc;
}

function clientsFor(cfg: Config): Clients {
  if (testClients) return testClients;
  if (!clients) {
    const kc = buildKubeConfig(cfg);
    clients = {
      core: kc.makeApiClient(CoreV1Api),
      networking: kc.makeApiClient(NetworkingV1Api),
      exec: new Exec(kc),
    };
  }
  return clients;
}

/** Test seam: install fake clients, or null to go back to the real ones. */
export function setKubernetesForTests(fake: Clients | null): void {
  testClients = fake;
  clients = null;
}

/** The status code an ApiException carries, or undefined for anything else. */
function statusCode(err: unknown): number | undefined {
  return err instanceof Error && 'code' in err ? (err as { code: number }).code : undefined;
}

/**
 * Reads something off the API, answering null for an object the cluster does
 * not have. Mirrors docker.ts's `inspecting`: absence is a legitimate answer
 * here, spelled as a 404, and anything else is rethrown.
 */
async function inspecting<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if (statusCode(err) === 404) return null;
    throw err;
  }
}

/**
 * Converts a Docker-style memory limit such as `4g` into the plain byte count
 * Kubernetes wants.
 *
 * A Kubernetes resource quantity's suffix is case-sensitive and `m` means
 * milli, not mega — so `BOX_MEM_LIMIT`'s own lowercase spelling cannot be
 * forwarded as a Kubernetes suffix without silently asking for a thousandth
 * of a byte. A bare integer has no such ambiguity.
 */
function memoryBytes(limit: string): string {
  const match = /^(\d+)([kmgKMG]?)$/.exec(limit);
  if (!match) throw new Error(`Invalid memory limit: ${limit}`);
  const value = Number(match[1]);
  const unit = (match[2] ?? '').toLowerCase();
  const scale = unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1;
  return String(value * scale);
}

/**
 * Where the entrypoint writes the system authorities together with the
 * deployment CA, and where the CA env vars point — same path as docker.ts's own.
 */
const CA_PATH = `${HOME_DIR}/.boxes/ca-bundle.crt`;

/** A box pod's environment, on the same terms as docker.ts's `boxEnv`, routed at the egress proxy's cluster Service instead of a Docker network alias. */
function boxEnv(
  env: Record<string, string>,
  caCertificate: string,
  cfg: Config,
): Array<{ name: string; value: string }> {
  const proxyUrl = `http://${cfg.K8S_EGRESS_PROXY_SERVICE}.${cfg.K8S_NAMESPACE}.svc.cluster.local:${cfg.EGRESS_PROXY_PORT}`;
  const merged: Record<string, string> = {
    ...env,
    TERM: 'dumb',
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
  };
  if (caCertificate !== '') {
    merged['BOXES_PROXY_CA'] = caCertificate;
    merged['NODE_EXTRA_CA_CERTS'] = CA_PATH;
    merged['SSL_CERT_FILE'] = CA_PATH;
    merged['GIT_SSL_CAINFO'] = CA_PATH;
    merged['CURL_CA_BUNDLE'] = CA_PATH;
    merged['CODEX_CA_CERTIFICATE'] = CA_PATH;
  }
  return Object.entries(merged)
    .filter(([, v]) => v !== '')
    .map(([name, value]) => ({ name, value }));
}

/** The pod volume a ref names. Only the two Kubernetes kinds may reach here. */
function podVolume(name: string, ref: VolumeRef): V1Volume {
  if (ref.kind === 'k8s-pvc') return { name, persistentVolumeClaim: { claimName: ref.claimName } };
  if (ref.kind === 'k8s-emptydir') return { name, emptyDir: {} };
  throw new Error(`a ${ref.kind} volume ref cannot back a Kubernetes pod`);
}

/** Where the setup init container mounts each PVC it prepares. */
const SETUP_MOUNTS = { workspace: '/mnt/workspace', home: '/mnt/home', nix: '/mnt/nix' } as const;

/**
 * Marks a home the seed has filled, so a later pod leaves the agent's own
 * dotfiles alone. Docker seeds a home once, at creation; a pod is created at
 * every start.
 */
const HOME_SEEDED = '.boxes/home-seeded';

/**
 * The init container that prepares a box's PVCs before the box runs, or null
 * when none of them is a PVC.
 *
 * A fresh PVC is empty and owned by whoever the provisioner says, so this
 * does what docker.ts's seedHomeFromImage and workspaces.ts's
 * createWorkspace/createNix do for a directory: gives each root to the agent,
 * and fills a new home from the image's /home/agent. The home is mounted
 * beside /home/agent rather than over it, so the image's own content is what
 * cp reads.
 *
 * It runs as root with only the capabilities that needs, the same ones the
 * root helper docker.ts's oneShot keeps: CHOWN and FOWNER for `cp -a` and the
 * chown, DAC_OVERRIDE to read the agent's 0700 home in the image.
 */
function volumeSetup(volumes: ProvisionedVolumes, cfg: Config): Omit<V1Container, 'image'> | null {
  const owner = `${cfg.BOX_UID}:${cfg.BOX_GID}`;
  const steps: string[] = [];
  const mounts: Array<{ name: string; mountPath: string }> = [];
  for (const name of ['workspace', 'home', 'nix'] as const) {
    if (volumes[name].kind !== 'k8s-pvc') continue;
    const dir = SETUP_MOUNTS[name];
    mounts.push({ name, mountPath: dir });
    if (name === 'home') {
      steps.push(
        `if [ ! -e ${dir}/${HOME_SEEDED} ]; then ` +
          `cp -a ${HOME_DIR}/. ${dir}/ && mkdir -p ${dir}/.boxes && touch ${dir}/${HOME_SEEDED} ` +
          `&& chown ${owner} ${dir}/.boxes ${dir}/${HOME_SEEDED}; fi`,
      );
    }
    steps.push(`chown ${owner} ${dir}`);
  }
  if (mounts.length === 0) return null;
  return {
    name: 'volume-setup',
    command: ['sh', '-c', `set -e; ${steps.join('; ')}`],
    securityContext: {
      runAsUser: 0,
      runAsNonRoot: false,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'], add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'] },
    },
    volumeMounts: mounts,
  };
}

/** Everything createPod needs to know about one box. */
export interface PodSpec {
  boxId: string;
  image: string;
  volumes: ProvisionedVolumes;
  env: Record<string, string>;
  caCertificate: string;
}

/**
 * Creates a box pod from the fixed, hardened template, and returns its
 * name — which is deterministic from the box id, so nothing has to be
 * remembered to find it again.
 */
export async function createPod(spec: PodSpec, cfg: Config): Promise<string> {
  const name = podName(spec.boxId);

  const initContainers: V1Container[] = [];
  const setup = volumeSetup(spec.volumes, cfg);
  if (setup) initContainers.push({ ...setup, image: spec.image });

  const pod: V1Pod = {
    metadata: { name, labels: { [LABEL]: spec.boxId } },
    spec: {
      restartPolicy: 'Never',
      terminationGracePeriodSeconds: TERMINATION_GRACE_SECONDS,
      ...(cfg.K8S_IMAGE_PULL_SECRET ? { imagePullSecrets: [{ name: cfg.K8S_IMAGE_PULL_SECRET }] } : {}),
      ...(initContainers.length > 0 ? { initContainers } : {}),
      volumes: [
        podVolume('workspace', spec.volumes.workspace),
        podVolume('home', spec.volumes.home),
        podVolume('nix', spec.volumes.nix),
        podVolume('agent-config', spec.volumes.agentConfig),
        // Docker's Tmpfs and ShmSize; see docker.ts's createContainer for why
        // both exist.
        { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '512Mi' } },
        { name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '512Mi' } },
      ],
      containers: [
        {
          name: CONTAINER_NAME,
          image: spec.image,
          workingDir: WORKSPACE_DIR,
          imagePullPolicy: cfg.K8S_IMAGE_PULL_POLICY,
          env: boxEnv(spec.env, spec.caCertificate, cfg),
          volumeMounts: [
            { name: 'workspace', mountPath: WORKSPACE_DIR },
            { name: 'home', mountPath: HOME_DIR },
            { name: 'nix', mountPath: NIX_DIR },
            { name: 'agent-config', mountPath: AGENT_CONFIG_DIR, readOnly: true },
            { name: 'tmp', mountPath: '/tmp' },
            { name: 'dshm', mountPath: '/dev/shm' },
          ],
          securityContext: {
            runAsUser: cfg.BOX_UID,
            runAsGroup: cfg.BOX_GID,
            runAsNonRoot: true,
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
            seccompProfile: { type: 'RuntimeDefault' },
            privileged: false,
          },
          resources: {
            // Requests equal to limits, so a box pod is QoS Guaranteed —
            // the closest Kubernetes equivalent to Docker's own fixed ceiling.
            limits: { memory: memoryBytes(cfg.BOX_MEM_LIMIT), cpu: String(cfg.BOX_CPUS) },
            requests: { memory: memoryBytes(cfg.BOX_MEM_LIMIT), cpu: String(cfg.BOX_CPUS) },
          },
        },
      ],
    },
  };

  await clientsFor(cfg).core.createNamespacedPod({ namespace: cfg.K8S_NAMESPACE, body: pod });
  return name;
}

/**
 * Confirms a pod exists, rather than starting one: a pod runs from the moment
 * it is created, so there is nothing here for `start` to do beyond making
 * sure the object `createPod` made is still there. Throwing on a pod that has
 * gone keeps a silent no-op from hiding a real bug rather than papering over
 * a state `restoreMissingContainer` already knows how to repair.
 */
export async function startPod(name: string, cfg: Config): Promise<void> {
  const pod = await inspecting(() => clientsFor(cfg).core.readNamespacedPod({ name, namespace: cfg.K8S_NAMESPACE }));
  if (!pod) throw new Error(`pod ${name} does not exist`);
}

/**
 * Deletes a pod, tolerating one that is already gone.
 *
 * Kubernetes has no pause: a stopped box is a deleted pod, and starting
 * it again means creating a fresh one against the same PVCs — see
 * boxes.ts's `restoreMissingContainer`, which already treats a missing
 * container as an ordinary repair.
 */
export async function deletePod(name: string, cfg: Config): Promise<void> {
  try {
    await clientsFor(cfg).core.deleteNamespacedPod({ name, namespace: cfg.K8S_NAMESPACE });
  } catch (err) {
    if (statusCode(err) === 404) return;
    throw err;
  }
  await podGone(name, cfg);
}

/**
 * The pod's grace period, the same 10 seconds docker.ts's stopContainer
 * gives. The entrypoint is PID 1 here with no init to forward SIGTERM, so a
 * stop takes all of it.
 */
const TERMINATION_GRACE_SECONDS = 10;

/**
 * Waits until a deleted pod is gone, the way a Docker stop returns only once
 * the container has stopped.
 *
 * A terminating pod still reads as Running, and its name stays taken. A start
 * that came right after a stop would otherwise find the old pod, start
 * nothing, and be left with no pod at all once it went.
 */
async function podGone(name: string, cfg: Config): Promise<void> {
  const deadline = Date.now() + (TERMINATION_GRACE_SECONDS + 30) * 1000;
  while (Date.now() < deadline) {
    try {
      await clientsFor(cfg).core.readNamespacedPod({ name, namespace: cfg.K8S_NAMESPACE });
    } catch (err) {
      if (statusCode(err) !== 404) {
        log.warn('could not confirm a deleted pod is gone', { pod: name, error: (err as Error).message });
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, podGonePollMs));
  }
  log.warn('a deleted pod is still terminating', { pod: name });
}

let podGonePollMs = 500;

/** Test seam: how often podGone looks. */
export function setPodGonePollForTests(ms: number): void {
  podGonePollMs = ms;
}

/** Resolves a pod's live state, mapping every lookup failure onto a state. */
export async function podState(name: string, cfg: Config): Promise<DockerState> {
  try {
    const pod = await clientsFor(cfg).core.readNamespacedPod({ name, namespace: cfg.K8S_NAMESPACE });
    switch (pod.status?.phase) {
      case 'Pending':
      case 'Running':
        return 'running';
      case 'Succeeded':
      case 'Failed':
        return 'exited';
      default:
        return 'unknown';
    }
  } catch (err) {
    if (statusCode(err) === 404) return 'missing';
    return 'unknown';
  }
}

/** Which of `destinations` the box container has no mount at. */
export async function missingMounts(
  name: string,
  destinations: readonly string[],
  cfg: Config,
): Promise<string[]> {
  try {
    const pod = await clientsFor(cfg).core.readNamespacedPod({ name, namespace: cfg.K8S_NAMESPACE });
    const container = pod.spec?.containers.find((c) => c.name === CONTAINER_NAME);
    const present = new Set((container?.volumeMounts ?? []).map((m) => m.mountPath));
    return destinations.filter((d) => !present.has(d));
  } catch {
    // A pod that cannot be inspected has nothing to fix by recreating it.
    return [];
  }
}

/** Every labelled box pod, for boot reconciliation and the orphan sweep. */
export async function listBoxPods(
  cfg: Config,
): Promise<Array<{ id: string; boxId: string; running: boolean; helper: boolean }>> {
  const list = await clientsFor(cfg).core.listNamespacedPod({
    namespace: cfg.K8S_NAMESPACE,
    labelSelector: LABEL,
  });
  return list.items.flatMap((pod) => {
    const boxId = pod.metadata?.labels?.[LABEL];
    const name = pod.metadata?.name;
    if (!boxId || !name) return [];
    // Kubernetes creates no short-lived helper pods of its own: the home seed
    // runs as an init container of the box pod itself, not a pod anybody
    // would find here.
    return [{ id: name, boxId, running: pod.status?.phase === 'Running', helper: false }];
  });
}

/** Every labelled box PVC, by the box each is labelled with. */
export async function listBoxClaims(
  cfg: Config,
): Promise<Array<{ name: string; boxId: string }>> {
  const list = await clientsFor(cfg).core.listNamespacedPersistentVolumeClaim({
    namespace: cfg.K8S_NAMESPACE,
    labelSelector: LABEL,
  });
  return list.items.flatMap((pvc) => {
    const boxId = pvc.metadata?.labels?.[LABEL];
    const name = pvc.metadata?.name;
    return boxId && name ? [{ name, boxId }] : [];
  });
}

function claimSpec(
  name: string,
  boxId: string,
  size: string,
  storageClass: string,
): V1PersistentVolumeClaim {
  return {
    metadata: { name, labels: { [LABEL]: boxId } },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: size } },
      ...(storageClass ? { storageClassName: storageClass } : {}),
    },
  };
}

/** Creates a box's PVC. */
export async function createClaim(
  name: string,
  boxId: string,
  size: string,
  cfg: Config,
): Promise<void> {
  await clientsFor(cfg).core.createNamespacedPersistentVolumeClaim({
    namespace: cfg.K8S_NAMESPACE,
    body: claimSpec(name, boxId, size, cfg.K8S_STORAGE_CLASS),
  });
}

/** Creates a box's PVC unless it is there already. */
export async function ensureClaim(
  name: string,
  boxId: string,
  size: string,
  cfg: Config,
): Promise<void> {
  try {
    await createClaim(name, boxId, size, cfg);
  } catch (err) {
    if (statusCode(err) !== 409) throw err;
  }
}

/** Removes a PVC, tolerating one that is already gone. */
export async function deleteClaim(name: string, cfg: Config): Promise<void> {
  try {
    await clientsFor(cfg).core.deleteNamespacedPersistentVolumeClaim({
      name,
      namespace: cfg.K8S_NAMESPACE,
    });
  } catch (err) {
    if (statusCode(err) !== 404) throw err;
  }
}

// --- network policy ------------------------------------------------------

/**
 * A box's `NetworkPolicy`: deny-all ingress, and egress narrowed to the
 * egress proxy plus DNS.
 *
 * The `k8s-app: kube-dns` selector is CoreDNS's own convention and the one
 * kind, minikube and a stock kubeadm cluster all ship with — but it is a
 * convention, not a guarantee: a cluster running a different DNS provider or
 * a relabelled CoreDNS needs this rule adjusted, or a box's egress can
 * resolve nothing and every host looks unreachable despite the policy being
 * otherwise correct.
 */
function boxNetworkPolicySpec(boxId: string, cfg: Config): V1NetworkPolicy {
  return {
    metadata: { name: networkPolicyName(boxId), labels: { [LABEL]: boxId } },
    spec: {
      podSelector: { matchLabels: { [LABEL]: boxId } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: [
        {
          to: [{ podSelector: { matchLabels: { app: cfg.K8S_EGRESS_PROXY_SERVICE } } }],
          ports: [{ protocol: 'TCP', port: cfg.EGRESS_PROXY_PORT }],
        },
        {
          to: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
              podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
            },
          ],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
      ],
    },
  };
}

/** Creates a box's `NetworkPolicy`. */
export async function createBoxNetworkPolicy(boxId: string, cfg: Config): Promise<void> {
  await clientsFor(cfg).networking.createNamespacedNetworkPolicy({
    namespace: cfg.K8S_NAMESPACE,
    body: boxNetworkPolicySpec(boxId, cfg),
  });
}

/**
 * Creates a box's `NetworkPolicy` if the cluster no longer has it, and
 * says whether it had to. Mirrors docker.ts's `ensureNetwork`.
 */
export async function ensureBoxNetworkPolicy(boxId: string, cfg: Config): Promise<boolean> {
  const existing = await inspecting(() =>
    clientsFor(cfg).networking.readNamespacedNetworkPolicy({
      name: networkPolicyName(boxId),
      namespace: cfg.K8S_NAMESPACE,
    }),
  );
  if (existing) return false;
  await createBoxNetworkPolicy(boxId, cfg);
  return true;
}

/** Whether a box's `NetworkPolicy` exists right now. */
export async function hasBoxNetworkPolicy(boxId: string, cfg: Config): Promise<boolean> {
  const existing = await inspecting(() =>
    clientsFor(cfg).networking.readNamespacedNetworkPolicy({
      name: networkPolicyName(boxId),
      namespace: cfg.K8S_NAMESPACE,
    }),
  );
  return existing !== null;
}

/** Removes a box's `NetworkPolicy`, tolerating one that is already gone. */
export async function deleteBoxNetworkPolicy(boxId: string, cfg: Config): Promise<void> {
  try {
    await clientsFor(cfg).networking.deleteNamespacedNetworkPolicy({
      name: networkPolicyName(boxId),
      namespace: cfg.K8S_NAMESPACE,
    });
  } catch (err) {
    if (statusCode(err) !== 404) throw err;
  }
}

/** Every labelled box `NetworkPolicy`, for the orphan sweep. */
export async function listBoxNetworkPolicies(
  cfg: Config,
): Promise<Array<{ name: string; boxId: string }>> {
  const list = await clientsFor(cfg).networking.listNamespacedNetworkPolicy({
    namespace: cfg.K8S_NAMESPACE,
    labelSelector: LABEL,
  });
  return list.items.flatMap((policy) => {
    const boxId = policy.metadata?.labels?.[LABEL];
    const name = policy.metadata?.name;
    return boxId && name ? [{ name, boxId }] : [];
  });
}

/** A lightweight call that throws when the cluster cannot be reached. */
export async function healthCheck(cfg: Config): Promise<void> {
  await clientsFor(cfg).core.readNamespace({ name: cfg.K8S_NAMESPACE });
}

// --- exec --------------------------------------------------------------

/**
 * Wraps a command so it runs with a working directory and extra environment
 * variables, neither of which the exec API takes natively the way Docker's
 * exec does.
 *
 * Every value here — the directory, each variable — travels as its own argv
 * entry, never appended into a string a shell parses; `sh -c`'s only
 * argument is the fixed script below, and `$1`/`$@` are what hand the real
 * values to it. The same discipline docker.ts's execInContainer keeps, for
 * the same reason.
 */
function wrapExec(cmd: readonly string[], opts: ExecOptions): string[] {
  let command: string[] = opts.timeoutMs === undefined
    ? [...cmd]
    : ['timeout', '--kill-after=5s', `${Math.ceil(opts.timeoutMs / 1000)}s`, ...cmd];
  if (opts.env) {
    command = ['env', ...Object.entries(opts.env).map(([k, v]) => `${k}=${v}`), ...command];
  }
  if (opts.workingDir !== undefined) {
    command = ['sh', '-c', 'cd "$1" && shift && exec "$@"', '_', opts.workingDir, ...command];
  }
  return command;
}

/** The exit code a finished exec's status carries, or null when it cannot be read. */
function exitCodeOf(status: V1Status): number | null {
  if (status.status === 'Success') return 0;
  const cause = status.details?.causes?.find((c) => c.reason === 'ExitCode');
  const code = cause?.message === undefined ? NaN : Number(cause.message);
  return Number.isInteger(code) ? code : null;
}

/** Everything a stream produced, as one string, up to a cap on its bytes — mirrors docker.ts's own `readAll`. */
async function readAll(stream: Readable, cap = Infinity): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.from(chunk as Buffer);
    if (size < cap) chunks.push(size + buf.length <= cap ? buf : buf.subarray(0, cap - size));
    size += buf.length;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Runs one command in a pod and collects its output, on the same terms as docker.ts's execInContainer. */
export async function execInPod(
  podId: string,
  cmd: string[],
  cfg: Config,
  opts: ExecOptions = {},
): Promise<ExecOutput> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let code: number | null = null;

  const [out, err] = await Promise.all([
    readAll(stdout, opts.maxOutput),
    readAll(stderr, opts.maxOutput),
    new Promise<void>((resolve, reject) => {
      clientsFor(cfg)
        .exec.exec(
          cfg.K8S_NAMESPACE,
          podId,
          CONTAINER_NAME,
          wrapExec(cmd, opts),
          stdout,
          stderr,
          null,
          false,
          (status) => {
            code = exitCodeOf(status);
          },
        )
        .then((ws) => {
          ws.on('close', () => resolve());
          ws.on('error', reject);
        }, reject);
    }),
  ]);
  return { stdout: out, stderr: err, code };
}

/** Everything a stream produced, as one buffer, up to a cap on its bytes — `readAll` without the lossy UTF-8 decode. */
async function readAllBuffer(stream: Readable, cap = Infinity): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.from(chunk as Buffer);
    if (size < cap) chunks.push(size + buf.length <= cap ? buf : buf.subarray(0, cap - size));
    size += buf.length;
  }
  return Buffer.concat(chunks);
}

/**
 * Runs one command in a pod and collects its stdout as raw bytes rather than
 * a decoded string — for the pod file-access script's `read` and `hash`
 * modes, where stdout is a file's own content and `execInPod`'s UTF-8 decode
 * would corrupt anything that is not valid UTF-8, which a workspace file has
 * no reason to be.
 */
export async function execInPodBinary(
  podId: string,
  cmd: string[],
  cfg: Config,
  opts: ExecOptions = {},
): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let code: number | null = null;

  const [out, err] = await Promise.all([
    readAllBuffer(stdout, opts.maxOutput),
    readAll(stderr, opts.maxOutput),
    new Promise<void>((resolve, reject) => {
      clientsFor(cfg)
        .exec.exec(
          cfg.K8S_NAMESPACE,
          podId,
          CONTAINER_NAME,
          wrapExec(cmd, opts),
          stdout,
          stderr,
          null,
          false,
          (status) => {
            code = exitCodeOf(status);
          },
        )
        .then((ws) => {
          ws.on('close', () => resolve());
          ws.on('error', reject);
        }, reject);
    }),
  ]);
  return { stdout: out, stderr: err, code };
}

/**
 * Runs one command in a pod with `input` fed to it on stdin, collecting its
 * output — the one thing `execInPod` cannot do, because its own stdin is
 * fixed to `null`. Used only by the pod file-access script's `write` mode,
 * which reads its content this way rather than as an argument.
 */
export async function execWithStdin(
  podId: string,
  cmd: string[],
  cfg: Config,
  input: Buffer,
): Promise<ExecOutput> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let code: number | null = null;
  // Buffered on the stream before the exec even starts, rather than after:
  // the remote end reads stdin as the command runs, and writing this once the
  // wait below has started would deadlock a command that reads before it
  // produces any output of its own.
  stdin.end(input);

  const [out, err] = await Promise.all([
    readAll(stdout),
    readAll(stderr),
    new Promise<void>((resolve, reject) => {
      clientsFor(cfg)
        .exec.exec(
          cfg.K8S_NAMESPACE,
          podId,
          CONTAINER_NAME,
          cmd,
          stdout,
          stderr,
          stdin,
          false,
          (status) => {
            code = exitCodeOf(status);
          },
        )
        .then((ws) => {
          ws.on('close', () => resolve());
          ws.on('error', reject);
        }, reject);
    }),
  ]);
  return { stdout: out, stderr: err, code };
}

/** Every process running in the box container, read from inside it — there is no `docker top` equivalent to ask the API for this instead. */
export async function listProcesses(podId: string, cfg: Config): Promise<ContainerProcess[]> {
  const { stdout, stderr, code } = await execInPod(podId, ['ps', '-eo', 'pid,ppid,args'], cfg);
  if (code !== 0) {
    throw new Error(
      `ps in the pod exited ${code ?? 'unknown'}: ${`${stdout}${stderr}`.trim()}`,
    );
  }
  const processes: ContainerProcess[] = [];
  for (const line of stdout.split('\n').slice(1)) {
    const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!row) continue;
    processes.push({ pid: Number(row[1]), ppid: Number(row[2]), command: row[3] ?? '', elapsedSeconds: null });
  }
  return processes;
}

/** Signals processes inside a pod, as the agent user — see docker.ts's killInContainer. */
export async function killInPod(
  podId: string,
  signal: 'TERM' | 'KILL',
  pids: readonly number[],
  cfg: Config,
): Promise<void> {
  if (pids.length === 0) return;
  const { stdout, stderr, code } = await execInPod(podId, ['kill', `-${signal}`, ...pids.map(String)], cfg);
  if (code !== 0) {
    log.debug('kill in pod reported trouble', { signal, pids, code, error: `${stdout}${stderr}`.trim() });
  }
}

/** Starts the adapter inside a running pod and demuxes its streams, on the same terms as docker.ts's spawnAdapterExec. */
export async function spawnAdapterExec(
  podId: string,
  cmd: string[],
  workingDir: string,
  cfg: Config,
): Promise<AdapterExec> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let exitCode: number | null = null;
  let settle: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    settle = resolve;
  });

  const socket = await clientsFor(cfg).exec.exec(
    cfg.K8S_NAMESPACE,
    podId,
    CONTAINER_NAME,
    wrapExec(cmd, { workingDir }),
    stdout,
    stderr,
    stdin,
    false,
    (status) => {
      exitCode = exitCodeOf(status);
    },
  );
  const finish = (): void => {
    stdout.end();
    stderr.end();
    settle(exitCode);
  };
  socket.on('close', finish);
  socket.on('error', (err: Error) => {
    log.warn('adapter exec stream error', { error: err.message });
    finish();
  });

  return {
    stdout,
    stderr,
    stdin,
    exited,
    kill: () => {
      try {
        socket.close();
      } catch {
        // already gone
      }
    },
  };
}

/** The tmux session every terminal on a pod shares — see docker.ts's own SHARED_TMUX_SESSION for why. */
const SHARED_TMUX_SESSION = 'boxes';

function terminalShell(client: string): string {
  return [
    'if ! command -v tmux >/dev/null 2>&1; then exec bash -l; fi',
    `tmux new-session -d -s ${SHARED_TMUX_SESSION} 2>/dev/null`,
    `exec tmux new-session -s ${client} -t ${SHARED_TMUX_SESSION}`,
  ].join('; ');
}

/**
 * Opens a pty in a box pod, running the shell a reader types into — see
 * docker.ts's openTerminalExec for the isolation this runs inside of, which
 * is unchanged here.
 *
 * Input and output are two streams joined into one Duplex: the exec writes
 * the pty's output to one and reads the reader's keys from the other, and one
 * stream for both would feed the shell its own output.
 *
 * The client library sizes the pty from the output stream's `columns` and
 * `rows` and resizes it on that stream's `resize` event, the protocol a
 * process.stdout speaks, so `resize` sets those and emits it.
 */
export async function openTerminalExec(
  podId: string,
  workingDir: string,
  cols: number,
  rows: number,
  cfg: Config,
): Promise<TerminalExec> {
  const client = `web-${randomBytes(4).toString('hex')}`;
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: cols, rows });
  const stream = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      input.write(chunk, encoding, callback);
    },
    final(callback) {
      input.end();
      callback();
    },
  });
  output.on('data', (chunk: Buffer) => stream.push(chunk));
  output.on('end', () => stream.push(null));
  let settle: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    settle = resolve;
  });

  const socket = await clientsFor(cfg).exec.exec(
    cfg.K8S_NAMESPACE,
    podId,
    CONTAINER_NAME,
    // The box's own TERM is dumb, for the agent's tools; a reader's terminal
    // is a real one, as docker.ts's exec says too.
    wrapExec(['bash', '-lc', terminalShell(client)], {
      workingDir,
      env: { TERM: 'xterm-256color' },
    }),
    output,
    output,
    input,
    true,
  );
  socket.on('close', () => {
    settle(null);
    output.end();
  });
  socket.on('error', (err: Error) => {
    log.warn('terminal exec stream error', { error: err.message });
    settle(null);
  });

  return {
    stream,
    resize: async (newCols, newRows) => {
      output.columns = newCols;
      output.rows = newRows;
      output.emit('resize');
    },
    exited,
    close: async () => {
      try {
        await execInPod(podId, ['tmux', 'kill-session', '-t', client], cfg);
      } catch (err) {
        log.debug('could not end a terminal box', { error: (err as Error).message });
      }
      try {
        socket.close();
      } catch {
        // already gone
      }
    },
  };
}
