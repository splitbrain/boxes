import { hostAgentConfigPath } from '../agents.ts';
import type { Config } from '../config.ts';
import * as dk from '../docker.ts';
import { log } from '../log.ts';
import * as ws from '../workspaces.ts';
import type { ProvisionedVolumes, Runtime, VolumeRef } from './types.ts';

/** The Docker bind source a `docker-path`/`docker-volume` ref names. Nothing else may back a Docker mount. */
function bindSource(ref: VolumeRef): string {
  if (ref.kind === 'docker-path') return ref.path;
  if (ref.kind === 'docker-volume') return ref.volumeName;
  throw new Error(`a ${ref.kind} volume ref cannot back a Docker container`);
}

/**
 * The real thing: every box runtime operation driven over the Docker
 * socket, exactly as `docker.ts` already does it.
 *
 * A pure delegation layer rather than a reimplementation, so this stays
 * behaviourally identical to what every caller already did through `dk.*`
 * before the runtime abstraction existed. `cfg` is read fresh from the
 * caller of {@link dockerRuntime} rather than cached on the returned object,
 * matching `docker.ts`'s own functions, which take it as an argument rather
 * than closing over one taken at some earlier moment.
 */
export function dockerRuntime(cfg: Config): Runtime {
  return {
    boxes: {
      names: dk.names,
      WORKSPACE_DIR: dk.WORKSPACE_DIR,
      AGENT_CONFIG_DIR: dk.AGENT_CONFIG_DIR,
      NIX_DIR: dk.NIX_DIR,
      credentialEnv: dk.credentialEnv,
      createNetwork: (networkName, subnet, boxId) =>
        dk.createNetwork(networkName, subnet, boxId),
      ensureNetwork: (networkName, subnet, boxId) =>
        dk.ensureNetwork(networkName, subnet, boxId),
      removeNetwork: (networkName) => dk.removeNetwork(networkName, cfg),
      ensureProxyAttached: (networkName) => dk.ensureProxyAttached(networkName, cfg),
      isProxyAttached: (networkName) => dk.isProxyAttached(networkName, cfg),
      createContainer: (spec) =>
        dk.createContainer(
          {
            boxId: spec.boxId,
            image: spec.image,
            networkName: spec.networkName,
            subnet: spec.subnet,
            workspaceSource: bindSource(spec.volumes.workspace),
            homeSource: bindSource(spec.volumes.home),
            nixSource: bindSource(spec.volumes.nix),
            agentConfigSource: bindSource(spec.volumes.agentConfig),
            env: spec.env,
            caCertificate: spec.caCertificate,
          },
          cfg,
        ),
      startContainer: (containerId) => dk.startContainer(containerId),
      stopContainer: (containerId) => dk.stopContainer(containerId),
      removeContainer: (containerId) => dk.removeContainer(containerId),
      containerState: (containerId) => dk.containerState(containerId),
      missingMounts: (containerId, destinations) => dk.missingMounts(containerId, destinations),
      listBoxContainers: () => dk.listBoxContainers(),
      listBoxNetworks: () => dk.listBoxNetworks(),
      listBoxVolumes: () => dk.listBoxVolumes(),
      listLoginContainers: () => dk.listLoginContainers(),
      removeVolume: (name) => dk.removeVolume(name),
      seedHomeFromImage: (hostDirectory, image, boxId) =>
        dk.seedHomeFromImage(hostDirectory, image, boxId),
      copyVolumeToDirectory: (volumeName, hostDirectory, image, boxId) =>
        dk.copyVolumeToDirectory(volumeName, hostDirectory, image, boxId),
      inContainer: () => dk.inContainer(),
      resolveHostMountSource: (destination) => dk.resolveHostMountSource(destination),

      volumeRefs: (boxId, hostDataDir, legacyHomeVolume): ProvisionedVolumes => ({
        workspace: { kind: 'docker-path', path: ws.hostWorkspacePath(hostDataDir, boxId) },
        home: legacyHomeVolume
          ? { kind: 'docker-volume', volumeName: legacyHomeVolume }
          : { kind: 'docker-path', path: ws.hostHomePath(hostDataDir, boxId) },
        nix: { kind: 'docker-path', path: ws.hostNixPath(hostDataDir, boxId) },
        agentConfig: {
          kind: 'docker-path',
          path: hostAgentConfigPath(hostDataDir, boxId),
        },
      }),
      provisionVolumes: async (boxId, image, volumes) => {
        ws.createWorkspace(cfg.DATA_DIR, boxId);
        ws.createNix(cfg.DATA_DIR, boxId);
        ws.createHome(cfg.DATA_DIR, boxId);
        // A directory-backed home starts out empty and needs the image's own
        // seed; a legacy volume is Docker-initialised already and never
        // reaches here through create() in the first place.
        if (volumes.home.kind === 'docker-path') {
          await dk.seedHomeFromImage(volumes.home.path, image, boxId);
        }
      },
      // Before anything binds it, or the daemon creates it empty and owned
      // by root.
      ensureAddedVolumes: async (boxId) => {
        ws.createNix(cfg.DATA_DIR, boxId);
      },
      removeVolumes: async (boxId, volumes) => {
        if (volumes.workspace.kind === 'docker-path') {
          try {
            ws.removeWorkspace(cfg.DATA_DIR, boxId);
          } catch (err) {
            log.box(boxId).warn('workspace removal failed', {
              error: (err as Error).message,
            });
          }
        }
        if (volumes.home.kind === 'docker-path') {
          try {
            ws.removeHome(cfg.DATA_DIR, boxId);
          } catch (err) {
            log.box(boxId).warn('home removal failed', {
              error: (err as Error).message,
            });
          }
        } else if (volumes.home.kind === 'docker-volume') {
          await dk.removeVolume(volumes.home.volumeName);
        }
        try {
          ws.removeNix(cfg.DATA_DIR, boxId);
        } catch (err) {
          log.box(boxId).warn('nix store removal failed', {
            error: (err as Error).message,
          });
        }
      },
    },
    exec: {
      execInContainer: (containerId, cmd, opts) => dk.execInContainer(containerId, cmd, opts),
      spawnAdapterExec: (containerId, cmd, workingDir) =>
        dk.spawnAdapterExec(containerId, cmd, workingDir),
      openTerminalExec: (containerId, workingDir, cols, rows) =>
        dk.openTerminalExec(containerId, workingDir, cols, rows),
      containerProcesses: (containerId) => dk.containerProcesses(containerId),
      containerProcessesFromInside: (containerId) => dk.containerProcessesFromInside(containerId),
      killInContainer: (containerId, signal, pids) =>
        dk.killInContainer(containerId, signal, pids),
    },
    images: {
      imageId: (image) => dk.imageId(image),
      pullImage: (image) => dk.pullImage(image),
      imageUserUid: (image) => dk.imageUserUid(image),
      imageInfo: (image) => dk.imageInfo(image),
      containerImageId: (containerId) => dk.containerImageId(containerId),
      listSupersededBoxImages: () => dk.listSupersededBoxImages(),
      removeImage: (id) => dk.removeImage(id),
    },
    system: {
      healthCheck: async () => {
        await dk.docker().ping();
      },
      selfContainerId: () => dk.selfContainerId(),
    },
  };
}
