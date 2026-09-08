import Docker from 'dockerode';
import { existsSync, readFileSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import type { Duplex } from 'node:stream';
import type { DockerState } from '../../shared/types.ts';
import type { Config, SessionProfile } from './config.ts';
import { log } from './log.ts';
import { sessionOwner } from './workspaces.ts';

/**
 * Container, network and volume lifecycle, plus the long-lived adapter exec.
 *
 * The HostConfig below is a fixed template that user input never reaches. The
 * caller supplies only the server-generated session id and the values a
 * session is to hold in place of the deployment's credentials.
 */

/** Docker label carrying the session id on every object Boxes creates. */
export const LABEL = 'boxes.session';

/**
 * The `uid:gid` every session process runs as, as Docker wants it written.
 *
 * Numbers rather than the image's `agent`, so SESSION_UID alone decides who a
 * session is and the image needs no rebuild to be read differently. The two
 * still have to agree about the *home volume*, which Docker initialises from
 * the image — see ensureSessionImage().
 */
function sessionUser(): string {
  const { uid, gid } = sessionOwner();
  return `${uid}:${gid}`;
}

/** The session's writable workspace, and the working directory of everything in it. */
export const WORKSPACE_DIR = '/workspace';

/**
 * Where the session's merged agent configuration is mounted, read-only.
 *
 * The entrypoint installs it into `~/.claude` from here. It is not mounted at
 * `~/.claude` directly because that directory is on the home volume, is
 * written by the agent, and holds the transcripts — a read-only mount over it
 * would break the box, and a writable one would let the agent edit what the
 * dashboard says is configured.
 */
export const AGENT_CONFIG_DIR = '/boxes/agent';

let client: Docker | null = null;

/** The shared Docker client, connected to the host socket on first use. */
export function docker(): Docker {
  if (!client) client = new Docker({ socketPath: '/var/run/docker.sock' });
  return client;
}

/** Test seam: install a client, or null to reset. */
export function setDockerForTests(d: Docker | null): void {
  client = d;
}

/**
 * Docker object names derived from a session id.
 *
 * There is no workspace volume here any more: a workspace is a directory on
 * the orchestrator's data volume, and the `ws-<id>` volume of a session from
 * before that change is read off its row rather than derived.
 */
export const names = {
  container: (id: string) => `session-${id}`,
  network: (id: string) => `sn-${id}`,
  homeVolume: (id: string) => `home-${id}`,
};

/**
 * What a session is handed in place of the deployment's real credentials.
 *
 * Where translation is on these are placeholders and the proxy swaps them for
 * the real thing on the wire, so nothing inside the container is worth
 * stealing. Where it is off — a credential this deployment did not configure —
 * they are whatever the profile holds, which is today's behavior.
 */
export interface SessionEgress {
  claudeOauthToken: string;
  ghToken: string;
  /**
   * PEM of the deployment CA the session must trust, or '' when nothing is
   * intercepted and no extra trust is needed.
   */
  caCertificate: string;
}

/** Everything createContainer needs to know about one session. */
export interface CreateContainerSpec {
  sessionId: string;
  image: string;
  networkName: string;
  subnet: string;
  /**
   * Host-side path bind-mounted at WORKSPACE_DIR. A path rather than a volume
   * name because the orchestrator has to read these files itself; see
   * workspaces.ts for how it is resolved.
   */
  workspaceSource: string;
  /**
   * Host-side path of the session's materialized agent configuration, bound
   * read-only at AGENT_CONFIG_DIR. Always present: a session with nothing
   * configured gets an empty manifest, which is how the entrypoint learns to
   * remove what a previous start installed.
   */
  agentConfigSource: string;
  homeVolume: string;
  profile: SessionProfile;
  egress: SessionEgress;
}

/** Where the entrypoint writes the CA, and where the CA env vars point. */
const CA_PATH = '/home/agent/.boxes/proxy-ca.crt';

/**
 * Environment of a session container.
 *
 * This is the only delivery path for a session's credentials, and with
 * translation on it carries no real one. The CA travels here too, as a PEM
 * rather than a mount, so the proxy's trust anchor needs no volume and no file
 * on the host.
 */
export function sessionEnv(spec: CreateContainerSpec, cfg: Config): string[] {
  const proxyUrl = `http://${cfg.EGRESS_PROXY_ALIAS}:${cfg.EGRESS_PROXY_PORT}`;
  const env: Record<string, string> = {
    CLAUDE_CODE_OAUTH_TOKEN: spec.egress.claudeOauthToken,
    GH_TOKEN: spec.egress.ghToken,
    GIT_NAME: spec.profile.gitName,
    GIT_EMAIL: spec.profile.gitEmail,
    TERM: 'dumb',
    CLAUDE_CONFIG_DIR: '/home/agent/.claude',
    // Every proxy-aware client honours these; anything else has no route
    // out, which is the intended failure mode.
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
  };

  if (spec.egress.caCertificate !== '') {
    // The entrypoint writes the PEM to CA_PATH; these are the four variables
    // that point node, gh, git and curl at it. A tool honouring none of them
    // fails TLS against the intercepted hosts and nothing else — the shape the
    // README's troubleshooting table describes.
    env['BOXES_PROXY_CA'] = spec.egress.caCertificate;
    env['NODE_EXTRA_CA_CERTS'] = CA_PATH;
    env['SSL_CERT_FILE'] = CA_PATH;
    env['GIT_SSL_CAINFO'] = CA_PATH;
    env['CURL_CA_BUNDLE'] = CA_PATH;
  }

  return Object.entries(env)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`);
}

/** Converts a Docker-style memory limit such as 4g into bytes. */
function memoryBytes(limit: string): number {
  const match = /^(\d+)([kmgKMG]?)$/.exec(limit);
  if (!match) throw new Error(`Invalid memory limit: ${limit}`);
  const value = Number(match[1]);
  const unit = (match[2] ?? '').toLowerCase();
  const scale = unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1;
  return value * scale;
}

/** Creates a session network. Internal, so it has no NAT and no default route. */
export async function createNetwork(networkName: string, subnet: string, sessionId: string): Promise<void> {
  await docker().createNetwork({
    Name: networkName,
    Driver: 'bridge',
    Internal: true,
    CheckDuplicate: true,
    IPAM: { Driver: 'default', Config: [{ Subnet: subnet }] },
    Labels: { [LABEL]: sessionId },
  });
}

/**
 * Whether a network's own inspect says the egress proxy is on it.
 *
 * One predicate for both questions below, so "is it attached" cannot come to
 * mean two slightly different things.
 */
function proxyOn(info: Docker.NetworkInspectInfo, cfg: Config): boolean {
  return Object.values(info.Containers ?? {}).some(
    (c) => c.Name === cfg.EGRESS_PROXY_CONTAINER,
  );
}

/**
 * Attaches the egress proxy to a session network under its alias, and reports
 * whether it is attached. The check runs every time, because compose can
 * recreate the proxy container and drop its dynamic attachments.
 */
export async function ensureProxyAttached(networkName: string, cfg: Config): Promise<boolean> {
  const net = docker().getNetwork(networkName);
  let info: Docker.NetworkInspectInfo;
  try {
    info = await net.inspect();
  } catch {
    return false;
  }
  if (proxyOn(info, cfg)) return true;
  try {
    await net.connect({
      Container: cfg.EGRESS_PROXY_CONTAINER,
      EndpointConfig: { Aliases: [cfg.EGRESS_PROXY_ALIAS] },
    });
    log.info('attached egress proxy to session network', { network: networkName });
    return true;
  } catch (err) {
    log.warn('could not attach egress proxy', {
      network: networkName,
      error: (err as Error).message,
    });
    return false;
  }
}

/** Whether the egress proxy is attached to a session network right now. */
export async function isProxyAttached(networkName: string, cfg: Config): Promise<boolean> {
  try {
    return proxyOn(await docker().getNetwork(networkName).inspect(), cfg);
  } catch {
    return false;
  }
}

/** Creates a volume labelled with its session. */
export async function createVolume(name: string, sessionId: string): Promise<void> {
  await docker().createVolume({ Name: name, Labels: { [LABEL]: sessionId } });
}

// --- resolving this process's own host-side paths ---------------------------

/**
 * This process's own container id, or null when it is not in a container.
 *
 * Three sources, because none of them holds everywhere. `/etc/hostname` is the
 * classic answer but compose sets a container's hostname to its service name,
 * which is not an id at all; mountinfo carries the id in the paths of the
 * three files Docker always binds into a container; the cgroup path carries it
 * under cgroup v1 and under v2 with a named hierarchy, and is `0::/` otherwise.
 */
export function selfContainerId(): string | null {
  const patterns: Array<[string, RegExp]> = [
    ['/proc/self/mountinfo', /\/containers\/([0-9a-f]{64})\//],
    ['/proc/self/cgroup', /(?:^|\/|docker-)([0-9a-f]{64})(?:\.scope)?$/m],
    ['/etc/hostname', /^([0-9a-f]{12,64})$/],
  ];
  for (const [file, pattern] of patterns) {
    try {
      const match = pattern.exec(readFileSync(file, 'utf8').trim());
      if (match?.[1]) return match[1];
    } catch {
      // not readable here; try the next source
    }
  }
  return null;
}

/**
 * Pulls an image, resolving once the daemon has finished with it.
 *
 * The orchestrator creates session containers but used to never fetch what
 * they run, which left the image something every deployment had to build out
 * of a checkout. Pulling it here is what lets SESSION_IMAGE name a published
 * tag and nothing else be done about it.
 *
 * No auth is passed: a deployment that needs a private registry configures
 * the daemon's own credentials, which is where Docker looks anyway.
 */
export async function pullImage(image: string): Promise<void> {
  const stream = await docker().pull(image);
  await new Promise<void>((resolve, reject) => {
    // The pull is a progress stream, and it is only complete when that stream
    // is: awaiting the call alone returns as soon as the transfer starts.
    docker().modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Reads something off an inspect, answering null for an object the daemon does
 * not have.
 *
 * "It is not here" is a legitimate answer to every question below, and the
 * daemon spells it as a 404. Any other failure is the daemon being unwell and
 * is rethrown, because reporting that as absence would have a caller quietly
 * act on a container or an image it never actually looked at.
 */
async function inspecting<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

/**
 * The uid an image's own `USER` names, or null when it names something this
 * cannot read as a number.
 *
 * An older image, or one built elsewhere, may carry a user *name* — there is
 * no uid to compare then, and saying nothing beats guessing.
 */
export async function imageUserUid(image: string): Promise<number | null> {
  return inspecting(async () => {
    const info = await docker().getImage(image).inspect();
    const user = (info.Config?.User ?? '').split(':')[0] ?? '';
    return /^\d+$/.test(user) ? Number(user) : null;
  });
}

/**
 * The id of an image on this host, or null when it is not here.
 *
 * The id and not the tag, because the question this answers is whether a
 * moving tag has moved.
 */
export async function imageId(image: string): Promise<string | null> {
  return inspecting(async () => (await docker().getImage(image).inspect()).Id ?? null);
}

/** The id of the image a container was created from, or null when it is gone. */
export async function containerImageId(containerId: string): Promise<string | null> {
  return inspecting(
    async () => (await docker().getContainer(containerId).inspect()).Image ?? null,
  );
}

/** Whether this process is running inside a container. */
export function inContainer(): boolean {
  return existsSync('/.dockerenv') || selfContainerId() !== null;
}

/**
 * The host-side path of a directory mounted into this process's own container,
 * or null when there is no such mount.
 *
 * This is the one thing a bind of a path under the orchestrator's own /data
 * needs and cannot guess: bind sources are resolved by the daemon, so the
 * source has to be the path the daemon knows, which is the `Source` of the
 * mount whose `Destination` is the directory in question. With the shipped
 * compose that resolves to `/var/lib/docker/volumes/boxes-data/_data`.
 */
export async function resolveHostMountSource(destination: string): Promise<string | null> {
  const self = selfContainerId();
  if (!self) return null;
  const info = await docker().getContainer(self).inspect();
  const mount = (info.Mounts ?? []).find((m) => m.Destination === destination);
  return mount?.Source ?? null;
}

/**
 * Copies a named volume's content into a host directory, through a one-shot
 * container that can see both.
 *
 * This is how a session created before workspaces were directories moves onto
 * one. The orchestrator has no path to a named volume — the very problem the
 * bind mount removes — so the copy has to run somewhere both are mounted.
 * `cp -a` preserves ownership, which keeps the agent's files the agent's;
 * that needs root in the helper, so this is the one container Boxes creates
 * that does not drop its capabilities. It has no network and a read-only
 * rootfs, and its argv is fixed here.
 */
export async function copyVolumeToDirectory(
  volumeName: string,
  hostDirectory: string,
  image: string,
  sessionId: string,
): Promise<void> {
  const container = await docker().createContainer({
    Image: image,
    User: 'root',
    // The image's own entrypoint holds a container open; this one has a job
    // and exits, so the entrypoint is replaced rather than run.
    Entrypoint: ['sh', '-c'],
    Cmd: ['cp -a /from/. /to/'],
    Labels: { [LABEL]: sessionId },
    HostConfig: {
      Binds: [`${volumeName}:/from:ro`, `${hostDirectory}:/to`],
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      RestartPolicy: { Name: 'no' },
      Init: true,
    },
  });
  try {
    await container.start();
    const { StatusCode } = (await container.wait()) as { StatusCode: number };
    if (StatusCode !== 0) {
      const logs = await container.logs({ stdout: true, stderr: true, tail: 20 });
      throw new Error(
        `copy of ${volumeName} exited ${StatusCode}: ${logs.toString('utf8').trim()}`,
      );
    }
  } finally {
    try {
      await container.remove({ force: true, v: false });
    } catch {
      // already gone
    }
  }
}

/** Creates a session container from the fixed, hardened HostConfig template. */
export async function createContainer(spec: CreateContainerSpec, cfg: Config): Promise<string> {
  const container = await docker().createContainer({
    name: names.container(spec.sessionId),
    Image: spec.image,
    User: sessionUser(),
    WorkingDir: WORKSPACE_DIR,
    Env: sessionEnv(spec, cfg),
    Labels: {
      [LABEL]: spec.sessionId,
      // A session container is the orchestrator's, and only the
      // orchestrator's: it is tracked by the id returned here, attached to
      // its network after the fact, and recreated on a new image at start.
      // An outside updater that stopped and recreated one would leave the id
      // in the database pointing at nothing and drop the proxy attachment
      // that is the session's only way out, so the opt-out every such tool
      // reads is part of the template rather than something each deployment
      // has to remember. Watchtower honours it; nothing else minds it.
      'com.centurylinklabs.watchtower.enable': 'false',
    },
    // The adapter is a separate exec; PID 1 only holds the container open.
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    HostConfig: {
      NetworkMode: spec.networkName,
      Binds: [
        // The workspace is a directory on the orchestrator's data volume, so
        // that reviewing a session's files needs no exec and no running
        // container. The home volume stays a named volume: it holds
        // transcripts and session-local credentials, and nothing outside the
        // container reads it.
        `${spec.workspaceSource}:${WORKSPACE_DIR}`,
        `${spec.homeVolume}:/home/agent`,
        // Read-only: what the dashboard says a box is configured with is not
        // something the agent inside it gets to rewrite.
        `${spec.agentConfigSource}:${AGENT_CONFIG_DIR}:ro`,
      ],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,size=512m,mode=1777' },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: memoryBytes(cfg.SESSION_MEM_LIMIT),
      NanoCpus: Math.round(cfg.SESSION_CPUS * 1e9),
      PidsLimit: cfg.SESSION_PIDS_LIMIT,
      RestartPolicy: { Name: 'no' },
      // The kernel discards default-disposition signals for PID 1, so the
      // entrypoint's sleep never sees SIGTERM. docker-init forwards the signal
      // and reaps, which keeps stops prompt.
      Init: true,
      // Stated explicitly so a later edit cannot loosen them by omission.
      Privileged: false,
      PublishAllPorts: false,
    },
  });
  return container.id;
}

/** Starts a container, tolerating one that already runs. */
export async function startContainer(containerId: string): Promise<void> {
  try {
    await docker().getContainer(containerId).start();
  } catch (err) {
    // 304 means the container is already started.
    if ((err as { statusCode?: number }).statusCode !== 304) throw err;
  }
}

/** Stops a container with a 10 second grace period, tolerating one already gone. */
export async function stopContainer(containerId: string): Promise<void> {
  try {
    await docker().getContainer(containerId).stop({ t: 10 });
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode;
    if (code !== 304 && code !== 404) throw err;
  }
}

/** Removes a container and keeps its volumes. */
export async function removeContainer(containerId: string): Promise<void> {
  try {
    await docker().getContainer(containerId).remove({ force: true, v: false });
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }
}

/** Removes a session network, detaching the egress proxy first. */
export async function removeNetwork(networkName: string, cfg: Config): Promise<void> {
  const net = docker().getNetwork(networkName);
  // Disconnect the proxy first, else Docker refuses to remove the network.
  try {
    await net.disconnect({ Container: cfg.EGRESS_PROXY_CONTAINER, Force: true });
  } catch {
    // Not attached, or already gone.
  }
  try {
    await net.remove();
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }
}

/** Removes a volume, tolerating one that is already gone. */
export async function removeVolume(name: string): Promise<void> {
  try {
    await docker().getVolume(name).remove();
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }
}

/** Resolves a container's live state, mapping every lookup failure onto a state. */
export async function containerState(containerId: string | null): Promise<DockerState> {
  if (!containerId) return 'missing';
  try {
    const info = await docker().getContainer(containerId).inspect();
    if (info.State?.Running) return 'running';
    return 'exited';
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return 'missing';
    return 'unknown';
  }
}

/** One process inside a container, as `docker top` reports it. */
export interface ContainerProcess {
  /**
   * The pid, in whichever namespace it was read.
   *
   * `docker top` runs `ps` on the *host*, so what it reports is the host's
   * pid for a process and not the one the container knows it by. Good enough
   * to walk the tree, which is all the reading needs; not something to hand a
   * `kill` inside the box. See `containerProcessesFromInside`.
   */
  pid: number;
  ppid: number;
  /** The whole command line, which is how a process is recognised. */
  command: string;
  /** How long it has been running, or null where `ps` would not say. */
  elapsedSeconds: number | null;
}

/**
 * The `ps` format the reading wants, and the one every `ps` has.
 *
 * `etimes` is procps' own — an age in whole seconds, which is what turns a
 * list of what is running into a list of what has been running for an hour.
 * A host whose `ps` does not know it fails the whole call, and a failed
 * reading holds every box on that host awake; so the answer is remembered on
 * the first refusal and the plain format used from then on.
 */
const PS_FORMATS = ['-eo pid,ppid,etimes,args', '-eo pid,ppid,args'] as const;
let psFormat: (typeof PS_FORMATS)[number] | null = null;

/** Test seam: forget which `ps` format this host was found to take. */
export function resetPsFormatForTests(): void {
  psFormat = null;
}

/** What the daemon answers a `top` with: whatever titles `ps` printed, and rows. */
interface ProcessListing {
  Titles?: string[];
  Processes?: string[][];
}

/** One `docker top`, in a format known to work here. */
async function top(containerId: string): Promise<ProcessListing> {
  const container = docker().getContainer(containerId);
  const ask = async (ps_args: string): Promise<ProcessListing> =>
    (await container.top({ ps_args })) as ProcessListing;

  if (psFormat) return ask(psFormat);
  try {
    const rich = await ask(PS_FORMATS[0]);
    psFormat = PS_FORMATS[0];
    return rich;
  } catch (err) {
    // Only the format is retried, and only once. A daemon that is down, or a
    // container that has gone, fails the plain call too and throws from there
    // — which is the "no answer" the caller has to keep treating as one.
    log.debug('docker top rejected the elapsed-time format; asking without it', {
      error: (err as Error).message,
    });
    const plain = await ask(PS_FORMATS[1]);
    psFormat = PS_FORMATS[1];
    return plain;
  }
}

/**
 * Every process running inside a container.
 *
 * `top` rather than an exec: it is one API call against the daemon, the `ps`
 * runs on the host, and a container with no `ps` of its own — or no shell —
 * answers just the same. An exec would also be a process, which is a poor
 * way to ask what processes there are.
 *
 * The columns are asked for by name and read back by name: `top` returns
 * whatever titles the host's `ps` printed, and the daemon splits each row on
 * whitespace with the command left whole at the end. A container that cannot
 * be reached throws, which the caller reads as "no answer" rather than as
 * "nothing running" — see `background.ts` for why that direction matters.
 */
export async function containerProcesses(containerId: string): Promise<ContainerProcess[]> {
  const listing = await top(containerId);

  const titles = listing.Titles ?? [];
  const pidAt = titles.indexOf('PID');
  const ppidAt = titles.indexOf('PPID');
  // Without both columns there is no tree to read, and guessing at positions
  // would invent one. The caller treats a throw as "no answer".
  if (pidAt === -1 || ppidAt === -1) {
    throw new Error(`docker top returned no PID/PPID columns: ${titles.join(',')}`);
  }
  // `etimes` prints under the same title as `etime` and is only ever asked
  // for as one of the two, so the title is enough to find it. Absent where
  // this host's `ps` would not take it.
  const elapsedAt = titles.indexOf('ELAPSED');
  // Whatever ps put last is the command; the daemon leaves its spaces alone.
  const commandAt = titles.length - 1;

  const processes: ContainerProcess[] = [];
  for (const row of listing.Processes ?? []) {
    const pid = Number(row[pidAt]);
    const ppid = Number(row[ppidAt]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const elapsed = elapsedAt === -1 ? NaN : Number(row[elapsedAt]);
    processes.push({
      pid,
      ppid,
      command: row[commandAt] ?? '',
      elapsedSeconds: Number.isFinite(elapsed) ? elapsed : null,
    });
  }
  return processes;
}

/**
 * The same reading, taken from inside the container.
 *
 * Only the stop needs this, and only because of the namespace: a pid from
 * `docker top` is the host's, and the box has its own numbering for the same
 * process. A `kill` has to be told the box's, so the tree is read again from
 * in there at the moment it is used — which is also the freshest it can be,
 * and a process that ended in between is simply not in it.
 *
 * `ps` is the session image's, which is why the image installs procps and
 * asserts it. A box without it throws, and a stop that cannot find its target
 * says so rather than killing something else.
 */
export async function containerProcessesFromInside(
  containerId: string,
): Promise<ContainerProcess[]> {
  const { output, exited } = await runExec(containerId, ['ps', '-eo', 'pid,ppid,args']);
  const text = await readAll(output);
  const code = await exited;
  if (code !== 0) throw new Error(`ps in the container exited ${code ?? 'unknown'}: ${text.trim()}`);

  const processes: ContainerProcess[] = [];
  for (const line of text.split('\n').slice(1)) {
    // Three fields, and the third keeps its spaces: `ps` pads the numbers on
    // the left, so what is wanted is the first two runs of digits and then
    // everything after them.
    const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!row) continue;
    processes.push({
      pid: Number(row[1]),
      ppid: Number(row[2]),
      command: row[3] ?? '',
      elapsedSeconds: null,
    });
  }
  return processes;
}

/**
 * Signals processes inside a container, as the agent user.
 *
 * The pids must be the container's own, and are only ever ones this read out
 * of it a moment earlier. They travel as separate arguments to `kill`, never
 * as a string a shell has to take apart. A pid that has already gone makes
 * `kill` complain and exit non-zero, which is not a failure worth reporting:
 * the point was for it to be gone.
 */
export async function killInContainer(
  containerId: string,
  signal: 'TERM' | 'KILL',
  pids: readonly number[],
): Promise<void> {
  if (pids.length === 0) return;
  const { output, exited } = await runExec(containerId, [
    'kill',
    `-${signal}`,
    ...pids.map((pid) => String(pid)),
  ]);
  const text = await readAll(output);
  const code = await exited;
  if (code !== 0) {
    log.debug('kill in container reported trouble', { signal, pids, code, error: text.trim() });
  }
}

/** Everything a stream will produce, as one string. */
async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** One short exec with its output demuxed into a single stream. */
async function runExec(
  containerId: string,
  cmd: string[],
): Promise<{ output: Readable; exited: Promise<number | null> }> {
  const exec = await docker().getContainer(containerId).exec({
    Cmd: cmd,
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: sessionUser(),
  });
  const stream = (await exec.start({ hijack: true, stdin: false })) as Duplex;
  const output = new PassThrough();
  docker().modem.demuxStream(stream, output, output);
  const { exited } = execCompletion(stream, exec, () => output.end());
  return { output, exited };
}

/**
 * Whether a container has a mount at `destination`.
 *
 * A container's mounts are fixed when it is created, so this is how a session
 * from before a mount existed is recognised and recreated with it. A container
 * that cannot be inspected answers true: a missing one has nothing to fix, and
 * recreating on a transient inspect failure would be the more destructive
 * mistake.
 */
export async function hasMount(containerId: string, destination: string): Promise<boolean> {
  try {
    const info = await docker().getContainer(containerId).inspect();
    return (info.Mounts ?? []).some((m) => m.Destination === destination);
  } catch {
    return true;
  }
}

/** Every labelled session container Docker knows about, for boot reconciliation. */
export async function listSessionContainers(): Promise<
  Array<{ id: string; sessionId: string; running: boolean }>
> {
  const containers = await docker().listContainers({
    all: true,
    filters: { label: [LABEL] },
  });
  return containers.flatMap((c) => {
    const sessionId = c.Labels?.[LABEL];
    if (!sessionId) return [];
    return [{ id: c.Id, sessionId, running: c.State === 'running' }];
  });
}

/**
 * A demuxed, long-lived exec carrying the ACP adapter's stdio.
 *
 * Tty is false, so Docker frames stdout and stderr into a single stream that
 * has to be demuxed. stdout carries newline-delimited JSON-RPC and nothing
 * else; the adapter sends all its logging to stderr.
 */
export interface AdapterExec {
  /** Newline-delimited JSON-RPC from the adapter. */
  stdout: Readable;
  /** Log-only. */
  stderr: Readable;
  /** Write newline-delimited JSON-RPC to the adapter. */
  stdin: Duplex;
  /** Resolves when the exec's stream ends, with the exit code if known. */
  exited: Promise<number | null>;
  kill(): void;
}

/**
 * Wires up the end of an exec: one promise for its exit code, and a kill.
 *
 * A hijacked stream reports its end as both `end` and `close`, so the settle
 * runs at most once — otherwise every exec would inspect itself twice for an
 * answer the promise has already taken. `onEnd` closes whatever the caller
 * demuxed into, before the exit code is read.
 */
function execCompletion(
  stream: Duplex,
  exec: { inspect: () => Promise<{ ExitCode?: number | null }> },
  onEnd: () => void,
  onError?: (err: Error) => void,
): { exited: Promise<number | null>; kill: () => void } {
  let settle: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    settle = resolve;
  });

  let finished = false;
  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    onEnd();
    try {
      settle((await exec.inspect()).ExitCode ?? null);
    } catch {
      settle(null);
    }
  };

  stream.on('end', () => void finish());
  stream.on('close', () => void finish());
  stream.on('error', (err: Error) => {
    onError?.(err);
    void finish();
  });

  return {
    exited,
    kill: () => {
      try {
        stream.destroy();
      } catch {
        // already gone
      }
    },
  };
}

/** Starts the adapter inside a running container and demuxes its streams. */
export async function spawnAdapterExec(
  containerId: string,
  cmd: string[],
  workingDir: string,
): Promise<AdapterExec> {
  const exec = await docker().getContainer(containerId).exec({
    Cmd: cmd,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: sessionUser(),
    WorkingDir: workingDir,
  });

  const stream = (await exec.start({ hijack: true, stdin: true })) as Duplex;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker().modem.demuxStream(stream, stdout, stderr);

  const { exited, kill } = execCompletion(
    stream,
    exec,
    () => {
      stdout.end();
      stderr.end();
    },
    (err) => log.warn('adapter exec stream error', { error: err.message }),
  );

  return { stdout, stderr, stdin: stream, exited, kill };
}

/** A one-off exec whose combined output is streamed back. */
export interface CommandExec {
  /** stdout and stderr, demuxed and merged in arrival order. */
  output: Readable;
  /** Resolves with the exit code once the stream ends, or null if unknown. */
  exited: Promise<number | null>;
  kill(): void;
}

/**
 * Runs one command in a session container as the agent user.
 *
 * The command travels as an argument to `bash -lc`, never as part of a
 * command line the host assembles, and it runs inside the container's
 * existing isolation: internal network, read-only rootfs, capabilities
 * dropped. No new privilege is introduced by running it.
 */
export async function runCommandExec(
  containerId: string,
  command: string,
  workingDir: string,
): Promise<CommandExec> {
  const exec = await docker().getContainer(containerId).exec({
    Cmd: ['bash', '-lc', command],
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: sessionUser(),
    WorkingDir: workingDir,
  });

  const stream = (await exec.start({ hijack: true, stdin: false })) as Duplex;
  // One stream for the caller: a shell's stderr is part of its output, and
  // splitting them would lose the order they were written in.
  const output = new PassThrough();
  docker().modem.demuxStream(stream, output, output);

  const { exited, kill } = execCompletion(stream, exec, () => output.end());
  return { output, exited, kill };
}
