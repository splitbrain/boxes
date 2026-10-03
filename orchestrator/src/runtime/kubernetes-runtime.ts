import { credentialEnv, AGENT_CONFIG_DIR, NIX_DIR, WORKSPACE_DIR } from '../docker.ts';
import type { Config } from '../config.ts';
import * as k8s from '../kubernetes.ts';
import { log } from '../log.ts';
import type { ProvisionedVolumes, Runtime } from './types.ts';

/**
 * The Kubernetes runtime: every box is a pod in `cfg.K8S_NAMESPACE`, its
 * workspace, home and Nix store are subPaths of one PVC, and its agent configuration is an empty dir —
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
      // separate "attach" step the way a Docker network connect is one. So the
      // box is attached once its policy is there, whether it was already or
      // has just been made, and not attached when that fails, as docker.ts
      // answers.
      ensureProxyAttached: async (networkName) => {
        try {
          await k8s.ensureBoxNetworkPolicy(k8s.boxIdFromNetworkPolicyName(networkName), cfg);
          return true;
        } catch (err) {
          log.warn('could not make the NetworkPolicy that lets a box reach the proxy', {
            networkPolicy: networkName,
            error: (err as Error).message,
          });
          return false;
        }
      },
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
      // Kubernetes box's mounts are subPaths of one PVC named from its id
      // alone — one block volume to attach per box, not three.
      volumeRefs: (boxId): ProvisionedVolumes => {
        const claimName = k8s.boxClaimName(boxId);
        return {
          workspace: { kind: 'k8s-pvc', claimName, subPath: 'workspace' },
          home: { kind: 'k8s-pvc', claimName, subPath: 'home' },
          nix: { kind: 'k8s-pvc', claimName, subPath: 'nix' },
          agentConfig: { kind: 'k8s-emptydir' },
        };
      },
      provisionVolumes: async (boxId, _image, volumes) => {
        for (const claimName of claimNames(volumes)) {
          await k8s.createClaim(claimName, boxId, cfg.K8S_VOLUME_SIZE, cfg);
        }
        // The subPaths and the home's own content are made by createPod's
        // init container, not here: the PVC has to exist first, but nothing
        // can run against it until a pod mounts it.
      },
      // Every Kubernetes box has had all three mounts on its claim since it
      // was created. A claim that has gone is lost data, which an empty
      // replacement would only hide.
      ensureAddedVolumes: () => Promise.resolve(),
      removeVolumes: async (_boxId, volumes) => {
        for (const claimName of claimNames(volumes)) {
          await k8s.deleteClaim(claimName, cfg);
        }
      },
    },
    exec: {
      execInContainer: (id, cmd, opts) => k8s.execInPod(id, cmd, cfg, opts),
      spawnAdapterExec: (id, cmd, workingDir) => k8s.spawnAdapterExec(id, cmd, workingDir, cfg),
      openTerminalExec: (id, workingDir, cols, rows) =>
        k8s.openTerminalExec(id, workingDir, cols, rows, cfg),
      // There is no `docker top` equivalent to ask the API for this instead,
      // so both readings come from the same in-pod `ps`.
      containerProcesses: (id) => k8s.listProcesses(id, cfg),
      containerProcessesFromInside: (id) => k8s.listProcesses(id, cfg),
      killInContainer: (id, signal, pids) => k8s.killInPod(id, signal, pids, cfg),
    },
    images: {
      // The kubelet on whichever node schedules a pod pulls its image
      // itself; this process has no Docker Engine API to a cluster node to
      // ask about one directly. So an image is known by its reference: a box
      // whose pod runs another reference than BOX_IMAGE moves onto it, which
      // takes a new tag per build, and a moving tag such as latest is not
      // noticed.
      imageId: (image) => Promise.resolve(image),
      pullImage: () => Promise.resolve(),
      imageUserUid: () => Promise.resolve(null),
      imageInfo: () => Promise.resolve(null),
      containerImageId: (id) => k8s.podImage(id, cfg),
      listSupersededBoxImages: () => Promise.resolve([]),
      removeImage: () => Promise.resolve(false),
    },
    system: {
      healthCheck: () => k8s.healthCheck(cfg),
      selfContainerId: () => null,
    },
  };
}

/** The distinct PVCs a box's mounts name. */
function claimNames(volumes: ProvisionedVolumes): string[] {
  const names = [volumes.workspace, volumes.home, volumes.nix, volumes.agentConfig].flatMap((ref) =>
    ref.kind === 'k8s-pvc' ? [ref.claimName] : [],
  );
  return [...new Set(names)];
}
