import { credentialEnv, AGENT_CONFIG_DIR, NIX_DIR, WORKSPACE_DIR } from '../docker.ts';
import type { Config } from '../config.ts';
import * as k8s from '../kubernetes.ts';
import { log } from '../log.ts';
import type { ProvisionedVolumes, Runtime } from './types.ts';

/**
 * The Kubernetes runtime: every box is a pod in `cfg.K8S_NAMESPACE`, its
 * workspace, home and Nix store are PVCs, and its agent configuration is an empty dir —
 * see kubernetes.ts for the pod template itself.
 *
 * Network isolation is a `NetworkPolicy` per box, replacing Docker's
 * internal bridge network and dynamic proxy attachment. A `NetworkPolicy`
 * object is only as good as the cluster's CNI: Calico and Cilium enforce it,
 * but Flannel's default configuration — what kind, minikube and k3s all run
 * out of the box — does not, in which case a box reaches the whole
 * cluster and the internet despite the policy existing. Logged once here so
 * that gap cannot go unnoticed on a cluster nobody has checked.
 */
let warnedAboutNetworkIsolation = false;

export function kubernetesRuntime(cfg: Config): Runtime {
  // `runtime()` builds a fresh Runtime on every call, on the same terms as
  // dockerRuntime — so this guards the warning itself rather than relying on
  // the caller to log it once.
  if (!warnedAboutNetworkIsolation) {
    warnedAboutNetworkIsolation = true;
    log.warn(
      'the kubernetes runtime creates a NetworkPolicy per box, but enforcement depends on ' +
        "the cluster's CNI supporting NetworkPolicy (Calico or Cilium do; Flannel's default " +
        'configuration in kind/minikube/k3s does not) — verify this on the cluster before ' +
        'relying on it for isolation',
    );
  }

  return {
    boxes: {
      names: {
        container: k8s.podName,
        // The NetworkPolicy's own name, on the same terms Docker's network
        // name is a real object's name too — row.network_name has to carry
        // this rather than the bare box id, because removeNetwork/
        // ensureProxyAttached/isProxyAttached only ever receive this one
        // string back, with no box id alongside it to fall back on.
        network: k8s.networkPolicyName,
      },
      WORKSPACE_DIR,
      AGENT_CONFIG_DIR,
      NIX_DIR,
      credentialEnv,

      // create/ensureNetwork get the box id as their own argument, so
      // they never need to recover it from the name.
      createNetwork: (_networkName, _subnet, boxId) => k8s.createBoxNetworkPolicy(boxId, cfg),
      ensureNetwork: (_networkName, _subnet, boxId) => k8s.ensureBoxNetworkPolicy(boxId, cfg),
      // These three take only the object's name — recover the box id
      // `networkPolicyName` built it from, the same way bindSource() in
      // docker-runtime.ts reads a Docker bind source back out of a VolumeRef.
      removeNetwork: (networkName) =>
        k8s.deleteBoxNetworkPolicy(k8s.boxIdFromNetworkPolicyName(networkName), cfg),
      // The one NetworkPolicy already grants egress to the proxy; there is no
      // separate "attach" step the way a Docker network connect is one.
      ensureProxyAttached: (networkName) =>
        k8s.ensureBoxNetworkPolicy(k8s.boxIdFromNetworkPolicyName(networkName), cfg),
      isProxyAttached: (networkName) =>
        k8s.hasBoxNetworkPolicy(k8s.boxIdFromNetworkPolicyName(networkName), cfg),

      createContainer: (spec) =>
        k8s.createPod(
          {
            boxId: spec.boxId,
            image: spec.image,
            volumes: spec.volumes,
            env: spec.env,
            caCertificate: spec.caCertificate,
          },
          cfg,
        ),
      startContainer: (id) => k8s.startPod(id, cfg),
      stopContainer: (id) => k8s.deletePod(id, cfg),
      removeContainer: (id) => k8s.deletePod(id, cfg),
      containerState: (id) => (id ? k8s.podState(id, cfg) : Promise.resolve('missing')),
      missingMounts: (id, destinations) => k8s.missingMounts(id, destinations, cfg),

      listBoxContainers: () => k8s.listBoxPods(cfg),
      listBoxNetworks: () => k8s.listBoxNetworkPolicies(cfg),
      listBoxVolumes: () => k8s.listBoxClaims(cfg),
      // The login flow stays Docker-only; see login.ts's own LoginRuntime.
      listLoginContainers: () => Promise.resolve([]),
      removeVolume: (name) => k8s.deleteClaim(name, cfg),

      seedHomeFromImage: () =>
        Promise.reject(
          new Error('not applicable to the kubernetes runtime: home seeding runs as a pod init container'),
        ),
      copyVolumeToDirectory: () =>
        Promise.reject(
          new Error('not applicable to the kubernetes runtime: a kubernetes box is never volume-backed'),
        ),

      inContainer: () => false,
      resolveHostMountSource: () => Promise.resolve(null),

      // Neither hostDataDir nor a legacy home volume means anything here: a
      // Kubernetes box's mounts are PVCs named from its id alone.
      volumeRefs: (boxId): ProvisionedVolumes => ({
        workspace: { kind: 'k8s-pvc', claimName: k8s.workspaceClaimName(boxId) },
        home: { kind: 'k8s-pvc', claimName: k8s.homeClaimName(boxId) },
        nix: { kind: 'k8s-pvc', claimName: k8s.nixClaimName(boxId) },
        agentConfig: { kind: 'k8s-emptydir' },
      }),
      provisionVolumes: async (boxId, _image, volumes) => {
        if (volumes.workspace.kind === 'k8s-pvc') {
          await k8s.createClaim(volumes.workspace.claimName, boxId, cfg.K8S_WORKSPACE_SIZE, cfg);
        }
        if (volumes.home.kind === 'k8s-pvc') {
          await k8s.createClaim(volumes.home.claimName, boxId, cfg.K8S_HOME_SIZE, cfg);
        }
        if (volumes.nix.kind === 'k8s-pvc') {
          await k8s.createClaim(volumes.nix.claimName, boxId, cfg.K8S_NIX_SIZE, cfg);
        }
        // The home's own content is seeded by createPod's init container, not
        // here: the PVC has to exist first, but nothing can run against it
        // until a pod mounts it.
      },
      // A box from before Nix stores existed has no claim for one, and a pod
      // naming a missing claim never schedules.
      ensureAddedVolumes: async (boxId, volumes) => {
        if (volumes.nix.kind === 'k8s-pvc') {
          await k8s.ensureClaim(volumes.nix.claimName, boxId, cfg.K8S_NIX_SIZE, cfg);
        }
      },
      removeVolumes: async (_boxId, volumes) => {
        if (volumes.workspace.kind === 'k8s-pvc') {
          await k8s.deleteClaim(volumes.workspace.claimName, cfg);
        }
        if (volumes.home.kind === 'k8s-pvc') {
          await k8s.deleteClaim(volumes.home.claimName, cfg);
        }
        if (volumes.nix.kind === 'k8s-pvc') {
          await k8s.deleteClaim(volumes.nix.claimName, cfg);
        }
      },
    },
    exec: {
      execInContainer: (id, cmd, opts) => k8s.execInPod(id, cmd, cfg, opts),
      spawnAdapterExec: (id, cmd, workingDir) => k8s.spawnAdapterExec(id, cmd, workingDir, cfg),
      openTerminalExec: (id, workingDir) => k8s.openTerminalExec(id, workingDir, cfg),
      // There is no `docker top` equivalent to ask the API for this instead,
      // so both readings come from the same in-pod `ps`.
      containerProcesses: (id) => k8s.listProcesses(id, cfg),
      containerProcessesFromInside: (id) => k8s.listProcesses(id, cfg),
      killInContainer: (id, signal, pids) => k8s.killInPod(id, signal, pids, cfg),
    },
    images: {
      // The kubelet on whichever node schedules a pod pulls its image
      // itself; this process has no Docker Engine API to a cluster node to
      // ask about one directly.
      imageId: () => Promise.resolve(null),
      pullImage: () => Promise.resolve(),
      imageUserUid: () => Promise.resolve(null),
      imageInfo: () => Promise.resolve(null),
      containerImageId: () => Promise.resolve(null),
      listSupersededBoxImages: () => Promise.resolve([]),
      removeImage: () => Promise.resolve(false),
    },
    system: {
      healthCheck: () => k8s.healthCheck(cfg),
      selfContainerId: () => null,
    },
  };
}
