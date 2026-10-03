import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import type { CredentialId, LoginState } from '../../shared/types.ts';
import {
  DEVTUNNELS_CLIENT_ID,
  GITHUB_TOKEN_URL,
  parseAuthDocument,
  postToken,
  type CredentialStore,
  type TokenPost,
} from './credentials.ts';
import type { Config } from './config.ts';
import * as dk from './docker.ts';
import { HttpError } from './http-error.ts';
import * as k8s from './kubernetes.ts';
import { Screen } from './screen.ts';
import { log } from './log.ts';

/**
 * Account logins. A harness login is run by the harness's own CLI in a
 * throwaway container. The Dev Tunnels login is GitHub's device flow, which
 * the orchestrator runs itself.
 *
 * The CLIs do not document the lines they print. So the parsers look for
 * shapes, such as a URL on the service's host, a one-time code or a token
 * prefix, and the raw output goes to the log.
 */

/** How long a person gets to finish a login before it fails, in milliseconds. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** Age in milliseconds after which the sweep removes a login container. */
export const LOGIN_CONTAINER_MAX_AGE_MS = 15 * 60_000;

/** Where Codex keeps its state inside the login container's tmpfs home. */
const CODEX_HOME = '/home/agent/.codex';

/** Where Claude Code keeps its state inside the login container's tmpfs home. */
const CLAUDE_CONFIG_DIR = '/home/agent/.claude';

/**
 * The URL `codex login --device-auth` sends a person to.
 *
 * Matched by prefix, as anything the CLI appends, such as a query with the
 * code, is still the right URL to show.
 */
const CODEX_DEVICE_URL = 'https://auth.openai.com/codex/device';

/**
 * What a Claude one-year token looks like, which is how it is recognised.
 *
 * Only the `sk-ant-` prefix is matched, not the kind after it, so a new token
 * kind cannot make the login hang. The minimum length keeps it off other text.
 */
const CLAUDE_TOKEN = /sk-ant-[A-Za-z0-9_-]{20,}/;

/** The prompt `claude setup-token` blocks on, read off its screen. */
const CLAUDE_CODE_PROMPT = /paste code here/i;

/**
 * The CLI's complaint about a code it would not take. The login goes on, so
 * the captured sentence is shown beside the input.
 */
const CLAUDE_CODE_REFUSED = /OAuth error:?\s*([^\n]+)/i;

/** What the CLI shows in place of its prompt once it has refused a code. */
const RETRY_PROMPT = /press enter to retry/i;

/**
 * How long to wait between writing a code and writing the return that enters
 * it, in milliseconds.
 *
 * The UI reads a chunk of stdin as one keypress, and two writes back to back
 * arrive as one chunk. The value is measured: with it, a real code is always
 * entered.
 */
const ENTER_DELAY_MS = 150;

/**
 * How long a token is left to finish arriving before it is stored, in
 * milliseconds.
 *
 * A read can end in the middle of a token, and the part matches the pattern
 * too. The wait is fixed, as the CLI may print nothing more and never exit.
 */
const TOKEN_GRACE_MS = 150;

/** How long a Claude token is valid, in days. It cannot be refreshed. */
const CLAUDE_TOKEN_DAYS = 365;

/** GitHub's endpoint that starts a device login. */
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';

/** What the Dev Tunnels app asks of a GitHub account: its public profile. */
const DEVTUNNELS_SCOPE = 'read:user';

/** Seconds GitHub adds to the poll interval each time it answers `slow_down`. */
const SLOW_DOWN_SECONDS = 5;

/** How long the GitHub user lookup may take, in milliseconds. */
const LOOKUP_TIMEOUT_MS = 15_000;

/** How many characters of a CLI's output are kept. */
const OUTPUT_LIMIT = 64 * 1024;

/** How many characters of the output a log line or error reports. */
const ERROR_TAIL = 600;

/** The credentials that have a login flow at all. */
export const LOGIN_CREDENTIALS: readonly CredentialId[] = ['claude', 'openai', 'devtunnels'];

/** Whether a credential is obtained by logging in rather than by pasting. */
export function hasLoginFlow(id: CredentialId): boolean {
  return LOGIN_CREDENTIALS.includes(id);
}

// --- the container and exec layer -------------------------------------------

/** One command a login runs in its container. */
export interface LoginExecSpec {
  /** The argument vector. */
  cmd: readonly string[];
  /** Variables set for the command. */
  env?: Record<string, string>;
  /** A terminal and a writable stdin: what an interactive CLI needs. */
  tty?: boolean;
}

/** A running login command: what it prints, what it can be told, and its end. */
export interface LoginExec {
  /** stdout and stderr merged, in the order they were written. */
  output: Readable;
  /** Writable only on a TTY exec; null otherwise. */
  stdin: Writable | null;
  /** Resolves when the command ends, with the exit code if known. */
  exited: Promise<number | null>;
  /** Ends the command's stream. */
  kill(): void;
}

/**
 * Everything a login needs from Docker. An interface, so tests can drive the
 * flows over scripted streams.
 */
export interface LoginRuntime {
  /** Creates and starts the throwaway container, and returns its id. */
  start(credentialId: CredentialId): Promise<string>;
  /** Runs one command in the container. */
  exec(containerId: string, spec: LoginExecSpec): Promise<LoginExec>;
  /** Removes it, whatever state it is in. Never throws. */
  remove(containerId: string): Promise<void>;
}

/** The real thing: a container from the box image, driven over the socket. */
export function dockerLoginRuntime(image: string): LoginRuntime {
  return {
    async start(credentialId) {
      const id = await dk.createLoginContainer({ image, credentialId });
      await dk.startContainer(id);
      return id;
    },
    async exec(containerId, spec) {
      const exec = await dk.spawnLoginExec(containerId, spec.cmd, {
        ...(spec.env ? { env: spec.env } : {}),
        ...(spec.tty ? { tty: true } : {}),
      });
      return exec;
    },
    async remove(containerId) {
      try {
        await dk.removeContainer(containerId);
      } catch (err) {
        log.warn('could not remove a login container', {
          container: containerId,
          error: (err as Error).message,
        });
      }
    },
  };
}

/** The same, as a pod: what a deployment on the Kubernetes runtime logs in with. */
export function kubernetesLoginRuntime(cfg: Config): LoginRuntime {
  return {
    start: (credentialId) => k8s.createLoginPod({ image: cfg.BOX_IMAGE, credentialId }, cfg),
    exec: (podId, spec) =>
      k8s.spawnLoginPodExec(
        podId,
        spec.cmd,
        {
          ...(spec.env ? { env: spec.env } : {}),
          ...(spec.tty ? { tty: true } : {}),
        },
        cfg,
      ),
    async remove(podId) {
      try {
        await k8s.deleteLoginPod(podId, cfg);
      } catch (err) {
        log.warn('could not remove a login pod', {
          pod: podId,
          error: (err as Error).message,
        });
      }
    },
  };
}

// --- GitHub, for the device login ------------------------------------------

/** What the Dev Tunnels login needs from GitHub. An interface, so tests can fake it. */
export interface GitHubClient {
  /** One POST to an OAuth endpoint. */
  post: TokenPost;
  /** The login name of the account a token belongs to, or null when GitHub does not say. */
  login(token: string): Promise<string | null>;
}

/** The real thing: GitHub's own endpoints. */
export const gitHubClient: GitHubClient = {
  post: postToken,
  async login(token) {
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const login = ((await res.json()) as { login?: unknown }).login;
      return typeof login === 'string' && login !== '' ? login : null;
    } catch {
      return null;
    }
  },
};

// --- the flows --------------------------------------------------------------

/** One login in progress, or the last one that finished. */
interface Flow {
  /** The login id the page polls with. */
  id: string;
  /** The credential the login is for. */
  credentialId: CredentialId;
  /** Where the login has got to. */
  state: LoginState;
  /** The login container, or null before it starts and after removal. */
  containerId: string | null;
  /** The running CLI, or null. */
  exec: LoginExec | null;
  /** Set once the state is `done` or `failed`; nothing moves it afterwards. */
  settled: boolean;
  /** Why the last code was refused, until another one is sent. */
  refusal: string | null;
  /** Whether the retry the CLI is waiting on has been pressed already. */
  retrying: boolean;
  /** The LOGIN_TIMEOUT_MS timer, or null once released. */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Runs the logins, one per credential at a time. Two logins for one
 * credential would race to write the same row, so a new one cancels the old.
 */
export class LoginManager {
  /** The current flow of each credential. */
  private readonly flows = new Map<CredentialId, Flow>();

  constructor(
    /** Where a finished login stores its credential. */
    private readonly credentials: CredentialStore,
    /** Runs the login containers and commands. */
    private runtime: LoginRuntime,
    /** How long a login may take, in milliseconds. */
    private readonly timeoutMs: number = LOGIN_TIMEOUT_MS,
    /** Where the Dev Tunnels login talks to GitHub. */
    private readonly github: GitHubClient = gitHubClient,
  ) {}

  /** Test seam: installs a runtime the tests script. */
  setRuntimeForTests(runtime: LoginRuntime): void {
    this.runtime = runtime;
  }

  /**
   * Starts a login and returns the id the page polls. It returns before the
   * container starts, and the page shows the `starting` state meanwhile.
   */
  start(credentialId: CredentialId): string {
    if (!hasLoginFlow(credentialId)) {
      throw new HttpError(
        400,
        `${credentialId} has no login flow: paste its token on the settings page instead`,
      );
    }
    const previous = this.flows.get(credentialId);
    if (previous) this.abort(previous, 'a newer login replaced this one');

    const flow: Flow = {
      id: randomUUID(),
      credentialId,
      state: { state: 'starting' },
      containerId: null,
      exec: null,
      settled: false,
      refusal: null,
      retrying: false,
      timer: null,
    };
    flow.timer = setTimeout(() => {
      this.fail(flow, 'the login was not finished in ten minutes');
    }, this.timeoutMs);
    flow.timer.unref?.();
    this.flows.set(credentialId, flow);

    void this.run(flow);
    return flow.id;
  }

  /** Where a login has got to, or a 404 for one that is no longer current. */
  state(credentialId: CredentialId, loginId: string): LoginState {
    return this.flow(credentialId, loginId).state;
  }

  /**
   * Types the code the person pasted into the CLI's prompt.
   *
   * It also accepts a code before the prompt is drawn, as the CLI reads the
   * stream when it gets there. A flow without stdin, such as Codex's, answers
   * 409.
   *
   * The code is entered with a carriage return, as a raw-mode UI does not turn
   * a newline into Enter. The return is written ENTER_DELAY_MS later, as a
   * separate keypress.
   */
  submitCode(credentialId: CredentialId, loginId: string, code: string): void {
    const flow = this.flow(credentialId, loginId);
    const trimmed = code.trim();
    if (trimmed === '') throw new HttpError(400, 'code is required');
    const waiting = flow.state.state === 'awaiting_code' || flow.state.state === 'awaiting_browser';
    if (!waiting || !flow.exec?.stdin) {
      throw new HttpError(409, 'this login is not waiting for a code');
    }
    // The refusal was about the previous code, so it goes now.
    flow.refusal = null;
    if (flow.state.state === 'awaiting_code' && flow.state.error !== null) {
      this.settle(flow, { state: 'awaiting_code', url: flow.state.url, error: null });
    }
    const stdin = flow.exec.stdin;
    stdin.write(trimmed);
    const enter = setTimeout(() => {
      // The flow may have ended while this waited, taking the stream with it.
      if (flow.settled || !stdin.writable) return;
      stdin.write('\r');
    }, ENTER_DELAY_MS);
    enter.unref?.();
  }

  /** Gives up on a login and takes its container with it. */
  cancel(credentialId: CredentialId, loginId: string): void {
    const flow = this.flow(credentialId, loginId);
    this.abort(flow, 'the login was cancelled');
  }

  /** Stops every login in flight, for a shutdown that should leave nothing. */
  closeAll(): void {
    for (const flow of [...this.flows.values()]) {
      this.abort(flow, 'the orchestrator is shutting down');
    }
  }

  /** The named flow, or a 404 saying it is not the current one. */
  private flow(credentialId: CredentialId, loginId: string): Flow {
    const flow = this.flows.get(credentialId);
    if (!flow || flow.id !== loginId) {
      throw new HttpError(404, 'no such login: it finished, was cancelled, or was replaced');
    }
    return flow;
  }

  /** Runs one flow to its end, and cleans up whatever it was holding. */
  private async run(flow: Flow): Promise<void> {
    if (flow.credentialId === 'devtunnels') {
      try {
        await this.devTunnelsLogin(flow);
      } catch (err) {
        this.fail(flow, (err as Error).message);
      } finally {
        this.release(flow);
      }
      return;
    }
    try {
      flow.containerId = await this.runtime.start(flow.credentialId);
      if (flow.settled) return;
      if (flow.credentialId === 'openai') await this.codexLogin(flow);
      else await this.claudeLogin(flow);
    } catch (err) {
      this.fail(flow, (err as Error).message);
    } finally {
      // The container always goes, as its home holds new credential material.
      this.release(flow);
      if (flow.containerId) {
        const containerId = flow.containerId;
        flow.containerId = null;
        await this.runtime.remove(containerId);
      }
    }
  }

  /**
   * Codex: the device-code flow.
   *
   * The CLI reads no stdin. It prints a URL and a one-time code, waits for the
   * person, writes `auth.json` and exits 0. On failure it exits 1 with the
   * reason on stderr.
   */
  private async codexLogin(flow: Flow): Promise<void> {
    const exec = await this.runtime.exec(flow.containerId!, {
      // The Codex CLI fails when CODEX_HOME does not exist.
      cmd: ['bash', '-lc', `mkdir -p "$CODEX_HOME" && exec codex login --device-auth`],
      env: { CODEX_HOME },
    });
    flow.exec = exec;

    let url: string | null = null;
    let code: string | null = null;
    const output = await readOutput(exec.output, (text) => {
      if (flow.settled) return;
      url = grown(url, deviceUrlIn(text));
      if (!url) return;
      code = grown(code, deviceCodeIn(text, url));
      this.settle(flow, { state: 'awaiting_browser', url, code });
    });

    if (flow.settled) return;
    const exit = await exec.exited;
    // The raw output, so a person can finish by hand if the parse failed.
    log.info('codex device login finished', { exit, url, code, output: tail(output) });
    if (exit !== 0) {
      this.fail(flow, `codex login exited ${exit ?? 'without a status'}: ${tail(output)}`);
      return;
    }

    const read = await this.runtime.exec(flow.containerId!, {
      cmd: ['cat', `${CODEX_HOME}/auth.json`],
    });
    const document = await readOutput(read.output, () => {});
    if ((await read.exited) !== 0) {
      this.fail(flow, `codex logged in but wrote no auth.json: ${tail(document)}`);
      return;
    }
    this.storeCodexDocument(flow, document);
  }

  /**
   * Stores the whole document the Codex CLI wrote, as the refresh needs the
   * refresh token beside the access token.
   */
  private storeCodexDocument(flow: Flow, document: string): void {
    const parsed = parseAuthDocument(document);
    if (!parsed) {
      this.fail(flow, 'codex wrote an auth.json this does not understand');
      return;
    }
    this.credentials.put('openai', 'oauth', document.trim(), {
      account: parsed.account,
      expires_at: parsed.expiresAt,
      refreshed_at: parsed.lastRefresh,
    });
    this.settle(flow, { state: 'done' });
    log.info('stored a Codex subscription credential', {
      account: parsed.account,
      expiresAt: parsed.expiresAt,
    });
  }

  /**
   * Dev Tunnels: GitHub's device flow for the Dev Tunnels app.
   *
   * GitHub hands out a one-time code, which the page shows with its URL, and
   * the orchestrator polls until the person has entered it.
   */
  private async devTunnelsLogin(flow: Flow): Promise<void> {
    const started = await this.github.post(GITHUB_DEVICE_CODE_URL, {
      client_id: DEVTUNNELS_CLIENT_ID,
      scope: DEVTUNNELS_SCOPE,
    });
    const { device_code: deviceCode, user_code: userCode, verification_uri: url } = started;
    if (!deviceCode || !userCode || !url) {
      throw new Error(
        `GitHub did not start a device login: ${started.error_description ?? started.error ?? 'no code in the answer'}`,
      );
    }
    this.settle(flow, { state: 'awaiting_browser', url, code: userCode });

    let interval = started.interval ?? SLOW_DOWN_SECONDS;
    while (!flow.settled) {
      await sleep(interval * 1000);
      if (flow.settled) return;
      const answer = await this.github.post(GITHUB_TOKEN_URL, {
        client_id: DEVTUNNELS_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      if (flow.settled) return;
      if (answer.access_token) {
        await this.storeDevTunnelsLogin(flow, answer.access_token, answer);
        return;
      }
      if (answer.error === 'authorization_pending') continue;
      if (answer.error === 'slow_down') {
        interval += SLOW_DOWN_SECONDS;
        continue;
      }
      this.fail(
        flow,
        `GitHub ended the login: ${answer.error_description ?? answer.error ?? 'no token in the answer'}`,
      );
      return;
    }
  }

  /**
   * Stores a Dev Tunnels login as a document with both tokens, named by the
   * GitHub account it belongs to.
   */
  private async storeDevTunnelsLogin(
    flow: Flow,
    accessToken: string,
    answer: { refresh_token?: string; expires_in?: number },
  ): Promise<void> {
    const account = await this.github.login(accessToken);
    if (flow.settled) return;
    const now = Date.now();
    this.credentials.put(
      'devtunnels',
      'oauth',
      JSON.stringify({ access_token: accessToken, refresh_token: answer.refresh_token ?? '' }),
      {
        // Without a name the store would show the document's last characters.
        account: account ?? 'a GitHub account',
        expires_at: answer.expires_in ? now + answer.expires_in * 1000 : null,
        refreshed_at: now,
      },
    );
    this.settle(flow, { state: 'done' });
    log.info('stored a Dev Tunnels login', { account });
  }

  /**
   * Claude: an interactive terminal UI with a code pasted back.
   *
   * `claude setup-token` needs a TTY. It prints a URL, blocks on a prompt, and
   * prints a one-year token once the code is entered. The scan reads a
   * rebuilt screen, as the UI redraws only the cells it changes.
   */
  private async claudeLogin(flow: Flow): Promise<void> {
    const exec = await this.runtime.exec(flow.containerId!, {
      cmd: ['bash', '-lc', 'exec claude setup-token'],
      env: { CLAUDE_CONFIG_DIR },
      tty: true,
    });
    flow.exec = exec;

    let url: string | null = null;
    let token: string | null = null;
    /** Set once a token has been seen, while the rest of it is given time to arrive. */
    let storing: ReturnType<typeof setTimeout> | null = null;
    /**
     * Whether the CLI has asked for a code yet. It stays true, as a refusal
     * draws over the prompt while the CLI still wants a code.
     */
    let prompted = false;
    const output = await readScreen(exec.output, (text) => {
      if (flow.settled) return;
      // The only record of what the login showed.
      log.debug('claude login output', { text: tail(text) });
      url = grown(url, visitUrlIn(text));
      token = grown(token, CLAUDE_TOKEN.exec(text)?.[0] ?? null);
      if (token) {
        // The token ends the flow, without waiting for the CLI to exit. It is
        // stored after TOKEN_GRACE_MS, as a read may end mid-token.
        storing ??= setTimeout(() => {
          if (flow.settled) return;
          if (token) this.storeClaudeToken(flow, token);
          exec.kill();
        }, TOKEN_GRACE_MS);
        return;
      }
      if (!url) return;
      // The prompt shows the CLI is waiting, and the page then draws an input.
      prompted ||= CLAUDE_CODE_PROMPT.test(text);
      if (prompted) {
        // Kept on the flow, as the retry below takes the complaint off the
        // screen. submitCode clears it.
        const reason = CLAUDE_CODE_REFUSED.exec(text)?.[1]?.trim() ?? null;
        if (reason !== null && flow.refusal === null) {
          flow.refusal = reason;
          log.warn('the CLI refused a login code', { reason });
        }
        // After a refusal the CLI discards input until Enter brings the
        // prompt back, so Enter is pressed here for the person.
        if (RETRY_PROMPT.test(text) && !flow.retrying) {
          flow.retrying = true;
          exec.stdin?.write('\r');
        } else if (!RETRY_PROMPT.test(text)) {
          flow.retrying = false;
        }
        this.settle(flow, { state: 'awaiting_code', url, error: flow.refusal });
        return;
      }
      this.settle(flow, { state: 'awaiting_browser', url, code: null });
    });

    if (storing) clearTimeout(storing);
    if (flow.settled) return;
    if (token) {
      // The CLI ended during the grace wait, so the token is complete.
      this.storeClaudeToken(flow, token);
      return;
    }
    log.info('claude setup-token finished', { exit: await exec.exited, url, output: tail(output) });
    this.fail(
      flow,
      `claude setup-token printed no token before it ended: ${tail(output)}`,
    );
  }

  /**
   * Stores the token the CLI printed, expiring CLAUDE_TOKEN_DAYS from now.
   * `setup-token` reports no account name, so the store uses the token's
   * last four characters.
   */
  private storeClaudeToken(flow: Flow, token: string): void {
    this.credentials.put('claude', 'token', token, {
      expires_at: Date.now() + CLAUDE_TOKEN_DAYS * 24 * 60 * 60 * 1000,
    });
    this.settle(flow, { state: 'done' });
    log.info('stored a Claude subscription token');
  }

  /** Records a new state, unless the flow has ended. `done` and `failed` end it. */
  private settle(flow: Flow, state: LoginState): void {
    if (flow.settled) return;
    flow.state = state;
    if (state.state === 'done' || state.state === 'failed') {
      flow.settled = true;
      this.release(flow);
    }
  }

  /** Ends a flow as failed, with a sentence the settings page can show. */
  private fail(flow: Flow, error: string): void {
    if (flow.settled) return;
    log.warn('a login failed', { credential: flow.credentialId, error });
    this.settle(flow, { state: 'failed', error });
  }

  /**
   * Fails a flow, removes its container now, and forgets it. For a cancel,
   * a shutdown, and a flow a newer login replaced. `run` then finds no
   * container left to remove.
   */
  private abort(flow: Flow, reason: string): void {
    this.fail(flow, reason);
    const containerId = flow.containerId;
    flow.containerId = null;
    if (containerId) void this.runtime.remove(containerId);
    if (this.flows.get(flow.credentialId) === flow) this.flows.delete(flow.credentialId);
  }

  /** Drops the timer and the exec a settled flow no longer needs. */
  private release(flow: Flow): void {
    if (flow.timer) {
      clearTimeout(flow.timer);
      flow.timer = null;
    }
    flow.exec?.kill();
  }
}

/** Resolves after some milliseconds, without holding the process open. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// --- reading what a CLI printed ---------------------------------------------

/**
 * Reads a redrawing CLI's terminal, and returns what is on its screen at the
 * end. onText gets the screen after every chunk, as the URL and the prompt
 * may be drawn over later.
 */
async function readScreen(
  output: Readable,
  onText: (text: string) => void,
): Promise<string> {
  const screen = new Screen();
  try {
    for await (const chunk of output) {
      screen.write(String(chunk));
      onText(screen.text);
    }
  } catch (err) {
    log.debug('a login stream ended abruptly', { error: (err as Error).message });
  }
  return screen.text;
}

/**
 * Reads a stream to its end, stripped of terminal escapes, and returns the
 * text. onText gets the whole text so far after every chunk, as a match may
 * be split across reads.
 */
async function readOutput(
  output: Readable,
  onText: (text: string) => void,
): Promise<string> {
  let text = '';
  try {
    for await (const chunk of output) {
      text = clamp(text + stripAnsi(String(chunk)));
      onText(text);
    }
  } catch (err) {
    // A flow that is done kills the exec, which ends this stream mid-read.
    log.debug('a login stream ended abruptly', { error: (err as Error).message });
  }
  return text;
}

/** Keeps the tail of a long stream, so a chatty CLI cannot grow without end. */
function clamp(text: string): string {
  return text.length <= OUTPUT_LIMIT ? text : text.slice(-OUTPUT_LIMIT);
}

/** The last of some output, for a log line or an error message. */
export function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= ERROR_TAIL ? trimmed : `…${trimmed.slice(-ERROR_TAIL)}`;
}

/** The byte every terminal control sequence starts with. */
const ESC = String.fromCharCode(0x1b);

/** The single-byte form of the same thing, which a CLI may still emit. */
const CSI = String.fromCharCode(0x9b);

/** Operating-system commands: a title change, a hyperlink. */
const OSC_PATTERN = new RegExp(
  `${ESC}\\][^${ESC}\\u0007]*(?:\\u0007|${ESC}\\\\)`,
  'g',
);

/** Control sequences: colour, cursor moves, erases, and the shorter escapes. */
const CSI_PATTERN = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]`,
  'g',
);

/**
 * Returns the text with its CSI and OSC terminal sequences removed, and with
 * carriage returns turned into newlines.
 */
export function stripAnsi(text: string): string {
  return (
    text
      .replace(OSC_PATTERN, '')
      .replace(CSI_PATTERN, '')
      // A terminal UI rewrites a line by returning to its start; read as
      // text, that is a new line.
      .replace(/\r\n?/g, '\n')
  );
}

/**
 * Returns the later reading when it extends the earlier one, and the earlier
 * one otherwise.
 *
 * A read may end in the middle of a URL or a code, so a longer later reading
 * replaces it. A redraw may cut a value short later, so a reading that does
 * not start with the earlier one is ignored.
 */
export function grown(seen: string | null, read: string | null): string | null {
  if (read === null) return seen;
  if (seen === null || read.startsWith(seen)) return read;
  return seen;
}

/** The Codex device URL in some output, or null. */
export function deviceUrlIn(text: string): string | null {
  const match = new RegExp(`${CODEX_DEVICE_URL}[^\\s"'<>]*`).exec(text);
  if (match) return match[0];
  // Otherwise any URL on the login host, in case the CLI moved the path.
  return /https:\/\/auth\.openai\.com\/[^\s"'<>]*/.exec(text)?.[0] ?? null;
}

/** Words that have the shape of a device code and are not one. */
const NOT_A_CODE = new Set([
  'HTTP', 'HTTPS', 'URL', 'CODE', 'OPENAI', 'CHATGPT', 'CODEX', 'ENTER', 'VISIT',
  'PASTE', 'HERE', 'PROMPTED', 'LOGIN', 'DEVICE', 'AUTH', 'COPY', 'PRESS',
  'CTRL', 'WARNING', 'ERROR', 'NOTE', 'THEN', 'YOUR', 'USER', 'OPEN', 'PLEASE',
  'WAITING', 'BROWSER', 'ACCOUNT', 'SUCCESS', 'FAILED', 'TOKEN',
]);

/**
 * The one-time code in some output, or null until one appears.
 *
 * It matches the shape: runs of four or more upper-case letters and digits,
 * joined by hyphens. Only text from the URL on is searched, with the URL cut
 * out. Words in NOT_A_CODE are skipped, and a match must have a hyphen, a
 * digit, or at least eight characters.
 */
export function deviceCodeIn(text: string, url: string): string | null {
  const from = text.indexOf(url);
  const after = (from === -1 ? text : text.slice(from)).split(url).join(' ');
  for (const match of after.matchAll(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})*\b/g)) {
    const candidate = match[0];
    if (NOT_A_CODE.has(candidate)) continue;
    if (candidate.includes('-') || /\d/.test(candidate) || candidate.length >= 8) {
      return candidate;
    }
  }
  return null;
}

/**
 * The URL `claude setup-token` wants visited, or null.
 *
 * The URL after `Visit:` first, and the first https URL otherwise.
 */
export function visitUrlIn(text: string): string | null {
  const labelled = /Visit:\s*(https?:\/\/[^\s"'<>]+)/i.exec(text);
  if (labelled?.[1]) return labelled[1];
  return /https:\/\/[^\s"'<>]+/.exec(text)?.[0] ?? null;
}
