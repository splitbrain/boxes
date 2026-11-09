/**
 * Tests for the real interception engine, reached over TLS as a client in a box
 * reaches it. The engine forwards to a stand-in tunnel and origin, so no test
 * needs the network.
 */

import { createHash } from 'node:crypto';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import tls from 'node:tls';
import * as mockttp from 'mockttp';
import { generateCACertificate } from 'mockttp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EgressPolicy, EgressRefusedToken } from '../../shared/types.ts';
import { Interceptor } from './inject.ts';

/** The placeholder that stands for the credential in a box. */
const PLACEHOLDER = 'ghp_PLACEHOLDERPLACEHOLDER';

/** The real credential. */
const SECRET = 'ghp_therealsecretvalue';

/** The deployment CA. The stand-in origin serves it as its own certificate. */
let ca: { key: string; cert: string };

/** Requests that arrived at the stand-in origin. */
let received: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];

/** The authorities that the engine sent to the stand-in tunnel in its CONNECT requests. */
let connects: string[] = [];

/** Ends the open event stream of the stand-in origin. */
let endStream: () => void = () => {};

/** A TLS server that stands in for the credential host. */
let origin: https.Server;

/** Port the stand-in origin listens on. */
let originPort = 0;

/** The hostname of the stand-in origin with a private CA. */
const PRIVATE_HOST = 'mcp.internal';

/** The private CA of the stand-in origin for PRIVATE_HOST. */
let privateCa: { key: string; cert: string };

/** A TLS server that stands in for PRIVATE_HOST. It signs its certificate with the private CA. */
let privateOrigin: mockttp.Mockttp;

/**
 * A stand-in for the upstream tunnel. It forwards each CONNECT to PRIVATE_HOST
 * to the private origin, and every other CONNECT to the stand-in origin.
 */
let tunnel: http.Server;

/** Port the stand-in tunnel listens on. */
let tunnelPort = 0;

/** The controller of the engine under test. */
let interceptor: Interceptor;

/** The policy that the engine reads. Each test sets it. */
let policy: EgressPolicy;

/** Count of the log lines in which the engine reports that it started. */
let starts = 0;

/** The refused OAuth tokens that the engine reported. */
let refusedTokens: EgressRefusedToken[] = [];

/** The server name of each TLS connection of the engine, and true when the connection named a CA list. */
let upstreamTls: Array<{ servername: string | undefined; ca: boolean }> = [];

/** The box of each connection of a test to the engine, by the local port of the connection. */
const engineClients = new Map<number, string>();

/** The unwrapped TLS client, for the connections these tests make themselves. */
const connectTls = tls.connect;

/** An answer read back from the engine. */
interface Answer {
  /** HTTP status code. */
  status: number;
  /** Response body, or the status message of a refused upgrade. */
  body: string;
}

/**
 * Starts a server on loopback.
 *
 * @param server The server to start.
 * @returns The port that the server listens on.
 */
const listen = (server: http.Server | https.Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });

/**
 * Lets the engine reach the stand-in origin over TLS.
 *
 * The engine checks the certificate of the origin against the system trust
 * store, and the test process cannot add a CA to that store at run time. The
 * wrapper skips the check for a connection that names no CA list, and records
 * each connection in upstreamTls. The connections of the tests use the
 * unwrapped client.
 */
function trustTheStandInOrigin(): void {
  const relaxed = (options: tls.ConnectionOptions, onSecure?: () => void): tls.TLSSocket => {
    upstreamTls.push({ servername: options.servername, ca: options.ca !== undefined });
    return connectTls(options.ca ? options : { ...options, rejectUnauthorized: false }, onSecure);
  };
  tls.connect = relaxed as typeof tls.connect;
}

beforeAll(async () => {
  ca = await generateCACertificate({ subject: { commonName: 'Boxes test CA' } });
  trustTheStandInOrigin();

  origin = https.createServer({ key: ca.key, cert: ca.cert }, (req, res) => {
    received.push({ url: req.url ?? '', headers: req.headers });
    const refusals: Record<string, [number, Record<string, string>]> = {
      '/expired': [401, { 'www-authenticate': 'Bearer error="invalid_token"' }],
      '/scope': [
        403,
        { 'www-authenticate': 'Bearer error="insufficient_scope", scope="write admin"' },
      ],
      '/forbidden': [403, {}],
    };
    const refusal = refusals[req.url ?? ''];
    if (refusal) {
      res.writeHead(refusal[0], refusal[1]);
      res.end('refused\n');
      return;
    }
    if (req.url === '/events') {
      // An event stream sends its first event and stays open until the test ends it.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      endStream = () => res.end('data: last\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('origin reached\n');
  });
  // Accepts every websocket, so a forwarded upgrade completes.
  origin.on('upgrade', (req: http.IncomingMessage, socket: net.Socket) => {
    received.push({ url: req.url ?? '', headers: req.headers });
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.end();
  });
  originPort = await listen(origin);

  privateCa = await generateCACertificate({ subject: { commonName: 'Boxes private test CA' } });
  privateOrigin = mockttp.getLocal({ https: privateCa });
  await privateOrigin.start();
  await privateOrigin.forGet().always().thenReply(200, 'private origin reached\n');
  await privateOrigin.forAnyWebSocket().always().thenEcho();

  // The engine reaches its proxy by CONNECT, whatever the target scheme.
  tunnel = http.createServer();
  tunnel.on('connect', (req, client, head) => {
    connects.push(req.url ?? '');
    const port = req.url?.startsWith(`${PRIVATE_HOST}:`) ? privateOrigin.port : originPort;
    const upstream = net.connect({ host: '127.0.0.1', port }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  tunnelPort = await listen(tunnel);

  interceptor = new Interceptor({
    policy: () => policy,
    upstreamProxyUrl: () => `http://127.0.0.1:${tunnelPort}`,
    engineClients,
    denied: () => {},
    refusedToken: (report) => refusedTokens.push(report),
    log: (msg) => {
      if (msg === 'interception engine started') starts += 1;
    },
  });
}, 30_000);

afterEach(() => {
  received = [];
  connects = [];
  refusedTokens = [];
  upstreamTls = [];
  endStream();
});

afterAll(async () => {
  await interceptor.stop();
  await privateOrigin.stop();
  origin.close();
  tunnel.close();
  tls.connect = connectTls;
});

/**
 * Makes a policy with one credential for api.github.com.
 *
 * @param over The fields to replace.
 * @returns The policy.
 */
function githubPolicy(over: Partial<EgressPolicy> = {}): EgressPolicy {
  return {
    boxes: [],
    ca,
    credentials: [
      {
        id: 'github',
        hosts: ['api.github.com'],
        headers: ['authorization'],
        placeholder: PLACEHOLDER,
        secret: SECRET,
      },
    ],
    ...over,
  };
}

/**
 * Opens a tunnel through the engine to one host, as a client in a box does.
 *
 * @param port The port of the engine.
 * @param authority The host and port to send in the CONNECT.
 * @param host The address of the engine to connect to.
 * @param box The id of the box that the connection belongs to, or undefined for no box.
 * @returns The socket, once the engine has answered the CONNECT.
 */
function tunnelThroughEngine(
  port: number,
  authority: string,
  host = '127.0.0.1',
  box?: string,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => {
      if (box !== undefined && socket.localPort !== undefined) {
        engineClients.set(socket.localPort, box);
      }
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      socket.once('data', () => resolve(socket));
    });
    socket.on('error', reject);
  });
}

/**
 * Sends a GET request through the engine over TLS and reads the answer.
 *
 * @param port The port of the engine.
 * @param headers The request headers.
 * @param host The hostname of the origin.
 * @param path The request path.
 * @param engineHost The address of the engine to connect to.
 * @param targetPort The port of the origin, as the client names it in the CONNECT.
 * @param box The id of the box that the connection belongs to, or undefined for no box.
 * @returns The status and the body of the answer.
 */
async function throughEngine(
  port: number,
  headers: http.OutgoingHttpHeaders,
  host = 'api.github.com',
  path = '/user',
  engineHost = '127.0.0.1',
  targetPort = 443,
  box?: string,
): Promise<Answer> {
  const socket = await tunnelThroughEngine(port, `${host}:${targetPort}`, engineHost, box);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        // With createConnection and no http.Agent, the request uses this socket and closes it.
        createConnection: () => connectTls({ socket, servername: host, ca: ca.cert }),
        host,
        port: targetPort,
        path,
        method: 'GET',
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Asks the engine to upgrade a connection to a websocket.
 *
 * @param port The port of the engine.
 * @param extraHeaders More request headers.
 * @param host The hostname of the origin.
 * @param path The request path.
 * @param box The id of the box that the connection belongs to, or undefined for no box.
 * @returns Status 101 when the engine forwarded the upgrade. Otherwise the
 *   status of the refusal, with its status message as the body.
 */
async function upgradeThroughEngine(
  port: number,
  extraHeaders: http.OutgoingHttpHeaders = {},
  host = 'api.github.com',
  path = '/v1/responses',
  box?: string,
): Promise<Answer> {
  const socket = await tunnelThroughEngine(port, `${host}:443`, '127.0.0.1', box);
  return new Promise((resolve, reject) => {
    const req = https.request({
      createConnection: () => connectTls({ socket, servername: host, ca: ca.cert }),
      host,
      path,
      method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'uay0UrT0EHqIs+QoxwgNtQ==',
        ...extraHeaders,
      },
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, body: res.statusMessage ?? '' });
    });
    req.on('upgrade', (_res, upgraded: net.Socket) => {
      upgraded.destroy();
      resolve({ status: 101, body: '' });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Sends a plain proxy request straight at the engine and reads the answer.
 *
 * @param port The port of the engine.
 * @param headers The request headers.
 * @param url The absolute request URI.
 * @returns The status and the body of the answer.
 */
function plainThroughEngine(
  port: number,
  headers: http.OutgoingHttpHeaders,
  url = 'http://api.github.com/user',
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: url,
        headers: { host: 'api.github.com', ...headers },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Checks if a server still answers on a loopback port.
 *
 * @param port The port to try.
 * @returns True when a connection opens.
 */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

describe('the interception engine', () => {
  it('starts only when there is both a CA and a credential to translate', async () => {
    policy = githubPolicy({ ca: null, credentials: [] });
    await interceptor.apply();
    expect(interceptor.port()).toBeNull();

    policy = githubPolicy({ credentials: [] });
    await interceptor.apply();
    expect(interceptor.port()).toBeNull();

    policy = githubPolicy();
    await interceptor.apply();
    expect(interceptor.port()).toBeGreaterThan(0);
  }, 30_000);

  it('swaps the placeholder for the real credential on the wire', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    const res = await throughEngine(interceptor.port()!, {
      authorization: `Bearer ${PLACEHOLDER}`,
    });

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
  }, 30_000);

  it('swaps the placeholder on a port that the host pattern names', async () => {
    policy = githubPolicy({
      credentials: [{ ...githubPolicy().credentials[0]!, hosts: ['api.github.com:8443'] }],
    });
    await interceptor.apply();

    const res = await throughEngine(
      interceptor.port()!,
      { authorization: `Bearer ${PLACEHOLDER}` },
      'api.github.com',
      '/user',
      '127.0.0.1',
      8443,
    );

    expect(res.status).toBe(200);
    expect(received[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
    // The upstream tunnel vets the port of the CONNECT.
    expect(connects).toEqual(['api.github.com:8443']);
  }, 30_000);

  it('does not swap on a port that no host pattern names', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    const res = await throughEngine(
      interceptor.port()!,
      { authorization: `Bearer ${PLACEHOLDER}` },
      'api.github.com',
      '/user',
      '127.0.0.1',
      8443,
    );

    expect(res.status).toBe(200);
    expect(received[0]?.headers.authorization).toBe(`Bearer ${PLACEHOLDER}`);
  }, 30_000);

  it('streams an event stream to the client before the stream ends', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    const socket = await tunnelThroughEngine(interceptor.port()!, 'api.github.com:443');
    const first = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        {
          createConnection: () => connectTls({ socket, servername: 'api.github.com', ca: ca.cert }),
          host: 'api.github.com',
          path: '/events',
          method: 'GET',
          headers: { accept: 'text/event-stream', authorization: `Bearer ${PLACEHOLDER}` },
        },
        (res) => {
          expect(res.headers['content-type']).toBe('text/event-stream');
          res.once('data', (chunk) => resolve(String(chunk)));
        },
      );
      req.on('error', reject);
      req.end();
    });

    // The origin has not ended the stream yet, so the engine passed the first event on as it came.
    expect(first).toBe('data: first\n\n');
    expect(received[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
    socket.destroy();
  }, 30_000);

  it('reports a 401 and a 403 with a Bearer challenge to an OAuth token', async () => {
    policy = githubPolicy({
      credentials: [
        { ...githubPolicy().credentials[0]!, id: 'mcp/s1/docs/authorization', oauth: true },
      ],
    });
    await interceptor.apply();
    const headers = { authorization: `Bearer ${PLACEHOLDER}` };

    expect(
      (await throughEngine(interceptor.port()!, headers, 'api.github.com', '/expired')).status,
    ).toBe(401);
    expect(
      (await throughEngine(interceptor.port()!, headers, 'api.github.com', '/scope')).status,
    ).toBe(403);
    expect(
      (await throughEngine(interceptor.port()!, headers, 'api.github.com', '/forbidden')).status,
    ).toBe(403);
    // A request without the placeholder carries no OAuth token.
    await throughEngine(interceptor.port()!, {}, 'api.github.com', '/expired');

    expect(refusedTokens).toEqual([
      {
        credentialId: 'mcp/s1/docs/authorization',
        status: 401,
        error: 'invalid_token',
        scope: null,
      },
      {
        credentialId: 'mcp/s1/docs/authorization',
        status: 403,
        error: 'insufficient_scope',
        scope: 'write admin',
      },
    ]);
  }, 30_000);

  it('reports no refused token for a credential without OAuth', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    const res = await throughEngine(
      interceptor.port()!,
      { authorization: `Bearer ${PLACEHOLDER}` },
      'api.github.com',
      '/expired',
    );

    expect(res.status).toBe(401);
    expect(refusedTokens).toEqual([]);
  }, 30_000);

  it('streams an event stream with an OAuth token to the client before the stream ends', async () => {
    policy = githubPolicy({
      credentials: [{ ...githubPolicy().credentials[0]!, oauth: true }],
    });
    await interceptor.apply();

    const socket = await tunnelThroughEngine(interceptor.port()!, 'api.github.com:443');
    const first = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        {
          createConnection: () => connectTls({ socket, servername: 'api.github.com', ca: ca.cert }),
          host: 'api.github.com',
          path: '/events',
          method: 'GET',
          headers: { accept: 'text/event-stream', authorization: `Bearer ${PLACEHOLDER}` },
        },
        (res) => res.once('data', (chunk) => resolve(String(chunk))),
      );
      req.on('error', reject);
      req.end();
    });

    expect(first).toBe('data: first\n\n');
    expect(refusedTokens).toEqual([]);
    socket.destroy();
  }, 30_000);

  it('swaps a credential that names no header in any header, and passes other values', async () => {
    policy = githubPolicy({
      credentials: [{ ...githubPolicy().credentials[0]!, headers: [] }],
    });
    await interceptor.apply();

    const res = await throughEngine(interceptor.port()!, {
      'x-api-key': PLACEHOLDER,
      authorization: 'Bearer someOtherToken',
    });

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.headers['x-api-key']).toBe(SECRET);
    expect(received[0]?.headers.authorization).toBe('Bearer someOtherToken');
  }, 30_000);

  it('refuses an upgrade that would need a swap, since it cannot be rewritten', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    const res = await upgradeThroughEngine(interceptor.port()!, {
      authorization: `Bearer ${PLACEHOLDER}`,
    });

    expect(res.status).toBe(403);
    // A rejected upgrade carries the reason in its status line.
    expect(res.body).toContain('refused by the egress policy');
    // Nothing reached the origin, so the placeholder did not leave the proxy.
    expect(received).toHaveLength(0);
  }, 30_000);

  it('forwards an upgrade that carries no placeholder unchanged', async () => {
    const tunnelToken = 'tunnel eyJhbGciOiJFUzI1NiJ9.e30.sig';
    policy = githubPolicy();
    await interceptor.apply();

    const res = await upgradeThroughEngine(interceptor.port()!, { authorization: tunnelToken });

    expect(res.status).toBe(101);
    expect(received).toHaveLength(1);
    expect(received[0]?.headers.authorization).toBe(tunnelToken);
  }, 30_000);

  it('forwards an upgrade that carries no credential, as it would a request', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    const res = await upgradeThroughEngine(interceptor.port()!);

    expect(res.status).toBe(101);
    expect(received).toHaveLength(1);
    expect(received[0]?.headers.authorization).toBeUndefined();
  }, 30_000);

  it('refuses a caller that did not come through the front door', async ({ skip }) => {
    // An agent in a box can reach the engine port on an interface that is not loopback.
    const outward = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (!outward) return skip('only loopback exists, so there is nothing to check');

    policy = githubPolicy();
    await interceptor.apply();

    const res = await throughEngine(
      interceptor.port()!,
      { authorization: `Bearer ${PLACEHOLDER}` },
      'api.github.com',
      '/user',
      outward,
    );

    expect(res.status).toBe(403);
    expect(res.body).toMatch(/front door|reachable from the proxy only/);
    expect(received).toHaveLength(0);
  }, 30_000);

  it('forwards a credential without a placeholder unchanged', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    const res = await throughEngine(interceptor.port()!, {
      authorization: 'Bearer ghp_someoneElsesToken',
    });

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.headers.authorization).toBe('Bearer ghp_someoneElsesToken');
  }, 30_000);

  it('leaves an unauthenticated request alone', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    const res = await throughEngine(interceptor.port()!, {});

    expect(res.status).toBe(200);
    expect(received[0]?.headers.authorization).toBeUndefined();
  }, 30_000);

  it('refuses a credential host reached in the clear', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    const res = await plainThroughEngine(interceptor.port()!, {
      authorization: `Bearer ${PLACEHOLDER}`,
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatch(/a credential host may only be reached over https/);
    // The placeholder and the secret must not travel as plaintext.
    expect(received).toHaveLength(0);
  }, 30_000);

  it('does not touch a host that has no credential configured', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    const res = await throughEngine(
      interceptor.port()!,
      { authorization: 'Bearer whatever' },
      'example.com',
      '/',
    );

    expect(res.status).toBe(200);
    expect(received[0]?.headers.authorization).toBe('Bearer whatever');
  }, 30_000);

  it('presents the deployment CA to an intercepted TLS client, and still swaps', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    // A client in a box sends CONNECT and then starts TLS under the deployment CA.
    const socket = await tunnelThroughEngine(interceptor.port()!, 'api.github.com:443');
    const secure = connectTls({ socket, servername: 'api.github.com', ca: ca.cert });
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', () => resolve());
      secure.once('error', reject);
    });
    expect(secure.authorized).toBe(true);
    expect(secure.getPeerCertificate().subject.CN).toBe('api.github.com');

    secure.write(
      `GET /user HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: Bearer ${PLACEHOLDER}\r\nConnection: close\r\n\r\n`,
    );
    const answer = await new Promise<string>((resolve) => {
      let body = '';
      secure.on('data', (c) => (body += c));
      secure.on('end', () => resolve(body));
    });
    expect(answer).toMatch(/^HTTP\/1\.1 200/);
    expect(received).toHaveLength(1);
    expect(received[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
    secure.destroy();
  }, 30_000);

  it('trusts an upstream CA for the boxes that have it, and only for them', async () => {
    const other = await generateCACertificate({ subject: { commonName: 'Boxes other CA' } });
    policy = githubPolicy({
      credentials: [],
      boxes: [
        {
          box: 'with-ca',
          token: 'token-a',
          open: false,
          hosts: [],
          upstreamCas: [{ host: PRIVATE_HOST, cert: privateCa.cert }],
        },
        {
          box: 'other-ca',
          token: 'token-b',
          open: false,
          hosts: [],
          upstreamCas: [{ host: PRIVATE_HOST, cert: other.cert }],
        },
        { box: 'without-ca', token: 'token-c', open: false, hosts: [] },
      ],
    });
    await interceptor.apply();
    const port = interceptor.port()!;
    const get = (box: string): Promise<Answer> =>
      throughEngine(port, {}, PRIVATE_HOST, '/', '127.0.0.1', 443, box);

    expect(await get('with-ca')).toEqual({ status: 200, body: 'private origin reached\n' });
    expect(upstreamTls.filter((c) => c.servername === PRIVATE_HOST)).toEqual([
      { servername: PRIVATE_HOST, ca: true },
    ]);
    expect((await get('other-ca')).status).toBe(502);

    upstreamTls = [];
    await get('without-ca');
    expect(upstreamTls.filter((c) => c.servername === PRIVATE_HOST)).toEqual([
      { servername: PRIVATE_HOST, ca: false },
    ]);

    const upgrade = await upgradeThroughEngine(port, {}, PRIVATE_HOST, '/ws', 'with-ca');
    expect(upgrade.status).toBe(101);
  }, 30_000);

  it('trusts an upstream CA for a client that speaks HTTP/2', async () => {
    policy = githubPolicy({
      credentials: [],
      boxes: [
        {
          box: 'with-ca',
          token: 'token-a',
          open: false,
          hosts: [],
          upstreamCas: [{ host: PRIVATE_HOST, cert: privateCa.cert }],
        },
      ],
    });
    await interceptor.apply();

    const socket = await tunnelThroughEngine(
      interceptor.port()!,
      `${PRIVATE_HOST}:443`,
      '127.0.0.1',
      'with-ca',
    );
    const session = http2.connect(`https://${PRIVATE_HOST}`, {
      createConnection: () =>
        connectTls({ socket, servername: PRIVATE_HOST, ca: ca.cert, ALPNProtocols: ['h2'] }),
    });
    const answer = await new Promise<Answer>((resolve, reject) => {
      const stream = session.request({ ':path': '/' });
      let status = 0;
      let body = '';
      stream.on('response', (headers) => (status = Number(headers[':status'])));
      stream.on('data', (chunk) => (body += chunk));
      stream.on('end', () => resolve({ status, body }));
      stream.on('error', reject);
    });
    session.close();

    expect(answer).toEqual({ status: 200, body: 'private origin reached\n' });
    expect(upstreamTls.filter((c) => c.servername === PRIVATE_HOST)).toEqual([
      { servername: PRIVATE_HOST, ca: true },
    ]);
  }, 30_000);

  it('restarts when the set of upstream CAs changes', async () => {
    const box = { box: 'with-ca', token: 'token-a', open: false, hosts: [] };
    policy = githubPolicy({ boxes: [box] });
    await interceptor.apply();
    starts = 0;

    policy = githubPolicy({
      boxes: [{ ...box, upstreamCas: [{ host: PRIVATE_HOST, cert: privateCa.cert }] }],
    });
    await interceptor.apply();
    expect(starts).toBe(1);

    await interceptor.apply();
    expect(starts).toBe(1);
  }, 30_000);

  it('stops decrypting as soon as the policy drops its credentials', async () => {
    policy = githubPolicy();
    await interceptor.apply();
    expect(interceptor.port()).toBeGreaterThan(0);

    policy = githubPolicy({ credentials: [] });
    await interceptor.apply();
    expect(interceptor.port()).toBeNull();
  }, 30_000);

  it('runs overlapping applies one after another, with no port gap', async () => {
    policy = githubPolicy();
    await interceptor.apply();
    const before = interceptor.port();
    expect(before).toBeGreaterThan(0);

    // A changed CA makes apply replace the running server.
    const other = await generateCACertificate({ subject: { commonName: 'Boxes other CA' } });
    policy = githubPolicy({ ca: other });
    starts = 0;
    const seen: Array<number | null> = [];
    const sampler = setInterval(() => seen.push(interceptor.port()), 1);
    await Promise.all([interceptor.apply(), interceptor.apply()]);
    clearInterval(sampler);

    // A second server would leak, because nothing could stop it. A port gap
    // would let the front door tunnel a credential host past the engine.
    expect(starts).toBe(1);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(null);
    expect(interceptor.port()).toBeGreaterThan(0);
    expect(await listening(before!)).toBe(false);
  }, 30_000);
});
