import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCACertificate } from 'mockttp';
import { afterEach, beforeAll, beforeEach, test } from 'vitest';
import { AgentStore } from './agents.ts';
import { ApiKeyStore } from './api-keys.ts';
import { type Db, openDb } from './db.ts';
import { HttpError } from './http-error.ts';
import { McpSecretStore } from './mcp-secrets.ts';
import { parseUpstreamCa, UpstreamCaStore } from './upstream-cas.ts';

/** The temporary data directory of each test. */
let dir: string;
/** The database of each test. */
let db: Db;
/** The store under test. */
let cas: UpstreamCaStore;
/** The agent store, which writes the upstream CAs of the MCP servers. */
let agents: AgentStore;
/** The id of the global set of the empty user. */
let setId: string;
/** A CA certificate as PEM. */
let caOne: string;
/** Another CA certificate as PEM. */
let caTwo: string;

/** The URL of the MCP server of the tests. */
const MCP_URL = 'https://mcp.internal:8443/mcp';

/** The host pattern of MCP_URL. */
const MCP_HOST = 'mcp.internal:8443';

beforeAll(async () => {
  caOne = (await generateCACertificate({ subject: { commonName: 'CA one' } })).cert.trim();
  caTwo = (await generateCACertificate({ subject: { commonName: 'CA two' } })).cert.trim();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-upstream-cas-'));
  db = openDb(dir);
  cas = new UpstreamCaStore(db, () => undefined);
  agents = new AgentStore(
    db,
    dir,
    undefined,
    undefined,
    new McpSecretStore(db, () => undefined),
    cas,
  );
  setId = agents.globalId('');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Checks that a function throws an HttpError with the status 400.
 *
 * @param fn The function to call.
 */
function assertBadRequest(fn: () => unknown): void {
  assert.throws(fn, (err: unknown) => err instanceof HttpError && err.statusCode === 400);
}

test('a PEM text gives its certificates, without the text around them', () => {
  assert.equal(
    parseUpstreamCa(`subject=CN = CA one\n${caOne}\n\n${caTwo}\n`),
    `${caOne}\n${caTwo}\n`,
  );
  assert.equal(parseUpstreamCa('  \n'), '');
});

test('a PEM text without a valid certificate is refused', () => {
  assertBadRequest(() => parseUpstreamCa('not a certificate'));
  assertBadRequest(() =>
    parseUpstreamCa('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'),
  );
  assertBadRequest(() => parseUpstreamCa(`${caOne}\n${'#'.repeat(70_000)}`));
});

test('an MCP server keeps the upstream CA of its host, and a save without one keeps it', () => {
  const server = { name: 'docs', url: MCP_URL, auth: 'none' as const, headers: [] };
  agents.putMcpServer('', setId, { ...server, upstreamCa: caOne });
  assert.equal(agents.getSet('', setId).mcpServers[0]?.upstreamCa, `${caOne}\n`);

  agents.putMcpServer('', setId, server);
  assert.equal(cas.shared('', [MCP_HOST]), `${caOne}\n`);

  agents.putMcpServer('', setId, { ...server, upstreamCa: '' });
  assert.equal(agents.getSet('', setId).mcpServers[0]?.upstreamCa, null);
});

test('an MCP server without https gets no upstream CA, and an empty one leaves the CA of its host', () => {
  const server = {
    name: 'docs',
    url: 'http://mcp.internal:8080/mcp',
    auth: 'none' as const,
    headers: [],
  };
  assertBadRequest(() => agents.putMcpServer('', setId, { ...server, upstreamCa: caOne }));

  const keys = new ApiKeyStore(db, () => undefined, cas);
  keys.put('', 'MCP_TOKEN', ['mcp.internal:8080'], 'secret-value', caOne);
  agents.putMcpServer('', setId, { ...server, upstreamCa: '' });
  assert.equal(cas.shared('', ['mcp.internal:8080']), `${caOne}\n`);
});

test('an API key and an MCP server on the same host share its upstream CA', () => {
  const keys = new ApiKeyStore(db, () => undefined, cas);
  keys.put('', 'MCP_TOKEN', [MCP_HOST], 'secret-value', caOne);
  agents.putMcpServer('', setId, { name: 'docs', url: MCP_URL, auth: 'none', headers: [] });
  assert.equal(agents.getSet('', setId).mcpServers[0]?.upstreamCa, `${caOne}\n`);

  agents.deleteMcpServer('', setId, 'docs');
  assert.equal(cas.shared('', [MCP_HOST]), `${caOne}\n`);

  keys.remove('', 'MCP_TOKEN');
  assert.equal(cas.shared('', [MCP_HOST]), null);
});

test('deleting a set removes the upstream CAs that only its MCP servers used', () => {
  const extra = agents.createSet('', 'Extra').id;
  agents.putMcpServer('', extra, {
    name: 'docs',
    url: MCP_URL,
    auth: 'none',
    headers: [],
    upstreamCa: caTwo,
  });
  assert.equal(cas.listAll().length, 1);

  agents.deleteSet('', extra);
  assert.deepEqual(cas.listAll(), []);
});
