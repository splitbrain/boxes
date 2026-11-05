/** The forward proxy server, which vets every destination before it connects. */

import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import { type AddressKind, addressKind, answerKind } from '../../shared/cidr.ts';
import { DEFAULT_PORTS } from '../../shared/hosts.ts';
import type { EgressBoxPolicy, EgressPolicy } from '../../shared/types.ts';
import { hostAllowed, hostListed, isInjectionHost } from './policy.ts';

/** Time limit to open the upstream connection of a CONNECT, in milliseconds. */
const CONNECT_TIMEOUT_MS = 15_000;

/** Time limit for an idle upstream connection, in milliseconds. */
const IDLE_TIMEOUT_MS = 120_000;

/** Time limit for the TLS engine to answer a replayed CONNECT, in milliseconds. */
const INTERCEPT_HANDSHAKE_MS = 10_000;

/** Categories of denial reasons. The proxy counts and reports each category. */
export type DenialCategory =
  | 'port'
  | 'allowlist'
  | 'blocked-address'
  | 'private-address'
  | 'dns'
  | 'credential-upgrade'
  | 'plaintext-credential-host'
  | 'no-policy'
  | 'proxy-auth';

/** Denial reason for a request to a credential host without TLS. */
export const PLAINTEXT_CREDENTIAL_REASON = 'a credential host may only be reached over https';

/** Denial reason while the proxy waits for its first policy. */
const NO_POLICY_REASON = 'the proxy has no policy yet';

/** The reason phrase of the status line of a refusal by the egress profile. */
const PROFILE_STATUS = 'Not allowed by the egress profile';

/** The headers of the 407 answer to a request without a valid box identity. */
const PROXY_AUTH_HEADERS = {
  'Proxy-Authenticate': 'Basic realm="boxes"',
  'Content-Length': '0',
  Connection: 'close',
};

/** The 407 answer to a CONNECT without a valid box identity, as raw HTTP. */
const PROXY_AUTH_RESPONSE = [
  'HTTP/1.1 407 Proxy Authentication Required',
  ...Object.entries(PROXY_AUTH_HEADERS).map(([name, value]) => `${name}: ${value}`),
  '',
  '',
].join('\r\n');

/** Destination of a request. */
export interface Target {
  /** Hostname or IP literal, without brackets. */
  host: string;
  /** Destination port. */
  port: number;
}

/**
 * Splits an authority into host and port. A bracketed host must be an IPv6
 * address, and nothing but a port may follow the brackets.
 *
 * @param authority The authority, as in example.com:443 or [::1]:443.
 * @param defaultPort The port to use when the authority names none.
 * @returns The host and port, or null when the authority is malformed.
 */
export function parseHostPort(authority: string, defaultPort: number): Target | null {
  // Bracketed IPv6 literal, as in [::1]:443
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end === -1) return null;
    const host = authority.slice(1, end);
    const rest = authority.slice(end + 1);
    if (net.isIP(host) !== 6) return null;
    if (rest !== '' && !rest.startsWith(':')) return null;
    const port = rest === '' ? defaultPort : Number(rest.slice(1));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { host, port };
  }
  const colon = authority.lastIndexOf(':');
  const host = colon === -1 ? authority : authority.slice(0, colon);
  if (host === '' || host.includes(':')) return null;
  const port = colon === -1 ? defaultPort : Number(authority.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

/** The outcome of vetting a target. */
export type Verdict =
  /** The target passed. address is the IP address to connect to, and family is its IP version. */
  | { ok: true; address: string; family: number }
  /** The target failed. category is the counted category, and reason says why. */
  | { ok: false; category: DenialCategory; reason: string };

/**
 * Checks if a denial category comes from the egress profile of a box, so
 * that a change to the profile can lift it.
 *
 * @param category The category of the denial.
 * @returns True for the categories allowlist, port and private-address.
 */
export function isProfileDenial(category: DenialCategory): boolean {
  return category === 'allowlist' || category === 'port' || category === 'private-address';
}

/**
 * Turns the kind of an address into a verdict. A public address passes. A
 * private address passes only when a host pattern of the box names the
 * target. A forbidden address never passes.
 *
 * @param kind The kind of the address or of the DNS answer.
 * @param listed True when a host pattern of the box names the target.
 * @param what The subject of the reason, as in "target address" or "an address of the hostname".
 * @returns Null when the address passes, or the denial.
 */
function addressDenial(
  kind: AddressKind,
  listed: boolean,
  what: string,
): { category: DenialCategory; reason: string } | null {
  if (kind === 'public' || (kind === 'private' && listed)) return null;
  if (kind === 'private') {
    return {
      category: 'private-address',
      reason: `${what} is in a private range, which only a host in the egress profile of this box can reach`,
    };
  }
  return { category: 'blocked-address', reason: `${what} is in a blocked range` };
}

/**
 * Vets a target and finds the single address to pin the connection to. An IP
 * literal is checked as it is. A hostname is resolved, and every answer must
 * pass. The host check comes before DNS, so a denied host is never looked up.
 *
 * @param target The destination of the request.
 * @param box The policy of the box that sent the request.
 * @returns The verdict, with the first resolved address when the target passes.
 */
export async function vetTarget(target: Target, box: EgressBoxPolicy): Promise<Verdict> {
  if (!hostAllowed(target.host, target.port, box)) {
    return {
      ok: false,
      category: DEFAULT_PORTS.has(target.port) ? 'allowlist' : 'port',
      reason: `${formatTarget(target)} is not allowed by the egress profile of this box`,
    };
  }

  // A private address needs a host that the user named. The open mode alone
  // does not open private networks.
  const listed = hostListed(target.host, target.port, box);

  const literalFamily = net.isIP(target.host);
  if (literalFamily !== 0) {
    const denial = addressDenial(addressKind(target.host), listed, 'target address');
    if (denial) return { ok: false, ...denial };
    return { ok: true, address: target.host, family: literalFamily };
  }

  let answers: dns.LookupAddress[];
  try {
    answers = await dns.promises.lookup(target.host, { all: true });
  } catch (err) {
    return {
      ok: false,
      category: 'dns',
      reason: `DNS lookup failed: ${(err as Error).message}`,
    };
  }

  const chosen = answers[0];
  if (!chosen) return { ok: false, category: 'dns', reason: 'no addresses resolved' };
  // The most restricted answer decides, against DNS rebinding. A hostname must
  // not pass with a public record and connect with a private one.
  const denial = addressDenial(
    answerKind(answers.map((a) => a.address)),
    listed,
    'an address of the hostname',
  );
  if (denial) return { ok: false, ...denial };
  return { ok: true, address: chosen.address, family: chosen.family };
}

/**
 * Writes a target as host and port. An IPv6 literal is in brackets.
 *
 * @param target The target.
 * @returns The target as in example.com:443 or [::1]:443.
 */
function formatTarget(target: Target): string {
  return net.isIP(target.host) === 6
    ? `[${target.host}]:${target.port}`
    : `${target.host}:${target.port}`;
}

/** Callbacks of a forward proxy server. */
export interface ForwardOptions {
  /** Returns the live policy. The server reads it for each request, so a push takes effect at once. */
  policy: () => EgressPolicy;
  /**
   * Finds the policy of the box that sent a request.
   *
   * @param header The value of the Proxy-Authorization header, or undefined when the request has none.
   * @param policy The live policy.
   * @returns The policy of the box, or null to answer the request with a 407.
   */
  identify: (header: string | undefined, policy: EgressPolicy) => EgressBoxPolicy | null;
  /** Returns the loopback port of the TLS engine, or null for no interception. */
  interceptPort: () => number | null;
  /** Returns true after the first policy push. The server forwards nothing before it. */
  applied: () => boolean;
  /**
   * Counts one denial under its category.
   *
   * @param category The category of the denial.
   * @param box The id of the box that sent the request, or undefined when it is not known.
   * @param target The refused target, or undefined when it is not known.
   */
  denied: (category: DenialCategory, box?: string, target?: Target) => void;
  /** Writes one structured log line. */
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Answers a forwarded request with a 403 and the reason.
 *
 * @param res The response to the client.
 * @param reason The denial reason.
 * @param category The category of the denial. A refusal by the egress profile gets its own reason phrase.
 */
function deny(res: http.ServerResponse, reason: string, category?: DenialCategory): void {
  const phrase = category !== undefined && isProfileDenial(category) ? PROFILE_STATUS : 'Forbidden';
  res.writeHead(403, phrase, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`egress denied: ${reason}\n`);
}

/**
 * Reads the first value of the Proxy-Authorization header.
 *
 * @param req The request from the client.
 * @returns The value, or undefined when the request has none.
 */
function proxyAuthorization(req: http.IncomingMessage): string | undefined {
  const header = req.headers['proxy-authorization'];
  return Array.isArray(header) ? header[0] : header;
}

/** Hop-by-hop headers, which end at this proxy. */
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * Copies the headers that may go on to the origin. The Connection header names
 * further headers that end at this hop, and every name is compared in lower
 * case.
 *
 * @param headers The headers of the client request.
 * @returns The headers without the hop-by-hop headers.
 */
export function forwardableHeaders(headers: http.IncomingHttpHeaders): http.IncomingHttpHeaders {
  const drop = new Set(HOP_BY_HOP_HEADERS);
  const connection = headers.connection;
  const named = Array.isArray(connection) ? connection.join(',') : (connection ?? '');
  for (const name of named.split(',')) {
    const trimmed = name.trim().toLowerCase();
    if (trimmed !== '') drop.add(trimmed);
  }

  const kept: http.IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (drop.has(name.toLowerCase())) continue;
    kept[name] = value;
  }
  return kept;
}

/**
 * Builds a forward proxy for plain HTTP requests with an absolute URI and for
 * CONNECT tunnels. The caller starts it listening.
 *
 * @param opts The callbacks of the server.
 * @returns The server, not yet listening.
 */
export function createForwardServer(opts: ForwardOptions): http.Server {
  const server = http.createServer();

  // Plain HTTP with an absolute URI.

  server.on('request', (req, res) => {
    if (!opts.applied()) {
      opts.denied('no-policy');
      opts.log('denied http request', { reason: NO_POLICY_REASON });
      deny(res, NO_POLICY_REASON);
      return;
    }

    const rawUrl = req.url ?? '';
    if (!/^https?:\/\//i.test(rawUrl)) {
      // A non-absolute request URI addresses this process as an origin server.
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('this is a forward proxy; use an absolute request URI\n');
      return;
    }

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      deny(res, 'malformed URL');
      return;
    }
    if (url.protocol !== 'http:') {
      // This path sends plain HTTP to the origin, so https must arrive as CONNECT.
      deny(res, 'only http:// may be forwarded; use CONNECT for https');
      return;
    }

    const target = parseHostPort(url.host, 80);
    if (!target) {
      deny(res, 'malformed host');
      return;
    }

    const policy = opts.policy();
    const box = opts.identify(proxyAuthorization(req), policy);
    if (!box) {
      opts.denied('proxy-auth');
      opts.log('denied http request', { host: target.host, reason: 'no valid box identity' });
      res.writeHead(407, PROXY_AUTH_HEADERS);
      res.end();
      return;
    }

    if (req.headers.upgrade) {
      // A forwarded upgrade would leave this proxy with a protocol it cannot
      // vet, and the request would never reach its response callback.
      res.writeHead(501, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('protocol upgrades are not forwarded\n');
      return;
    }

    if (opts.interceptPort() !== null && isInjectionHost(target.host, target.port, policy)) {
      // In the clear, a credential host would get the placeholder, or the real
      // secret as plaintext.
      opts.denied('plaintext-credential-host', box.box, target);
      opts.log('denied http request', {
        box: box.box,
        host: target.host,
        reason: PLAINTEXT_CREDENTIAL_REASON,
      });
      deny(res, PLAINTEXT_CREDENTIAL_REASON);
      return;
    }

    void vetTarget(target, box).then((verdict) => {
      if (!verdict.ok) {
        opts.denied(verdict.category, box.box, target);
        opts.log('denied http request', {
          box: box.box,
          host: target.host,
          port: target.port,
          category: verdict.category,
          reason: verdict.reason,
        });
        deny(res, verdict.reason, verdict.category);
        return;
      }
      // The client can disconnect before the vetting ends.
      if (res.destroyed) return;

      const headers = forwardableHeaders(req.headers);
      headers.host = url.host;

      const upstream = http.request(
        {
          // Pinned to the vetted address. The Host header preserves virtual
          // hosting, and no second resolution can race the check.
          host: verdict.address,
          port: target.port,
          method: req.method,
          path: `${url.pathname}${url.search}`,
          headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
      upstream.on('error', (err) => {
        opts.log('upstream http error', { host: target.host, error: err.message });
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        res.end('upstream error\n');
      });
      // A client that hangs up must not leave the request to the origin running.
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    });
  });

  // CONNECT tunnels.

  server.on('connect', (req, clientSocket: net.Socket, head: Buffer) => {
    // A client can reset the socket while a refusal is written, and an error without a listener stops the process.
    clientSocket.on('error', () => clientSocket.destroy());
    const refuse = (code: number, reason: string): void => {
      try {
        clientSocket.write(`HTTP/1.1 ${code} ${reason}\r\n\r\n`);
      } catch {
        // client already gone
      }
      clientSocket.destroy();
    };

    if (!opts.applied()) {
      opts.denied('no-policy');
      opts.log('denied CONNECT', { reason: NO_POLICY_REASON });
      refuse(403, 'Forbidden');
      return;
    }

    const target = parseHostPort(req.url ?? '', 443);
    if (!target) {
      refuse(400, 'Bad Request');
      return;
    }

    const policy = opts.policy();
    const box = opts.identify(proxyAuthorization(req), policy);
    if (!box) {
      opts.denied('proxy-auth');
      opts.log('denied CONNECT', { host: target.host, reason: 'no valid box identity' });
      try {
        clientSocket.end(PROXY_AUTH_RESPONSE);
      } catch {
        clientSocket.destroy();
      }
      return;
    }

    void vetTarget(target, box).then((verdict) => {
      if (!verdict.ok) {
        opts.denied(verdict.category, box.box, target);
        opts.log('denied CONNECT', {
          box: box.box,
          host: target.host,
          port: target.port,
          category: verdict.category,
          reason: verdict.reason,
        });
        if (isProfileDenial(verdict.category)) {
          const body = `egress denied: ${verdict.reason}\n`;
          try {
            clientSocket.end(
              `HTTP/1.1 403 ${PROFILE_STATUS}\r\n` +
                'Content-Type: text/plain; charset=utf-8\r\n' +
                `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                `Connection: close\r\n\r\n${body}`,
            );
          } catch {
            clientSocket.destroy();
          }
          return;
        }
        refuse(403, 'Forbidden');
        return;
      }

      const enginePort = opts.interceptPort();
      if (enginePort !== null && isInjectionHost(target.host, target.port, policy)) {
        if (target.port === 80) {
          // The proxy takes port 80 as plain HTTP. There, the engine could swap
          // the real credential into plaintext.
          opts.denied('plaintext-credential-host', box.box, target);
          opts.log('denied CONNECT', {
            box: box.box,
            host: target.host,
            port: target.port,
            reason: PLAINTEXT_CREDENTIAL_REASON,
          });
          refuse(403, 'Forbidden');
          return;
        }
        connectToEngine(target, enginePort, clientSocket, head, opts);
        return;
      }

      // Once the tunnel is established the client may be speaking TLS, so a
      // later failure closes it rather than writing a status line into it.
      let established = false;
      const upstream = net.connect(
        { host: verdict.address, port: target.port, family: verdict.family },
        () => {
          established = true;
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length > 0) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        },
      );

      upstream.setTimeout(CONNECT_TIMEOUT_MS, () => {
        upstream.destroy();
        clientSocket.destroy();
      });
      upstream.on('connect', () => upstream.setTimeout(IDLE_TIMEOUT_MS));
      upstream.on('error', (err) => {
        opts.log('upstream CONNECT error', { host: target.host, error: err.message });
        if (established) clientSocket.destroy();
        else refuse(502, 'Bad Gateway');
        upstream.destroy();
      });
      clientSocket.on('error', () => upstream.destroy());
      clientSocket.on('close', () => upstream.destroy());
    });
  });

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

/**
 * Hands an intercepted CONNECT to the TLS engine on loopback.
 *
 * The function replays the CONNECT to the engine, so the engine learns the
 * destination and picks the certificate for the host that the client asked for.
 *
 * @param target The vetted destination.
 * @param enginePort The loopback port of the engine.
 * @param clientSocket The socket of the client.
 * @param head The bytes that the client sent after its CONNECT.
 * @param opts The callbacks of the server.
 */
function connectToEngine(
  target: Target,
  enginePort: number,
  clientSocket: net.Socket,
  head: Buffer,
  opts: ForwardOptions,
): void {
  const authority = `${target.host}:${target.port}`;
  const engine = net.connect({ host: '127.0.0.1', port: enginePort }, () => {
    engine.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });

  // Once the tunnel is established the client speaks TLS, so a late failure
  // closes it rather than writing a status line into the stream.
  let established = false;
  const failed = (reason: string): void => {
    clearTimeout(handshake);
    opts.log('interception failed', { host: target.host, reason });
    if (!established) {
      try {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      } catch {
        // client already gone
      }
    }
    clientSocket.destroy();
    engine.destroy();
  };

  const handshake = setTimeout(
    () => failed('engine did not answer the CONNECT'),
    INTERCEPT_HANDSHAKE_MS,
  );
  handshake.unref?.();

  let banner = Buffer.alloc(0);
  const onData = (chunk: Buffer): void => {
    banner = Buffer.concat([banner, chunk]);
    const end = banner.indexOf('\r\n\r\n');
    if (end === -1) {
      if (banner.length > 8192) failed('engine sent an oversized CONNECT reply');
      return;
    }
    clearTimeout(handshake);
    engine.off('data', onData);

    const status = banner.subarray(0, banner.indexOf('\r\n')).toString('latin1');
    if (!/^HTTP\/1\.[01] 200/.test(status)) {
      failed(`engine refused the CONNECT: ${status}`);
      return;
    }

    established = true;
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    // Anything the engine sent past its own reply belongs to the client.
    const rest = banner.subarray(end + 4);
    if (rest.length > 0) clientSocket.write(rest);
    if (head.length > 0) engine.write(head);
    engine.pipe(clientSocket);
    clientSocket.pipe(engine);
  };

  engine.on('data', onData);
  engine.setTimeout(IDLE_TIMEOUT_MS, () => engine.destroy());
  engine.on('error', (err) => failed(err.message));
  clientSocket.on('error', () => engine.destroy());
  clientSocket.on('close', () => engine.destroy());
}
