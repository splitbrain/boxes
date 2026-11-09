/**
 * Entry point of the egress proxy.
 *
 * Box networks are internal. The orchestrator attaches the proxy to each box
 * network, and the proxy is the only way out of it. The proxy keeps all state
 * in memory and writes no secret to disk.
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { DEFAULT_PORTS } from '../../shared/hosts.ts';
import type { EgressPolicy, EgressRefusedToken, EgressStatus } from '../../shared/types.ts';
import { createControlServer, resolveControlAddress } from './control.ts';
import {
  createForwardServer,
  type DenialCategory,
  isProfileDenial,
  type Target,
} from './forward.ts';
import { Interceptor } from './inject.ts';
import {
  boxFromAuthorization,
  EMPTY_POLICY,
  injectionPatterns,
  policyHash,
  upstreamBoxPolicy,
} from './policy.ts';
import { RefusedTargets } from './refused.ts';

/**
 * Writes one JSON line to stderr.
 *
 * @param msg The message.
 * @param fields More fields for the line.
 */
function log(msg: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), msg, ...fields })}\n`);
}

/**
 * Reports a setting that the proxy cannot start with, and stops the process.
 *
 * @param message The description of the bad setting.
 */
function fatalConfig(message: string): never {
  log('fatal config error', { error: message });
  process.exit(1);
}

/**
 * Reads a port from the environment. A value that is not a port number stops
 * the proxy, because a wrong port would bind where nobody expects it.
 *
 * @param name The name of the environment variable.
 * @param fallback The port to use when the variable is unset or blank.
 * @returns The port.
 */
function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    fatalConfig(`${name} must be a whole number between 1 and 65535, not ${raw}`);
  }
  return value;
}

/** Port the proxy listens on, facing the boxes. */
const PORT = portFromEnv('PORT', 3128);

/** Port the control channel listens on, facing the orchestrator. */
const CONTROL_PORT = portFromEnv('CONTROL_PORT', 3129);

/** Address the control channel binds to. When unset, resolveControlAddress finds it. */
const CONTROL_BIND = process.env.CONTROL_BIND?.trim() ?? '';
if (CONTROL_BIND !== '' && net.isIP(CONTROL_BIND) === 0) {
  fatalConfig(`CONTROL_BIND must be an IP address, not ${CONTROL_BIND}`);
}

/** The live policy. Empty until the orchestrator pushes one. */
let policy: EgressPolicy = EMPTY_POLICY;

/** True after the first policy push, also when that policy is empty. */
let applied = false;

/**
 * Denials since boot, by category, reported on the control channel. The
 * categories are a fixed set, so an agent cannot grow this map or put a
 * hostname of its choice into the status.
 */
const denials = new Map<DenialCategory, number>();

/** The targets that the egress profile of each box refused. */
const refused = new RefusedTargets();

/**
 * The refused OAuth tokens since the last policy push, by credential id. The
 * next push answer takes them.
 */
const refusedTokens = new Map<string, EgressRefusedToken>();

/** Start time of this process in milliseconds since the epoch, for the uptime in the status. */
const bootedAt = Date.now();

/**
 * Counts one denial under its category. A denial by the egress profile also
 * goes into the list of refused targets of the box.
 *
 * @param category The category of the denial.
 * @param box The id of the box that sent the request, or undefined when it is not known.
 * @param target The refused target, or undefined when it is not known.
 */
function denied(category: DenialCategory, box?: string, target?: Target): void {
  denials.set(category, (denials.get(category) ?? 0) + 1);
  // The upstream tunnel has no box, so its denials have the empty box id.
  if (box && target !== undefined && isProfileDenial(category)) {
    refused.record(box, target.host, target.port, category);
  }
}

/**
 * Builds the status that the proxy reports on the control channel.
 *
 * @returns The current status.
 */
function status(): EgressStatus {
  return {
    applied,
    policyHash: policyHash(policy),
    boxCount: policy.boxes.length,
    credentialIds: policy.credentials.map((c) => c.id),
    denials: Object.fromEntries(denials),
    uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
  };
}

/**
 * The upstream tunnel, on loopback. The engine sends every connection through
 * it, so decrypted traffic gets the same checks. Its intercept port is always
 * null, so the connections of the engine do not loop back into the engine.
 */
const upstream = createForwardServer({
  policy: () => policy,
  identify: (_header, current) => upstreamBoxPolicy(current),
  interceptPort: () => null,
  applied: () => applied,
  denied,
  log: (msg, fields) => log(msg, { via: 'upstream', ...fields }),
});

/** Port the upstream tunnel listens on, known once it is bound. */
let upstreamPort = 0;

/** The id of the box of each open connection from the front door to the engine, by the local port of the connection. */
const engineClients = new Map<number, string>();

/** The controller of the TLS interception engine for the credential hosts and the hosts with an upstream CA. */
const interceptor = new Interceptor({
  policy: () => policy,
  upstreamProxyUrl: () => `http://127.0.0.1:${upstreamPort}`,
  engineClients,
  denied,
  refusedToken: (report) => {
    refusedTokens.set(report.credentialId, report);
    log('a server refused an OAuth token', {
      credential: report.credentialId,
      status: report.status,
      error: report.error,
    });
  },
  log,
});

/**
 * The front door, facing the boxes. It forwards vetted requests and tunnels,
 * and hands a CONNECT to a credential host or to a host with an upstream CA of
 * the box to the interception engine.
 */
const front = createForwardServer({
  policy: () => policy,
  identify: boxFromAuthorization,
  interceptPort: () => interceptor.port(),
  engineClients,
  applied: () => applied,
  denied,
  log,
});

/** The last queued policy push. queuePush chains each new push to it. */
let pushes: Promise<void> = Promise.resolve();

/**
 * Runs one policy push after the previous push has finished or failed.
 *
 * A push that the engine refuses restores the previous policy. The queue keeps
 * the rollback from discarding a policy that another push applied.
 *
 * @param work The push to run.
 * @returns The result of the push.
 */
function queuePush(work: () => Promise<void>): Promise<void> {
  const next = pushes.then(work, work);
  // A failure belongs to the push that asked, not to the pushes behind it.
  pushes = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** The control channel, facing the orchestrator. */
const control = createControlServer({
  apply: (pushed) =>
    queuePush(async () => {
      const previous = policy;
      policy = pushed;
      try {
        await interceptor.apply();
      } catch (err) {
        // Restore the previous policy, so that no credential stays configured
        // without an engine to swap it in.
        policy = previous;
        await interceptor.apply().catch(() => undefined);
        throw new Error(`could not apply policy: ${(err as Error).message}`);
      }
      applied = true;
      refused.retain(new Set(policy.boxes.map((b) => b.box)));
      log('applied policy', {
        hash: policyHash(policy),
        boxes: policy.boxes.length,
        credentials: policy.credentials.map((c) => c.id),
        intercepting: injectionPatterns(policy),
      });
    }),
  status,
  takeRefusedTokens: () => {
    const reports = [...refusedTokens.values()];
    refusedTokens.clear();
    return reports;
  },
  denials: (box) => refused.list(box),
  log,
});

/**
 * Starts a server listening.
 *
 * @param server The server to start.
 * @param port The port, or 0 for a free port.
 * @param host The address to bind to.
 * @returns The port that the server is bound to.
 */
function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** Starts the three listeners, resolving the control bind address last. */
async function main(): Promise<void> {
  upstreamPort = await listen(upstream, 0, '127.0.0.1');
  log('upstream tunnel listening', { port: upstreamPort });

  await listen(front, PORT, '0.0.0.0');
  log('egress proxy listening', { port: PORT, defaultPorts: [...DEFAULT_PORTS] });

  const bind = CONTROL_BIND || (await resolveControlAddress());
  if (bind === null) {
    // A bind to all interfaces would open the channel that carries the secrets
    // to every box network. On loopback, the pushes of the orchestrator fail,
    // and the orchestrator shows the error in /healthz.
    log('WARNING: could not resolve the control interface; binding to loopback only');
  }
  await listen(control.server, CONTROL_PORT, bind ?? '127.0.0.1');
  log('control channel listening', { port: CONTROL_PORT, address: bind ?? '127.0.0.1' });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log('shutting down', { signal });
    // Closing the front door waits for every tunnel through it, and a busy one
    // must not keep the process alive.
    setTimeout(() => process.exit(0), 5_000).unref();
    void interceptor.stop().finally(() => {
      control.server.close();
      upstream.close();
      front.close(() => process.exit(0));
    });
  });
}

main().catch((err: Error) => {
  log('fatal boot error', { error: err.message });
  process.exit(1);
});
