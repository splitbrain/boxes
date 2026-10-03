import { z } from 'zod';
import type { CredentialId } from '../../shared/types.ts';
import { DEFAULT_BOX_GID, DEFAULT_BOX_UID } from './workspaces.ts';

/**
 * The orchestrator's configuration, read from the process environment.
 *
 * Every setting has a working default, so the orchestrator starts with no
 * configuration at all.
 */

/** A positive whole number of minutes. */
const durationMinutes = z.coerce.number().int().positive();

/** A bare hostname of two labels or more: no scheme, no port, no path. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * An on/off setting, spelled the way a person would write one.
 *
 * An unrecognised value fails at boot with the rest of the configuration.
 */
const flag = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
  .transform((value) => ['true', '1', 'yes', 'on'].includes(value));

/** Every setting the orchestrator reads from its environment, with its default. */
const schema = z.object({
  /** Where the orchestrator keeps its database and every box's files. */
  DATA_DIR: z.string().min(1).default('/data'),
  /**
   * Host-side path of DATA_DIR. Bind sources name this path, because the
   * Docker daemon resolves them.
   *
   * Empty is the normal case: at boot the orchestrator inspects its own
   * container and takes the `Source` of the mount at DATA_DIR. With the
   * shipped compose that is `/var/lib/docker/volumes/boxes_boxes-data/_data`.
   * Set this where that cannot work: a nested or rootless daemon, or a
   * compose file that mounts a real host directory for /data.
   */
  HOST_DATA_DIR: z.string().default(''),
  /** Port the HTTP server listens on. */
  PORT: z.coerce.number().int().positive().default(3000),
  /**
   * Lowest severity written to stderr. `debug` logs every forwarded ACP
   * message, which is a lot of output for a busy deployment.
   */
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /** Image every box container is created from. */
  BOX_IMAGE: z.string().min(1).default('ghcr.io/splitbrain/boxes/box:latest'),
  /**
   * uid box containers run as, and so the owner of every file in a
   * workspace.
   *
   * The box image has to agree. It builds its `agent` user on the same
   * numbers through the AGENT_UID and AGENT_GID build args. A new box's home
   * is a directory that seedHomeFromImage() fills from the image with
   * `cp -a`, so the files in it keep the owner the image gave them.
   * ensureBoxImage() reads the image's user and logs a warning when the two
   * differ.
   *
   * When this is the uid the orchestrator runs as, the orchestrator needs no
   * root to hand files to the agent.
   */
  BOX_UID: z.coerce.number().int().positive().default(DEFAULT_BOX_UID),
  /** gid box containers run as, on the same terms as BOX_UID. */
  BOX_GID: z.coerce.number().int().positive().default(DEFAULT_BOX_GID),
  /**
   * How often the box image is pulled again, in minutes, so a moving tag such
   * as `:latest` keeps moving. A box moves onto the new image at its next
   * start.
   *
   * 0 turns the refresh off, for an image built on the host that no registry
   * holds. The image is still pulled once when it is missing, because a box
   * cannot be created without it.
   */
  BOX_IMAGE_PULL_MINUTES: z.coerce.number().int().nonnegative().default(60),
  /**
   * Whether a copy of the box image that a pull has superseded is removed
   * from this host.
   *
   * On by default, because each untagged image left behind costs a gigabyte
   * or two. The candidates are the image the last pull replaced and every
   * untagged image with the box image's label. The daemon refuses to remove
   * an image that a container was created from.
   *
   * Off is for a host that keeps old images on purpose: to roll back without
   * the registry, or because something outside Boxes runs them.
   */
  BOX_IMAGE_PRUNE: flag.default(true),
  /** Address range each box's own /24 network is taken from. */
  BOX_SUBNET_POOL: z.string().regex(/^\d+\.\d+\.\d+\.\d+\/\d+$/).default('10.200.0.0/16'),
  /**
   * Memory one box container may use, such as `4g`.
   *
   * The limit covers every adapter in the box. Each harness that has a
   * thread runs its own adapter process with its own agent under it. The
   * defaults are not measured against two busy agents in one box. When a box
   * reaches the limit, the kernel kills a process in it.
   */
  BOX_MEM_LIMIT: z.string().regex(/^\d+[kmgKMG]?$/).default('4g'),
  /** CPUs one box container may use. */
  BOX_CPUS: z.coerce.number().positive().default(2),
  /**
   * Processes one box container may run. When a box reaches the limit, a tool
   * call fails because it cannot fork.
   */
  BOX_PIDS_LIMIT: z.coerce.number().int().positive().default(512),

  /** How many minutes a box may go without activity before the reaper stops it. */
  IDLE_STOP_MINUTES: durationMinutes.default(30),

  /**
   * How long a reading of what is running in a box stays valid, in seconds.
   *
   * Each new reading costs one Docker API call. A longer window lets a
   * finished build show as running for longer in the browser.
   */
  BACKGROUND_POLL_SECONDS: z.coerce.number().int().positive().default(20),

  /**
   * How long a thread has to be silent before the agent counts as stopped,
   * in seconds.
   *
   * `claude-agent-acp` ends each processing cycle with a `usage_update` that
   * carries a cost, and that marker decides before this timer does.
   * `codex-acp` sends no such update, so every Codex thread depends on this
   * timer. While a tool call the agent waits on is open, the thread counts as
   * working however long it is silent.
   */
  AGENT_QUIET_SECONDS: z.coerce.number().int().positive().default(3),

  /**
   * How long a thread has to stay silent before a push notification says its
   * turn has finished, in seconds. Measured from the last thing the agent
   * said, so it includes AGENT_QUIET_SECONDS.
   *
   * Longer than the quiet threshold, because a screen can correct itself a
   * moment later and a push notification cannot.
   */
  AGENT_SETTLE_SECONDS: z.coerce.number().int().positive().default(30),

  /**
   * Largest single attachment a prompt may carry into a workspace, in
   * mebibytes.
   *
   * It limits one upload, which the orchestrator holds in memory before it
   * writes the file.
   */
  MAX_ATTACHMENT_MB: z.coerce.number().int().positive().default(25),

  /**
   * What happens to a permission request nobody answered within
   * PERMISSION_HOLD_MINUTES: `hold` keeps waiting, `deny` picks the request's
   * own reject option.
   */
  PERMISSION_FALLBACK: z.enum(['hold', 'deny']).default('hold'),
  /**
   * How long a permission request waits for an answer before
   * PERMISSION_FALLBACK applies.
   */
  PERMISSION_HOLD_MINUTES: durationMinutes.default(120),

  /**
   * Who operates this deployment, for the VAPID assertion every Web Push
   * carries. A push service with a problem contacts this address. RFC 8292
   * allows a mailto: or an https: URL.
   */
  PUSH_SUBJECT: z
    .string()
    .refine((v) => v.startsWith('mailto:') || v.startsWith('https://'), {
      message: 'must be a mailto: or https: URL',
    })
    .default('https://github.com/splitbrain/boxes'),

  /** Container name of the egress proxy the orchestrator attaches. */
  EGRESS_PROXY_CONTAINER: z.string().min(1).default('boxes-egress-proxy'),
  /** Name the egress proxy answers to on every box network. */
  EGRESS_PROXY_ALIAS: z.string().min(1).default('proxy'),
  /** Port boxes reach the egress proxy on. */
  EGRESS_PROXY_PORT: z.coerce.number().int().positive().default(3128),
  /**
   * Port of the proxy's control channel on the compose network. Only the
   * orchestrator connects to it.
   */
  EGRESS_CONTROL_PORT: z.coerce.number().int().positive().default(3129),

  /**
   * Hosts boxes may reach, comma or whitespace separated. Exact names and
   * one-label wildcards: `github.com, *.githubusercontent.com`. Empty is off,
   * which leaves every public host reachable.
   */
  EGRESS_ALLOWED_HOSTS: z.string().default(''),

  /**
   * The GitLab the settings page's token is for, as a bare hostname with no
   * scheme and no path. `gitlab.com` unless a deployment runs its own.
   *
   * A self-managed instance has to be on a public address, because the proxy
   * refuses private ranges whatever the credential set says.
   */
  GITLAB_HOST: z
    .string()
    .regex(HOSTNAME, { message: 'must be a bare hostname such as gitlab.example.com' })
    .default('gitlab.com'),

  /**
   * Where a box runs: a Docker container on this host, or a pod in a
   * Kubernetes cluster.
   *
   * Every setting below this one is read only when it is `kubernetes` — a
   * Docker deployment carries none of it, the same way EGRESS_PROXY_PORT
   * carries no meaning for a deployment with the allowlist off.
   */
  RUNTIME: z.enum(['docker', 'kubernetes']).default('docker'),

  /** Namespace a box's pod, PVCs and NetworkPolicy are created in. */
  K8S_NAMESPACE: z.string().min(1).default('boxes-sessions'),
  /**
   * Path of the kubeconfig the cluster is reached through. Empty is the
   * client library's own default: in-cluster credentials when the
   * orchestrator is itself a pod, `~/.kube/config` otherwise.
   */
  K8S_KUBECONFIG: z.string().default(''),
  /** Whether the orchestrator is itself a pod in the cluster it manages. */
  K8S_IN_CLUSTER: flag.default(false),
  /** StorageClass a box's PVCs are provisioned with. Empty is the cluster's own default. */
  K8S_STORAGE_CLASS: z.string().default(''),
  /**
   * Size of the one PVC a box's workspace, home and Nix store share, each in
   * its own subPath.
   *
   * Kubernetes has no equivalent of a bind mount's unbounded host directory —
   * a PersistentVolumeClaim states a size up front — so this is a limit
   * Docker deployments have never had to set. One claim rather than three
   * because a block storage provider caps how many volumes a node attaches:
   * Hetzner's 16 would otherwise stop at five running boxes per node.
   */
  K8S_VOLUME_SIZE: z.string().regex(/^\d+[EPTGMK]i?$/).default('35Gi'),
  K8S_IMAGE_PULL_POLICY: z.enum(['Always', 'IfNotPresent', 'Never']).default('IfNotPresent'),
  /** A pre-existing imagePullSecret's name, for a box image on a private registry. */
  K8S_IMAGE_PULL_SECRET: z.string().default(''),
  /** Name of the ClusterIP service the egress proxy is reachable at. */
  K8S_EGRESS_PROXY_SERVICE: z.string().min(1).default('boxes-egress-proxy'),
});

/** The parsed settings, plus the values derived from them. */
export type Config = Readonly<z.infer<typeof schema>> & {
  /** The parsed allowlist. Empty means the allowlist is off. */
  readonly egressAllowedHosts: readonly string[];
  /**
   * Every credential this deployment can translate, and where each one
   * travels. A box holds a placeholder for each entry; the proxy swaps in the
   * ones the store holds a secret for.
   */
  readonly credentialSet: readonly CredentialSpec[];
};

/**
 * One credential the proxy can translate, and everything the deployment knows
 * about it except the secret. The secret is stored in the database.
 */
export interface CredentialSpec {
  /** Which stored credential this is: the key of the row that holds its secret. */
  id: CredentialId;
  /** Hosts intercepted so the credential can be swapped in. */
  hosts: readonly string[];
  /** Headers the credential may travel in, lowercased. */
  headers: readonly string[];
  /**
   * Hosts this credential's tools need reachable but never send it to, so a
   * narrow allowlist cannot break them. Not intercepted.
   */
  alsoAllow: readonly string[];
  /**
   * Prefix a generated placeholder carries, so that a client checking the
   * shape of its token accepts it and fails at the API rather than at startup.
   */
  placeholderPrefix: string;
  /**
   * Authorization schemes under which the hosts accept tokens they issued
   * themselves. The proxy lets values under these schemes through unchanged.
   * Absent means none.
   */
  passthroughSchemes?: readonly string[];
}

/**
 * The credentials whose hosts are fixed. A deployment translates the ones the
 * credential store holds a secret for; the rest stay ordinary passthrough
 * hosts.
 *
 * No setting changes these entries, because the hosts and headers are facts
 * about the services.
 */
const FIXED_CREDENTIALS: readonly CredentialSpec[] = [
  {
    id: 'claude',
    hosts: ['api.anthropic.com'],
    headers: ['authorization', 'x-api-key'],
    // The token endpoints an OAuth credential is refreshed at. Not
    // intercepted: the orchestrator sends the refresh with its own credential.
    alsoAllow: ['console.anthropic.com', 'platform.claude.com', 'claude.ai'],
    placeholderPrefix: 'sk-ant-oat01-',
  },
  {
    id: 'openai',
    // The API-key endpoint only. `chatgpt.com` serves subscriptions, and the
    // two reject each other's credentials. Leaving it unintercepted lets a
    // deployment key and a person's subscription coexist in one box.
    hosts: ['api.openai.com'],
    headers: ['authorization'],
    // Where Codex logs in and refreshes, and the subscription endpoint.
    // `files.openai.com` and `ab.chatgpt.com` are left to the allowlist.
    alsoAllow: ['auth.openai.com', 'chatgpt.com'],
    placeholderPrefix: 'sk-',
  },
  {
    id: 'github',
    hosts: ['github.com', 'api.github.com', '*.githubusercontent.com'],
    // git sends the token as the password of an HTTP Basic pair and gh sends
    // it directly; both arrive in this one header.
    headers: ['authorization'],
    alsoAllow: ['codeload.github.com'],
    placeholderPrefix: 'ghp_',
  },
];

/**
 * The GitLab credential, on the host GITLAB_HOST names.
 *
 * git sends the token as the password of an HTTP Basic pair. glab sends a
 * personal access token in PRIVATE-TOKEN and an OAuth token as a bearer.
 * The proxy reads both headers, so it swaps or refuses every form.
 */
function gitlabCredential(host: string): CredentialSpec {
  return {
    id: 'gitlab',
    hosts: [host],
    headers: ['authorization', 'private-token'],
    alsoAllow: [],
    placeholderPrefix: 'glpat-',
  };
}

/**
 * The Dev Tunnels credential: a GitHub token from the Dev Tunnels app, which
 * the share-app skill creates tunnels with.
 *
 * The pattern covers the global and regional control planes and the regional
 * relays. Only a control plane gets the GitHub token. While a tunnel is
 * hosted, the CLI sends a control plane and a relay a token the service
 * issued for that tunnel, under the `tunnel` scheme, which passes unchanged.
 */
const DEVTUNNELS_CREDENTIAL: CredentialSpec = {
  id: 'devtunnels',
  hosts: ['*.rel.tunnels.api.visualstudio.com'],
  headers: ['authorization'],
  alsoAllow: [],
  placeholderPrefix: 'ghu_',
  passthroughSchemes: ['tunnel'],
};

/** Every credential this deployment can translate, in settings-page order. */
function credentialSetFor(gitlabHost: string): readonly CredentialSpec[] {
  return [...FIXED_CREDENTIALS, gitlabCredential(gitlabHost), DEVTUNNELS_CREDENTIAL];
}

/** Splits a comma or whitespace separated host list into patterns. */
function parseHostList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h !== ''),
    ),
  ];
}

/** The config parsed at first use, or null before then. */
let cached: Config | null = null;

/**
 * Drops the empty entries of an environment, so an empty value reads as a
 * setting nobody provided.
 *
 * `FOO=` in an .env file, and a compose pass-through for a variable the host
 * does not set, both arrive as an empty string, which would fail the regex
 * and enum fields at boot.
 */
function withoutEmpty(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
}

/** Parses an environment into a config, throwing on any invalid value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(withoutEmpty(env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const base = parsed.data;
  const allowedHosts = parseHostList(base.EGRESS_ALLOWED_HOSTS);
  for (const pattern of allowedHosts) {
    if (pattern === '*') {
      throw new Error(
        'Invalid configuration:\n  EGRESS_ALLOWED_HOSTS: a bare * would allow every host; ' +
          'leave the setting empty to turn the allowlist off',
      );
    }
    if (pattern.includes('*') && !pattern.startsWith('*.')) {
      throw new Error(
        `Invalid configuration:\n  EGRESS_ALLOWED_HOSTS: ${pattern} may only use a leading *. wildcard`,
      );
    }
  }

  return {
    ...base,
    egressAllowedHosts: allowedHosts,
    credentialSet: credentialSetFor(base.GITLAB_HOST),
  };
}

/** The process-wide config, parsed on first call. */
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test seam: install a config without touching process.env. */
export function setConfigForTests(c: Config): void {
  cached = c;
}
