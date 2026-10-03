import type { DockerState, ImageInfo } from '../../../shared/types.ts';
import type {
  AdapterExec,
  ContainerProcess,
  ExecOptions,
  ExecOutput,
  TerminalExec,
} from '../docker.ts';

export type { AdapterExec, ContainerProcess, ExecOptions, ExecOutput, TerminalExec };

/**
 * A backend's own handle for one of a box's four mounts, opaque to
 * everything but the runtime that issued it.
 *
 * A host path for Docker and a claim name for Kubernetes are not the same
 * kind of thing, and nothing outside the two runtime implementations needs to
 * tell them apart — `boxes.ts` only ever carries one of these from
 * `volumeRefs` to `createContainer`.
 */
export type VolumeRef =
  | { kind: 'docker-path'; path: string }
  | { kind: 'docker-volume'; volumeName: string }
  | { kind: 'k8s-pvc'; claimName: string }
  | { kind: 'k8s-emptydir' };

/** The four mounts every box container has, whatever backs them. */
export interface ProvisionedVolumes {
  workspace: VolumeRef;
  home: VolumeRef;
  nix: VolumeRef;
  agentConfig: VolumeRef;
}

/**
 * Everything a box's container needs to know about it, backend-neutral.
 *
 * The Docker-specific counterpart, `docker.ts`'s own `CreateContainerSpec`, is
 * built from this inside `docker-runtime.ts`: the four raw bind sources it
 * wants are read out of `volumes` there, where the `docker-path`/`docker-volume`
 * split is understood, rather than carried as strings this far up.
 */
export interface BoxContainerSpec {
  boxId: string;
  image: string;
  networkName: string;
  subnet: string;
  volumes: ProvisionedVolumes;
  env: Record<string, string>;
  caCertificate: string;
}

/**
 * Container, network, volume and image lifecycle for boxes: everything
 * `BoxManager` needs from the runtime it is deployed on.
 *
 * Shaped after `docker.ts`'s own exports rather than an idealised backend,
 * because the point of this interface is to hide which one is behind it
 * without changing what a caller has to know to use it.
 */
export interface BoxRuntime {
  names: {
    container(boxId: string): string;
    network(boxId: string): string;
  };
  readonly WORKSPACE_DIR: string;
  readonly AGENT_CONFIG_DIR: string;
  readonly NIX_DIR: string;

  credentialEnv(
    placeholderFor: (credentialId: string) => string,
    identity: { gitName: string; gitEmail: string },
    gitlabHost: string,
  ): Record<string, string>;

  createNetwork(networkName: string, subnet: string, boxId: string): Promise<void>;
  ensureNetwork(networkName: string, subnet: string, boxId: string): Promise<boolean>;
  removeNetwork(networkName: string): Promise<void>;
  ensureProxyAttached(networkName: string): Promise<boolean>;
  isProxyAttached(networkName: string): Promise<boolean>;

  createContainer(spec: BoxContainerSpec): Promise<string>;
  startContainer(containerId: string): Promise<void>;
  stopContainer(containerId: string): Promise<void>;
  removeContainer(containerId: string): Promise<void>;
  containerState(containerId: string | null): Promise<DockerState>;
  /** Which of `destinations` a container has no mount at. */
  missingMounts(containerId: string, destinations: readonly string[]): Promise<string[]>;

  listBoxContainers(): Promise<
    Array<{ id: string; boxId: string; running: boolean; helper: boolean }>
  >;
  listBoxNetworks(): Promise<Array<{ name: string; boxId: string }>>;
  listBoxVolumes(): Promise<Array<{ name: string; boxId: string }>>;
  listLoginContainers(): Promise<
    Array<{ id: string; credentialId: string; createdAt: number }>
  >;
  removeVolume(name: string): Promise<void>;

  seedHomeFromImage(hostDirectory: string, image: string, boxId: string): Promise<void>;
  copyVolumeToDirectory(
    volumeName: string,
    hostDirectory: string,
    image: string,
    boxId: string,
  ): Promise<void>;

  /** Whether this process itself is running inside a container. */
  inContainer(): boolean;
  /** The host-side path of a directory mounted into this process's own container. */
  resolveHostMountSource(destination: string): Promise<string | null>;

  /**
   * The backend-specific handles for a box's four mounts, deterministic
   * from its id and carrying no side effect — safe to call on every create
   * and every recreate alike.
   *
   * `hostDataDir` and `legacyHomeVolume` are Docker's own concerns (a bind
   * source, and a named volume a box created before homes became
   * directories still mounts); a Kubernetes implementation takes and ignores
   * both, since neither concept exists there.
   */
  volumeRefs(
    boxId: string,
    hostDataDir: string,
    legacyHomeVolume: string | null,
  ): ProvisionedVolumes;
  /** Creates what `volumeRefs` named: directories and a home seed for Docker, PVCs and an init container's seed for Kubernetes. */
  provisionVolumes(boxId: string, image: string, volumes: ProvisionedVolumes): Promise<void>;
  /**
   * Creates the mounts a box created before they existed lacks: the Nix
   * store, for now. Does nothing for a box that has them all.
   */
  ensureAddedVolumes(boxId: string, volumes: ProvisionedVolumes): Promise<void>;
  /** Removes what `provisionVolumes` created. Tolerates what is already gone. */
  removeVolumes(boxId: string, volumes: ProvisionedVolumes): Promise<void>;
}

/** Running commands and long-lived streams inside a box's container. */
export interface BoxExecRuntime {
  execInContainer(
    containerId: string,
    cmd: string[],
    opts?: ExecOptions,
  ): Promise<ExecOutput>;
  spawnAdapterExec(containerId: string, cmd: string[], workingDir: string): Promise<AdapterExec>;
  openTerminalExec(
    containerId: string,
    workingDir: string,
    cols: number,
    rows: number,
  ): Promise<TerminalExec>;
  containerProcesses(containerId: string): Promise<ContainerProcess[]>;
  containerProcessesFromInside(containerId: string): Promise<ContainerProcess[]>;
  killInContainer(
    containerId: string,
    signal: 'TERM' | 'KILL',
    pids: readonly number[],
  ): Promise<void>;
}

/** The box image's own lifecycle: pulling it, and reading what is on the host. */
export interface BoxImageRuntime {
  imageId(image: string): Promise<string | null>;
  pullImage(image: string): Promise<void>;
  imageUserUid(image: string): Promise<number | null>;
  imageInfo(image: string): Promise<ImageInfo | null>;
  containerImageId(containerId: string): Promise<string | null>;
  listSupersededBoxImages(): Promise<string[]>;
  removeImage(id: string): Promise<boolean>;
}

/** Facts about the runtime itself, rather than about any one box. */
export interface RuntimeSystem {
  /** Throws when the runtime cannot be reached. */
  healthCheck(): Promise<void>;
  /** This process's own container id, or null when it is not in one. */
  selfContainerId(): string | null;
}

/** Everything `BoxManager` and the gateway need from the deployment's runtime. */
export interface Runtime {
  boxes: BoxRuntime;
  exec: BoxExecRuntime;
  images: BoxImageRuntime;
  system: RuntimeSystem;
}
