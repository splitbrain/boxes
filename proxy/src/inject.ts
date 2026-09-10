import * as mockttp from 'mockttp';
import type { CompletedRequest, Headers } from 'mockttp';
import type { EgressPolicy } from '../../shared/types.ts';
import { decideCredentials, injectionPatterns } from './policy.ts';

/**
 * The TLS interception engine, and the one place a real credential is written
 * onto the wire.
 *
 * It runs on loopback and is fed by the front door, which hands it only a host
 * that has a credential configured. Everything else stays an opaque tunnel
 * this process cannot read.
 *
 * Every request it forwards goes back out through the upstream tunnel, so the
 * resolved-address vetting still governs the connection that leaves.
 */

/** What the interceptor needs from the process around it. */
export interface InterceptorOptions {
  /** The live policy. */
  policy: () => EgressPolicy;
  /** Loopback URL of the tunnel every upstream connection must go through. */
  upstreamProxyUrl: () => string;
  /** Records a denial, by reason. */
  denied: (reason: string) => void;
  /** Structured logging. */
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

/** Headers the engine derives from the request URL, so a copy must not pin them. */
const URL_LINKED_HEADERS = ['host', ':authority'];

/**
 * What this proxy tells the engine to do with a request: leave it alone,
 * forward it with a rewritten header set, or answer it with a refusal. Stated
 * structurally because the engine's callback result type is not part of its
 * public surface.
 */
type RequestDecision =
  | void
  | { headers: Headers }
  | {
      response: {
        statusCode: number;
        headers: Record<string, string>;
        body: string;
      };
    };

/** Starts, restarts and stops the engine as the policy requires. */
export class Interceptor {
  private server: mockttp.Mockttp | null = null;

  /** Fingerprint of the CA the running server was started with. */
  private runningCert: string | null = null;

  constructor(private readonly opts: InterceptorOptions) {}

  /** Loopback port the front door hands intercepted connections to, if any. */
  port(): number | null {
    return this.server?.port ?? null;
  }

  /**
   * Brings the engine in line with the current policy.
   *
   * A policy with no CA or no credential stops it, so a deployment that
   * configures no credential decrypts nothing. A changed CA restarts it,
   * because the certificates it mints are derived from that key. A changed
   * credential needs neither, since the rule reads the policy per request.
   */
  async apply(): Promise<void> {
    const policy = this.opts.policy();
    const wanted = policy.ca !== null && policy.credentials.length > 0 ? policy.ca : null;

    if (wanted === null) {
      await this.stop();
      return;
    }
    if (this.server && this.runningCert === wanted.cert) return;

    await this.stop();
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
      await server
        .forAnyRequest()
        .thenPassThrough({
          beforeRequest: (req) => this.decide(req),
          proxyConfig: { proxyUrl: this.opts.upstreamProxyUrl() },
        });

      await server.on('tls-client-error', (failure) => {
        // The shape of a tool that ignores the CA env vars: it reaches an
        // intercepted host and refuses the certificate.
        this.opts.log('TLS handshake rejected by the client', {
          host: failure.tlsMetadata?.sniHostname ?? null,
          reason: failure.failureCause,
        });
      });
    } catch (err) {
      // A listening engine with no rule would forward without deciding.
      await server.stop().catch(() => undefined);
      throw err;
    }

    this.server = server;
    this.runningCert = wanted.cert;
    this.opts.log('interception engine started', {
      port: server.port,
      hosts: injectionPatterns(policy),
    });
  }

  /** Stops the engine, leaving nothing decrypting. */
  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.runningCert = null;
    try {
      await server.stop();
    } catch (err) {
      this.opts.log('interception engine failed to stop cleanly', {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Decides one intercepted request: forward it as it stands, forward it with
   * the real credential in place of the placeholder, or refuse it here.
   */
  private decide(req: CompletedRequest): RequestDecision {
    const policy = this.opts.policy();
    let host: string;
    try {
      host = new URL(req.url).hostname;
    } catch {
      host = req.destination?.hostname ?? '';
    }

    const verdict = decideCredentials(host, req.headers, policy);
    if (verdict.action === 'pass') return;

    if (verdict.action === 'deny') {
      this.opts.denied(verdict.reason);
      this.opts.log('denied intercepted request', { host, reason: verdict.reason });
      return {
        response: {
          statusCode: 403,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: `egress denied: ${verdict.reason}\n`,
        },
      };
    }

    // Replacing the header set wholesale is the callback's only option, so the
    // originals are copied. The URL-linked headers are dropped: the engine
    // derives them from the request URL, and reads a copy as a rewrite.
    const headers: Headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (URL_LINKED_HEADERS.includes(name.toLowerCase())) continue;
      headers[name] = value;
    }
    for (const [name, value] of Object.entries(verdict.headers)) headers[name] = value;

    return { headers };
  }
}
