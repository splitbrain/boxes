import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { AgentStore } from './agents.ts';
import { type Db, openDb } from './db.ts';
import { type FakeOAuth, type FakeOAuthOptions, fakeOAuth } from './fake-oauth.ts';
import { guardedFetch, McpOAuth, readDocument } from './mcp-oauth.ts';
import { type McpSecretEntry, McpSecretStore } from './mcp-secrets.ts';

/** The origin of the dashboard in the tests. */
const ORIGIN = 'https://boxes.example.com';

/** The temporary DATA_DIR of each test. */
let dir: string;
/** The database of each test. */
let db: Db;
/** The secret rows of each test. */
let secrets: McpSecretStore;
/** The agent store of each test. */
let agents: AgentStore;
/** The id of the global set of the empty user. */
let setId: string;
/** The clock of the OAuth client. */
let now: number;
/** The number of writes that called onChange. */
let changes: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-mcp-oauth-'));
  db = openDb(dir);
  changes = 0;
  secrets = new McpSecretStore(db, () => {
    changes += 1;
  });
  agents = new AgentStore(db, dir, undefined, undefined, secrets);
  setId = agents.globalId('');
  now = 1_000_000_000_000;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Makes a fake, an OAuth server entry for it, and the OAuth client.
 *
 * @param options The settings of the fake.
 * @returns The fake and the client.
 */
function setup(options: FakeOAuthOptions = {}): { fake: FakeOAuth; client: McpOAuth } {
  const fake = fakeOAuth(options);
  agents.putMcpServer('', setId, { name: 'docs', url: fake.mcpUrl, auth: 'oauth', headers: [] });
  const client = new McpOAuth(
    secrets,
    (owner, id, name) => agents.mcpServer(owner, id, name),
    fake.fetch,
    () => now,
  );
  return { fake, client };
}

/**
 * Gives the OAuth row of the server of the tests.
 *
 * @returns The row.
 */
function row(): McpSecretEntry {
  const found = secrets.get(setId, 'docs', 'authorization');
  assert.ok(found);
  return found;
}

/**
 * Runs a whole login.
 *
 * @param fake The fake.
 * @param client The OAuth client.
 * @returns The authorization URL.
 */
async function login(fake: FakeOAuth, client: McpOAuth): Promise<URL> {
  const answer = await client.connect('', setId, 'docs', { origin: ORIGIN }, ORIGIN);
  assert.ok('authorizationUrl' in answer);
  const params = fake.authorize(answer.authorizationUrl);
  await client.callback('', {
    state: params.get('state') ?? '',
    code: params.get('code') ?? undefined,
    iss: params.get('iss') ?? undefined,
  });
  return new URL(answer.authorizationUrl);
}

test('a login finds the authorization server, registers a client and stores the token', async () => {
  const { fake, client } = setup();
  assert.equal(row().status, 'disconnected');

  const answer = await client.connect('', setId, 'docs', { origin: ORIGIN }, ORIGIN);
  assert.ok('authorizationUrl' in answer);
  const url = new URL(answer.authorizationUrl);
  assert.equal(url.origin + url.pathname, `${fake.issuer}/authorize`);
  const query = Object.fromEntries(url.searchParams);
  assert.equal(query.response_type, 'code');
  assert.equal(query.client_id, 'dcr-1');
  assert.equal(query.redirect_uri, `${ORIGIN}/oauth/callback`);
  assert.equal(query.code_challenge_method, 'S256');
  assert.equal(query.resource, fake.mcpUrl);
  // The scope of the challenge, and offline_access from the authorization server.
  assert.equal(query.scope, 'read offline_access');
  const registration = fake.requests.find((r) => r.url.endsWith('/register'));
  assert.deepEqual(registration?.fields.grant_types, ['authorization_code', 'refresh_token']);
  assert.deepEqual(registration?.fields.redirect_uris, [`${ORIGIN}/oauth/callback`]);
  assert.equal(registration?.fields.token_endpoint_auth_method, 'none');

  const params = fake.authorize(answer.authorizationUrl);
  const callback = {
    state: params.get('state') ?? '',
    code: params.get('code') ?? undefined,
    iss: params.get('iss') ?? undefined,
  };
  assert.deepEqual(await client.callback('', callback), { setId });
  const stored = row();
  assert.equal(stored.secret, 'Bearer at-3');
  assert.equal(stored.status, 'ok');
  assert.equal(stored.expires_at, now + 3600_000);
  assert.equal(stored.refreshed_at, now);
  const doc = readDocument(stored.oauth);
  assert.equal(doc.refresh_token, 'rt-3');
  assert.deepEqual(doc.scopes, ['read', 'offline_access']);
  assert.equal(doc.client?.registered, 'dcr');
  assert.equal(doc.server?.issuer, fake.issuer);
  assert.ok(changes > 0);

  // Each login is accepted once, and a login of another user is unknown.
  await assert.rejects(client.callback('', callback), /unknown or older than 10 minutes/);
  const again = await client.connect('', setId, 'docs', { origin: ORIGIN }, ORIGIN);
  assert.ok('authorizationUrl' in again);
  await assert.rejects(
    client.callback('bob', {
      state: new URL(again.authorizationUrl).searchParams.get('state') ?? '',
    }),
    /unknown/,
  );
  // The second login uses the stored client.
  assert.equal(fake.requests.filter((r) => r.url.endsWith('/register')).length, 1);
});

test('a login without a challenge reads the well-known metadata and the scopes of the resource', async () => {
  const { fake, client } = setup({ challenge: false });
  const url = await login(fake, client);
  assert.equal(url.searchParams.get('scope'), 'read write offline_access');
  assert.equal(row().status, 'ok');
});

test('a started login waits 10 minutes for its callback', async () => {
  const { fake, client } = setup();
  const answer = await client.connect('', setId, 'docs', { origin: ORIGIN }, ORIGIN);
  assert.ok('authorizationUrl' in answer);
  const params = fake.authorize(answer.authorizationUrl);
  now += 10 * 60_000;
  await assert.rejects(
    client.callback('', { state: params.get('state') ?? '', code: params.get('code') ?? '' }),
    /older than 10 minutes/,
  );
});

test('a server without client registration asks for a client ID, and the client of the user logs in', async () => {
  const { fake, client } = setup({ dcr: false, authMethods: ['client_secret_post'] });

  assert.deepEqual(await client.connect('', setId, 'docs', { origin: ORIGIN }, ORIGIN), {
    needsClient: true,
    redirectUri: `${ORIGIN}/oauth/callback`,
  });

  const answer = await client.connect(
    '',
    setId,
    'docs',
    { origin: ORIGIN, clientId: ' manual-1 ', clientSecret: 'shh' },
    ORIGIN,
  );
  assert.ok('authorizationUrl' in answer);
  assert.equal(new URL(answer.authorizationUrl).searchParams.get('client_id'), 'manual-1');
  const params = fake.authorize(answer.authorizationUrl);
  await client.callback('', {
    state: params.get('state') ?? '',
    code: params.get('code') ?? undefined,
    iss: params.get('iss') ?? undefined,
  });
  const token = fake.requests.find((r) => r.fields.grant_type === 'authorization_code');
  assert.equal(token?.fields.client_id, 'manual-1');
  assert.equal(token?.fields.client_secret, 'shh');
  assert.equal(row().status, 'ok');

  // The client has the redirect URI of the first origin, so another origin needs another client.
  const other = 'https://other.example.com';
  assert.deepEqual(await client.connect('', setId, 'docs', { origin: other }, other), {
    needsClient: true,
    redirectUri: `${other}/oauth/callback`,
  });
});

test('a client secret goes into a Basic header when the server lists no other method', async () => {
  const { fake, client } = setup({ dcr: false, authMethods: [] });
  const answer = await client.connect(
    '',
    setId,
    'docs',
    { origin: ORIGIN, clientId: 'manual1', clientSecret: 'shh' },
    ORIGIN,
  );
  assert.ok('authorizationUrl' in answer);
  const params = fake.authorize(answer.authorizationUrl);
  await client.callback('', {
    state: params.get('state') ?? '',
    code: params.get('code') ?? undefined,
    iss: params.get('iss') ?? undefined,
  });
  const token = fake.requests.find((r) => r.fields.grant_type === 'authorization_code');
  assert.equal(token?.fields.client_secret, undefined);
  assert.equal(
    token?.headers.authorization,
    `Basic ${Buffer.from('manual1:shh').toString('base64')}`,
  );
});

test('the iss parameter of the callback is checked as the MCP specification says', async () => {
  /**
   * Starts a login and sends its callback with another iss.
   *
   * @param options The settings of the fake.
   * @param iss The iss of the callback, or undefined for none.
   * @returns The promise of the callback.
   */
  const run = async (options: FakeOAuthOptions, iss: string | undefined): Promise<unknown> => {
    db.prepare('DELETE FROM agent_mcp_servers').run();
    const { fake, client } = setup(options);
    const answer = await client.connect('', setId, 'docs', { origin: ORIGIN }, ORIGIN);
    assert.ok('authorizationUrl' in answer);
    const params = fake.authorize(answer.authorizationUrl);
    return client.callback('', {
      state: params.get('state') ?? '',
      code: params.get('code') ?? undefined,
      iss,
    });
  };
  const issuer = 'https://auth.example.com/tenant';

  await assert.rejects(run({ issParameter: true }, 'https://evil.example.com'), /iss/);
  await assert.rejects(run({ issParameter: true }, undefined), /iss/);
  await assert.rejects(run({ issParameter: false }, 'https://evil.example.com'), /iss/);
  // The comparison is of strings, so a trailing slash makes another issuer.
  await assert.rejects(run({ issParameter: false }, `${issuer}/`), /iss/);
  assert.deepEqual(await run({ issParameter: false }, undefined), { setId });
  assert.deepEqual(await run({ issParameter: true }, issuer), { setId });
});

test('an error of the authorization server reaches the user', async () => {
  const { fake, client } = setup();
  const answer = await client.connect('', setId, 'docs', { origin: ORIGIN }, ORIGIN);
  assert.ok('authorizationUrl' in answer);
  const state = new URL(answer.authorizationUrl).searchParams.get('state') ?? '';
  await assert.rejects(
    client.callback('', {
      state,
      iss: fake.issuer,
      error: 'access_denied',
      errorDescription: 'the user said no',
    }),
    /refused the login \(access_denied: the user said no\)/,
  );
  assert.equal(row().status, 'disconnected');
});

test('a connect needs the origin of the dashboard and a server with OAuth', async () => {
  const { client } = setup();
  await assert.rejects(
    client.connect('', setId, 'docs', { origin: ORIGIN }, 'https://evil.example.com'),
    /differs from the Origin header/,
  );
  await assert.rejects(
    client.connect('', setId, 'docs', { origin: `${ORIGIN}/path` }, `${ORIGIN}/path`),
    /origin must be the origin/,
  );
  await assert.rejects(
    client.connect('', setId, 'docs', { origin: 'javascript:x' }, 'javascript:x'),
    /origin must be the origin/,
  );
  agents.putMcpServer('', setId, {
    name: 'plain',
    url: 'https://plain.example.com/',
    auth: 'none',
    headers: [],
  });
  await assert.rejects(
    client.connect('', setId, 'plain', { origin: ORIGIN }, ORIGIN),
    /does not use OAuth/,
  );
  await assert.rejects(
    client.connect('bob', setId, 'docs', { origin: ORIGIN }, ORIGIN),
    /not found/,
  );
});

test('a resource metadata document for another resource is refused', async () => {
  const fake = fakeOAuth({ mcpUrl: 'https://mcp.example.com/mcp' });
  agents.putMcpServer('', setId, {
    name: 'docs',
    url: 'https://mcp.example.com/mcp/',
    auth: 'oauth',
    headers: [],
  });
  const client = new McpOAuth(
    secrets,
    (owner, id, name) => agents.mcpServer(owner, id, name),
    async (url, init) =>
      fake.fetch(url === 'https://mcp.example.com/mcp/' ? fake.mcpUrl : url, init),
    () => now,
  );
  await assert.rejects(
    client.connect('', setId, 'docs', { origin: ORIGIN }, ORIGIN),
    /names the resource https:\/\/mcp.example.com\/mcp, not https:\/\/mcp.example.com\/mcp\//,
  );
});

test('a refresh comes in the second half of the lifetime and stores the rotated refresh token', async () => {
  const { fake, client } = setup();
  await login(fake, client);
  const loggedIn = now;

  now = loggedIn + 29 * 60_000;
  await client.refreshDue();
  assert.equal(row().secret, 'Bearer at-3');

  now = loggedIn + 31 * 60_000;
  await Promise.all([client.refreshDue(), client.refresh(setId, 'docs')]);
  const refreshes = fake.requests.filter((r) => r.fields.grant_type === 'refresh_token');
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0]?.fields.refresh_token, 'rt-3');
  assert.equal(refreshes[0]?.fields.resource, fake.mcpUrl);
  const stored = row();
  assert.equal(stored.secret, 'Bearer at-4');
  assert.equal(stored.refreshed_at, now);
  assert.equal(readDocument(stored.oauth).refresh_token, 'rt-4');

  // The rotated refresh token works for the next refresh.
  now += 31 * 60_000;
  await client.refreshDue();
  assert.equal(row().secret, 'Bearer at-5');
});

test('a token without an expiry or without a refresh token gets no refresh from the tick', async () => {
  const forever = setup({ expiresIn: null });
  await login(forever.fake, forever.client);
  now += 365 * 24 * 60 * 60_000;
  await forever.client.refreshDue();
  assert.equal(
    forever.fake.requests.filter((r) => r.fields.grant_type === 'refresh_token').length,
    0,
  );
  assert.equal(row().status, 'ok');

  db.prepare('DELETE FROM agent_mcp_servers').run();
  const once = setup({ refreshTokens: false });
  await login(once.fake, once.client);
  now += 2 * 60 * 60_000;
  await once.client.refreshDue();
  assert.equal(once.fake.requests.filter((r) => r.fields.grant_type === 'refresh_token').length, 0);
});

test('invalid_grant drops the refresh token, and invalid_client makes the next login register a new client', async () => {
  const { fake, client } = setup();
  await login(fake, client);

  fake.refreshError = 'invalid_grant';
  await client.refresh(setId, 'docs');
  assert.equal(row().status, 'failing');
  assert.match(row().last_error ?? '', /invalid_grant/);
  assert.equal(readDocument(row().oauth).refresh_token, undefined);
  assert.equal(row().secret, 'Bearer at-3');

  fake.refreshError = 'invalid_client';
  await login(fake, client);
  assert.equal(row().status, 'ok');
  await client.refresh(setId, 'docs');
  assert.match(row().last_error ?? '', /invalid_client/);
  assert.equal(readDocument(row().oauth).client, undefined);

  fake.refreshError = null;
  await login(fake, client);
  assert.equal(fake.requests.filter((r) => r.url.endsWith('/register')).length, 2);
  assert.equal(row().status, 'ok');
});

test('a refused token gets a refresh or the status failing, and a missing scope goes into the next login', async () => {
  const { fake, client } = setup();
  await login(fake, client);
  const refusal = { credentialId: 'x', status: 401, error: 'invalid_token', scope: null };

  // A token from the last 5 minutes gets no refresh.
  await client.handleRefused([{ row: row(), refusal }]);
  assert.equal(row().status, 'failing');
  assert.match(row().last_error ?? '', /refused the token \(401 invalid_token\)/);

  now += 5 * 60_000;
  await client.handleRefused([{ row: row(), refusal }]);
  assert.equal(row().status, 'ok');
  assert.equal(row().secret, 'Bearer at-4');

  await client.handleRefused([
    {
      row: row(),
      refusal: {
        credentialId: 'x',
        status: 403,
        error: 'insufficient_scope',
        scope: 'write admin',
      },
    },
  ]);
  assert.equal(row().status, 'failing');
  assert.match(row().last_error ?? '', /needs more permissions/);
  assert.deepEqual(readDocument(row().oauth).scopes, ['read', 'offline_access', 'write', 'admin']);
  const url = await login(fake, client);
  assert.equal(url.searchParams.get('scope'), 'read offline_access write admin');
});

test('the fetch of the OAuth client refuses http and private addresses', async () => {
  await assert.rejects(guardedFetch('http://example.com/', {}), /does not use https/);
  await assert.rejects(guardedFetch('https://127.0.0.1/', {}), /blocked address/);
  await assert.rejects(guardedFetch('https://[::1]/', {}), /blocked address/);
  await assert.rejects(guardedFetch('https://localhost/', {}), /blocked address/);
  await assert.rejects(guardedFetch('https://10.0.0.5/', {}), /blocked address/);
});

test('the fetch of the OAuth client lets only the host of the MCP server have a private address', async () => {
  // Another host than the MCP server stays public.
  await assert.rejects(
    guardedFetch('https://10.0.0.5/', { privateHost: '10.0.0.6' }),
    /blocked address/,
  );
  // Loopback stays forbidden, also for the host of the MCP server.
  await assert.rejects(
    guardedFetch('https://127.0.0.1/', { privateHost: '127.0.0.1' }),
    /blocked address/,
  );
  await assert.rejects(
    guardedFetch('https://localhost/', { privateHost: 'localhost' }),
    /blocked address/,
  );
  // The host of the MCP server passes the address check. Nothing listens there, so the request fails later.
  await assert.rejects(
    guardedFetch('https://10.255.255.1/', {
      privateHost: '10.255.255.1',
      signal: AbortSignal.timeout(50),
    }),
    /could not reach/,
  );
});
