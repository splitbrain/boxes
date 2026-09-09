import { randomBytes } from 'node:crypto';
import {
  GLOBAL_AGENT_SET,
  type CreateSessionBody,
  type CreateThreadBody,
  type SessionDetail,
  type SessionSummary,
  type ThreadSummary,
} from '../../shared/types.ts';
import { AgentStore, ensureAgentsRoot, hostAgentConfigPath } from './agents.ts';
import type { Config, SessionProfile } from './config.ts';
import type { EgressManager } from './egress.ts';
import {
  clearSessionTurns,
  currentThread,
  getThread,
  listThreads,
  nextSubnetIndex,
  sessionTurnActive,
  sessionsWithActiveTurns,
  touchSession,
  type Db,
  type SessionRow,
  type ThreadRow,
} from './db.ts';
import { SessionUsage, SESSION_SIZE_TTL_MS } from './diskusage.ts';
import * as dk from './docker.ts';
import { HttpError } from './http-error.ts';
import { log } from './log.ts';
import type { Notifier } from './notify.ts';
import * as ws from './workspaces.ts';
import { PendingStore } from './gateway/pending.ts';
import { NOTHING_TO_FORK, UpstreamSession } from './gateway/upstream.ts';
import { allocateSubnet } from './subnet.ts';

/**
 * Session lifecycle and the owner of every UpstreamSession. Docker is the
 * runtime truth; the sessions table is metadata.
 */

/** argv for the pinned ACP adapter inside the session container. */
const AGENT_CMD = ['claude-agent-acp'];

/** Creates, starts, stops and describes sessions. */
export class SessionManager {
  private readonly upstreams = new Map<string, UpstreamSession>();

  /** Permission requests waiting for a browser, across all sessions. */
  readonly pending: PendingStore;

  /**
   * How big each session's workspace has got, measured off the request path
   * and rarely: the list is polled every few seconds, a walk of a checkout is
   * not something to do per request, and a box that is down is not something
   * to walk twice. See diskusage.ts.
   */
  private readonly usage = new SessionUsage({
    // Everything a session is on disk: the agent's files, and the home its
    // thread history, caches and installed tools are in — which on a box that
    // has been working is usually the larger of the two. A session still
    // backed by a named home volume contributes only its workspace, there
    // being no path to the other half.
    pathsOf: (id) => [this.workspacePathOf(id), this.homePathOf(id)],
    ttlMs: SESSION_SIZE_TTL_MS,
    onTrouble: (id, error) =>
      log.session(id).warn('could not measure what a session is using', {
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
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly egress: EgressManager,
    /** Where "a thread wants you" goes; see notify.ts. */
    private readonly notifier: Notifier,
    /**
     * The AGENTS.md, skills and commands a session is given. Owned by the app
     * so the REST routes and the lifecycle share one, since editing a set and
     * starting a session are two halves of the same feature.
     */
    private readonly agents: AgentStore,
  ) {
    this.pending = new PendingStore(db);
    this.hostDataDir = cfg.HOST_DATA_DIR || cfg.DATA_DIR;
  }

  // --- workspaces -----------------------------------------------------------

  /**
   * Resolves the host-side path of DATA_DIR, once, at boot.
   *
   * Inside a container the orchestrator's own path for its data volume is not
   * the path the daemon would resolve a bind source against, and getting this
   * wrong is silent: the daemon would happily create an empty directory at
   * that path on the host and mount that instead, leaving the agent's files
   * somewhere the orchestrator cannot see. So a failure here is fatal, and
   * says which setting fixes it.
   */
  async resolveHostDataDir(): Promise<void> {
    ws.ensureWorkspacesRoot(this.cfg.DATA_DIR);
    ensureAgentsRoot(this.cfg.DATA_DIR);
    if (this.cfg.HOST_DATA_DIR) {
      log.info('using the configured host path for the data directory', {
        hostDataDir: this.hostDataDir,
      });
      return;
    }
    if (!dk.inContainer()) return;
    const source = await dk.resolveHostMountSource(this.cfg.DATA_DIR);
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
   * Where a session's files are on this process's own filesystem, or null for
   * a session still backed by a named volume — which the review surface reads
   * as "not reviewable until this session is started once".
   *
   * Derived from the current DATA_DIR rather than read from the row, so moving
   * the data volume moves the workspaces with it; the stored column only says
   * whether the session has a directory at all. An unknown or deleted session
   * is null too: the caller's own 404 says so more precisely than a throw from
   * here would.
   */
  workspacePathOf(id: string): string | null {
    const row = this.getRow(id);
    if (!row || row.status === 'deleted' || !row.workspace_dir) return null;
    return ws.workspacePath(this.cfg.DATA_DIR, row.id);
  }

  /**
   * Where a session's home is on this process's own filesystem, on the same
   * terms as its workspace, and null for one still backed by a named volume.
   */
  homePathOf(id: string): string | null {
    const row = this.getRow(id);
    if (!row || row.status === 'deleted' || !row.home_dir) return null;
    return ws.homePath(this.cfg.DATA_DIR, row.id);
  }

  // --- the session image ----------------------------------------------------

  /**
   * Makes sure the session image is on this host, pulling it when it is not.
   *
   * Absent, there is nothing to create a session out of, so this is the one
   * pull that is allowed to fail loudly. Present, it costs one inspect and
   * says nothing.
   */
  async ensureSessionImage(): Promise<void> {
    if (!(await dk.imageId(this.cfg.SESSION_IMAGE))) {
      log.info('the session image is not on this host; pulling it', {
        image: this.cfg.SESSION_IMAGE,
      });
      await dk.pullImage(this.cfg.SESSION_IMAGE);
      log.info('pulled the session image', { image: this.cfg.SESSION_IMAGE });
    }
    await this.warnOnSessionUidDrift();
  }

  /**
   * Says so when the session image was built on a different uid than
   * SESSION_UID.
   *
   * A container can be run as any uid, so the workspace bind is fine either
   * way. The home volume is not: Docker initialises a new one from the image's
   * own `/home/agent`, so it arrives owned by the uid the *image* was built
   * on, and nothing outside the container can chown it afterwards. Mismatched,
   * the agent cannot write its own home and every turn fails on something
   * obscure — so it is worth one loud line at boot rather than being
   * discovered later.
   *
   * A warning and not a refusal: the image is the deployment's to fix, the
   * rest of the orchestrator works, and reviewing an existing session does not
   * need a container at all.
   */
  private async warnOnSessionUidDrift(): Promise<void> {
    let imageUid: number | null;
    try {
      imageUid = await dk.imageUserUid(this.cfg.SESSION_IMAGE);
    } catch (err) {
      log.warn('could not read the session image user', { error: (err as Error).message });
      return;
    }
    if (imageUid === null || imageUid === this.cfg.SESSION_UID) return;
    log.warn(
      'the session image was built on a different uid than SESSION_UID; ' +
        "a session's home volume will not be writable by the agent",
      {
        image: this.cfg.SESSION_IMAGE,
        imageUid,
        sessionUid: this.cfg.SESSION_UID,
      },
    );
  }

  /**
   * Pulls the session image again, so a tag that moves actually moves here.
   *
   * Best-effort on purpose: the image already on the host still works, and a
   * registry that is down — or a tag that was built locally and can be pulled
   * from nowhere — must not become the orchestrator's problem. Nothing
   * running is touched; a session adopts what arrived the next time it is
   * started.
   */
  async refreshSessionImage(): Promise<void> {
    const before = await dk.imageId(this.cfg.SESSION_IMAGE);
    await dk.pullImage(this.cfg.SESSION_IMAGE);
    const after = await dk.imageId(this.cfg.SESSION_IMAGE);
    if (after && after !== before) {
      log.info('the session image moved; sessions adopt it as they are started', {
        image: this.cfg.SESSION_IMAGE,
      });
      // The copy it moved off is now untagged, on this host, and a gigabyte or
      // two. Nothing else is ever going to reclaim it.
      await this.pruneSupersededImages(before);
    }
  }

  /**
   * Removes copies of the session image that a pull has superseded.
   *
   * Called after a refresh that moved the tag, which is the only thing that
   * makes one. `supersededId` is the image the pull replaced, known exactly
   * because this process watched it happen; the sweep alongside it catches
   * the ones an earlier process replaced and did not live to clean up, which
   * it can do because the image carries a label of its own (docker.ts).
   *
   * Nothing here is forced. An image a container was created from is refused
   * by the daemon, and that refusal is what makes this safe to run while
   * sessions exist: a box that has not been started since the tag moved is
   * still on the old image, and start recreates it onto the new one. The
   * image goes on a later sweep.
   */
  private async pruneSupersededImages(supersededId: string | null): Promise<void> {
    if (!this.cfg.SESSION_IMAGE_PRUNE) return;
    const current = await dk.imageId(this.cfg.SESSION_IMAGE);
    const candidates = new Set(await dk.listSupersededSessionImages());
    // A deployment building its own session image without the label has no
    // superseded copy this can find later — but the one this process just
    // replaced is known outright, so that case is covered while the process
    // that saw it lives.
    if (supersededId) candidates.add(supersededId);
    candidates.delete(current ?? '');

    for (const id of candidates) {
      try {
        if (await dk.removeImage(id)) {
          log.info('removed a superseded session image', { image: id });
        }
      } catch (err) {
        log.warn('could not remove a superseded session image', {
          image: id,
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Removes Docker objects and workspace directories belonging to sessions
   * that no longer exist.
   *
   * Everything Boxes creates is labelled with its session (docker.ts, LABEL),
   * and reconcile() reads that one way only: for each row, what Docker has.
   * Nothing read it the other way, so anything left behind by a crash between
   * `docker create` and the row's own update, or by a teardown that failed
   * halfway and only logged it, stayed on the host forever — invisible to
   * Boxes, and a home volume of it is where an agent's runtime installs went.
   *
   * The rule is exact rather than heuristic, and it is exact because of the
   * order create() works in: the row is inserted *before* any Docker object
   * exists, so an object labelled with a session that has no live row cannot
   * be one that is on its way up. A deleted session's tombstone counts as no
   * row, which is what makes a failed teardown recoverable.
   *
   * Ordering matters: a network with a container still on it, or a volume
   * still mounted into one, is refused. Containers go first.
   */
  async sweepOrphans(): Promise<void> {
    const live = new Set(this.allRows().map((row) => row.id));
    const containers = await dk.listSessionContainers();
    const networks = await dk.listSessionNetworks();
    const volumes = await dk.listSessionVolumes();
    const orphaned = <T extends { sessionId: string }>(all: T[]): T[] =>
      all.filter((o) => !live.has(o.sessionId));

    const strays = [...orphaned(containers), ...orphaned(networks), ...orphaned(volumes)];
    const sessions = new Set(strays.map((o) => o.sessionId));
    if (sessions.size === 0) return;

    // The one shape that is likelier to be a database these objects do not
    // belong to than a genuine pile of orphans: a sessions table with nothing
    // in it at all, and a host full of sessions. A data volume mounted from
    // the wrong place, or replaced, leaves exactly that — and going ahead
    // would take the home volume of every session on the host, which is the
    // one loss here that nothing can recover.
    //
    // Deleted sessions are counted, tombstones and all, which is what keeps
    // this from firing on the ordinary case it would otherwise break: a
    // deployment whose sessions have all been deleted still has rows, and its
    // failed teardowns still get swept.
    const known = (
      this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    ).n;
    if (known === 0) {
      log.warn('not sweeping: this database knows of no session, and the host is full of them', {
        sessions: [...sessions],
        containers: orphaned(containers).length,
        networks: orphaned(networks).length,
        volumes: orphaned(volumes).length,
      });
      return;
    }

    log.info('sweeping what is left of sessions that are gone', { sessions: [...sessions] });
    for (const container of orphaned(containers)) {
      await this.sweeping(container.sessionId, 'container', () =>
        dk.removeContainer(container.id),
      );
    }
    for (const network of orphaned(networks)) {
      await this.sweeping(network.sessionId, 'network', () =>
        dk.removeNetwork(network.name, this.cfg),
      );
    }
    for (const volume of orphaned(volumes)) {
      await this.sweeping(volume.sessionId, 'volume', () => dk.removeVolume(volume.name));
    }
    // And the files, which are the size of all of the above put together. The
    // workspace and home of a session with no row are unreachable by every
    // surface Boxes has: no card lists them, no review opens one, and no
    // container mounts either.
    for (const sessionId of sessions) {
      await this.sweeping(sessionId, 'workspace', () =>
        Promise.resolve(ws.removeWorkspace(this.cfg.DATA_DIR, sessionId)),
      );
      await this.sweeping(sessionId, 'home', () =>
        Promise.resolve(ws.removeHome(this.cfg.DATA_DIR, sessionId)),
      );
    }
  }

  /**
   * Runs one removal of the sweep, keeping the rest going when it fails.
   *
   * A stray object that cannot be removed is worth a line and nothing more:
   * whatever is holding it will let go eventually, and the next sweep tries
   * again. Stopping the sweep on it would leave the objects behind it for as
   * long as this one is stuck.
   */
  private async sweeping(
    sessionId: string,
    what: string,
    remove: () => Promise<void>,
  ): Promise<void> {
    try {
      await remove();
      log.session(sessionId).info('swept an orphaned object', { what });
    } catch (err) {
      log.session(sessionId).warn('could not sweep an orphaned object', {
        what,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Rebuilds a session's container when Docker no longer has the one the row
   * names, and returns the row as it now stands.
   *
   * Everything a session container is comes from the row and the two
   * directories the row points at — the image, the network, the mounts, the
   * environment — so a container is reproducible and losing one costs nothing
   * durable. Until now it cost the session: `start` handed the missing id to
   * the daemon, got a 404 back, and there was no other way in. The workspace
   * and the home would be sitting intact on the data volume, unreachable
   * through Boxes, and the only way out was to delete the session and copy
   * the files by hand.
   *
   * A container goes missing more easily than it sounds. `docker container
   * prune` takes every stopped container, and an idle Boxes session *is* a
   * stopped container — the reaper stops them all day. `docker system prune`
   * does that and the network too, which is why this makes the network again
   * as well.
   *
   * Only for a container the daemon says is not there. `unknown` is a daemon
   * that would not answer, and rebuilding on that would mean replacing a
   * container that is running perfectly well behind a failed inspect.
   *
   * A session still on a workspace *volume* is left to `migrateWorkspace`,
   * which runs before this and rebuilds the container itself. Its row has no
   * workspace directory to bind, so `containerSpec` cannot describe it.
   */
  private async restoreMissingContainer(row: SessionRow): Promise<SessionRow> {
    if (!row.container_id || !row.workspace_dir) return row;
    if ((await dk.containerState(row.container_id)) !== 'missing') return row;

    const slog = log.session(row.id);
    slog.warn('the container is gone; rebuilding it from the session row', {
      container: row.container_id,
    });
    // The network goes at the same moment the container does, under any prune
    // that takes both, and a container cannot be created into one that is not
    // there.
    if (await dk.ensureNetwork(row.network_name, row.subnet, row.id)) {
      slog.info('the session network was gone too; made it again', {
        network: row.network_name,
        subnet: row.subnet,
      });
    }
    const containerId = await this.recreateContainer(row);
    this.db
      .prepare('UPDATE sessions SET container_id = ? WHERE id = ?')
      .run(containerId, row.id);
    slog.info('rebuilt the container', { container: containerId });
    return this.mustGet(row.id);
  }

  /**
   * Moves a session onto the current session image, when what its container
   * was created from is no longer what SESSION_IMAGE resolves to.
   *
   * Recreating is how a session container changes anything about itself —
   * migrateWorkspace does the same for its mount — and it is cheap: the
   * rootfs is read-only and everything durable lives in the two mounts, so
   * the workspace and the adapter's thread history come across untouched.
   *
   * Start is the only moment this can happen. Under a running container it
   * would kill the adapter exec mid-turn, so a running session is left alone
   * and comes through here at its next stop/start cycle — which the idle
   * reaper produces on its own within IDLE_STOP_MINUTES.
   *
   * The comparison is on image ids, not on the tag, because the case worth
   * catching is `latest` having moved under a name that did not change.
   */
  private async rollOntoCurrentImage(row: SessionRow): Promise<SessionRow> {
    if (!row.container_id) return row;
    const slog = log.session(row.id);

    let wanted: string | null;
    let current: string | null;
    try {
      wanted = await dk.imageId(this.cfg.SESSION_IMAGE);
      current = await dk.containerImageId(row.container_id);
    } catch (err) {
      // Whatever the daemon is unhappy about, it is not worth refusing to
      // start a session that already has a container over.
      slog.warn('could not compare the session image; starting as it is', {
        error: (err as Error).message,
      });
      return row;
    }
    // Nothing on the host to move to, or a container Docker no longer has:
    // either way there is nothing to decide, and start() surfaces the second.
    if (!wanted || !current || wanted === current) return row;

    if (await this.deferredWhileRunning(row, 'session image change')) return row;

    slog.info('recreating the container on the current session image', {
      from: current,
      image: this.cfg.SESSION_IMAGE,
    });
    // The adapter ran as an exec inside the container about to be removed, so
    // anything the gateway still holds for this session is already dead.
    this.upstreams.get(row.id)?.stop();

    const containerId = await this.recreateContainer({
      ...row,
      image: this.cfg.SESSION_IMAGE,
    });
    this.db
      .prepare('UPDATE sessions SET container_id = ?, image = ? WHERE id = ?')
      .run(containerId, this.cfg.SESSION_IMAGE, row.id);
    slog.info('session moved onto the current session image', {
      image: this.cfg.SESSION_IMAGE,
    });
    return this.mustGet(row.id);
  }

  // --- recreating a container -----------------------------------------------
  //
  // A container's image and its mounts are fixed when it is created, so every
  // change to either replaces the container. That is cheap — the rootfs is
  // read-only and everything durable lives in the mounts — but it is only
  // safe while nothing is running in it, hence the guard the three callers
  // share.

  /**
   * Whether a change that has to replace the container must wait, because the
   * container is still running. Says so in the log when it does.
   *
   * Killing a live container would take the adapter exec, and any turn in it,
   * with it. The change comes through at the session's next stop/start cycle,
   * which the idle reaper produces on its own within IDLE_STOP_MINUTES.
   */
  private async deferredWhileRunning(row: SessionRow, what: string): Promise<boolean> {
    if ((await dk.containerState(row.container_id)) !== 'running') return false;
    log.session(row.id).info(`${what} deferred: the container is still running`);
    return true;
  }

  /**
   * Replaces a session's container with a fresh one built from `row`, and
   * returns the new container's id. The caller records it.
   *
   * The old container is stopped before it is removed even where it is known
   * to be down already: both calls tolerate a container that is gone, and one
   * order for all three callers is worth more than the saved request.
   */
  private async recreateContainer(row: SessionRow): Promise<string> {
    if (row.container_id) {
      await dk.stopContainer(row.container_id);
      await dk.removeContainer(row.container_id);
    }
    const containerId = await dk.createContainer(
      this.containerSpec(row, this.profileFor(row)),
      this.cfg,
    );
    await dk.startContainer(containerId);
    return containerId;
  }

  // --- helpers --------------------------------------------------------------

  /** The stored row for a session, including deleted ones. */
  getRow(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
  }

  /** Every session that has not been deleted, newest first. */
  private allRows(): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE status != 'deleted' ORDER BY created_at DESC")
      .all() as SessionRow[];
  }

  /**
   * Records a new status, leaving a deleted session deleted. An upstream spawn
   * still retrying when the session was removed reports its outcome
   * afterwards, and that must not resurrect the row.
   */
  private setStatus(id: string, status: SessionRow['status']): void {
    this.db
      .prepare("UPDATE sessions SET status = ? WHERE id = ? AND status != 'deleted'")
      .run(status, id);
  }

  /**
   * Everything createContainer needs about a session, built from its stored
   * row and the deployment's current credentials.
   *
   * One place rather than two, because a session's container is created twice:
   * once at create, and once more when a volume-backed workspace migrates to a
   * directory and the container has to be recreated with the new mount.
   */
  private containerSpec(row: SessionRow, profile: SessionProfile): dk.CreateContainerSpec {
    return {
      sessionId: row.id,
      image: row.image,
      networkName: row.network_name,
      subnet: row.subnet,
      workspaceSource: ws.hostWorkspacePath(this.hostDataDir, row.id),
      agentConfigSource: hostAgentConfigPath(this.hostDataDir, row.id),
      // A directory for every session created since homes became
      // directories, and the old named volume for one created before — which
      // goes on mounting it for as long as it lives. There is no migration:
      // the two arrangements simply coexist until the last old session is
      // deleted.
      homeSource: row.home_dir
        ? ws.hostHomePath(this.hostDataDir, row.id)
        : row.home_volume,
      profile,
      egress: {
        claudeOauthToken: this.egress.sessionValue('claude', profile.claudeOauthToken),
        ghToken: this.egress.sessionValue('github', profile.ghToken),
        caCertificate: this.egress.caCertificate(),
      },
    };
  }

  /**
   * The profile a session was created with, or the default when the deployment
   * has since dropped it. A session that outlived its profile must still start.
   */
  private profileFor(row: SessionRow): SessionProfile {
    const profile = this.cfg.profiles[row.profile];
    if (profile) return profile;
    const fallback = this.cfg.profiles['DEFAULT'];
    if (!fallback) throw new HttpError(500, `Unknown profile: ${row.profile}`);
    log.session(row.id).warn('profile is gone; falling back to DEFAULT', {
      profile: row.profile,
    });
    return fallback;
  }

  /** The persistent upstream for a session, created on first use. */
  upstream(id: string): UpstreamSession {
    let up = this.upstreams.get(id);
    if (!up) {
      up = new UpstreamSession(
        id,
        this.db,
        this.cfg,
        this.pending,
        this.notifier,
        (status) => this.setStatus(id, status),
        async () => {
          const row = this.getRow(id);
          if (!row || row.status === 'deleted') return;
          this.agents.materialize(id, row.agent_set_id);
          // Opening a thread starts a stopped box without going through
          // start(), so the one repair that decides whether there is a box at
          // all has to happen here too. It leaves the row's container id
          // current, which is what the caller reads next.
          await this.restoreMissingContainer(row);
        },
      );
      this.upstreams.set(id, up);
    }
    return up;
  }

  // --- create ---------------------------------------------------------------

  /**
   * Creates the network, volumes and container for a new session. Any failed
   * step tears the whole session down and marks it as an error.
   */
  async create(body: CreateSessionBody): Promise<SessionDetail> {
    const name = body.name?.trim();
    if (!name) throw new HttpError(400, 'name is required');
    if (name.length > 100) throw new HttpError(400, 'name must be 100 characters or fewer');

    const profileName = body.profile?.trim() || 'DEFAULT';
    const profile = this.cfg.profiles[profileName];
    if (!profile) throw new HttpError(400, `Unknown profile: ${profileName}`);

    // The global set is applied whatever this says, so naming it is the same
    // as naming nothing and is stored as nothing.
    const requested = body.agentSet?.trim() ?? '';
    const agentSetId = requested === '' || requested === GLOBAL_AGENT_SET ? null : requested;
    if (agentSetId && !this.agents.has(agentSetId)) {
      throw new HttpError(400, `Unknown agent set: ${agentSetId}`);
    }

    // Before anything is allocated, and after the checks above, which cost
    // nothing: a request naming a set that is not there should not pull an
    // image on its way to a 400. A deployment whose first pull failed would
    // otherwise get the daemon's "no such image" halfway through creating a
    // session, and a teardown to go with it.
    try {
      await this.ensureSessionImage();
    } catch (err) {
      throw new HttpError(
        503,
        `Session image ${this.cfg.SESSION_IMAGE} is not available: ${(err as Error).message}`,
      );
    }

    // Server-generated: user input never reaches a Docker object name.
    const id = randomBytes(4).toString('hex');
    const now = Date.now();
    const subnet = allocateSubnet(this.cfg.SESSION_SUBNET_POOL, nextSubnetIndex(this.db));
    const row: SessionRow = {
      id,
      name,
      profile: profileName,
      image: this.cfg.SESSION_IMAGE,
      agent_cmd: JSON.stringify(AGENT_CMD),
      container_id: null,
      network_name: dk.names.network(id),
      subnet,
      // Directory-backed from the start, both of them, so neither volume is
      // created and the columns that named them stay empty.
      ws_volume: '',
      home_volume: '',
      workspace_dir: ws.workspacePath(this.cfg.DATA_DIR, id),
      home_dir: ws.homePath(this.cfg.DATA_DIR, id),
      // No base revision until the reviewer picks one: a review compares
      // against each repository's own working tree by default.
      review_base_rev: null,
      status: 'creating',
      agent_set_id: agentSetId,
      current_thread_id: null,
      created_at: now,
      last_active_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
           network_name, subnet, ws_volume, home_volume, workspace_dir, home_dir,
           status, agent_set_id, current_thread_id, created_at, last_active_at)
         VALUES (@id, @name, @profile, @image, @agent_cmd, @container_id,
           @network_name, @subnet, @ws_volume, @home_volume, @workspace_dir, @home_dir,
           @status, @agent_set_id, @current_thread_id, @created_at, @last_active_at)`,
      )
      .run(row);

    const slog = log.session(id);
    try {
      await dk.createNetwork(row.network_name, subnet, id);
      await dk.ensureProxyAttached(row.network_name, this.cfg);
      ws.createWorkspace(this.cfg.DATA_DIR, id);
      // Before the container, because it is one of its mounts.
      this.agents.materialize(id, agentSetId);
      // A bind mount covers what the image put in /home/agent rather than
      // being seeded from it the way a named volume was, so the seeding is
      // ours to do. See dk.seedHomeFromImage — an empty home costs the
      // agent's own `~/.local/bin` on the PATH of a login shell.
      ws.createHome(this.cfg.DATA_DIR, id);
      await dk.seedHomeFromImage(
        ws.hostHomePath(this.hostDataDir, id),
        row.image,
        id,
      );
      const containerId = await dk.createContainer(
        this.containerSpec(row, profile),
        this.cfg,
      );
      await dk.startContainer(containerId);
      this.db
        .prepare("UPDATE sessions SET container_id = ?, status = 'running' WHERE id = ?")
        .run(containerId, id);
      slog.info('session created', { name });
    } catch (err) {
      slog.error('session create failed; tearing down', { error: (err as Error).message });
      await this.teardownResources(id);
      this.setStatus(id, 'error');
      throw new HttpError(500, `Failed to create session: ${(err as Error).message}`);
    }

    return this.detail(id);
  }

  // --- start / stop / delete ------------------------------------------------

  /** Starts a stopped session's container and re-attaches the egress proxy. */
  async start(id: string): Promise<SessionDetail> {
    let row = this.mustGet(id);
    if (!row.container_id) throw new HttpError(409, 'Session has no container');
    // Rewritten on every start, so an edited set reaches the box here — the
    // entrypoint installs what this leaves behind, and nothing else does.
    // Before either step below, both of which may create a container that
    // binds the directory: the daemon would otherwise create it itself, empty
    // and owned by root.
    this.agents.materialize(row.id, row.agent_set_id);
    row = await this.migrateWorkspace(row);
    // Before the two below, which both ask the daemon about a container that
    // may not be there: after this one, there is a container to ask about.
    row = await this.restoreMissingContainer(row);
    // Before the mount check below, not after: a roll recreates the container
    // from containerSpec, which already binds the agent configuration, so a
    // session that moves image comes back with the mount and the check that
    // follows finds nothing left to do. The other order would recreate the
    // same container twice.
    row = await this.rollOntoCurrentImage(row);
    row = await this.ensureAgentConfigMount(row);
    await dk.startContainer(row.container_id!);
    await dk.ensureProxyAttached(row.network_name, this.cfg);
    this.setStatus(id, 'running');
    // The upstream reconnects on the next forwarded message, which re-issues
    // session/load and restores the thread.
    return this.detail(id);
  }

  /**
   * Moves a session created before this change off its workspace volume and
   * onto a directory, and returns the row as it now stands.
   *
   * Start is the only moment this can happen: the mount is fixed when a
   * container is created, so the container has to be replaced. That is cheap
   * here — a session container has a read-only rootfs and everything durable
   * lives in its two mounts — but it is not free of risk, so the order is
   * chosen to lose nothing at any step: copy first, recreate second, and drop
   * the volume only once the new container has started. A crash anywhere
   * before the row is updated leaves a volume-backed session that migrates
   * again on the next attempt.
   *
   * A running legacy session is left alone. Its container works, and it will
   * come through here at its next stop/start cycle.
   */
  private async migrateWorkspace(row: SessionRow): Promise<SessionRow> {
    if (row.workspace_dir) return row;
    const slog = log.session(row.id);
    if (await this.deferredWhileRunning(row, 'workspace migration')) return row;

    slog.info('migrating the workspace volume to a directory', { volume: row.ws_volume });
    const directory = ws.createWorkspace(this.cfg.DATA_DIR, row.id);
    const hostDirectory = ws.hostWorkspacePath(this.hostDataDir, row.id);

    if (row.ws_volume) {
      await dk.copyVolumeToDirectory(row.ws_volume, hostDirectory, row.image, row.id);
    }
    // The agent has to own what it works in, and cp -a brought the volume's
    // own ownership with it, which a Docker-initialised volume gets right.
    ws.chownToAgent(directory);

    const containerId = await this.recreateContainer(row);
    this.db
      .prepare(
        `UPDATE sessions SET container_id = ?, workspace_dir = ?, ws_volume = ''
          WHERE id = ?`,
      )
      .run(containerId, directory, row.id);

    if (row.ws_volume) await dk.removeVolume(row.ws_volume);
    slog.info('workspace migrated', { directory });
    return this.mustGet(row.id);
  }

  /**
   * Gives a session created before agent configuration existed the mount that
   * carries it, and returns the row as it now stands.
   *
   * Nothing is lost if this fails halfway, because the directory is already
   * written and the next start tries again.
   *
   * A running session is left alone. Restarting it under the user would be a
   * worse surprise than configuration arriving one stop/start cycle late.
   */
  private async ensureAgentConfigMount(row: SessionRow): Promise<SessionRow> {
    if (!row.container_id) return row;
    if (await dk.hasMount(row.container_id, dk.AGENT_CONFIG_DIR)) return row;
    if (await this.deferredWhileRunning(row, 'agent configuration')) return row;
    log.session(row.id).info('recreating the container with the agent configuration mount');
    const containerId = await this.recreateContainer(row);
    this.db
      .prepare('UPDATE sessions SET container_id = ? WHERE id = ?')
      .run(containerId, row.id);
    return this.mustGet(row.id);
  }

  /** Stops the container and drops the upstream connection. */
  async stop(id: string): Promise<SessionDetail> {
    const row = this.mustGet(id);
    this.upstreams.get(id)?.stop();
    if (row.container_id) await dk.stopContainer(row.container_id);
    this.setStatus(id, 'stopped');
    log.session(id).info('session stopped');
    return this.detail(id);
  }

  /** Deletes a session and everything it is made of, its volumes included. */
  async remove(id: string): Promise<void> {
    const row = this.mustGet(id);
    this.upstreams.get(id)?.close();
    this.upstreams.delete(id);
    await this.teardownResources(id);
    // Every table keyed by the session id, so a deleted session leaves nothing
    // behind: the row itself stays as a tombstone — see setStatus — and these
    // have no reader once it does.
    for (const table of ['pending_requests', 'acp_log', 'exec_log', 'threads']) {
      this.db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(id);
    }
    this.usage.forget(id);
    this.setStatus(id, 'deleted');
    log.session(id).info('session deleted', { name: row.name });
  }

  /**
   * Removes a session's container, network and volumes. Every failure is
   * logged rather than thrown, so teardown always finishes.
   */
  private async teardownResources(id: string): Promise<void> {
    const row = this.getRow(id);
    if (!row) return;
    const slog = log.session(id);
    if (row.container_id) {
      try {
        await dk.stopContainer(row.container_id);
        await dk.removeContainer(row.container_id);
      } catch (err) {
        slog.warn('container teardown failed', { error: (err as Error).message });
      }
    }
    try {
      await dk.removeNetwork(row.network_name, this.cfg);
    } catch (err) {
      slog.warn('network teardown failed', { error: (err as Error).message });
    }
    // The workspace and the home hold the agent's work and the adapter's
    // thread history. Nothing else refers to either once the session is gone,
    // so a session that is deleted takes them with it rather than leaving them
    // orphaned.
    if (row.workspace_dir) {
      try {
        ws.removeWorkspace(this.cfg.DATA_DIR, row.id);
      } catch (err) {
        slog.warn('workspace removal failed', { error: (err as Error).message });
      }
    }
    if (row.home_dir) {
      try {
        ws.removeHome(this.cfg.DATA_DIR, row.id);
      } catch (err) {
        slog.warn('home removal failed', { error: (err as Error).message });
      }
    }
    try {
      this.agents.removeMaterialized(row.id);
    } catch (err) {
      slog.warn('agent configuration removal failed', { error: (err as Error).message });
    }
    // Only a session from before each of these became a directory still has
    // the volume it used to be.
    if (row.ws_volume) await dk.removeVolume(row.ws_volume);
    if (row.home_volume) await dk.removeVolume(row.home_volume);
  }

  // --- views ----------------------------------------------------------------

  /** The stored row for a live session, or a 404. */
  private mustGet(id: string): SessionRow {
    const row = this.getRow(id);
    if (!row || row.status === 'deleted') throw new HttpError(404, 'Session not found');
    return row;
  }

  /**
   * Where a local command should run for this session, starting the
   * container if it is stopped. The workspace root, which is where the
   * adapter runs too.
   */
  async execTarget(id: string): Promise<{ containerId: string; workingDir: string }> {
    let row = this.mustGet(id);
    if (!row.container_id) throw new HttpError(409, 'Session has no container');
    // A stopped container starts here too, and the entrypoint installs
    // whatever is on disk when it does.
    this.agents.materialize(row.id, row.agent_set_id);
    // And one that is gone is made again, the same way start does it: a
    // `!bang` command is as good a moment as any to find out that something
    // pruned the box, and as good a moment to put it back.
    row = await this.restoreMissingContainer(row);
    await dk.startContainer(row.container_id!);
    return { containerId: row.container_id!, workingDir: dk.WORKSPACE_DIR };
  }

  /** Marks a session active, so running a command holds off the reaper. */
  touch(id: string): void {
    touchSession(this.db, id);
  }

  /**
   * Says the orchestrator has written into a session's workspace, so its size
   * is measured again rather than answered from what a stopped box was left
   * at.
   *
   * A box that is down cannot grow on its own, which is what lets a stopped
   * session be measured once and then left alone. An upload is the exception
   * — the one way enough bytes arrive in a workspace with nothing running in
   * it to move the figure — and this is it saying so.
   */
  workspaceChanged(id: string): void {
    this.usage.forget(id);
  }

  /** Summaries of every live session. */
  async list(): Promise<SessionSummary[]> {
    const rows = this.allRows();
    const counts = this.pending.countsBySession();
    const running = sessionsWithActiveTurns(this.db);
    return Promise.all(
      rows.map(async (row) =>
        this.summarize(row, counts.get(row.id) ?? 0, running.has(row.id)),
      ),
    );
  }

  /** Builds a summary, resolving the container state against Docker. */
  private async summarize(
    row: SessionRow,
    pendingCount: number,
    turnActive: boolean,
  ): Promise<SessionSummary> {
    const dockerState = await dk.containerState(row.container_id);
    const pendingByThread = this.pending.countsByThread(row.id);
    // What the gateway believes about the box right now, which lives in
    // memory beside the adapter rather than in the database: the agent is
    // talking on these threads, and these tasks are still running in them.
    // Read once here so every thread of one summary answers from the same
    // moment. `upstreams.get` rather than `upstream()`, which would start one.
    const upstream = this.upstreams.get(row.id);
    const speaking = new Set(upstream?.speakingThreads ?? []);
    const working = new Set(upstream?.workingThreads ?? []);
    return {
      id: row.id,
      name: row.name,
      profile: row.profile,
      status: row.status,
      dockerState,
      // Derived from the threads rather than stored beside them: a turn runs
      // on a conversation, and the session's answer is that any of them has
      // one.
      turnActive,
      speaking: speaking.size > 0,
      backgroundBusy: upstream?.backgroundActive ?? false,
      pendingCount,
      attachedCount: upstream?.attachedCount ?? 0,
      wsToken: this.cfg.WS_AUTH_TOKEN,
      threads: listThreads(this.db, row.id).map((thread) =>
        toThreadSummary(thread, pendingByThread, speaking, working),
      ),
      currentThreadId: row.current_thread_id,
      // False until the adapter has been reached and has advertised it. The
      // capability is unstable, so an absent one is taken at face value.
      canFork: upstream?.canFork ?? false,
      agentSetId: row.agent_set_id,
      agentSetName: this.agents.nameOf(row.agent_set_id),
      // What was last measured, and null until there is a measurement. Never
      // waits for one: this is a card's rough indicator, and the list behind
      // it is polled every five seconds.
      //
      // A container known to be down is measured once and then left alone —
      // nothing is running in it, so nothing in it is changing. 'unknown' is
      // not 'exited': a Docker read that failed says nothing about whether
      // the agent is working, and a size frozen on that would be frozen on a
      // guess. See diskusage.ts.
      diskBytes: this.usage.bytes(
        row.id,
        dockerState !== 'exited' && dockerState !== 'missing',
      ),
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    };
  }

  /** A summary plus the Docker object names the detail view shows. */
  async detail(id: string): Promise<SessionDetail> {
    const row = this.mustGet(id);
    const summary = await this.summarize(
      row,
      this.pending.countForSession(id),
      sessionTurnActive(this.db, id),
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
      acpSessionId: currentThread(this.db, id)?.acp_session_id ?? null,
      proxyAttached: await dk.isProxyAttached(row.network_name, this.cfg),
    };
  }

  // --- threads --------------------------------------------------------------

  /** Every conversation of a session, oldest first. */
  threads(id: string): ThreadSummary[] {
    this.mustGet(id);
    const pendingByThread = this.pending.countsByThread(id);
    return listThreads(this.db, id).map((thread) => toThreadSummary(thread, pendingByThread));
  }

  /**
   * Whether a thread belongs to a session. The WebSocket upgrade asks before
   * a socket exists, so a path naming another session's thread is a 404
   * rather than a connection that fails later.
   */
  hasThread(sessionId: string, threadId: string): boolean {
    const row = getThread(this.db, threadId);
    return row !== undefined && row.session_id === sessionId;
  }

  /**
   * Adds a conversation to a session and makes it current: empty by default,
   * or carrying another thread's context when `from` names one.
   *
   * Both need the adapter, because only the adapter can mint a thread.
   */
  async createThread(id: string, body: CreateThreadBody | undefined): Promise<ThreadSummary> {
    this.mustGet(id);
    const from = body?.from?.trim();
    const up = this.upstream(id);
    try {
      const row = from ? await up.forkThread(from) : await up.newThread();
      return toThreadSummary(row, this.pending.countsByThread(id));
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'Thread not found') throw new HttpError(404, message);
      // A thread minted and never prompted has no adapter-side conversation
      // to branch from, which is the caller's timing rather than a fault.
      if (message === NOTHING_TO_FORK) throw new HttpError(409, message);
      throw new HttpError(500, `Failed to create thread: ${message}`);
    }
  }

  /**
   * Makes one of a session's threads current: the thread a connection that
   * names none gets.
   *
   * Nobody is dropped and nothing reconnects. A browser is pinned to its own
   * thread for the life of its socket, so the session's default is only ever
   * read at a handshake — see UpstreamSession.switchThread.
   */
  selectThread(id: string, threadId: string): ThreadSummary {
    this.mustGet(id);
    const row = getThread(this.db, threadId);
    if (!row || row.session_id !== id) throw new HttpError(404, 'Thread not found');
    return toThreadSummary(this.upstream(id).switchThread(threadId));
  }

  /**
   * Stops one thing that conversation left running, or all of it.
   *
   * A thread the adapter has no conversation for cannot have left anything in
   * the box: work is a process under an agent process, and it has none.
   */
  async stopBackgroundWork(
    id: string,
    threadId: string,
    processId?: string,
  ): Promise<{ stopped: number }> {
    this.mustGet(id);
    const row = getThread(this.db, threadId);
    if (!row || row.session_id !== id) throw new HttpError(404, 'Thread not found');
    if (!row.acp_session_id) return { stopped: 0 };
    return { stopped: await this.upstream(id).stopBackgroundWork(row.acp_session_id, processId) };
  }

  // --- boot reconciliation --------------------------------------------------

  /**
   * Aligns the stored rows with what Docker runs: adopts live
   * containers, marks missing ones stopped, and re-attaches the egress proxy.
   * Upstream connections are re-established on first use.
   */
  async reconcile(): Promise<void> {
    this.pending.clearStale();
    const live = new Map(
      (await dk.listSessionContainers()).map((c) => [c.sessionId, c]),
    );
    for (const row of this.allRows()) {
      const container = live.get(row.id);
      if (!container) {
        if (row.status === 'running') {
          log.session(row.id).warn('container missing at boot; marking stopped');
          this.setStatus(row.id, 'stopped');
        }
        continue;
      }
      if (container.id !== row.container_id) {
        this.db
          .prepare('UPDATE sessions SET container_id = ? WHERE id = ?')
          .run(container.id, row.id);
      }
      this.setStatus(row.id, container.running ? 'running' : 'stopped');
      // A turn cannot survive an orchestrator restart: the upstream
      // connection that owned it is gone, on every thread of the session.
      clearSessionTurns(this.db, row.id);
      await dk.ensureProxyAttached(row.network_name, this.cfg);
    }
    log.info('boot reconciliation complete', { sessions: this.allRows().length });
  }

  /**
   * Re-attaches the egress proxy to every running session's network. Returns
   * the ids of the sessions where that failed.
   */
  async reconcileProxyAttachments(): Promise<string[]> {
    const warnings: string[] = [];
    for (const row of this.allRows()) {
      if (row.status !== 'running') continue;
      const ok = await dk.ensureProxyAttached(row.network_name, this.cfg);
      if (!ok) warnings.push(row.id);
    }
    return warnings;
  }

  /** Drops every upstream connection, for shutdown. */
  closeAll(): void {
    for (const up of this.upstreams.values()) up.close();
    this.upstreams.clear();
  }

  /** Periodic housekeeping on every upstream. */
  maintenance(): void {
    for (const up of this.upstreams.values()) up.maintenance();
  }
}

/**
 * One stored thread, as the API reports it.
 *
 * `pendingByThread` is keyed by the adapter's own id, which is what a queued
 * permission request records, and a thread the adapter has forgotten has no
 * queued requests by definition.
 */
function toThreadSummary(
  row: ThreadRow,
  pendingByThread: Map<string, number> = new Map(),
  speaking: ReadonlySet<string> = new Set(),
  working: ReadonlySet<string> = new Set(),
): ThreadSummary {
  const acp = row.acp_session_id;
  return {
    id: row.id,
    acpSessionId: acp,
    title: row.title,
    ordinal: row.ordinal,
    turnActive: row.turn_active === 1,
    // These three are the live gateway's, keyed by the adapter's own id: a
    // thread the adapter has forgotten has nothing running in it and nobody
    // talking on it, by definition.
    speaking: acp ? speaking.has(acp) : false,
    backgroundBusy: acp ? working.has(acp) : false,
    pendingCount: acp ? (pendingByThread.get(acp) ?? 0) : 0,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

