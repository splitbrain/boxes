/** Tests for host parsing and for vetting the port, host and address of a target. */

import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EgressBoxPolicy, EgressPolicy } from '../../shared/types.ts';
import {
  createForwardServer,
  type DenialCategory,
  parseHostPort,
  type Target,
  vetTarget,
} from './forward.ts';
import { boxFromAuthorization } from './policy.ts';

/**
 * Makes the DNS lookup answer with fixed addresses, so the test uses no network.
 *
 * @param addresses The addresses that the lookup returns.
 */
function resolvesTo(...addresses: string[]): void {
  vi.spyOn(dns.promises, 'lookup').mockResolvedValue(
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })) as never,
  );
}

/** The policy of an open box with no host patterns. */
const OPEN: EgressBoxPolicy = { box: 'open', token: 'open-token', open: true, hosts: [] };

/**
 * Makes the policy of a closed box that can reach only the given hosts.
 *
 * @param hosts The host patterns of the box.
 * @returns The policy of the box.
 */
const allowing = (...hosts: string[]): EgressBoxPolicy => ({
  box: 'closed',
  token: 'closed-token',
  open: false,
  hosts,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseHostPort', () => {
  it('splits names, defaults the port, and brackets IPv6', () => {
    expect(parseHostPort('example.com', 443)).toEqual({ host: 'example.com', port: 443 });
    expect(parseHostPort('example.com:8443', 443)).toEqual({ host: 'example.com', port: 8443 });
    expect(parseHostPort('[::1]:443', 443)).toEqual({ host: '::1', port: 443 });
    expect(parseHostPort('[::1]', 443)).toEqual({ host: '::1', port: 443 });
  });

  it('refuses malformed authorities', () => {
    expect(parseHostPort(':443', 443)).toBeNull();
    expect(parseHostPort('example.com:0', 443)).toBeNull();
    expect(parseHostPort('example.com:99999', 443)).toBeNull();
    expect(parseHostPort('example.com:http', 443)).toBeNull();
    expect(parseHostPort('[::1', 443)).toBeNull();
    // Only a port may follow the brackets, and the brackets must hold an IPv6 address.
    expect(parseHostPort('[8.8.8.8]junk', 443)).toBeNull();
    expect(parseHostPort('[::ffff:8.8.8.8]x', 443)).toBeNull();
    expect(parseHostPort('[::1]443', 443)).toBeNull();
    expect(parseHostPort('[8.8.8.8]', 443)).toBeNull();
    expect(parseHostPort('[example.com]:443', 443)).toBeNull();
    expect(parseHostPort('[]', 443)).toBeNull();
    expect(parseHostPort('[]:443', 443)).toBeNull();
    // A host outside brackets cannot hold a colon.
    expect(parseHostPort('a:b:443', 443)).toBeNull();
    expect(parseHostPort('::1', 443)).toBeNull();
    expect(parseHostPort('[::ffff:8.8.8.8]:443', 443)).toEqual({
      host: '::ffff:8.8.8.8',
      port: 443,
    });
  });
});

describe('vetTarget', () => {
  it('allows every host on the ports 80 and 443 for an open box', async () => {
    resolvesTo('93.184.216.34');
    await expect(vetTarget({ host: 'example.com', port: 443 }, OPEN)).resolves.toMatchObject({
      ok: true,
    });
    await expect(vetTarget({ host: 'example.com', port: 80 }, OPEN)).resolves.toMatchObject({
      ok: true,
    });
    await expect(vetTarget({ host: 'example.com', port: 22 }, OPEN)).resolves.toEqual({
      ok: false,
      category: 'port',
      reason: 'example.com:22 is not allowed by the egress profile of this box',
    });
  });

  it('allows another port for an open box only when a pattern names it', async () => {
    resolvesTo('93.184.216.34');
    const box = { ...OPEN, hosts: ['mcp.example.com:8443'] };
    await expect(vetTarget({ host: 'mcp.example.com', port: 8443 }, box)).resolves.toMatchObject({
      ok: true,
    });
    await expect(vetTarget({ host: 'example.com', port: 8443 }, box)).resolves.toMatchObject({
      ok: false,
      category: 'port',
    });
  });

  it('allows only the listed hosts for a closed box', async () => {
    resolvesTo('93.184.216.34');
    const box = allowing('mcp.example.com:8443');
    await expect(vetTarget({ host: 'mcp.example.com', port: 8443 }, box)).resolves.toMatchObject({
      ok: true,
    });
    await expect(vetTarget({ host: 'other.example.com', port: 8443 }, box)).resolves.toEqual({
      ok: false,
      category: 'port',
      reason: 'other.example.com:8443 is not allowed by the egress profile of this box',
    });
    await expect(vetTarget({ host: 'mcp.example.com', port: 443 }, box)).resolves.toEqual({
      ok: false,
      category: 'allowlist',
      reason: 'mcp.example.com:443 is not allowed by the egress profile of this box',
    });
  });

  it('checks the host before it resolves anything', async () => {
    const lookup = vi.spyOn(dns.promises, 'lookup');
    const verdict = await vetTarget({ host: 'evil.com', port: 443 }, allowing('example.com'));
    expect(verdict).toEqual({
      ok: false,
      category: 'allowlist',
      reason: 'evil.com:443 is not allowed by the egress profile of this box',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('puts an IPv6 literal in brackets in the reason', async () => {
    await expect(vetTarget({ host: '2001:db8::1', port: 443 }, allowing())).resolves.toEqual({
      ok: false,
      category: 'allowlist',
      reason: '[2001:db8::1]:443 is not allowed by the egress profile of this box',
    });
  });

  it('pins the connection to a vetted address', async () => {
    resolvesTo('93.184.216.34', '93.184.216.35');
    await expect(
      vetTarget({ host: 'example.com', port: 443 }, allowing('example.com')),
    ).resolves.toEqual({ ok: true, address: '93.184.216.34', family: 4 });
  });

  it('refuses a name that resolves to any private address, closing DNS rebinding', async () => {
    resolvesTo('93.184.216.34', '192.168.1.5');
    await expect(vetTarget({ host: 'rebind.example', port: 443 }, OPEN)).resolves.toEqual({
      ok: false,
      category: 'private-address',
      reason:
        'an address of the hostname is in a private range, which only a host in the egress profile of this box can reach',
    });
  });

  it('refuses a name that resolves to any forbidden address, also when the profile names it', async () => {
    resolvesTo('10.0.0.5', '127.0.0.1');
    await expect(
      vetTarget({ host: 'loop.example', port: 443 }, allowing('loop.example')),
    ).resolves.toEqual({
      ok: false,
      category: 'blocked-address',
      reason: 'an address of the hostname is in a blocked range',
    });
  });

  it('refuses address literals in private space in the open mode, including the v4-mapped form', async () => {
    for (const host of [
      '192.168.1.1',
      '10.0.0.1',
      '100.64.0.1',
      'fd7a:115c:a1e0::1',
      '::ffff:192.168.1.1',
    ]) {
      await expect(vetTarget({ host, port: 443 }, OPEN)).resolves.toEqual({
        ok: false,
        category: 'private-address',
        reason:
          'target address is in a private range, which only a host in the egress profile of this box can reach',
      });
    }
  });

  it('refuses forbidden address literals, also when the profile names them', async () => {
    for (const host of ['169.254.169.254', '127.0.0.1', '0.0.0.0', '::1', 'fe80::1']) {
      await expect(
        vetTarget({ host, port: 443 }, allowing(host.includes(':') ? `[${host}]` : host)),
      ).resolves.toEqual({
        ok: false,
        category: 'blocked-address',
        reason: 'target address is in a blocked range',
      });
    }
  });

  it('lets a host of the profile reach a private address', async () => {
    resolvesTo('10.43.27.38');
    await expect(
      vetTarget(
        { host: 'gonats-api.gonats.svc.cluster.local', port: 8080 },
        allowing('gonats-api.gonats.svc.cluster.local:8080'),
      ),
    ).resolves.toEqual({ ok: true, address: '10.43.27.38', family: 4 });
  });

  it('lets a wildcard host of the profile reach a private address in the open mode', async () => {
    resolvesTo('192.168.1.20');
    const box: EgressBoxPolicy = { ...OPEN, hosts: ['*.home.arpa'] };
    await expect(vetTarget({ host: 'ha.home.arpa', port: 443 }, box)).resolves.toEqual({
      ok: true,
      address: '192.168.1.20',
      family: 4,
    });
  });

  it('lets a private address literal of the profile pass', async () => {
    await expect(
      vetTarget({ host: '100.101.102.103', port: 8123 }, allowing('100.101.102.103:8123')),
    ).resolves.toEqual({ ok: true, address: '100.101.102.103', family: 4 });
  });

  it('does not open a private address for another port of a listed host', async () => {
    resolvesTo('10.43.27.38');
    const box: EgressBoxPolicy = { ...OPEN, hosts: ['api.internal:8080'] };
    await expect(vetTarget({ host: 'api.internal', port: 443 }, box)).resolves.toMatchObject({
      ok: false,
      category: 'private-address',
    });
  });

  it('matches an address literal against the host patterns as a literal', async () => {
    await expect(vetTarget({ host: '1.1.1.1', port: 443 }, allowing('1.1.1.1'))).resolves.toEqual({
      ok: true,
      address: '1.1.1.1',
      family: 4,
    });
    await expect(
      vetTarget({ host: '1.1.1.1', port: 443 }, allowing('*.1.1.1')),
    ).resolves.toMatchObject({ ok: false });
  });

  it('fails closed when a name does not resolve', async () => {
    vi.spyOn(dns.promises, 'lookup').mockRejectedValue(new Error('ENOTFOUND'));
    await expect(vetTarget({ host: 'nope.example', port: 443 }, OPEN)).resolves.toEqual({
      ok: false,
      category: 'dns',
      reason: 'DNS lookup failed: ENOTFOUND',
    });

    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([] as never);
    await expect(vetTarget({ host: 'nope.example', port: 443 }, OPEN)).resolves.toEqual({
      ok: false,
      category: 'dns',
      reason: 'no addresses resolved',
    });
  });
});

/**
 * Makes the value of a Proxy-Authorization header with the Basic scheme.
 *
 * @param user The user, which is the box id.
 * @param password The password, which is the token of the box.
 * @returns The header value.
 */
const basic = (user: string, password: string): string =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

/** The token of the open box in the front door tests. */
const OPEN_TOKEN = 'a'.repeat(64);

/** The token of the closed box in the front door tests. */
const CLOSED_TOKEN = 'b'.repeat(64);

/** One call of the denied callback. */
interface Denial {
  /** The category of the denial. */
  category: DenialCategory;
  /** The id of the box, or undefined when the proxy does not know it. */
  box: string | undefined;
  /** The refused target, or undefined when the proxy does not know it. */
  target: Target | undefined;
}

/** An answer of the front door to a plain HTTP request. */
interface HttpAnswer {
  /** The status code. */
  status: number;
  /** The reason phrase of the status line. */
  phrase: string;
  /** The response headers. */
  headers: http.IncomingHttpHeaders;
  /** The response body. */
  body: string;
}

describe('the front door', () => {
  /** The servers that a test started. */
  const servers: net.Server[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  /**
   * Starts a server on loopback.
   *
   * @param server The server to start.
   * @returns The port that the server listens on.
   */
  const listen = (server: net.Server): Promise<number> =>
    new Promise((resolve) => {
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });

  /**
   * Sends a CONNECT to the front door and reads the status line of the answer.
   *
   * @param port The port of the front door.
   * @param authority The host and port to send in the CONNECT.
   * @param auth The value of the Proxy-Authorization header. The default is the header of the open box.
   * @returns The status line.
   */
  const connect = (
    port: number,
    authority: string,
    auth: string = basic('open-box', OPEN_TOKEN),
  ): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.write(
          `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n` +
            `Proxy-Authorization: ${auth}\r\n\r\n`,
        );
      });
      socket.once('data', (chunk) => {
        resolve(String(chunk).split('\r\n')[0] ?? '');
        socket.destroy();
      });
      socket.on('error', reject);
    });

  /**
   * Sends a CONNECT to the front door and reads the full answer until the
   * front door closes the connection.
   *
   * @param port The port of the front door.
   * @param authority The host and port to send in the CONNECT.
   * @param auth The value of the Proxy-Authorization header, or null to send no header.
   * @returns The full answer, with the status line, the headers and the body.
   */
  const connectAnswer = (port: number, authority: string, auth: string | null): Promise<string> =>
    new Promise((resolve, reject) => {
      let text = '';
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        const header = auth === null ? '' : `Proxy-Authorization: ${auth}\r\n`;
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${header}\r\n`);
      });
      socket.on('data', (chunk) => (text += chunk));
      socket.on('close', () => resolve(text));
      socket.on('error', reject);
    });

  /**
   * Sends a plain HTTP request through the front door.
   *
   * @param port The port of the front door.
   * @param url The absolute URL of the request.
   * @param auth The value of the Proxy-Authorization header, or null to send no header.
   * @returns The answer of the front door.
   */
  const get = (port: number, url: string, auth: string | null): Promise<HttpAnswer> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: url,
          headers: {
            host: new URL(url).host,
            ...(auth === null ? {} : { 'proxy-authorization': auth }),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              phrase: res.statusMessage ?? '',
              headers: res.headers,
              body,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });

  /**
   * Starts a front door for a policy with a credential for mcp.example.com on
   * port 8443 and for api.example.com, and a stand-in engine that records each
   * CONNECT it gets. The policy has an open box that can also reach
   * mcp.example.com on port 8443, and a closed box that can reach only
   * api.example.com.
   *
   * @returns The port of the front door, the CONNECT authorities of the engine, and the denials.
   */
  async function frontDoor(): Promise<{
    port: number;
    engine: string[];
    denials: Denial[];
  }> {
    resolvesTo('93.184.216.34');
    const engine: string[] = [];
    const denials: Denial[] = [];
    const fakeEngine = http.createServer();
    fakeEngine.on('connect', (req, socket: net.Socket) => {
      engine.push(req.url ?? '');
      socket.end('HTTP/1.1 200 Connection Established\r\n\r\n');
    });
    const enginePort = await listen(fakeEngine);

    const policy: EgressPolicy = {
      boxes: [
        { box: 'open-box', token: OPEN_TOKEN, open: true, hosts: ['mcp.example.com:8443'] },
        { box: 'closed-box', token: CLOSED_TOKEN, open: false, hosts: ['api.example.com'] },
      ],
      ca: { key: 'K', cert: 'C' },
      credentials: [
        {
          id: 'mcp',
          hosts: ['mcp.example.com:8443', 'api.example.com'],
          headers: [],
          placeholder: 'PLACEHOLDER',
          secret: 'SECRET',
        },
      ],
    };
    const front = createForwardServer({
      policy: () => policy,
      identify: boxFromAuthorization,
      interceptPort: () => enginePort,
      applied: () => true,
      denied: (category, box, target) => denials.push({ category, box, target }),
      log: () => {},
    });
    return { port: await listen(front), engine, denials };
  }

  it('hands a credential host on a named port to the engine', async () => {
    const { port, engine } = await frontDoor();
    expect(await connect(port, 'mcp.example.com:8443')).toBe('HTTP/1.1 200 Connection Established');
    expect(engine).toEqual(['mcp.example.com:8443']);
  });

  it('refuses a credential host on port 80 and on a port that no pattern names', async () => {
    const { port, engine, denials } = await frontDoor();
    expect(await connect(port, 'api.example.com:80')).toBe('HTTP/1.1 403 Forbidden');
    expect(await connect(port, 'mcp.example.com:9000')).toBe(
      'HTTP/1.1 403 Not allowed by the egress profile',
    );
    expect(engine).toEqual([]);
    expect(denials.map((d) => d.category)).toEqual(['plaintext-credential-host', 'port']);
  });

  describe('without a valid box identity', () => {
    /** The headers that do not identify a box, by the name of the case. */
    const badHeaders: Array<[string, string | null]> = [
      ['no header', null],
      ['a wrong token', basic('open-box', 'c'.repeat(64))],
      ['the box id of another box', basic('closed-box', OPEN_TOKEN)],
    ];

    it.each(badHeaders)('answers a CONNECT with %s with a 407', async (_name, auth) => {
      const { port, engine, denials } = await frontDoor();
      const answer = await connectAnswer(port, 'api.example.com:443', auth);
      expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 407 Proxy Authentication Required');
      expect(answer).toContain('\r\nProxy-Authenticate: Basic realm="boxes"\r\n');
      expect(engine).toEqual([]);
      expect(denials).toEqual([{ category: 'proxy-auth', box: undefined, target: undefined }]);
    });

    it.each(badHeaders)('answers a plain HTTP request with %s with a 407', async (_name, auth) => {
      const { port, denials } = await frontDoor();
      const answer = await get(port, 'http://example.com/', auth);
      expect(answer.status).toBe(407);
      expect(answer.phrase).toBe('Proxy Authentication Required');
      expect(answer.headers['proxy-authenticate']).toBe('Basic realm="boxes"');
      expect(denials).toEqual([{ category: 'proxy-auth', box: undefined, target: undefined }]);
    });
  });

  it.each([
    ['a refusal', basic('closed-box', CLOSED_TOKEN)],
    ['a 407', null],
  ])('keeps running when a client resets the socket during %s', async (_name, auth) => {
    const { port } = await frontDoor();
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => {
          const header = auth === null ? '' : `Proxy-Authorization: ${auth}\r\n`;
          socket.write(`CONNECT other.example.com:443 HTTP/1.1\r\n${header}\r\n`, () => {
            socket.resetAndDestroy();
            resolve();
          });
        });
      });
    }
    expect(await connect(port, 'api.example.com:443')).toBe('HTTP/1.1 200 Connection Established');
  });

  it('lets an open box reach any host on port 443, but not on another port', async () => {
    const { port, engine, denials } = await frontDoor();
    // The open mode allows api.example.com without a pattern for it.
    expect(await connect(port, 'api.example.com:443')).toBe('HTTP/1.1 200 Connection Established');
    expect(await connect(port, 'api.example.com:8443')).toBe(
      'HTTP/1.1 403 Not allowed by the egress profile',
    );
    expect(engine).toEqual(['api.example.com:443']);
    expect(denials).toEqual([
      { category: 'port', box: 'open-box', target: { host: 'api.example.com', port: 8443 } },
    ]);
  });

  it('lets a closed box reach only its listed hosts', async () => {
    const { port, engine, denials } = await frontDoor();
    const auth = basic('closed-box', CLOSED_TOKEN);
    expect(await connect(port, 'api.example.com:443', auth)).toBe(
      'HTTP/1.1 200 Connection Established',
    );
    expect(await connect(port, 'mcp.example.com:8443', auth)).toBe(
      'HTTP/1.1 403 Not allowed by the egress profile',
    );
    expect(await connect(port, 'other.example.com:443', auth)).toBe(
      'HTTP/1.1 403 Not allowed by the egress profile',
    );
    expect(engine).toEqual(['api.example.com:443']);
    expect(denials).toEqual([
      { category: 'port', box: 'closed-box', target: { host: 'mcp.example.com', port: 8443 } },
      {
        category: 'allowlist',
        box: 'closed-box',
        target: { host: 'other.example.com', port: 443 },
      },
    ]);
  });

  it('names the target in the body of a refused CONNECT', async () => {
    const { port, denials } = await frontDoor();
    const answer = await connectAnswer(
      port,
      'other.example.com:443',
      basic('closed-box', CLOSED_TOKEN),
    );
    const [head, body] = answer.split('\r\n\r\n');
    expect(head?.split('\r\n')[0]).toBe('HTTP/1.1 403 Not allowed by the egress profile');
    expect(head).toContain('\r\nContent-Type: text/plain; charset=utf-8');
    expect(body).toBe(
      'egress denied: other.example.com:443 is not allowed by the egress profile of this box\n',
    );
    expect(denials).toEqual([
      {
        category: 'allowlist',
        box: 'closed-box',
        target: { host: 'other.example.com', port: 443 },
      },
    ]);
  });

  it('names the target in the body of a refused plain HTTP request', async () => {
    const { port, denials } = await frontDoor();
    const answer = await get(port, 'http://other.example.com/', basic('closed-box', CLOSED_TOKEN));
    expect(answer.status).toBe(403);
    expect(answer.phrase).toBe('Not allowed by the egress profile');
    expect(answer.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(answer.body).toBe(
      'egress denied: other.example.com:80 is not allowed by the egress profile of this box\n',
    );
    expect(denials).toEqual([
      { category: 'allowlist', box: 'closed-box', target: { host: 'other.example.com', port: 80 } },
    ]);
  });
});
