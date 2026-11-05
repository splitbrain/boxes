/**
 * The configuration of the orchestrator, read from the process environment.
 *
 * Every setting has a working default, so the orchestrator starts with no
 * configuration at all.
 */

import { z } from 'zod';
import type { CredentialId } from '../../shared/types.ts';
import { DEFAULT_BOX_GID, DEFAULT_BOX_UID } from './workspaces.ts';

/** A positive whole number of minutes. */
const durationMinutes = z.coerce.number().int().positive();

/** A bare hostname with two or more labels, without a scheme, a port or a path. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * An on or off setting, with the usual words for true and false.
 *
 * An unrecognised value fails at boot with the rest of the configuration.
 */
const flag = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
  .transform((value) => ['true', '1', 'yes', 'on'].includes(value));

/** Every setting the orchestrator reads from its environment, with its default. */
const schema = z.object({
  /**
   * The runtime of the boxes, which is the Docker daemon of this host or the
   * Kubernetes cluster of the orchestrator. The doc of a setting that only one
   * runtime reads tells so.
   */
  RUNTIME: z.enum(['docker', 'kubernetes']).default('docker'),
  /** The directory of the database and of the files of each box. */
  DATA_DIR: z.string().min(1).default('/data'),
  /**
   * The path of DATA_DIR on the host. Bind sources name this path, because the
   * Docker daemon resolves them.
   *
   * Empty is the normal case. Then at boot, the orchestrator inspects its own
   * container and takes the `Source` of the mount at DATA_DIR. With the shipped
   * compose file, that is `/var/lib/docker/volumes/boxes_boxes-data/_data`.
   * Set this value where that cannot work, for example for a nested or
   * rootless daemon, or for a compose file that mounts a host directory for /data.
   *
   * Docker only.
   */
  HOST_DATA_DIR: z.string().default(''),
  /** The port of the HTTP server. */
  PORT: z.coerce.number().int().positive().default(3000),
  /**
   * The lowest severity that goes to stderr. `debug` logs every forwarded ACP
   * message, which is a lot of output for a busy deployment.
   */
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /**
   * The HTTP header that holds the username, for example `Remote-User`. The
   * reverse proxy in front of the orchestrator authenticates the user and sets
   * the header. Empty is single user mode, in which the orchestrator ignores
   * every header and each request has the empty user.
   *
   * The header is safe only when each request goes through the reverse proxy,
   * and when each route of the reverse proxy replaces the header of the client.
   */
  AUTH_USER_HEADER: z
    .string()
    .regex(/^[A-Za-z0-9-]+$/, { message: 'must be an HTTP header name such as Remote-User' })
    .transform((value) => value.toLowerCase())
    .default(''),

  /** The image of each box container. */
  BOX_IMAGE: z.string().min(1).default('ghcr.io/splitbrain/boxes/box:latest'),
  /**
   * The uid of the box containers, which is also the owner of each file in a
   * workspace.
   *
   * When the orchestrator runs as this uid, it needs no root to give files to
   * the agent.
   */
  BOX_UID: z.coerce.number().int().positive().default(DEFAULT_BOX_UID),
  /** The gid of the box containers, like BOX_UID. */
  BOX_GID: z.coerce.number().int().positive().default(DEFAULT_BOX_GID),
  /**
   * The time between two pulls of the box image, in minutes, so a moving tag
   * such as `:latest` stays current. A box gets the new image at its next
   * start.
   *
   * 0 turns the refresh off, for an image built on the host that no registry
   * holds. The image is still pulled once when it is missing, because a box
   * cannot be created without it.
   *
   * Docker only. On Kubernetes, BOX_IMAGE_PULL_POLICY decides.
   */
  BOX_IMAGE_PULL_MINUTES: z.coerce.number().int().nonnegative().default(60),
  /**
   * True to remove from this host each copy of the box image that a pull
   * replaced.
   *
   * On by default, because each untagged image takes disk space. The
   * candidates are the image that the last pull replaced and every untagged
   * image with the label of the box image. The daemon refuses to remove an
   * image that a container was created from.
   *
   * Off is for a host that keeps old images on purpose, for example for a
   * rollback without the registry, or for programs outside Boxes that run them.
   *
   * Docker only. On Kubernetes, the kubelet removes unused images.
   */
  BOX_IMAGE_PRUNE: flag.default(true),
  /** The address range for the /24 network of each box. Docker only. */
  BOX_SUBNET_POOL: z
    .string()
    .regex(/^\d+\.\d+\.\d+\.\d+\/\d+$/)
    .default('10.200.0.0/16'),
  /**
   * The memory limit of one box container, for example `4g`.
   *
   * The limit applies to all adapters in the box. Each harness with a thread
   * runs its own adapter process, with its own agent below it. When a box
   * reaches the limit, the kernel kills a process in it.
   */
  BOX_MEM_LIMIT: z
    .string()
    .regex(/^\d+[kmgKMG]?$/)
    .default('4g'),
  /** The CPU limit of one box container. */
  BOX_CPUS: z.coerce.number().positive().default(2),
  /**
   * The process limit of one box container. When a box reaches the limit, a
   * tool call fails because it cannot fork.
   *
   * Docker only. On Kubernetes, the kubelet setting `podPidsLimit` limits the
   * processes of each pod on a node.
   */
  BOX_PIDS_LIMIT: z.coerce.number().int().positive().default(512),
  /**
   * The memory that the scheduler reserves for one box pod, in the format of
   * BOX_MEM_LIMIT. Kubernetes only.
   *
   * Less than the limit, because most boxes are idle most of the time. A box
   * that uses more than this can be evicted when its node runs out of memory.
   */
  BOX_MEM_REQUEST: z
    .string()
    .regex(/^\d+[kmgKMG]?$/)
    .default('1g'),
  /** The CPUs that the scheduler reserves for one box pod. Kubernetes only. */
  BOX_CPU_REQUEST: z.coerce.number().positive().default(0.5),
  /**
   * The size of the volume claim of one box, which holds its workspace, its
   * home and its Nix store, in the format of BOX_MEM_LIMIT. Kubernetes only.
   */
  BOX_STORAGE_SIZE: z
    .string()
    .regex(/^\d+[kmgKMG]?$/)
    .default('20g'),
  /**
   * The pull policy of the kubelet for the box image of a box pod. Kubernetes
   * only.
   *
   * `Always` resolves the tag at each start, so a box gets a new image at its
   * next start. `IfNotPresent` is for an image that is loaded into
   * the cluster and is in no registry.
   */
  BOX_IMAGE_PULL_POLICY: z.enum(['Always', 'IfNotPresent', 'Never']).default('Always'),

  /** The minutes without activity after which the reaper stops a box. */
  IDLE_STOP_MINUTES: durationMinutes.default(30),

  /**
   * The time in seconds for which a process reading of a box stays valid.
   *
   * Each new reading runs `ps` in the box. With a longer time, the browser
   * shows a finished build as running for longer.
   */
  BACKGROUND_POLL_SECONDS: z.coerce.number().int().positive().default(20),

  /**
   * The silence in seconds after which the agent of a thread counts as stopped.
   *
   * `claude-agent-acp` ends each processing cycle with a `usage_update` that
   * has a cost, and that marker decides before this timer does. `codex-acp`
   * sends no such update, so every Codex thread depends on this timer. While a
   * tool call that the agent waits on is open, the thread counts as working,
   * however long the silence is.
   */
  AGENT_QUIET_SECONDS: z.coerce.number().int().positive().default(3),

  /**
   * The silence in seconds after which a push notification tells that the turn
   * of a thread is finished. The time starts at the last message of the agent,
   * so it includes AGENT_QUIET_SECONDS.
   *
   * Longer than the quiet threshold, because a screen can correct itself a
   * moment later and a push notification cannot.
   */
  AGENT_SETTLE_SECONDS: z.coerce.number().int().positive().default(30),

  /**
   * The maximum size of one attachment, in mebibytes.
   *
   * The orchestrator holds the upload in memory before it writes the file.
   */
  MAX_ATTACHMENT_MB: z.coerce.number().int().positive().default(25),

  /**
   * The action for a permission request without an answer after
   * PERMISSION_HOLD_MINUTES. `hold` continues to wait, and `deny` selects the
   * reject option of the request.
   */
  PERMISSION_FALLBACK: z.enum(['hold', 'deny']).default('hold'),
  /**
   * The minutes that a permission request waits for an answer before
   * PERMISSION_FALLBACK applies.
   */
  PERMISSION_HOLD_MINUTES: durationMinutes.default(120),

  /**
   * The contact of the operator of this deployment, for the VAPID assertion of
   * each Web Push. A push service with a problem contacts this address. RFC 8292
   * allows a mailto: or an https: URL.
   */
  PUSH_SUBJECT: z
    .string()
    .refine((v) => v.startsWith('mailto:') || v.startsWith('https://'), {
      message: 'must be a mailto: or https: URL',
    })
    .default('https://github.com/splitbrain/boxes'),

  /** The container name of the egress proxy that the orchestrator attaches. Docker only. */
  EGRESS_PROXY_CONTAINER: z.string().min(1).default('boxes-egress-proxy'),
  /** The name of the egress proxy on each box network. Docker only. */
  EGRESS_PROXY_ALIAS: z.string().min(1).default('proxy'),
  /** The port of the egress proxy for the boxes. */
  EGRESS_PROXY_PORT: z.coerce.number().int().positive().default(3128),
  /**
   * The name of the Service of the egress proxy, in the namespace of the
   * orchestrator. Boxes reach the proxy at its cluster IP, and the isolation
   * of a box allows the pods that the Service selects. Kubernetes only.
   */
  EGRESS_PROXY_SERVICE: z.string().min(1).default('boxes-egress-proxy'),
  /**
   * The URL of the control channel of the proxy, on the compose network or at
   * the proxy Service. Only the orchestrator connects to it.
   */
  EGRESS_CONTROL_URL: z.url({ protocol: /^http$/ }).default('http://boxes-egress-proxy:3129'),

  /**
   * The GitLab host of the token on the settings page, as a bare hostname
   * without a scheme or a path.
   *
   * A self-managed instance can be on a private address, because the proxy
   * lets a host of a credential reach a private range.
   */
  GITLAB_HOST: z
    .string()
    .regex(HOSTNAME, { message: 'must be a bare hostname such as gitlab.example.com' })
    .default('gitlab.com'),
});

/** The parsed settings, plus the values derived from them. */
export type Config = Readonly<z.infer<typeof schema>> & {
  /**
   * Every credential that this deployment can translate, with its hosts and
   * headers. A box holds a placeholder for each entry with a stored secret,
   * and the proxy replaces the placeholder with the secret.
   */
  readonly credentialSet: readonly CredentialSpec[];
};

/**
 * One credential that the proxy can translate, with all data of the
 * deployment about it except the secret. The database stores the secret.
 */
export interface CredentialSpec {
  /** The id of the credential, which is the key of the row with its secret. */
  id: CredentialId;
  /** The hosts where the proxy puts in the credential. */
  hosts: readonly string[];
  /** The headers that can hold the credential, in lowercase. */
  headers: readonly string[];
  /**
   * The hosts that the tools of this credential must reach, but that never get
   * the credential. A box with a closed egress profile can reach them. The
   * proxy does not intercept these hosts.
   */
  alsoAllow: readonly string[];
  /**
   * The prefix of a generated placeholder, so a client that checks the format
   * of its token accepts the placeholder at startup.
   */
  placeholderPrefix: string;
}

/**
 * The credentials with fixed hosts. A deployment translates each credential
 * with a stored secret. The hosts of the other credentials stay normal
 * passthrough hosts.
 *
 * No setting changes these entries, because the hosts and the headers are
 * facts of the services.
 */
const FIXED_CREDENTIALS: readonly CredentialSpec[] = [
  {
    id: 'claude',
    hosts: ['api.anthropic.com'],
    headers: ['authorization', 'x-api-key'],
    // The token endpoints for the refresh of an OAuth credential. The proxy does
    // not intercept them, because the orchestrator sends the refresh itself.
    alsoAllow: ['console.anthropic.com', 'platform.claude.com', 'claude.ai'],
    placeholderPrefix: 'sk-ant-oat01-',
  },
  {
    id: 'openai',
    // Only the endpoint for API keys. `chatgpt.com` serves subscriptions, and each
    // endpoint refuses the credentials of the other. The proxy does not intercept
    // `chatgpt.com`, so a deployment key and a subscription can work in one box.
    hosts: ['api.openai.com'],
    headers: ['authorization'],
    // The login and refresh host of Codex, and the subscription endpoint. The
    // egress profile decides for `files.openai.com` and `ab.chatgpt.com`.
    alsoAllow: ['auth.openai.com', 'chatgpt.com'],
    placeholderPrefix: 'sk-',
  },
  {
    id: 'github',
    hosts: ['github.com', 'api.github.com', '*.githubusercontent.com'],
    // git sends the token as the password of HTTP Basic, and gh sends it
    // directly. Both use this header.
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
 * The proxy reads both headers, so it replaces the placeholder in each form.
 *
 * @param host The GitLab host.
 * @returns The credential spec.
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
 * The Dev Tunnels credential, which is a GitHub token from the Dev Tunnels
 * app. The share-app skill uses it to create tunnels.
 *
 * The pattern covers the global and regional control planes and the regional
 * relays. Only a control plane gets the GitHub token.
 */
const DEVTUNNELS_CREDENTIAL: CredentialSpec = {
  id: 'devtunnels',
  hosts: ['*.rel.tunnels.api.visualstudio.com'],
  headers: ['authorization'],
  alsoAllow: [],
  placeholderPrefix: 'ghu_',
};

/**
 * Gives every credential that this deployment can translate, in the order of the settings page.
 *
 * @param gitlabHost The GitLab host.
 * @returns The credential specs.
 */
function credentialSetFor(gitlabHost: string): readonly CredentialSpec[] {
  return [...FIXED_CREDENTIALS, gitlabCredential(gitlabHost), DEVTUNNELS_CREDENTIAL];
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
 *
 * @param env The environment.
 * @returns The environment without the empty entries.
 */
function withoutEmpty(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
}

/**
 * Parses an environment into a config.
 *
 * @param env The environment.
 * @returns The config.
 * @throws {Error} When a value is not valid. The message lists each problem.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(withoutEmpty(env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const base = parsed.data;
  return {
    ...base,
    credentialSet: credentialSetFor(base.GITLAB_HOST),
  };
}

/**
 * Gives the config of the process, and parses it on the first call.
 *
 * @returns The config.
 */
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/**
 * Installs a config for tests, without a change to process.env.
 *
 * @param c The config.
 */
export function setConfigForTests(c: Config): void {
  cached = c;
}
