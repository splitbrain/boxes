/** The TLS interception engine, the one place a real credential goes onto the wire. */

import type { CompletedRequest, Headers, InitiatedResponse } from 'mockttp';
import * as mockttp from 'mockttp';
import type { EgressPolicy, EgressRefusedToken } from '../../shared/types.ts';
import { bearerChallenge } from '../../shared/www-authenticate.ts';
import { type DenialCategory, PLAINTEXT_CREDENTIAL_REASON } from './forward.ts';
import {
  credentialsForHost,
  decideCredentials,
  injectionPatterns,
  upstreamCaCerts,
  upstreamCasFor,
} from './policy.ts';

/** Callbacks of the interceptor. */
export interface InterceptorOptions {
  /** Returns the live policy. */
  policy: () => EgressPolicy;
  /**
   * Returns the loopback URL of the tunnel that every upstream connection goes
   * through, so the address vetting also covers what the engine forwards.
   */
  upstreamProxyUrl: () => string;
  /** The id of the box of each open connection from the front door, by the remote port of the connection. */
  engineClients: ReadonlyMap<number, string>;
  /** Counts one denial under its category. */
  denied: (category: DenialCategory) => void;
  /** Records a server answer that refused an OAuth token. */
  refusedToken: (report: EgressRefusedToken) => void;
  /** Writes one structured log line. */
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Gives the destination of an intercepted request.
 *
 * @param req The intercepted request or upgrade.
 * @returns The hostname, the port and the scheme with its colon. The scheme is empty when the URL does not parse.
 */
function targetOf(req: CompletedRequest): { host: string; port: number; protocol: string } {
  try {
    const url = new URL(req.url);
    const encrypted = url.protocol === 'https:' || url.protocol === 'wss:';
    const port = url.port !== '' ? Number(url.port) : encrypted ? 443 : 80;
    return { host: url.hostname, port, protocol: url.protocol };
  } catch {
    return {
      host: req.destination?.hostname ?? '',
      port: req.destination?.port ?? 443,
      protocol: '',
    };
  }
}

/**
 * Checks if a peer address is loopback.
 *
 * @param address The remote address of the peer.
 * @returns True for 127.0.0.1, ::1 and ::ffff:127.0.0.1.
 */
function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** The maximum number of requests with an OAuth token that wait for their answers. */
const MAX_OAUTH_REQUESTS = 10_000;

/** Headers that decide leaves out of a new header set, so the engine derives them from the request URL. */
const URL_LINKED_HEADERS = ['host', ':authority'];

/**
 * Result of the beforeRequest callback of the engine. It is undefined to
 * forward the request unchanged, a new header set, or a response that refuses
 * the request.
 */
type RequestDecision =
  | undefined
  | { headers: Headers }
  | {
      response: {
        statusCode: number;
        headers: Record<string, string>;
        body: string;
      };
    };

/** Result of the checks in screen. */
type Screening =
  /** Forward the request unchanged. */
  | { action: 'pass' }
  /** Forward the request with the values in headers. credentialIds names the credentials that were swapped in. */
  | { action: 'swap'; headers: Record<string, string>; credentialIds: string[] }
  /** Refuse the request. category is the counted category, and reason says why. */
  | { action: 'refuse'; category: DenialCategory; reason: string };

/**
 * Controller of the interception engine. It starts, restarts and stops the
 * engine to match the policy.
 */
export class Interceptor {
  /** The running engine, or null when nothing is intercepted. */
  private server: mockttp.Mockttp | null = null;

  /** The CA certificate and the upstream CAs that the running server was started with, as one text. */
  private runningKey: string | null = null;

  /**
   * The last queued call. enqueue chains each new call to it, so starts and
   * stops never overlap.
   */
  private queue: Promise<void> = Promise.resolve();

  /** The id of the OAuth credential in each forwarded request that waits for its answer, by request id. */
  private readonly oauthRequests = new Map<string, string>();

  /**
   * Creates a controller with no running engine.
   *
   * @param opts The callbacks of the interceptor.
   */
  constructor(private readonly opts: InterceptorOptions) {}

  /**
   * Runs work once everything queued before it has finished, or failed.
   *
   * @param work The call to run.
   * @returns The result of the work.
   */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work, work);
    // A failure belongs to the caller that asked, not to the calls behind it.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Gives the loopback port of the running engine. The front door hands
   * intercepted connections to it.
   *
   * @returns The port, or null when no engine runs.
   */
  port(): number | null {
    return this.server?.port ?? null;
  }

  /**
   * Makes the engine match the current policy.
   *
   * A policy without a CA, or without credentials and upstream CAs, stops the
   * engine. A changed CA restarts the engine, because the engine signs its
   * certificates with the CA. A changed set of upstream CAs restarts the
   * engine, because each upstream CA has rules of its own. A changed credential
   * needs no restart, because the rules read the policy for each request.
   *
   * Calls run one after another. A new server listens before the old server
   * stops, so port() never returns null while the policy asks for interception.
   */
  apply(): Promise<void> {
    return this.enqueue(() => this.applyNow());
  }

  /** Stops the engine. */
  stop(): Promise<void> {
    return this.enqueue(() => this.stopNow());
  }

  /** The body of apply, run with no other call in flight. */
  private async applyNow(): Promise<void> {
    const policy = this.opts.policy();
    const certs = upstreamCaCerts(policy).sort();
    const wanted =
      policy.ca !== null && (policy.credentials.length > 0 || certs.length > 0) ? policy.ca : null;

    if (wanted === null) {
      await this.stopNow();
      return;
    }
    const key = [wanted.cert, ...certs].join('\n');
    if (this.server && this.runningKey === key) return;

    const server = mockttp.getLocal({
      https: { key: wanted.key, cert: wanted.cert },
      http2: true,
      // A long-lived proxy must not accumulate every request it has seen.
      recordTraffic: false,
      suggestChanges: false,
      cors: false,
    });

    await server.start();
    try {
      const proxyConfig = { proxyUrl: this.opts.upstreamProxyUrl() };
      // The engine uses the first rule that matches, so the rules of the
      // upstream CAs come before the general rule.
      for (const cert of certs) {
        await server
          .forAnyRequest()
          .always()
          .matching((req) => this.upstreamCa(req) === cert)
          .thenPassThrough({
            beforeRequest: (req) => this.decide(req),
            proxyConfig,
            additionalTrustedCAs: [{ cert }],
          });
      }
      await server.forAnyRequest().thenPassThrough({
        beforeRequest: (req) => this.decide(req),
        proxyConfig,
      });

      // The engine runs the matchers of all rules, and upgradeAllowed counts each
      // refusal. Only one matcher gets past the check of the upstream CA, so
      // upgradeAllowed runs once for each upgrade. The last rule refuses all
      // other upgrades with a 403 and a reason.
      for (const cert of certs) {
        await server
          .forAnyWebSocket()
          .always()
          .matching((req) => this.upstreamCa(req) === cert && this.upgradeAllowed(req))
          .thenPassThrough({ proxyConfig, additionalTrustedCAs: [{ cert }] });
      }
      await server
        .forAnyWebSocket()
        .always()
        .matching((req) => this.upstreamCa(req) === null && this.upgradeAllowed(req))
        .thenPassThrough({ proxyConfig });
      await server
        .forAnyWebSocket()
        .always()
        .thenRejectConnection(403, 'protocol upgrade refused by the egress policy');

      // The event comes with the head of the answer and holds back no body, so an
      // event stream reaches the client at once.
      await server.on('response-initiated', (res) => this.answered(res));
      await server.on('abort', (req) => this.oauthRequests.delete(req.id));

      await server.on('tls-client-error', (failure) => {
        // A client that does not trust the deployment CA rejects the certificate,
        // for example a tool that ignores the CA environment variables.
        this.opts.log('TLS handshake rejected by the client', {
          host: failure.tlsMetadata?.sniHostname ?? null,
          reason: failure.failureCause,
        });
      });
    } catch (err) {
      // A partly configured engine must not keep listening.
      await server.stop().catch(() => undefined);
      throw err;
    }

    const previous = this.server;
    this.server = server;
    this.runningKey = key;
    if (previous) await this.stopServer(previous);
    this.opts.log('interception engine started', {
      port: server.port,
      hosts: injectionPatterns(policy),
    });
  }

  /** The body of stop, run with no other call in flight. */
  private async stopNow(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.runningKey = null;
    await this.stopServer(server);
  }

  /**
   * Stops one server. A failure to stop is logged and not thrown.
   *
   * @param server The server to stop.
   */
  private async stopServer(server: mockttp.Mockttp): Promise<void> {
    try {
      await server.stop();
    } catch (err) {
      this.opts.log('interception engine failed to stop cleanly', {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Reads the answer to a request with an OAuth token. A 401, or a 403 with a
   * Bearer challenge, goes to the refusedToken callback.
   *
   * @param res The head of the answer.
   */
  private answered(res: InitiatedResponse): void {
    const credentialId = this.oauthRequests.get(res.id);
    if (credentialId === undefined) return;
    this.oauthRequests.delete(res.id);

    const raw = res.headers['www-authenticate'];
    const challenge = bearerChallenge(Array.isArray(raw) ? raw.join(', ') : raw);
    if (res.statusCode !== 401 && !(res.statusCode === 403 && challenge)) return;
    this.opts.refusedToken({
      credentialId,
      status: res.statusCode,
      error: challenge?.error ?? null,
      scope: challenge?.scope ?? null,
    });
  }

  /**
   * True when an intercepted protocol upgrade may go on unchanged. The upgrade
   * must pass the checks in screen and must need no swap.
   *
   * The engine forwards an upgrade with its headers unchanged. An upgrade that
   * needs a swap would send the placeholder, so the method refuses it. The
   * method logs and counts each refusal.
   *
   * @param req The upgrade request.
   * @returns True when the engine may forward the upgrade.
   */
  private upgradeAllowed(req: CompletedRequest): boolean {
    const { host, verdict } = this.screen(req);
    if (verdict.action === 'pass') return true;
    const category = verdict.action === 'refuse' ? verdict.category : 'credential-upgrade';
    const reason =
      verdict.action === 'refuse'
        ? verdict.reason
        : 'a credential cannot be swapped into a protocol upgrade';
    this.opts.denied(category);
    this.opts.log('denied intercepted upgrade', { host, reason });
    return false;
  }

  /**
   * Finds the upstream CA that a request trusts. The box of the request is the
   * box of its connection from the front door.
   *
   * @param req The intercepted request or upgrade.
   * @returns The certificate of the first upstream CA of the box for the host of the request, or null.
   */
  private upstreamCa(req: CompletedRequest): string | null {
    const id =
      req.remotePort === undefined ? undefined : this.opts.engineClients.get(req.remotePort);
    const box = id === undefined ? undefined : this.opts.policy().boxes.find((b) => b.box === id);
    if (!box) return null;
    const { host, port } = targetOf(req);
    return upstreamCasFor(host, port, box)[0] ?? null;
  }

  /**
   * Runs the checks that requests and upgrades share. The request must come
   * from the front door over loopback and must use TLS to a credential host.
   * decideCredentials then decides the swap.
   *
   * @param req The intercepted request or upgrade.
   * @returns The hostname of the request and the result of the checks.
   */
  private screen(req: CompletedRequest): { host: string; verdict: Screening } {
    const policy = this.opts.policy();
    const { host, port, protocol } = targetOf(req);

    // The engine listens on every interface, and the proxy sits on every box
    // network. Only the front door, over loopback, may reach it, so an agent
    // cannot skip the checks of the front door.
    if (!isLoopback(req.remoteIpAddress)) {
      return {
        host,
        verdict: {
          action: 'refuse',
          category: 'blocked-address',
          reason: 'the interception engine is reachable from the proxy only',
        },
      };
    }

    const encrypted = protocol === 'https:' || protocol === 'wss:';
    if (!encrypted && credentialsForHost(host, port, policy).length > 0) {
      // In the clear a swap would put the real credential on the wire as
      // plaintext, and forwarding unswapped would hand over the placeholder.
      return {
        host,
        verdict: {
          action: 'refuse',
          category: 'plaintext-credential-host',
          reason: PLAINTEXT_CREDENTIAL_REASON,
        },
      };
    }

    return { host, verdict: decideCredentials(host, port, req.headers, policy) };
  }

  /**
   * Decides one intercepted request. The engine forwards it as it stands,
   * forwards it with the real credential in place of the placeholder, or refuses it.
   *
   * @param req The intercepted request.
   * @returns The result for the beforeRequest callback of the engine.
   */
  private decide(req: CompletedRequest): RequestDecision {
    const { host, verdict } = this.screen(req);
    if (verdict.action === 'pass') return;

    if (verdict.action === 'refuse') {
      this.opts.denied(verdict.category);
      this.opts.log('denied intercepted request', { host, reason: verdict.reason });
      return {
        response: {
          statusCode: 403,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: `egress denied: ${verdict.reason}\n`,
        },
      };
    }

    // The callback can only replace the full header set, so the originals are
    // copied. The engine takes a URL-linked header in the new set as an
    // explicit override, so the copy leaves those headers out.
    const headers: Headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (URL_LINKED_HEADERS.includes(name.toLowerCase())) continue;
      headers[name] = value;
    }
    for (const [name, value] of Object.entries(verdict.headers)) headers[name] = value;

    const credentials = this.opts.policy().credentials;
    const oauthId = verdict.credentialIds.find(
      (id) => credentials.find((c) => c.id === id)?.oauth === true,
    );
    if (oauthId !== undefined) {
      if (this.oauthRequests.size >= MAX_OAUTH_REQUESTS) {
        const oldest = this.oauthRequests.keys().next().value;
        if (oldest !== undefined) this.oauthRequests.delete(oldest);
      }
      this.oauthRequests.set(req.id, oauthId);
    }

    return { headers };
  }
}
