import { z } from 'zod';
import { resolveWsAuthToken } from './secret.ts';
import { DEFAULT_SESSION_GID, DEFAULT_SESSION_UID } from './workspaces.ts';

/**
 * Environment parsing. Every setting the orchestrator reads comes from the
 * process env and is parsed once at boot, so a misconfigured deployment fails
 * at startup.
 *
 * Every setting has a working default, so the orchestrator starts with no
 * configuration at all.
 */

const durationMinutes = z.coerce.number().int().positive();

/**
 * An on/off setting, spelled the way a person would write one.
 *
 * Not `z.coerce.boolean()`, which reads any non-empty string as true and so
 * turns `SETTING=false` into on — the one mistake a boolean environment
 * variable exists to make. An unrecognised value fails at boot with the rest
 * of the configuration, rather than quietly meaning whichever of the two is
 * worse.
 */
const flag = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
  .transform((value) => ['true', '1', 'yes', 'on'].includes(value));

const schema = z.object({
  DATA_DIR: z.string().min(1).default('/data'),
  /**
   * Host-side path of DATA_DIR, which is what a session's workspace bind has
   * to name — the daemon resolves bind sources, not this process.
   *
   * Empty is the normal case: at boot the orchestrator inspects its own
   * container and takes the `Source` of the mount at DATA_DIR, which with the
   * shipped compose is `/var/lib/docker/volumes/boxes-data/_data`. Set this
   * only where that cannot work — a nested or rootless daemon, or a compose
   * file that mounts a real host directory for /data.
   */
  HOST_DATA_DIR: z.string().default(''),
  PORT: z.coerce.number().int().positive().default(3000),

  SESSION_IMAGE: z.string().min(1).default('boxes-session:latest'),
  /**
   * uid and gid session containers run as, and so the owner of every file in
   * a workspace.
   *
   * The session image has to agree: it builds its `agent` user on these same
   * numbers through the AGENT_UID and AGENT_GID build args, and a session's
   * home is a named volume Docker ownership-initialises from the image, which
   * nothing outside the container can then chown. ensureSessionImage() reads
   * the image's own user back and says so when the two have drifted.
   *
   * Setting these to the uid the orchestrator itself runs as is what lets it
   * drop root: there is then nothing to give away. See workspaces.ts.
   */
  SESSION_UID: z.coerce.number().int().positive().default(DEFAULT_SESSION_UID),
  SESSION_GID: z.coerce.number().int().positive().default(DEFAULT_SESSION_GID),
  /**
   * How often the session image is pulled again, so that a moving tag such as
   * `:latest` actually moves. A session adopts what has arrived when it is
   * next started; nothing running is disturbed.
   *
   * 0 turns the refresh off, which is what an image built on the host wants —
   * there is no registry to pull it from, and trying every hour would only
   * fill the log. The image is still pulled once when it is missing
   * altogether, because a session cannot be created without it.
   */
  SESSION_IMAGE_PULL_MINUTES: z.coerce.number().int().nonnegative().default(60),
  /**
   * Whether a copy of the session image that a pull has superseded is removed
   * from this host.
   *
   * On, because the alternative is a gigabyte or two of it per release, kept
   * forever, that nothing else will ever reclaim: an untagged image is not
   * something a deployment goes looking for. Only images carrying the session
   * image's own label are touched, and only once no container is left running
   * on one — see docker.ts.
   *
   * Off is for a host that keeps old images deliberately: to roll back to one
   * without the registry, or because something outside Boxes runs them.
   */
  SESSION_IMAGE_PRUNE: flag.default('true'),
  SESSION_SUBNET_POOL: z.string().regex(/^\d+\.\d+\.\d+\.\d+\/\d+$/).default('10.200.0.0/16'),
  SESSION_MEM_LIMIT: z.string().regex(/^\d+[kmgKMG]?$/).default('4g'),
  SESSION_CPUS: z.coerce.number().positive().default(2),
  SESSION_PIDS_LIMIT: z.coerce.number().int().positive().default(512),

  IDLE_STOP_MINUTES: durationMinutes.default(30),

  /**
   * How long an answer about what is running in a box stands before the box
   * is asked again, in seconds.
   *
   * This is a Docker API call per running session per window, so it is not
   * free — and it is also what a browser is shown, so it should not lag a
   * build finishing by much. There is no cap on the answer itself and no need
   * of one: it is a reading rather than a tally, so a stale one is at most
   * this old and never wrong for longer.
   *
   * Two readers on two clocks. The reaper asks when it sweeps, and the lazy
   * refresh behind the probe is enough for that. A person watching a thread
   * is the other, and nothing reports a build finishing — so while a browser
   * is attached this is the clock the bar above their composer goes away on.
   * See gateway/background.ts.
   */
  BACKGROUND_POLL_SECONDS: z.coerce.number().int().positive().default(20),

  /**
   * How long a thread has to say nothing before the agent counts as having
   * stopped, in seconds.
   *
   * The fallback, and for the adapter Boxes ships with it is only that: that
   * one marks the end of a processing cycle with a `usage_update` carrying a
   * cost, and gateway/activity.ts takes it. This is for the adapters that say
   * nothing — no stop reason arrives for a prompt being held open, and a turn
   * the harness started on its own has no request to end, so how long a gap
   * has to be before it is read as the end is all that is left. Wrong in either direction it costs
   * little: a short one puts a send button under a model that is thinking
   * between tool calls, which was allowed anyway, and a long one leaves the
   * spinner up a second or two after the agent has finished. A tool call the
   * agent is waiting on suspends the question entirely — see
   * gateway/activity.ts.
   */
  AGENT_QUIET_SECONDS: z.coerce.number().int().positive().default(3),

  /**
   * How long a thread has to stay quiet before anybody is told its turn has
   * finished, in seconds. Measured from the last thing the agent said, so it
   * includes AGENT_QUIET_SECONDS.
   *
   * Longer than the quiet threshold on purpose: the screen can afford to be
   * wrong for a moment and correct itself, and a push notification cannot.
   * "Your turn has finished" on a lock screen is a claim there is no taking
   * back, so it waits until the silence is convincing.
   */
  AGENT_SETTLE_SECONDS: z.coerce.number().int().positive().default(30),

  /**
   * Largest single attachment a prompt may carry into a workspace, in
   * mebibytes.
   *
   * The cap is on the upload rather than on the workspace, because the
   * workspace has no size worth policing here — the agent can fill it faster
   * than any user with a file picker. What this bounds is one request the
   * orchestrator buffers in memory before writing it out.
   */
  MAX_ATTACHMENT_MB: z.coerce.number().int().positive().default(25),

  /**
   * Validated against the bearer.<token> WebSocket subprotocol. Unset means
   * the orchestrator generates one and keeps it in the data volume.
   */
  WS_AUTH_TOKEN: z.string().default(''),

  PERMISSION_FALLBACK: z.enum(['hold', 'deny']).default('hold'),
  PERMISSION_HOLD_MINUTES: durationMinutes.default(120),

  /**
   * Who operates this deployment, for the VAPID assertion every Web Push
   * carries. A push service with a problem contacts this rather than
   * silently dropping the messages; RFC 8292 allows a mailto: or an https:
   * URL and nothing else.
   */
  PUSH_SUBJECT: z
    .string()
    .refine((v) => v.startsWith('mailto:') || v.startsWith('https://'), {
      message: 'must be a mailto: or https: URL',
    })
    .default('https://github.com/splitbrain/boxes'),

  /** Container name of the egress proxy the orchestrator attaches. */
  EGRESS_PROXY_CONTAINER: z.string().min(1).default('boxes-egress-proxy'),
  EGRESS_PROXY_ALIAS: z.string().min(1).default('proxy'),
  EGRESS_PROXY_PORT: z.coerce.number().int().positive().default(3128),
  /**
   * Port of the proxy's control channel, on the compose network. Nobody sets
   * this: the orchestrator is the only thing that speaks to it, and it is
   * unreachable from a session either way.
   */
  EGRESS_CONTROL_PORT: z.coerce.number().int().positive().default(3129),

  /**
   * Hosts sessions may reach, comma or whitespace separated. Exact names and
   * one-label wildcards: `github.com, *.githubusercontent.com`. Empty is off,
   * which leaves every public host reachable, as it is today.
   */
  EGRESS_ALLOWED_HOSTS: z.string().default(''),

  PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN: z.string().default(''),
  PROFILE_DEFAULT_GH_TOKEN: z.string().default(''),
  PROFILE_DEFAULT_GIT_NAME: z.string().default('boxes-bot'),
  PROFILE_DEFAULT_GIT_EMAIL: z.string().default('boxes-bot@users.noreply.github.com'),
});

export type Config = Readonly<z.infer<typeof schema>> & {
  /** Credentials by profile name. */
  readonly profiles: Readonly<Record<string, SessionProfile>>;
  /** The parsed allowlist. Empty means the allowlist is off. */
  readonly egressAllowedHosts: readonly string[];
  /**
   * The credentials this deployment translates: the entries of CREDENTIAL_SET
   * whose secret is actually configured.
   */
  readonly egressCredentials: readonly ConfiguredCredential[];
};

/**
 * One credential the proxy can translate, and everything the deployment knows
 * about it that is not the secret itself.
 *
 * The host lists and header names are fixed here rather than configured,
 * because they are facts about the services, not preferences: getting them
 * wrong either breaks a tool or widens what a credential can reach.
 */
export interface CredentialSpec {
  /** Stable identifier, used in logs, status and the placeholder file. */
  id: string;
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
}

/** A credential spec together with the secret this deployment configured. */
export interface ConfiguredCredential extends CredentialSpec {
  secret: string;
}

/**
 * Every credential the proxy knows how to translate. A deployment translates
 * the ones it configures a secret for; the rest stay ordinary passthrough
 * hosts, which is what preserves the "log in inside a session" flow.
 */
export const CREDENTIAL_SET: readonly CredentialSpec[] = [
  {
    id: 'claude',
    hosts: ['api.anthropic.com'],
    headers: ['authorization', 'x-api-key'],
    // The token endpoints an OAuth credential may be refreshed at. They are
    // reachable but not intercepted, so a session that runs `claude
    // setup-token` still works and keeps its own token.
    alsoAllow: ['console.anthropic.com', 'platform.claude.com', 'claude.ai'],
    placeholderPrefix: 'sk-ant-oat01-',
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

/** Splits a comma or whitespace separated host list into patterns. */
export function parseHostList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h !== ''),
    ),
  ];
}

/** Credentials + identity handed to a session container at create time. */
export interface SessionProfile {
  claudeOauthToken: string;
  ghToken: string;
  gitName: string;
  gitEmail: string;
}

let cached: Config | null = null;

/**
 * An empty value means the setting was not provided.
 *
 * `FOO=` in an .env file, and a compose pass-through for a variable the host
 * does not set, both arrive as an empty string. Treating that as a value
 * rather than as an absence would fail the regex and enum fields at boot,
 * for a setting nobody actually set.
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

  const secrets: Record<string, string> = {
    claude: base.PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN,
    github: base.PROFILE_DEFAULT_GH_TOKEN,
  };

  return {
    ...base,
    WS_AUTH_TOKEN: resolveWsAuthToken(base.DATA_DIR, base.WS_AUTH_TOKEN),
    egressAllowedHosts: allowedHosts,
    egressCredentials: CREDENTIAL_SET.flatMap((spec) => {
      const secret = secrets[spec.id] ?? '';
      return secret ? [{ ...spec, secret }] : [];
    }),
    profiles: {
      DEFAULT: {
        claudeOauthToken: base.PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN,
        ghToken: base.PROFILE_DEFAULT_GH_TOKEN,
        gitName: base.PROFILE_DEFAULT_GIT_NAME,
        gitEmail: base.PROFILE_DEFAULT_GIT_EMAIL,
      },
    },
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
