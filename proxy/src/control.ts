import { timingSafeEqual } from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import os from 'node:os';
import type { EgressPolicy, EgressStatus } from '../../shared/types.ts';
import { parsePolicy } from './policy.ts';

/**
 * The control channel: how the proxy gets its policy.
 *
 * The proxy boots empty. The orchestrator pushes the allowlist, the CA and the
 * credential map over this endpoint, and the proxy holds all of it in memory
 * for as long as it runs. A restarted proxy has nothing again until the
 * orchestrator's reconciler pushes afresh.
 *
 * Two things keep it out of a session's reach. It binds to the compose network
 * only, and a session sits on an internal network with no route to that
 * address. It also requires a bearer token, which nobody configures: the first
 * push sets it and every later push has to match, and the orchestrator is the
 * only party that can reach the interface to claim it.
 */

/** Largest policy body accepted, in bytes. */
const MAX_BODY = 1 << 20;

/** What the control server does with what it receives. */
export interface ControlOptions {
  /** Applies a pushed policy. Rejecting it answers the push with a 400. */
  apply: (policy: EgressPolicy) => Promise<void>;
  /** The current status to report back. */
  status: () => EgressStatus;
  /** Structured logging. */
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

/** Constant-time comparison of two tokens of any length. */
function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The address to bind the control channel to: this container's own address on
 * the network that carries the default route.
 *
 * Session networks are created internal, so they install no default route.
 * The compose network does, so the interface the default route leaves by is
 * the one the orchestrator is on. Connecting a UDP socket performs that route
 * lookup and sends nothing.
 *
 * Null means the lookup failed, and the caller then binds to loopback: an
 * unreachable control channel is a safe failure and an exposed one is not.
 */
export async function resolveControlAddress(): Promise<string | null> {
  const address = await new Promise<string | null>((resolve) => {
    const socket = dgram.createSocket('udp4');
    const done = (value: string | null): void => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(value);
    };
    socket.on('error', () => done(null));
    try {
      // A routable address outside every private range, so the lookup picks
      // the default route rather than a directly attached network.
      socket.connect(53, '192.0.2.1', () => {
        try {
          done(socket.address().address);
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });

  if (address === null || address === '0.0.0.0') return null;
  // Only bind to an address this container holds.
  const held = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .some((entry) => entry.address === address);
  return held ? address : null;
}

/** A control server, and the token it has accepted so far. */
export interface ControlServer {
  server: http.Server;
  /** True once a push has claimed the channel. */
  claimed: () => boolean;
}

/**
 * Builds the control server. The server is returned before it listens, and
 * holds no token until the first authenticated push claims the channel.
 */
export function createControlServer(opts: ControlOptions): ControlServer {
  let token: string | null = null;

  /** Answers with one JSON body and the length that goes with it. */
  const send = (res: http.ServerResponse, code: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  };

  /** Checks the bearer, claiming the channel if nobody has yet. */
  const authorize = (req: http.IncomingMessage): boolean => {
    const header = req.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    const presented = /^bearer\s+(.+)$/i.exec(value ?? '')?.[1]?.trim();
    if (!presented) return false;

    if (token === null) {
      token = presented;
      opts.log('control channel claimed by its first caller');
      return true;
    }
    return tokensMatch(token, presented);
  };

  const server = http.createServer((req, res) => {
    if (!authorize(req)) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      send(res, 200, opts.status());
      return;
    }

    if (req.method !== 'POST' || req.url !== '/policy') {
      send(res, 404, { error: 'not found' });
      return;
    }

    let body = '';
    let oversized = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (oversized) return;
      body += chunk;
      if (body.length > MAX_BODY) {
        oversized = true;
        send(res, 413, { error: 'policy too large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (oversized) return;
      void (async () => {
        try {
          const policy = parsePolicy(JSON.parse(body));
          await opts.apply(policy);
          send(res, 200, opts.status());
        } catch (err) {
          const message = (err as Error).message;
          opts.log('rejected a pushed policy', { error: message });
          send(res, 400, { error: message });
        }
      })();
    });
  });

  return { server, claimed: () => token !== null };
}
