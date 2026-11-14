import type { CredentialId, CredentialMethod } from './credentials.ts';
import { HARNESSES } from './harness.ts';
import { HOME_DIR } from './runtime/runtime.ts';

/**
 * The path of the CA bundle. It links to the bundle file of the trust store
 * that the box setup writes with the system certificates and the deployment CA.
 */
const CA_PATH = `${HOME_DIR}/.boxes/ca-bundle.crt`;

/** The inputs for the environment of a box. */
export interface BoxEnvInputs {
  /** Returns the placeholder that the egress proxy replaces with a stored credential. */
  placeholderFor: (credentialId: string) => string;
  /** Returns the method of a stored credential, or null when none is stored. */
  methodFor: (credentialId: CredentialId) => CredentialMethod | null;
  /** The GitLab host of the GitLab credential. */
  gitlabHost: string;
  /** The URL of the egress proxy, as seen from a box. */
  proxyUrl: string;
  /** True when the deployment has a CA. */
  hasCa: boolean;
  /** The placeholder of each API key a user added, by its variable name. */
  apiKeys: Readonly<Record<string, string>>;
}

/** The variables that the box image or the runtime sets, which an API key must not replace. */
const IMAGE_ENV_NAMES = [
  'CODEX_PATH',
  'HOME',
  'HOSTNAME',
  'LANG',
  'NPM_CONFIG_PREFIX',
  'PATH',
  'SHELL',
  'TMPDIR',
  'USER',
];

/**
 * Builds the full environment of a box as a plain record. The runtime converts
 * it to its own format. Variables with an empty value are left out.
 *
 * Each credential variable holds a placeholder and never the real credential.
 * The egress proxy replaces the placeholder with the real secret. Each harness
 * adds its variables, also a harness that no thread in the box uses. A
 * credential that is not stored has no placeholder, so its variable is left
 * out. The environment is fixed when the container is created, so a credential
 * entered later reaches the box when its container is created again.
 *
 * GH_TOKEN is for git and gh. GITLAB_TOKEN and GITLAB_HOST are for git and
 * glab. DEVTUNNELS_TOKEN is the GitHub token for the Dev Tunnels API, for the
 * share-app skill. The API keys of the user go in first, so a variable of
 * Boxes has priority over a key with the same name.
 *
 * @param inputs The placeholders and the methods of the owner of the box, and the settings of the deployment.
 * @returns The variables by name.
 */
export function boxEnv(inputs: BoxEnvInputs): Record<string, string> {
  const env: Record<string, string> = { ...inputs.apiKeys };
  for (const harness of Object.values(HARNESSES)) {
    const id = harness.credentialId;
    // A harness without a credential runs on the API keys above.
    if (id === null) Object.assign(env, harness.env('', null));
    else Object.assign(env, harness.env(inputs.placeholderFor(id), inputs.methodFor(id)));
  }
  env.GH_TOKEN = inputs.placeholderFor('github');
  env.GITLAB_TOKEN = inputs.placeholderFor('gitlab');
  env.GITLAB_HOST = inputs.gitlabHost;
  env.DEVTUNNELS_TOKEN = inputs.placeholderFor('devtunnels');

  env.TERM = 'dumb';
  // Each client with proxy support uses these variables. Other clients have no
  // route out, and that failure is intended.
  env.HTTP_PROXY = inputs.proxyUrl;
  env.HTTPS_PROXY = inputs.proxyUrl;
  env.http_proxy = inputs.proxyUrl;
  env.https_proxy = inputs.proxyUrl;
  env.NO_PROXY = 'localhost,127.0.0.1';
  env.no_proxy = 'localhost,127.0.0.1';

  if (inputs.hasCa) {
    // The variables below point node, gh, git, git-lfs, curl and Codex to
    // CA_PATH. A tool that ignores /etc/ssl/certs, such as node, needs them.
    env.NODE_EXTRA_CA_CERTS = CA_PATH;
    env.SSL_CERT_FILE = CA_PATH;
    env.GIT_SSL_CAINFO = CA_PATH;
    env.CURL_CA_BUNDLE = CA_PATH;
    // Codex reads this variable first, then SSL_CERT_FILE.
    env.CODEX_CA_CERTIFICATE = CA_PATH;
  }

  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
}

/**
 * The names that an API key cannot use. These are the variables that boxEnv
 * sets when each credential is stored, and the variables that the box image or
 * the runtime sets.
 *
 * @returns The reserved names.
 */
export function reservedEnvNames(): ReadonlySet<string> {
  const names = new Set(IMAGE_ENV_NAMES);
  // The Claude variable depends on the method, so the loop tries both methods.
  for (const method of ['token', 'api_key'] as const) {
    const env = boxEnv({
      placeholderFor: () => 'set',
      methodFor: () => method,
      gitlabHost: 'set',
      proxyUrl: 'set',
      hasCa: true,
      apiKeys: {},
    });
    for (const name of Object.keys(env)) names.add(name);
  }
  return names;
}
