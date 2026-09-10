import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import type { EgressPolicy } from '../../shared/types.ts';
import { allAddressesAllowed, isBlockedAddress } from './cidr.ts';
import { hostAllowed, isInjectionHost } from './policy.ts';

/**
 * The forwarding half of the proxy: allowlist, address vetting, and the pinned
 * connection out.
 *
 * The proxy runs two of these. The front door faces the session networks and
 * may hand an intercepted host to the TLS engine; the upstream tunnel listens
 * on loopback and vets every connection the TLS engine makes, so decrypting a
 * host buys no way around the checks below.
 */

/** Destination ports an agent may reach. */
export const ALLOWED_PORTS = new Set([80, 443]);

/** How long a CONNECT may take to establish, in milliseconds. */
const CONNECT_TIMEOUT_MS = 15_000;

/** How long an established connection may sit idle, in milliseconds. */
const IDLE_TIMEOUT_MS = 120_000;

/** How long the TLS engine has to accept a replayed CONNECT, in milliseconds. */
const INTERCEPT_HANDSHAKE_MS = 10_000;

/** Where a request wants to go. */
export interface Target {
  host: string;
  port: number;
}

/** Splits an authority into host and port, or null if it is malformed. */
export function parseHostPort(authority: string, defaultPort: number): Target | null {
  // IPv6 literals arrive bracketed: [::1]:443
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end === -1) return null;
    const host = authority.slice(1, end);
    const rest = authority.slice(end + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : defaultPort;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { host, port };
  }
  const colon = authority.lastIndexOf(':');
  if (colon === -1) return { host: authority, port: defaultPort };
  const host = authority.slice(0, colon);
  const port = Number(authority.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (host === '') return null;
  return { host, port };
}

/** The outcome of vetting a target. */
export type Verdict =
  | { ok: true; address: string; family: number }
  | { ok: false; reason: string };

/**
 * Vets a target and returns the single address to pin the connection to. An IP
 * literal is checked as it stands; a hostname is resolved first and every
 * answer has to pass. The allowlist is checked first, so a denied host is
 * never looked up.
 */
export async function vetTarget(target: Target, policy: EgressPolicy): Promise<Verdict> {
  if (!ALLOWED_PORTS.has(target.port)) {
    return { ok: false, reason: `port ${target.port} not allowed` };
  }
  if (!hostAllowed(target.host, policy)) {
    return { ok: false, reason: 'host is not on the egress allowlist' };
  }

  // An IP literal skips DNS but goes through the identical CIDR check.
  const literalFamily = net.isIP(target.host);
  if (literalFamily !== 0) {
    if (isBlockedAddress(target.host)) {
      return { ok: false, reason: 'target address is in a blocked range' };
    }
    return { ok: true, address: target.host, family: literalFamily };
  }

  let answers: dns.LookupAddress[];
  try {
    answers = await dns.promises.lookup(target.host, { all: true });
  } catch (err) {
    return { ok: false, reason: `DNS lookup failed: ${(err as Error).message}` };
  }

  const addresses = answers.map((a) => a.address);
  if (!allAddressesAllowed(addresses)) {
    // Rejecting when any answer is private closes DNS rebinding: a hostname
    // must not pass with a public record and connect with a private one.
    return { ok: false, reason: 'hostname resolves to a blocked address' };
  }

  const chosen = answers[0];
  if (!chosen) return { ok: false, reason: 'no addresses resolved' };
  return { ok: true, address: chosen.address, family: chosen.family };
}

/** What a forwarding server needs from the process around it. */
export interface ForwardOptions {
  /** The live policy, read per request so a push takes effect at once. */
  policy: () => EgressPolicy;
  /**
   * Loopback port of the TLS engine, or null when this server never
   * intercepts. The upstream tunnel passes null, which is what keeps the
   * engine's own connections from looping back into it.
   */
  interceptPort: () => number | null;
  /** Records a denial, by reason. */
  denied: (reason: string) => void;
  /** Structured logging. */
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

/** Answers a forwarded request with a 403 and the reason. */
function deny(res: http.ServerResponse, reason: string): void {
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`egress denied: ${reason}\n`);
}

/**
 * Builds a forward proxy: absolute-URI HTTP on port 80, CONNECT for
 * everything else. The server is returned before it listens.
 */
export function createForwardServer(opts: ForwardOptions): http.Server {
  const server = http.createServer();

  // --- absolute-URI plain HTTP (port 80) ------------------------------------

  server.on('request', (req, res) => {
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
      // https must arrive as CONNECT: plaintext forwarding never terminates TLS.
      deny(res, 'only http:// may be forwarded; use CONNECT for https');
      return;
    }

    const target = parseHostPort(url.host, 80);
    if (!target) {
      deny(res, 'malformed host');
      return;
    }

    const policy = opts.policy();
    if (opts.interceptPort() !== null && isInjectionHost(target.host, policy)) {
      // A credential host reached in the clear would leak the placeholder, or
      // invite injecting the real secret into plaintext. These hosts serve
      // https anyway.
      const reason = 'a credential host may only be reached over https';
      opts.denied(reason);
      opts.log('denied http request', { host: target.host, reason });
      deny(res, reason);
      return;
    }

    void vetTarget(target, policy).then((verdict) => {
      if (!verdict.ok) {
        opts.denied(verdict.reason);
        opts.log('denied http request', {
          host: target.host,
          port: target.port,
          reason: verdict.reason,
        });
        deny(res, verdict.reason);
        return;
      }

      const headers = { ...req.headers };
      delete headers['proxy-connection'];
      delete headers['proxy-authorization'];
      headers['host'] = url.host;

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
      req.pipe(upstream);
    });
  });

  // --- CONNECT tunnel (port 443) --------------------------------------------

  server.on('connect', (req, clientSocket: net.Socket, head: Buffer) => {
    const refuse = (code: number, reason: string): void => {
      try {
        clientSocket.write(`HTTP/1.1 ${code} ${reason}\r\n\r\n`);
      } catch {
        // client already gone
      }
      clientSocket.destroy();
    };

    const target = parseHostPort(req.url ?? '', 443);
    if (!target) {
      refuse(400, 'Bad Request');
      return;
    }

    const policy = opts.policy();
    void vetTarget(target, policy).then((verdict) => {
      if (!verdict.ok) {
        opts.denied(verdict.reason);
        opts.log('denied CONNECT', {
          host: target.host,
          port: target.port,
          reason: verdict.reason,
        });
        refuse(403, 'Forbidden');
        return;
      }

      const enginePort = opts.interceptPort();
      if (enginePort !== null && isInjectionHost(target.host, policy)) {
        connectToEngine(target, enginePort, clientSocket, head, opts);
        return;
      }

      const upstream = net.connect(
        { host: verdict.address, port: target.port, family: verdict.family },
        () => {
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
        refuse(502, 'Bad Gateway');
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
 * The CONNECT is replayed rather than the socket spliced, so the engine
 * learns the destination and picks the certificate for the host the client
 * asked for.
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

  // Once the tunnel is established the client is speaking TLS, so a late
  // failure has to close it rather than write a status line into the stream.
  let established = false;
  const failed = (reason: string): void => {
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

  const handshake = setTimeout(() => failed('engine did not answer the CONNECT'), INTERCEPT_HANDSHAKE_MS);
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
