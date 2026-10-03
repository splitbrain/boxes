import { randomBytes } from 'node:crypto';
import {
  GLOBAL_AGENT_SET,
  type CreateBoxBody,
  type CreateThreadBody,
  type HarnessId,
  type BoxDetail,
  type BoxSummary,
  type BoxTunnel,
  type ThreadOptions,
  type ThreadSummary,
} from '../../shared/types.ts';
import { AgentStore, ensureAgentsRoot } from './agents.ts';
import type { Config } from './config.ts';
import type { EgressManager } from './egress.ts';
import {
  clearBoxTurns,
  latestThread,
  getThread,
  insertThread,
  listThreads,
  nextSubnetIndex,
  boxTurnActive,
  boxesWithActiveTurns,
  setThreadDone,
  threadConfig,
  takenSubnets,
  touchBox,
  type Db,
  type BoxRow,
  type ThreadRow,
} from './db.ts';
import { BoxUsage, BOX_SIZE_TTL_MS } from './diskusage.ts';
import { fileAccess } from './fileaccess.ts';
import type { FileRoot } from './fileaccess/types.ts';
import { DEFAULT_HARNESS, harness } from './harness.ts';
import { HttpError } from './http-error.ts';
import { LOGIN_CONTAINER_MAX_AGE_MS } from './login.ts';
import { log } from './log.ts';
import type { Notifier } from './notify.ts';
import { isDirectory } from './review/fs.ts';
import { runtime } from './runtime.ts';
import type { BoxContainerSpec, BoxRuntime, ProvisionedVolumes } from './runtime/types.ts';
import { generateWsToken } from './secret.ts';
import { readSettings } from './settings.ts';
import type { BoxReading } from './tunnels.ts';
import * as ws from './workspaces.ts';
import { PendingStore } from './gateway/pending.ts';
import { NOTHING_TO_FORK, THREAD_NOT_FOUND, UpstreamBox } from './gateway/upstream.ts';
import { allocateSubnet } from './subnet.ts';

/**
 * How many times more boxes the host may hold than the database knows of
 * before the orphan sweep refuses to run.
 *
 * It catches a database that does not belong to these files, such as a data
 * volume mounted from the wrong place. A ratio rather than an empty-table
 * check, so one box created against the wrong database does not disarm it.
 */
const STRAY_BOX_RATIO = 3;

/**
 * How often typing in a terminal writes the box's activity back, in
 * milliseconds.
 *
 * The reaper reads activity in minutes, so writing a row per keystroke would
 * record nothing it acts on any differently.
 */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Creates, starts, stops and describes boxes, and owns every UpstreamBox.
 * Docker holds the runtime state; the boxes table holds the metadata.
 */
export class BoxManager {
  /** The gateway connection of each box, created on first use. */
  private readonly upstreams = new Map<string, UpstreamBox>();

  /**
   * One promise chain per box, so two operations that change the same box
   * never overlap. Different boxes do not wait on each other, and a
   * box's entry goes as soon as its chain drains.
   */
  private readonly slots = new Map<string, Promise<unknown>>();

  /**
   * Boxes a stop or a delete has overtaken. Whatever is queued or running
   * for one gives itself up at its next step; see {@link giveUpIfPreempted}.
   */
  private readonly preempted = new Set<string>();

  /**
   * How many terminals are open on each box, and when typing in one last
   * marked it active.
   *
   * A box with a terminal open holds the reaper off the way an attached
   * browser does. Entries go as the last terminal of a box closes.
   */
  private readonly terminals = new Map<string, { open: number; touchedAt: number }>();

  /** Permission requests waiting for a browser, across all boxes. */
  readonly pending: PendingStore;

  /**
   * How big each box has got, measured off the request path.
   *
   * A path here is a `<root>:<id>` token rather than a filesystem path, and
   * fileAccess() measures it: for Docker the same directory
   * workspacePathOf/homePathOf/nixPathOf name, for Kubernetes over the box's
   * pod.
   */
  private readonly usage = new BoxUsage({
    // Everything a box is on disk. A box on a named home volume has no home
    // path, so only its workspace and Nix store count.
    pathsOf: (id) => [
      this.workspacePathOf(id) ? `workspace:${id}` : null,
      this.homePathOf(id) ? `home:${id}` : null,
      this.cfg.RUNTIME === 'kubernetes' || this.nixPathOf(id) ? `nix:${id}` : null,
    ],
    ttlMs: BOX_SIZE_TTL_MS,
    measure: (token) => {
      const [root, id] = token.split(':') as [FileRoot, string];
      return fileAccess(this.cfg).directorySize(id, root);
    },
    onTrouble: (id, error) =>
      log.box(id).warn('could not measure what a box is using', {
        error: error.message,
      }),
  });

  /**
   * Host-side path of DATA_DIR, which is what a workspace bind source has to
   * name. Starts as this process's own path — the truth outside a container,
   * where `npm run dev` and the tests run — and is replaced at boot by
   * resolveHostDataDir().
   */
  private hostDataDir: string;

  constructor(
    /** Where the boxes and their threads are stored. */
    private readonly db: Db,
    /** The deployment's configuration. */
    private readonly cfg: Config,
    /** The egress policy, and the credential placeholders a box is given. */
    private readonly egress: EgressManager,
    /** Sends the push notifications a thread raises. */
    private readonly notifier: Notifier,
    /**
     * The AGENTS.md, skills and commands a box is given. The app creates it,
     * so the REST routes and the lifecycle share one store.
     */
    private readonly agents: AgentStore,
    /** The dev tunnel ports a box hosts, as the tunnel reconciler last read them. */
    private readonly tunnelsOf: (boxId: string) => BoxTunnel[] = () => [],
  ) {
    this.pending = new PendingStore(db);
    this.hostDataDir = cfg.HOST_DATA_DIR || cfg.DATA_DIR;
  }

  // --- one operation per box at a time -----------------------------------

  /**
   * Runs `fn` with the box to itself, after whatever is already queued
   * for it.
   *
   * Container repairs check the daemon's state and act on it a moment later.
   * Start, a local command and the gateway all reach them, and the reaper
   * stops boxes under all three. So every operation that changes a box runs
   * alone, in arrival order. Reads are not queued. A request for a busy box
   * waits without a timeout, and a rejection does not block the queue.
   *
   * Nothing `fn` calls may take a slot for the same box again, or it would
   * wait for itself forever. So each queued public method wraps a private
   * form that takes no slot, and the repairs and the teardown call those.
   */
  private withSlot<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.slots.get(id) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const tail: Promise<void> = result.then(
      () => this.releaseSlot(id, tail),
      () => this.releaseSlot(id, tail),
    );
    this.slots.set(id, tail);
    return result;
  }

  /** Forgets a box's chain once nothing is left waiting on it. */
  private releaseSlot(id: string, tail: Promise<void>): void {
    if (this.slots.get(id) === tail) this.slots.delete(id);
  }

  /**
   * Gives up the operation in flight when a stop or a delete has overtaken
   * it.
   *
   * Checked between the steps of an operation rather than inside one: a
   * container half created is worse than one step too many, and every step
   * here is short.
   */
  private giveUpIfPreempted(id: string): void {
    if (!this.preempted.has(id)) return;
    throw new HttpError(409, 'This box was stopped while the request was in flight');
  }

  // --- workspaces -----------------------------------------------------------

  /**
   * Resolves the host-side path of DATA_DIR, once, at boot.
   *
   * Inside a container, the orchestrator's path for its data volume is not
   * the path the daemon resolves a bind source against. A wrong path fails
   * silently: the daemon creates an empty directory there and mounts it, and
   * the agent's files end up where the orchestrator cannot see them. So a
   * failure here is fatal, and the message names the setting that fixes it.
   */
  async resolveHostDataDir(): Promise<void> {
    // Bind sources are a Docker concern alone: a Kubernetes box's mounts are
    // PVCs, named from its id rather than resolved against a host path.
    if (this.cfg.RUNTIME === 'kubernetes') return;
    ws.ensureWorkspacesRoot(this.cfg.DATA_DIR);
    ensureAgentsRoot(this.cfg.DATA_DIR);
    if (this.cfg.HOST_DATA_DIR) {
      log.info('using the configured host path for the data directory', {
        hostDataDir: this.hostDataDir,
      });
      return;
    }
    if (!runtime(this.cfg).boxes.inContainer()) return;
    const source = await runtime(this.cfg).boxes.resolveHostMountSource(this.cfg.DATA_DIR);
    if (!source) {
      throw new Error(
        `Could not resolve the host-side path of ${this.cfg.DATA_DIR}: this process is in a ` +
          'container but has no mount there, or its own container could not be identified. ' +
          'Mount the data directory, or set HOST_DATA_DIR to the path the Docker daemon knows it by.',
      );
    }
    this.hostDataDir = source;
    log.info('resolved the host path of the data directory', { hostDataDir: source });
  }

  /**
   * Where a box's files are on this process's own filesystem, or null for
   * a box still backed by a named volume.
   *
   * Derived from the current DATA_DIR rather than read from the row, so moving
   * the data volume moves the workspaces with it; the stored column says only
   * whether the box has a directory. An unknown or deleted box is
   * null as well, and the caller answers that with its own 404.
   */
  workspacePathOf(id: string): string | null {
    const row = this.getRow(id);
    if (!row || row.status === 'deleted' || !row.workspace_dir) return null;
    return ws.workspacePath(this.cfg.DATA_DIR, row.id);
  }

  /**
   * Where a box's home is on this process's own filesystem, on the same
   * terms as its workspace, and null for one still backed by a named volume.
   */
  homePathOf(id: string): string | null {
    const row = this.getRow(id);
    if (!row || row.status === 'deleted' || !row.home_dir) return null;
    return ws.homePath(this.cfg.DATA_DIR, row.id);
  }

  /**
   * Where a box's Nix store is on this process's own filesystem, and null
   * for a box that has none yet.
   *
   * No column records it: every box is given the directory at its next
   * start, so the directory itself is what says whether it is there. A box
   * from before Nix stores existed has none until then, and is measured by
   * its other two directories in the meantime.
   */
  nixPathOf(id: string): string | null {
    const row = this.getRow(id);
    if (!row || row.status === 'deleted') return null;
    const path = ws.nixPath(this.cfg.DATA_DIR, row.id);
    return ws.directoryExists(path) ? path : null;
  }

  /**
   * Whether a review can reach this box's files at all right now.
   *
   * For Docker, a directory-backed box whose directory is there. A box still
   * on a named volume has no path this process can read. A Kubernetes box's
   * workspace is a PVC from the moment it is created, reachable through its
   * pod, which {@link ensureFilesReachable} brings up.
   */
  reviewable(id: string): boolean {
    const row = this.getRow(id);
    if (!row || row.status === 'deleted') return false;
    if (this.cfg.RUNTIME === 'kubernetes') return true;
    const path = this.workspacePathOf(id);
    return path !== null && isDirectory(path);
  }

  /**
   * Makes sure a review can reach this box's files before touching any of
   * them.
   *
   * A no-op for Docker, whose files are directories on this process's own
   * filesystem whether or not the container runs. A Kubernetes box's files
   * are reachable only through its pod, so this starts it as opening a
   * thread would.
   */
  async ensureFilesReachable(id: string): Promise<void> {
    if (this.cfg.RUNTIME !== 'kubernetes') return;
    await this.execTarget(id);
  }

  // --- the box image ----------------------------------------------------

  /**
   * Makes sure the box image is on this host, pulling it when it is not.
   *
   * Absent, there is nothing to create a box out of, so this is the one
   * pull that is allowed to fail loudly. Present, it costs one inspect and
   * says nothing.
   */
  async ensureBoxImage(): Promise<void> {
    if (!(await runtime(this.cfg).images.imageId(this.cfg.BOX_IMAGE))) {
      log.info('the box image is not on this host; pulling it', {
        image: this.cfg.BOX_IMAGE,
      });
      await runtime(this.cfg).images.pullImage(this.cfg.BOX_IMAGE);
      log.info('pulled the box image', { image: this.cfg.BOX_IMAGE });
    }
    await this.warnOnBoxUidDrift();
  }

  /**
   * Says so when the box image was built on a different uid than
   * BOX_UID.
   *
   * A container can run as any uid, so the workspace bind works either way.
   * The home does not: seedHomeFromImage() fills a new home from the image's
   * `/home/agent` with `cp -a`, so its files keep the uid the image was built
   * on. When the two differ, the agent cannot write its own home and every
   * turn fails.
   *
   * A warning and not a refusal, because the rest of the orchestrator works
   * and reviewing an existing box needs no container.
   */
  private async warnOnBoxUidDrift(): Promise<void> {
    let imageUid: number | null;
    try {
      imageUid = await runtime(this.cfg).images.imageUserUid(this.cfg.BOX_IMAGE);
    } catch (err) {
      log.warn('could not read the box image user', { error: (err as Error).message });
      return;
    }
    if (imageUid === null || imageUid === this.cfg.BOX_UID) return;
    log.warn(
      'the box image was built on a different uid than BOX_UID; ' +
        "a box's home will not be writable by the agent",
      {
        image: this.cfg.BOX_IMAGE,
        imageUid,
        boxUid: this.cfg.BOX_UID,
      },
    );
  }

  /**
   * Pulls the box image again, so a moving tag moves here.
   *
   * Best effort, because the image already on the host still works. A box
   * moves onto the new image at its next start.
   */
  async refreshBoxImage(): Promise<void> {
    const before = await runtime(this.cfg).images.imageId(this.cfg.BOX_IMAGE);
    await runtime(this.cfg).images.pullImage(this.cfg.BOX_IMAGE);
    const after = await runtime(this.cfg).images.imageId(this.cfg.BOX_IMAGE);
    if (after && after !== before) {
      log.info('the box image moved; boxes adopt it as they are started', {
        image: this.cfg.BOX_IMAGE,
      });
      // The copy it moved off is now untagged, on this host, and a gigabyte
      // or two that nothing else reclaims.
      await this.pruneSupersededImages(before);
    }
  }

  /**
   * Removes copies of the box image that a pull has superseded.
   *
   * Called after a refresh that moved the tag. `supersededId` is the image
   * that pull replaced. The labelled images also include those an earlier
   * process replaced and did not clean up.
   *
   * Nothing is forced. The daemon refuses to remove an image a container was
   * created from, so a box that has not started since the tag moved keeps
   * its old image. That image goes on a later sweep, after the box's next
   * start has moved it onto the new one.
   */
  private async pruneSupersededImages(supersededId: string | null): Promise<void> {
    if (!this.cfg.BOX_IMAGE_PRUNE) return;
    const current = await runtime(this.cfg).images.imageId(this.cfg.BOX_IMAGE);
    const candidates = new Set(await runtime(this.cfg).images.listSupersededBoxImages());
    // An image built without the label is found only here, by its id.
    if (supersededId) candidates.add(supersededId);
    candidates.delete(current ?? '');

    for (const id of candidates) {
      try {
        if (await runtime(this.cfg).images.removeImage(id)) {
          log.info('removed a superseded box image', { image: id });
        }
      } catch (err) {
        log.warn('could not remove a superseded box image', {
          image: id,
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Removes Docker objects and workspace directories belonging to boxes
   * that no longer exist.
   *
   * Everything Boxes creates is labelled with its box. reconcile() looks up
   * what Docker has for each row; this looks up the row for each labelled
   * object. It finds what a crash during a create, or a teardown that failed
   * halfway, left behind.
   *
   * create() inserts the row before any Docker object exists, so an object
   * whose box has no live row is never one being created. A deleted box's
   * tombstone counts as no row, so a failed teardown is swept too.
   *
   * Containers go first, because the daemon refuses to remove a network or a
   * volume a container still uses.
   */
  async sweepOrphans(): Promise<void> {
    // A login container belongs to no box, so the rules below do not apply.
    await this.sweepLoginContainers();

    const containers = await runtime(this.cfg).boxes.listBoxContainers();
    const networks = await runtime(this.cfg).boxes.listBoxNetworks();
    const volumes = await runtime(this.cfg).boxes.listBoxVolumes();
    // A teardown removes the Docker objects first, so a box it gave up on
    // halfway may have only its directories left.
    const directories = ws.boxDirectoryIds(this.cfg.DATA_DIR);
    // Read last: a box created while the readings above ran has its row by
    // now, so its objects are not taken for orphans.
    const live = new Set(this.allRows().map((row) => row.id));
    const orphaned = <T extends { boxId: string }>(all: T[]): T[] =>
      all.filter((o) => !live.has(o.boxId));
    const strayContainers = orphaned(containers);
    const strayNetworks = orphaned(networks);
    const strayVolumes = orphaned(volumes);
    const strayDirectories = directories.filter((id) => !live.has(id));

    const strays = [...strayContainers, ...strayNetworks, ...strayVolumes];
    const boxes = new Set([...strays.map((o) => o.boxId), ...strayDirectories]);
    if (boxes.size === 0) return;

    // Tombstones count, so a deployment whose boxes were all deleted still
    // gets its failed teardowns swept.
    const known = (
      this.db.prepare('SELECT COUNT(*) AS n FROM boxes').get() as { n: number }
    ).n;
    if (boxes.size > known * STRAY_BOX_RATIO) {
      log.warn('not sweeping: the host holds far more boxes than this database knows of', {
        strays: boxes.size,
        known,
        ratio: STRAY_BOX_RATIO,
        boxes: [...boxes],
        containers: strayContainers.length,
        networks: strayNetworks.length,
        volumes: strayVolumes.length,
        directories: strayDirectories.length,
      });
      return;
    }

    log.info('sweeping what is left of boxes that are gone', { boxes: [...boxes] });
    for (const container of strayContainers) {
      await this.sweeping(container.boxId, 'container', () =>
        runtime(this.cfg).boxes.removeContainer(container.id),
      );
    }
    for (const network of strayNetworks) {
      await this.sweeping(network.boxId, 'network', () =>
        runtime(this.cfg).boxes.removeNetwork(network.name),
      );
    }
    for (const volume of strayVolumes) {
      await this.sweeping(volume.boxId, 'volume', () => runtime(this.cfg).boxes.removeVolume(volume.name));
    }
    for (const boxId of boxes) {
      await this.sweeping(boxId, 'workspace', () =>
        Promise.resolve(ws.removeWorkspace(this.cfg.DATA_DIR, boxId)),
      );
      await this.sweeping(boxId, 'home', () =>
        Promise.resolve(ws.removeHome(this.cfg.DATA_DIR, boxId)),
      );
      await this.sweeping(boxId, 'nix store', () =>
        Promise.resolve(ws.removeNix(this.cfg.DATA_DIR, boxId)),
      );
    }
  }

  /**
   * Removes login containers that nothing is waiting on.
   *
   * A login removes its container when the flow ends. A restart mid-login
   * leaves the container behind, holding half a credential in a tmpfs home.
   *
   * Age is the only rule, because a login container has no owner to ask. The
   * cutoff is longer than the ten minutes a flow may take, so a login in
   * progress is never swept.
   */
  private async sweepLoginContainers(): Promise<void> {
    const cutoff = Date.now() - LOGIN_CONTAINER_MAX_AGE_MS;
    let containers: Awaited<ReturnType<BoxRuntime['listLoginContainers']>>;
    try {
      containers = await runtime(this.cfg).boxes.listLoginContainers();
    } catch (err) {
      log.warn('could not list login containers', { error: (err as Error).message });
      return;
    }
    for (const container of containers) {
      if (container.createdAt > cutoff) continue;
      try {
        await runtime(this.cfg).boxes.removeContainer(container.id);
        log.info('swept an abandoned login container', {
          credential: container.credentialId,
          container: container.id,
        });
      } catch (err) {
        log.warn('could not sweep an abandoned login container', {
          container: container.id,
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Runs one removal of the sweep, keeping the rest going when it fails.
   *
   * A failure is logged, and the next sweep tries again.
   */
  private async sweeping(
    boxId: string,
    what: string,
    remove: () => Promise<void>,
  ): Promise<void> {
    try {
      await remove();
      log.box(boxId).info('swept an orphaned object', { what });
    } catch (err) {
      log.box(boxId).warn('could not sweep an orphaned object', {
        what,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Rebuilds a box's container when Docker no longer has the one the row
   * names, and returns the row as it now stands.
   *
   * A box container is built entirely from the row and the box's
   * directories, so losing one costs nothing durable. `docker container
   * prune` removes every stopped container, which includes every idle box.
   * `docker system prune` removes the network too, so this recreates the
   * network as well.
   *
   * Only for a container the daemon reports as missing. `unknown` means the
   * daemon did not answer, and the container may be running.
   *
   * A box still on a workspace volume is left to `migrateWorkspace`, which
   * runs before this and rebuilds the container itself.
   */
  private async restoreMissingContainer(row: BoxRow): Promise<BoxRow> {
    if (!row.container_id || !row.workspace_dir) return row;
    if ((await runtime(this.cfg).boxes.containerState(row.container_id)) !== 'missing') return row;

    const slog = log.box(row.id);
    // A Kubernetes stop deletes the pod, so every start comes through here.
    // The new pod is on the current image, as a Docker box rolls onto it at
    // its start.
    const kubernetes = this.cfg.RUNTIME === 'kubernetes';
    const image = kubernetes ? this.cfg.BOX_IMAGE : row.image;
    if (kubernetes) {
      slog.info('starting the box in a new pod', { image });
    } else {
      slog.warn('the container is gone; rebuilding it from the box row', {
        container: row.container_id,
      });
    }
    // A prune that removed the container may have removed the network too.
    if (await runtime(this.cfg).boxes.ensureNetwork(row.network_name, row.subnet, row.id)) {
      slog.info('the box network was gone too; made it again', {
        network: row.network_name,
        subnet: row.subnet,
      });
    }
    const containerId = await this.recreateContainer({ ...row, image });
    this.db
      .prepare('UPDATE boxes SET container_id = ?, image = ? WHERE id = ?')
      .run(containerId, image, row.id);
    slog.info('rebuilt the container', { container: containerId });
    return this.mustGet(row.id);
  }

  /**
   * Moves a box onto the current box image, when what its container
   * was created from is no longer what BOX_IMAGE resolves to.
   *
   * A running box is left alone until its next start.
   *
   * The comparison is on image ids rather than the tag, because a tag such
   * as `latest` moves without changing its name.
   */
  private async rollOntoCurrentImage(row: BoxRow): Promise<BoxRow> {
    if (!row.container_id) return row;
    const slog = log.box(row.id);

    let wanted: string | null;
    let current: string | null;
    try {
      wanted = await runtime(this.cfg).images.imageId(this.cfg.BOX_IMAGE);
      current = await runtime(this.cfg).images.containerImageId(row.container_id);
    } catch (err) {
      // A box that already has a container can start without the comparison.
      slog.warn('could not compare the box image; starting as it is', {
        error: (err as Error).message,
      });
      return row;
    }
    // Nothing on the host to move to, or a container Docker no longer has:
    // either way there is nothing to decide, and start() surfaces the second.
    if (!wanted || !current || wanted === current) return row;

    if (await this.deferredWhileRunning(row, 'box image change')) return row;

    slog.info('recreating the container on the current box image', {
      from: current,
      image: this.cfg.BOX_IMAGE,
    });
    // The adapter ran as an exec inside the container about to be removed, so
    // anything the gateway still holds for this box is already dead.
    this.upstreams.get(row.id)?.stop();

    const containerId = await this.recreateContainer({
      ...row,
      image: this.cfg.BOX_IMAGE,
    });
    this.db
      .prepare('UPDATE boxes SET container_id = ?, image = ? WHERE id = ?')
      .run(containerId, this.cfg.BOX_IMAGE, row.id);
    slog.info('box moved onto the current box image', {
      image: this.cfg.BOX_IMAGE,
    });
    return this.mustGet(row.id);
  }

  // --- recreating a container -----------------------------------------------
  //
  // A container's image and mounts are fixed at creation, so changing either
  // replaces the container. The rootfs is read-only and everything durable
  // lives in the mounts, so nothing is lost.

  /**
   * Whether a change that has to replace the container must wait, because the
   * container is still running. Says so in the log when it does.
   *
   * Killing a live container would take the adapter exec, and any turn in it,
   * with it. The change comes through at the box's next stop/start cycle,
   * which the idle reaper produces on its own within IDLE_STOP_MINUTES.
   */
  private async deferredWhileRunning(row: BoxRow, what: string): Promise<boolean> {
    if ((await runtime(this.cfg).boxes.containerState(row.container_id)) !== 'running') return false;
    log.box(row.id).info(`${what} deferred: the container is still running`);
    return true;
  }

  /**
   * Replaces a box's container with a fresh one built from `row`, and
   * returns the new container's id. The row names the new container and the
   * workspace directory it binds before it is started, so a start that fails
   * cannot leave the row naming the removed container. The caller records
   * whatever else changed.
   *
   * The old container is stopped before it is removed even when it is
   * already down; both calls tolerate a container that is gone.
   */
  private async recreateContainer(row: BoxRow): Promise<string> {
    if (row.container_id) {
      await runtime(this.cfg).boxes.stopContainer(row.container_id);
      await runtime(this.cfg).boxes.removeContainer(row.container_id);
    }
    const containerId = await runtime(this.cfg).boxes.createContainer(this.containerSpec(row));
    this.db
      .prepare('UPDATE boxes SET container_id = ?, workspace_dir = ? WHERE id = ?')
      .run(containerId, row.workspace_dir, row.id);
    await runtime(this.cfg).boxes.startContainer(containerId);
    return containerId;
  }

  // --- helpers --------------------------------------------------------------

  /** The stored row for a box, including deleted ones. */
  getRow(id: string): BoxRow | undefined {
    return this.db.prepare('SELECT * FROM boxes WHERE id = ?').get(id) as
      | BoxRow
      | undefined;
  }

  /** Every box that has not been deleted, newest first. */
  private allRows(): BoxRow[] {
    return this.db
      .prepare("SELECT * FROM boxes WHERE status != 'deleted' ORDER BY created_at DESC")
      .all() as BoxRow[];
  }

  /**
   * Records a new status, leaving a deleted box deleted. An upstream spawn
   * still retrying when the box was removed reports its outcome later, and
   * that must not bring the row back.
   */
  private setStatus(id: string, status: BoxRow['status']): void {
    this.db
      .prepare("UPDATE boxes SET status = ? WHERE id = ? AND status != 'deleted'")
      .run(status, id);
  }

  /**
   * Everything createContainer needs about a box, built from its stored
   * row and what the deployment currently holds. Both a new box and every
   * recreated container are built from it.
   *
   * Every box gets the same placeholder for each credential, and the proxy
   * swaps in the secret. So no container is rebuilt when a credential
   * arrives.
   */
  private containerSpec(row: BoxRow): BoxContainerSpec {
    const settings = readSettings(this.db);
    return {
      boxId: row.id,
      image: row.image,
      networkName: row.network_name,
      subnet: row.subnet,
      volumes: this.boxVolumes(row),
      env: runtime(this.cfg).boxes.credentialEnv(
        (id) => this.egress.placeholderFor(id),
        { gitName: settings.gitName, gitEmail: settings.gitEmail },
        this.cfg.GITLAB_HOST,
      ),
      caCertificate: this.egress.caCertificate(),
    };
  }

  /**
   * The runtime's own handles for a box's four mounts.
   *
   * For Docker, a home directory for a newer box and the named volume for an
   * older one; homes are never migrated. The Kubernetes runtime ignores both
   * `hostDataDir` and the volume, since its boxes are backed by PVCs alone.
   */
  private boxVolumes(row: BoxRow): ProvisionedVolumes {
    return runtime(this.cfg).boxes.volumeRefs(
      row.id,
      this.hostDataDir,
      row.home_dir ? null : row.home_volume || null,
    );
  }

  /** The persistent upstream for a box, created on first use. */
  upstream(id: string): UpstreamBox {
    let up = this.upstreams.get(id);
    if (!up) {
      up = new UpstreamBox(
        id,
        this.db,
        this.cfg,
        this.pending,
        this.notifier,
        (status) => this.setStatus(id, status),
        async () => {
          // Opening a thread starts a stopped box without start(), so the
          // repairs run here too, under the same slot. The row is read inside
          // the slot, because it can change while this waits.
          await this.withSlot(id, async () => {
            const row = this.getRow(id);
            if (!row || row.status === 'deleted') return;
            await this.prepareContainer(row);
          });
        },
      );
      this.upstreams.set(id, up);
    }
    return up;
  }

  // --- create ---------------------------------------------------------------

  /**
   * Creates the network, directories and container for a new box. Any
   * failed step tears the whole box down and marks it as an error.
   */
  async create(body: CreateBoxBody): Promise<BoxDetail> {
    const name = body.name?.trim();
    if (!name) throw new HttpError(400, 'name is required');
    if (name.length > 100) throw new HttpError(400, 'name must be 100 characters or fewer');

    // The global set is applied whatever this says, so naming it is the same
    // as naming nothing and is stored as nothing.
    const requested = body.agentSet?.trim() ?? '';
    const agentSetId = requested === '' || requested === GLOBAL_AGENT_SET ? null : requested;
    if (agentSetId && !this.agents.has(agentSetId)) {
      throw new HttpError(400, `Unknown agent set: ${agentSetId}`);
    }

    // Checked before anything is allocated, so an unknown harness costs no
    // resources on its way to a 400.
    const thread = threadOptions(body.thread);

    // After the checks above, so an invalid request pulls no image.
    try {
      await this.ensureBoxImage();
    } catch (err) {
      throw new HttpError(
        503,
        `Box image ${this.cfg.BOX_IMAGE} is not available: ${(err as Error).message}`,
      );
    }

    // Server-generated: user input never reaches a Docker object name.
    const id = randomBytes(4).toString('hex');
    const now = Date.now();
    const subnet = allocateSubnet(
      this.cfg.BOX_SUBNET_POOL,
      nextSubnetIndex(this.db),
      takenSubnets(this.db),
    );
    if (!subnet) throw new HttpError(503, 'No free subnet in the pool');
    const row: BoxRow = {
      id,
      name,
      // Every box is DEFAULT: the deployment has one set of credentials.
      profile: 'DEFAULT',
      image: this.cfg.BOX_IMAGE,
      container_id: null,
      network_name: runtime(this.cfg).boxes.names.network(id),
      subnet,
      // Both are directories, so the volume columns stay empty.
      ws_volume: '',
      home_volume: '',
      workspace_dir: ws.workspacePath(this.cfg.DATA_DIR, id),
      home_dir: ws.homePath(this.cfg.DATA_DIR, id),
      // No base revision until the reviewer picks one. A review compares
      // each repository against its own HEAD by default.
      review_base_rev: null,
      status: 'creating',
      agent_set_id: agentSetId,
      // A token of its own, so it opens this box's WebSocket and no other.
      ws_token: generateWsToken(),
      created_at: now,
      last_active_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO boxes (id, name, profile, image, container_id,
           network_name, subnet, ws_volume, home_volume, workspace_dir, home_dir,
           status, agent_set_id, ws_token, created_at, last_active_at)
         VALUES (@id, @name, @profile, @image, @container_id,
           @network_name, @subnet, @ws_volume, @home_volume, @workspace_dir, @home_dir,
           @status, @agent_set_id, @ws_token, @created_at, @last_active_at)`,
      )
      .run(row);

    const slog = log.box(id);
    try {
      await this.withSlot(id, () => this.createResources(row));
      this.setStatus(id, 'running');
      // The first conversation, as a row only. The first browser to open it
      // starts the adapter, so a box can be created for a harness whose
      // credential has not been entered yet.
      insertThread(this.db, id, {
        harness: thread.harness,
        modeId: thread.modeId ?? null,
        config: thread.config ?? { ...harness(thread.harness).defaultConfig },
      });
      slog.info('box created', { name, harness: thread.harness });
    } catch (err) {
      slog.error('box create failed; tearing down', { error: (err as Error).message });
      await this.teardownResources(id);
      this.setStatus(id, 'error');
      throw new HttpError(500, `Failed to create box: ${(err as Error).message}`);
    }

    return this.detail(id);
  }

  /**
   * Builds the network, the three directories and the container of a new
   * box, and starts it.
   *
   * Runs under the box's slot. The network comes before the container that
   * joins it, and every directory before the container that binds it.
   */
  private async createResources(row: BoxRow): Promise<void> {
    const id = row.id;
    await runtime(this.cfg).boxes.createNetwork(row.network_name, row.subnet, id);
    await runtime(this.cfg).boxes.ensureProxyAttached(row.network_name);
    // Before the container, because it is one of its mounts.
    this.agents.materialize(id, row.agent_set_id);
    // The workspace, home and Nix store. A Docker home is a bind mount that
    // hides the image's /home/agent, so the image's home is copied in.
    await runtime(this.cfg).boxes.provisionVolumes(id, row.image, this.boxVolumes(row));
    const containerId = await runtime(this.cfg).boxes.createContainer(this.containerSpec(row));
    // Recorded before the start, so a start that fails leaves a row naming
    // the container and the teardown removes it.
    this.db.prepare('UPDATE boxes SET container_id = ? WHERE id = ?').run(containerId, id);
    await runtime(this.cfg).boxes.startContainer(containerId);
  }

  // --- start / stop / delete ------------------------------------------------

  /**
   * Everything a box's container has to be brought up to date on before
   * it is started, in the one order that is safe. Returns the row as it now
   * stands, which is what names the container to start.
   *
   * Every repair does nothing for a box that does not need it, and each is
   * put off while the container runs, so a turn is never cut off.
   *
   * Runs under the caller's slot and takes none of its own. A stop or a
   * delete that arrives meanwhile takes effect between the repairs.
   */
  private async prepareContainer(row: BoxRow): Promise<BoxRow> {
    this.giveUpIfPreempted(row.id);
    // Before any step that may create a container binding this directory,
    // which the daemon would otherwise create empty and owned by root.
    this.agents.materialize(row.id, row.agent_set_id);
    // The Nix store likewise, which an older box may not have yet.
    await runtime(this.cfg).boxes.ensureAddedVolumes(row.id, this.boxVolumes(row));
    // Before anything binds the other two, for the same reason.
    this.requireDirectories(row);
    let current = await this.migrateWorkspace(row);
    this.giveUpIfPreempted(row.id);
    // Before the two below, which need a container to ask the daemon about.
    current = await this.restoreMissingContainer(current);
    this.giveUpIfPreempted(row.id);
    // Before the mount check: a recreated container already has every mount.
    current = await this.rollOntoCurrentImage(current);
    this.giveUpIfPreempted(row.id);
    return this.ensureTemplateMounts(current);
  }

  /**
   * Refuses to go on when a box's bind sources are gone, naming what is
   * missing, and marks the box as an error.
   *
   * Docker creates a missing bind source, empty and owned by root. The box
   * then looks healthy while every turn fails. A crash during a delete, a
   * partly restored backup, or a wrong HOST_DATA_DIR all cause this.
   *
   * The directories are not recreated, because a fresh home would erase the
   * adapter's thread transcripts. Only the mounts the row marks as
   * directories are checked.
   */
  private requireDirectories(row: BoxRow): void {
    // A Kubernetes box's mounts are PVCs the cluster owns, not directories
    // this process can see.
    if (this.cfg.RUNTIME === 'kubernetes') return;
    const missing: string[] = [];
    const workspace = ws.workspacePath(this.cfg.DATA_DIR, row.id);
    const home = ws.homePath(this.cfg.DATA_DIR, row.id);
    if (row.workspace_dir && !ws.directoryExists(workspace)) {
      missing.push(`its workspace directory (${workspace})`);
    }
    if (row.home_dir && !ws.directoryExists(home)) {
      missing.push(`its home directory (${home})`);
    }
    if (missing.length === 0) return;

    this.setStatus(row.id, 'error');
    log.box(row.id).error('refusing to start a box whose files are gone', { missing });
    throw new HttpError(
      409,
      `This box cannot start: ${missing.join(' and ')} cannot be found. ` +
        'Restore the files from a backup, or delete the box.',
    );
  }

  /**
   * Starts a stopped box's container and re-attaches the egress proxy.
   * Waits for whatever else the box is in the middle of.
   */
  async start(id: string): Promise<BoxDetail> {
    return this.withSlot(id, () => this.startHeld(id));
  }

  /** The body of {@link start}, which runs under the box's slot. */
  private async startHeld(id: string): Promise<BoxDetail> {
    const stored = this.mustGet(id);
    if (!stored.container_id) throw new HttpError(409, 'Box has no container');
    const row = await this.prepareContainer(stored);
    this.giveUpIfPreempted(id);
    await runtime(this.cfg).boxes.startContainer(row.container_id!);
    await runtime(this.cfg).boxes.ensureProxyAttached(row.network_name);
    this.setStatus(id, 'running');
    // The upstream reconnects on the next forwarded message, which sends
    // session/load again and restores the thread.
    return this.detail(id);
  }

  /**
   * Moves a box that still has a workspace volume onto a directory, and
   * returns the row as it now stands.
   *
   * The order loses nothing at any step: copy first, recreate the container
   * second, and drop the volume only once the new container has started. The
   * row records the directory as soon as the container that binds it exists.
   * Otherwise a crash could leave a row that says volume, and the next start
   * would copy the volume over the agent's work.
   *
   * A running box is left alone until its next start.
   */
  private async migrateWorkspace(row: BoxRow): Promise<BoxRow> {
    if (row.workspace_dir) return row;
    const slog = log.box(row.id);
    if (await this.deferredWhileRunning(row, 'workspace migration')) return row;

    slog.info('migrating the workspace volume to a directory', { volume: row.ws_volume });
    const directory = ws.createWorkspace(this.cfg.DATA_DIR, row.id);
    const hostDirectory = ws.hostWorkspacePath(this.hostDataDir, row.id);

    if (row.ws_volume) {
      await runtime(this.cfg).boxes.copyVolumeToDirectory(row.ws_volume, hostDirectory, row.image, row.id);
    }
    // cp -a kept the ownership of the contents; the directory itself needs it.
    ws.chownToAgent(directory);

    await this.recreateContainer({ ...row, workspace_dir: directory });
    this.db.prepare("UPDATE boxes SET ws_volume = '' WHERE id = ?").run(row.id);

    if (row.ws_volume) await runtime(this.cfg).boxes.removeVolume(row.ws_volume);
    slog.info('workspace migrated', { directory });
    return this.mustGet(row.id);
  }

  /**
   * Gives a box created before a mount existed the mounts the template has
   * now, and returns the row as it now stands.
   *
   * An older container may lack the agent configuration or the Nix store
   * mount, and is recreated once from the template. A failure halfway loses
   * nothing, because the directories are already written and the next start
   * tries again. A running box is left alone until its next start.
   */
  private async ensureTemplateMounts(row: BoxRow): Promise<BoxRow> {
    if (!row.container_id) return row;
    const missing = await runtime(this.cfg).boxes.missingMounts(row.container_id, [
      runtime(this.cfg).boxes.AGENT_CONFIG_DIR,
      runtime(this.cfg).boxes.NIX_DIR,
    ]);
    if (missing.length === 0) return row;
    if (await this.deferredWhileRunning(row, 'the mounts it lacks')) return row;
    log.box(row.id).info('recreating the container with the mounts it lacks', { missing });
    const containerId = await this.recreateContainer(row);
    this.db
      .prepare('UPDATE boxes SET container_id = ? WHERE id = ?')
      .run(containerId, row.id);
    return this.mustGet(row.id);
  }

  /**
   * Stops the container and drops the upstream connection.
   *
   * Overtakes what the box is in the middle of rather than queueing behind
   * it. The flag and the upstream's stop are set before the slot is asked
   * for, so the work in flight gives up at its next step.
   */
  async stop(id: string): Promise<BoxDetail> {
    this.preempted.add(id);
    this.upstreams.get(id)?.stop();
    return this.withSlot(id, () => this.stopHeld(id));
  }

  /**
   * Stops a box unless something else is already working on it, and says
   * whether it did.
   *
   * For the reaper, which must never wait. A box with an operation in flight
   * is in use, so the reaper looks at it again on the next tick. The queue
   * is checked and taken in the same synchronous step.
   */
  async stopUnlessBusy(id: string): Promise<boolean> {
    if (this.slots.has(id)) return false;
    await this.stop(id);
    return true;
  }

  /** The body of {@link stop}, which runs under the box's slot. */
  private async stopHeld(id: string): Promise<BoxDetail> {
    // Everything queued before this has given up; what comes after may run.
    this.preempted.delete(id);
    const row = this.mustGet(id);
    if (row.container_id) await runtime(this.cfg).boxes.stopContainer(row.container_id);
    this.setStatus(id, 'stopped');
    log.box(id).info('box stopped');
    return this.detail(id);
  }

  /**
   * Deletes a box and everything it is made of, its volumes included.
   * Overtakes what the box is in the middle of, the way a stop does.
   */
  async remove(id: string): Promise<void> {
    this.preempted.add(id);
    this.upstreams.get(id)?.close();
    return this.withSlot(id, () => this.removeHeld(id));
  }

  /** The body of {@link remove}, which runs under the box's slot. */
  private async removeHeld(id: string): Promise<void> {
    this.preempted.delete(id);
    const row = this.mustGet(id);
    // The tombstone goes first. Every writer still in flight checks it, so
    // none of them inserts a row for a box that is going away.
    this.setStatus(id, 'deleted');
    this.upstreams.delete(id);
    await this.teardownResources(id);
    // Every table keyed by the box id. The box row stays as a tombstone.
    for (const table of ['pending_requests', 'threads']) {
      this.db.prepare(`DELETE FROM ${table} WHERE box_id = ?`).run(id);
    }
    this.usage.forget(id);
    log.box(id).info('box deleted', { name: row.name });
  }

  /**
   * Removes a box's container, network, directories and volumes. Every
   * failure is logged rather than thrown, so teardown always finishes.
   */
  private async teardownResources(id: string): Promise<void> {
    const row = this.getRow(id);
    if (!row) return;
    const slog = log.box(id);
    if (row.container_id) {
      try {
        await runtime(this.cfg).boxes.stopContainer(row.container_id);
        await runtime(this.cfg).boxes.removeContainer(row.container_id);
      } catch (err) {
        slog.warn('container teardown failed', { error: (err as Error).message });
      }
    }
    try {
      await runtime(this.cfg).boxes.removeNetwork(row.network_name);
    } catch (err) {
      slog.warn('network teardown failed', { error: (err as Error).message });
    }
    // The workspace, home and Nix store. No column says which boxes have a
    // Nix store, so every box is tried.
    try {
      await runtime(this.cfg).boxes.removeVolumes(row.id, this.boxVolumes(row));
    } catch (err) {
      slog.warn('volume removal failed', { error: (err as Error).message });
    }
    try {
      this.agents.removeMaterialized(row.id);
    } catch (err) {
      slog.warn('agent configuration removal failed', { error: (err as Error).message });
    }
    // Only an older box still has volumes.
    if (row.ws_volume) await runtime(this.cfg).boxes.removeVolume(row.ws_volume);
    if (row.home_volume) await runtime(this.cfg).boxes.removeVolume(row.home_volume);
  }

  // --- views ----------------------------------------------------------------

  /** The stored row for a live box, or a 404. */
  mustGet(id: string): BoxRow {
    const row = this.getRow(id);
    if (!row || row.status === 'deleted') throw new HttpError(404, 'Box not found');
    return row;
  }

  /**
   * Where a local command should run for this box, starting the
   * container if it is stopped. The workspace root, which is where the
   * adapter runs too.
   *
   * Marks the box active, because everything that asks for this is about
   * to work in the box: a terminal opening a shell, or a review running git.
   */
  async execTarget(id: string): Promise<{ containerId: string; workingDir: string }> {
    return this.withSlot(id, () => this.execTargetHeld(id));
  }

  /** The body of {@link execTarget}, which runs under the box's slot. */
  private async execTargetHeld(id: string): Promise<{ containerId: string; workingDir: string }> {
    const stored = this.mustGet(id);
    if (!stored.container_id) throw new HttpError(409, 'Box has no container');
    // This starts a stopped container, so it runs the same repairs start()
    // runs.
    const row = await this.prepareContainer(stored);
    this.giveUpIfPreempted(id);
    await runtime(this.cfg).boxes.startContainer(row.container_id!);
    this.touch(id);
    return { containerId: row.container_id!, workingDir: runtime(this.cfg).boxes.WORKSPACE_DIR };
  }

  /** Marks a box active, so reaching into the box holds off the reaper. */
  touch(id: string): void {
    touchBox(this.db, id);
  }

  /**
   * Marks a box active, at most once every {@link TOUCH_INTERVAL_MS}.
   *
   * What a terminal calls as its reader types.
   */
  touchThrottled(id: string): void {
    const held = this.terminals.get(id);
    const now = Date.now();
    if (held && now - held.touchedAt < TOUCH_INTERVAL_MS) return;
    if (held) held.touchedAt = now;
    this.touch(id);
  }

  /**
   * Counts one open terminal onto a box, and returns the handle that
   * takes it off again.
   *
   * The count is what the reaper reads, so it has to go up before the box is
   * started rather than once the shell is there: starting takes seconds, and
   * a tick landing inside them must not stop the box being opened.
   */
  holdTerminal(id: string): () => void {
    const held = this.terminals.get(id) ?? { open: 0, touchedAt: 0 };
    held.open++;
    this.terminals.set(id, held);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.terminals.get(id);
      if (!current) return;
      current.open--;
      if (current.open <= 0) this.terminals.delete(id);
    };
  }

  /** How many terminals are open on a box. */
  terminalCount(id: string): number {
    return this.terminals.get(id)?.open ?? 0;
  }

  /**
   * Says the orchestrator has written into a box's workspace, so its size
   * is measured again rather than answered from what a stopped box was left
   * at.
   *
   * A stopped box is measured once and then left alone, because it cannot
   * grow on its own. An upload is the exception.
   */
  workspaceChanged(id: string): void {
    this.usage.forget(id);
  }

  /**
   * The command lines running in every box that has not been deleted, for
   * the tunnel reconciler. A box whose container is not running has none. A
   * box whose state or processes cannot be read is reported as null.
   */
  async processReadings(): Promise<BoxReading[]> {
    return Promise.all(
      this.allRows().map(async (row): Promise<BoxReading> => {
        const state = await runtime(this.cfg).boxes.containerState(row.container_id);
        if (state === 'exited' || state === 'missing') return { boxId: row.id, commands: [] };
        if (state !== 'running' || !row.container_id) return { boxId: row.id, commands: null };
        try {
          const processes = await runtime(this.cfg).exec.containerProcesses(row.container_id);
          return { boxId: row.id, commands: processes.map((p) => p.command) };
        } catch {
          return { boxId: row.id, commands: null };
        }
      }),
    );
  }

  /** Summaries of every live box. */
  async list(): Promise<BoxSummary[]> {
    const rows = this.allRows();
    const counts = this.pending.countsByBox();
    const running = boxesWithActiveTurns(this.db);
    return Promise.all(
      rows.map(async (row) =>
        this.summarize(row, counts.get(row.id) ?? 0, running.has(row.id)),
      ),
    );
  }

  /** Builds a summary, resolving the container state against Docker. */
  private async summarize(
    row: BoxRow,
    pendingCount: number,
    turnActive: boolean,
  ): Promise<BoxSummary> {
    const dockerState = await runtime(this.cfg).boxes.containerState(row.container_id);
    const pendingByThread = this.pending.countsByThread(row.id);
    // The gateway's in-memory view of which threads are speaking and which
    // have tasks running, read once so every thread answers from the same
    // moment. `upstreams.get` rather than `upstream()`, which would create one.
    const upstream = this.upstreams.get(row.id);
    const speaking = new Set(upstream?.speakingThreads ?? []);
    const working = new Set(upstream?.workingThreads ?? []);
    return {
      id: row.id,
      name: row.name,
      profile: row.profile,
      status: row.status,
      dockerState,
      // True when any of the box's threads has a turn running.
      turnActive,
      speaking: speaking.size > 0,
      backgroundBusy: upstream?.backgroundActive ?? false,
      pendingCount,
      attachedCount: upstream?.attachedCount ?? 0,
      wsToken: row.ws_token,
      threads: listThreads(this.db, row.id).map((thread) =>
        toThreadSummary(
          thread,
          pendingByThread,
          speaking,
          working,
          // Each adapter says for itself whether it can fork. An adapter not
          // yet reached is absent from the set.
          upstream?.forkableHarnesses ?? new Set<HarnessId>(),
        ),
      ),
      agentSetId: row.agent_set_id,
      agentSetName: this.agents.nameOf(row.agent_set_id),
      // What was last measured, and null until there is a measurement.
      // 'unknown' counts as live: a Docker read that failed says nothing
      // about whether the agent is working.
      diskBytes: this.usage.bytes(
        row.id,
        dockerState !== 'exited' && dockerState !== 'missing',
      ),
      tunnels: this.tunnelsOf(row.id),
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    };
  }

  /** A summary plus the Docker object names the detail view shows. */
  async detail(id: string): Promise<BoxDetail> {
    const row = this.mustGet(id);
    const summary = await this.summarize(
      row,
      this.pending.countForBox(id),
      boxTurnActive(this.db, id),
    );
    return {
      ...summary,
      image: row.image,
      containerId: row.container_id,
      networkName: row.network_name,
      subnet: row.subnet,
      wsVolume: row.ws_volume,
      workspaceDir: row.workspace_dir,
      homeVolume: row.home_volume,
      homeDir: row.home_dir,
      acpSessionId: latestThread(this.db, id)?.acp_session_id ?? null,
      proxyAttached: await runtime(this.cfg).boxes.isProxyAttached(row.network_name),
      // `upstreams.get` rather than `upstream()`, which would create one. A
      // box without an upstream has no reading, so the list is empty.
      boxWork: [...(this.upstreams.get(id)?.boxWork ?? [])],
    };
  }

  // --- threads --------------------------------------------------------------

  /** Every conversation of a box, oldest first. */
  threads(id: string): ThreadSummary[] {
    this.mustGet(id);
    const pendingByThread = this.pending.countsByThread(id);
    const forkable = this.upstreams.get(id)?.forkableHarnesses ?? new Set<HarnessId>();
    return listThreads(this.db, id).map((thread) =>
      toThreadSummary(thread, pendingByThread, new Set(), new Set(), forkable),
    );
  }

  /**
   * Whether a thread belongs to a box. The WebSocket upgrade asks before
   * a socket exists, so a path naming another box's thread is a 404
   * rather than a connection that fails later.
   */
  hasThread(boxId: string, threadId: string): boolean {
    const row = getThread(this.db, threadId);
    return row !== undefined && row.box_id === boxId;
  }

  /** One of a box's threads, or a 404 when the box has no such thread. */
  private mustGetThread(id: string, threadId: string): ThreadRow {
    const row = getThread(this.db, threadId);
    if (!row || row.box_id !== id) throw new HttpError(404, THREAD_NOT_FOUND);
    return row;
  }

  /**
   * Adds a conversation to a box: on the agent and
   * settings the body names, or carrying another thread's context when `from`
   * names one.
   *
   * A fork needs the adapter, because only the adapter can branch a
   * transcript. A fresh thread's row is written before its conversation is
   * created, so a harness without a credential still gets a thread.
   */
  async createThread(id: string, body: CreateThreadBody | undefined): Promise<ThreadSummary> {
    this.mustGet(id);
    const from = body?.from?.trim();
    // A fork keeps its source's harness and options, because only the adapter
    // that wrote a transcript can load it.
    const options = from ? undefined : threadOptions(body?.options);
    const up = this.upstream(id);
    try {
      const row = from ? await up.forkThread(from) : await up.newThread(options);
      return toThreadSummary(
        row,
        this.pending.countsByThread(id),
        new Set(),
        new Set(),
        up.forkableHarnesses,
      );
    } catch (err) {
      const message = (err as Error).message;
      if (message === THREAD_NOT_FOUND) throw new HttpError(404, message);
      // A thread never prompted has no conversation to fork yet.
      if (message === NOTHING_TO_FORK) throw new HttpError(409, message);
      throw new HttpError(500, `Failed to create thread: ${message}`);
    }
  }

  /**
   * Marks one of a box's conversations done, or takes the mark off again.
   *
   * The mark is the reader's own note. The thread keeps its conversation, its
   * tasks go on running, and it still answers prompts.
   */
  setThreadDone(id: string, threadId: string, done: boolean): ThreadSummary {
    this.mustGet(id);
    const row = this.mustGetThread(id, threadId);
    setThreadDone(this.db, threadId, done);
    return toThreadSummary(
      { ...row, done: done ? 1 : 0 },
      this.pending.countsByThread(id),
      new Set(),
      new Set(),
      this.upstreams.get(id)?.forkableHarnesses ?? new Set<HarnessId>(),
    );
  }

  /**
   * Stops one task a thread left running, or every task it has.
   *
   * A thread with no adapter conversation has no tasks, so it answers zero.
   */
  async stopBackgroundWork(
    id: string,
    threadId: string,
    taskId?: string,
  ): Promise<{ stopped: number }> {
    this.mustGet(id);
    const row = this.mustGetThread(id, threadId);
    if (!row.acp_session_id) return { stopped: 0 };
    return { stopped: await this.upstream(id).stopBackgroundWork(row.acp_session_id, taskId) };
  }

  /**
   * Kills every process in a box that Boxes did not start itself, whether or
   * not a thread has a task for it.
   *
   * An adapter restart loses the tasks the old process announced, and a
   * signal is the only way to reach the work they left running.
   */
  async stopBoxWork(id: string): Promise<{ stopped: number }> {
    this.mustGet(id);
    return { stopped: await this.upstream(id).stopBoxWork() };
  }

  // --- boot reconciliation --------------------------------------------------

  /**
   * Aligns the stored rows with what Docker runs: adopts live containers,
   * marks missing ones stopped, fails a create that was interrupted, and
   * re-attaches the egress proxy. Upstream connections are re-established on
   * first use.
   */
  async reconcile(): Promise<void> {
    this.pending.clearStale();
    // Helpers are left out: one that outlived its job is labelled with the
    // box too, and adopting it would leave the row naming a copy script.
    const live = new Map(
      (await runtime(this.cfg).boxes.listBoxContainers()).filter((c) => !c.helper).map((c) => [c.boxId, c]),
    );
    for (const row of this.allRows()) {
      // A turn cannot survive an orchestrator restart, because the upstream
      // connection that owned it is gone.
      clearBoxTurns(this.db, row.id);
      const container = live.get(row.id);
      if (!container) {
        if (row.status === 'running') {
          log.box(row.id).warn('container missing at boot; marking stopped');
          this.setStatus(row.id, 'stopped');
        } else if (row.status === 'creating') {
          // The process that was creating it is gone, so the create cannot finish.
          log.box(row.id).warn('create did not finish before the restart; marking error');
          this.setStatus(row.id, 'error');
        }
        continue;
      }
      if (container.id !== row.container_id) {
        this.db
          .prepare('UPDATE boxes SET container_id = ? WHERE id = ?')
          .run(container.id, row.id);
      }
      this.setStatus(row.id, container.running ? 'running' : 'stopped');
      await runtime(this.cfg).boxes.ensureProxyAttached(row.network_name);
    }
    log.info('boot reconciliation complete', { boxes: this.allRows().length });
  }

  /**
   * Re-attaches the egress proxy to every running box's network. Returns
   * the ids of the boxes where that failed.
   */
  async reconcileProxyAttachments(): Promise<string[]> {
    const warnings: string[] = [];
    for (const row of this.allRows()) {
      if (row.status !== 'running') continue;
      const ok = await runtime(this.cfg).boxes.ensureProxyAttached(row.network_name);
      if (!ok) warnings.push(row.id);
    }
    return warnings;
  }

  /** Drops every upstream connection, for shutdown. */
  closeAll(): void {
    for (const up of this.upstreams.values()) up.close();
    this.upstreams.clear();
  }

  /** Periodic housekeeping: forgetting the upstreams that hold nothing. */
  maintenance(): void {
    this.dropIdleUpstreams();
  }

  /**
   * Forgets every upstream of a box that is down and holding nothing.
   *
   * The reaper creates an upstream for every running box it checks, and
   * nothing else drops them. An upstream with no browser attached, no request
   * waiting and no adapter connection holds nothing a fresh one could not
   * rebuild.
   *
   * A running box keeps its upstream, because the upstream holds the reading
   * of what runs in the box, which the reaper asks for every tick.
   */
  private dropIdleUpstreams(): void {
    for (const [id, up] of this.upstreams) {
      if (!up.holdsNothing) continue;
      if (this.getRow(id)?.status === 'running') continue;
      up.close();
      this.upstreams.delete(id);
    }
  }
}

/**
 * One stored thread, as the API reports it.
 *
 * The live sets and `pendingByThread` are keyed by the adapter's own id. A
 * thread without one has nothing running, nobody speaking and no request
 * waiting.
 */
function toThreadSummary(
  row: ThreadRow,
  pendingByThread: Map<string, number> = new Map(),
  speaking: ReadonlySet<string> = new Set(),
  working: ReadonlySet<string> = new Set(),
  forkable: ReadonlySet<HarnessId> = new Set(),
): ThreadSummary {
  const acp = row.acp_session_id;
  return {
    id: row.id,
    harness: row.harness,
    acpSessionId: acp,
    title: row.title,
    ordinal: row.ordinal,
    turnActive: row.turn_active === 1,
    // These three come from the live gateway, keyed by the adapter's own id.
    speaking: acp ? speaking.has(acp) : false,
    backgroundBusy: acp ? working.has(acp) : false,
    pendingCount: acp ? (pendingByThread.get(acp) ?? 0) : 0,
    modeId: row.mode_id,
    config: threadConfig(row),
    // False while this thread's adapter has not been reached.
    canFork: forkable.has(row.harness),
    done: row.done === 1,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}


/**
 * What a request asked a thread to be, checked.
 *
 * An absent harness means Claude on its defaults. An unknown harness is a
 * 400. The config map keeps its string values unchecked, because the adapter
 * decides which options a harness offers.
 */
function threadOptions(options: ThreadOptions | undefined): ThreadOptions {
  const wanted = options?.harness ?? DEFAULT_HARNESS;
  try {
    harness(wanted);
  } catch {
    throw new HttpError(400, `Unknown harness: ${String(wanted)}`);
  }
  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries(options?.config ?? {})) {
    if (typeof value === 'string') config[key] = value;
  }
  return {
    harness: wanted,
    ...(options?.modeId ? { modeId: options.modeId } : {}),
    ...(options?.config ? { config } : {}),
  };
}
