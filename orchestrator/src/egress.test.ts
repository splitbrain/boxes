import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentStore } from './agents.ts';
import { ApiKeyStore } from './api-keys.ts';
import type { Config } from './config.ts';
import { loadConfig } from './config.ts';
import { type CredentialId, type CredentialRow, CredentialStore } from './credentials.ts';
import { type Db, openDb } from './db.ts';
import {
  composePolicy,
  type EgressBoxInput,
  EgressManager,
  type EgressMaterial,
  pushPolicy,
  type RefusedMcpToken,
  resolveEgressMaterial,
} from './egress.ts';
import { McpSecretStore } from './mcp-secrets.ts';

/** A real Claude token as the store holds it. */
const CLAUDE_TOKEN = 'sk-ant-oat01-the-real-claude-token';

/** A real OpenAI API key as the store holds it. */
const OPENAI_KEY = 'sk-therealopenaiapikey';

/** A real GitHub token as the store holds it. */
const GH_TOKEN = 'ghp_therealgithubtoken';

/** A real GitLab token as the store holds it. */
const GITLAB_TOKEN = 'glpat-therealgitlabtoken';

/** The temporary data directories that afterEach removes. */
let dirs: string[] = [];
/** The fake proxies that afterEach closes. */
let servers: http.Server[] = [];
/** The databases that afterEach closes. */
let dbs: Db[] = [];

afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
  for (const d of dbs) d.close();
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/**
 * Creates a temporary data directory that afterEach removes.
 *
 * @returns The path of the directory.
 */
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boxes-egress-'));
  dirs.push(dir);
  return dir;
}

/**
 * Returns a config from an environment, with defaults for everything else.
 *
 * @param env The variables to set, on top of a new data directory.
 * @returns The config.
 */
function configFrom(env: Record<string, string> = {}): Config {
  return loadConfig({ DATA_DIR: dataDir(), ...env });
}

/**
 * Returns a credential store over a database of its own, holding the given secrets.
 *
 * @param cfg The config with the data directory and the credential set.
 * @param secrets The token of each credential to store.
 * @param onChange The function that the store calls after each write.
 * @returns The store and its database.
 */
function storeWith(
  cfg: Config,
  secrets: Partial<Record<CredentialId, string>> = {},
  onChange: () => void = () => {},
): { store: CredentialStore; db: Db } {
  const db = openDb(cfg.DATA_DIR);
  dbs.push(db);
  const store = new CredentialStore(db, onChange, cfg.credentialSet);
  for (const [id, secret] of Object.entries(secrets)) {
    store.put('', id as CredentialId, 'token', secret);
  }
  return { store, db };
}

/**
 * Returns the rows of a store, as composePolicy takes them.
 *
 * @param store The credential store.
 * @returns The rows.
 */
function rows(store: CredentialStore): CredentialRow[] {
  return store.list('');
}

/**
 * Returns a box as composePolicy takes it, owned by the empty user, in a
 * closed profile without hosts.
 *
 * @param over The fields that replace the defaults.
 * @returns The box.
 */
function boxInput(over: Partial<EgressBoxInput> = {}): EgressBoxInput {
  return {
    id: 'b1',
    owner: '',
    token: 'f00d',
    open: false,
    hosts: [],
    mcpHosts: [],
    ...over,
  };
}

describe('resolveEgressMaterial', () => {
  it('generates a CA and a control token, and stores them in the database', async () => {
    const { db } = storeWith(configFrom());
    const material = await resolveEgressMaterial(db);

    expect(material.ca.cert).toContain('BEGIN CERTIFICATE');
    expect(material.ca.key).toContain('PRIVATE KEY');
    expect(material.controlToken).toMatch(/^[0-9a-f]{64}$/);

    const stored = db.prepare("SELECT value FROM app_keys WHERE key = 'egress'").get() as {
      value: string;
    };
    expect(JSON.parse(stored.value)).toEqual(material);
  }, 30_000);

  it('reuses what it stored, because running boxes hold the old CA', async () => {
    const { db } = storeWith(configFrom());
    const first = await resolveEgressMaterial(db);
    const second = await resolveEgressMaterial(db);

    expect(second.ca.cert).toBe(first.ca.cert);
    expect(second.controlToken).toBe(first.controlToken);
  }, 30_000);

  it('never writes a real credential to the material', async () => {
    const { db } = storeWith(configFrom(), { claude: CLAUDE_TOKEN, github: GH_TOKEN });
    await resolveEgressMaterial(db);
    const stored = db.prepare("SELECT value FROM app_keys WHERE key = 'egress'").get() as {
      value: string;
    };
    expect(stored.value).not.toContain(CLAUDE_TOKEN);
    expect(stored.value).not.toContain(GH_TOKEN);
  }, 30_000);
});

describe('composePolicy', () => {
  it('translates only the credentials the store holds a secret for', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg, { github: GH_TOKEN });
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(cfg, material, rows(store), [], []);

    expect(policy.credentials.map((c) => c.id)).toEqual(['github']);
    expect(policy.credentials[0]?.secret).toBe(GH_TOKEN);
    expect(policy.credentials[0]?.placeholder).toBe(store.get('', 'github')?.placeholder);
  }, 30_000);

  it('carries the credential of each user for one host, with the owner in the id', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg, { claude: CLAUDE_TOKEN });
    store.put('alice', 'claude', 'token', 'sk-ant-oat01-alice-token');
    const key = new ApiKeyStore(db, () => {}).put(
      'alice',
      'OPENROUTER_API_KEY',
      ['openrouter.ai'],
      'sk-or-v1-0123456789abcdef',
    );
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(cfg, material, store.listAll(), [key], []);

    // The proxy selects the credential whose placeholder is in the request.
    expect(policy.credentials.map((c) => [c.id, c.secret, c.placeholder])).toEqual([
      ['claude', CLAUDE_TOKEN, store.get('', 'claude')?.placeholder],
      ['alice/claude', 'sk-ant-oat01-alice-token', store.get('alice', 'claude')?.placeholder],
      ['api-key:alice/OPENROUTER_API_KEY', 'sk-or-v1-0123456789abcdef', key.placeholder],
    ]);
    expect(store.get('', 'claude')?.placeholder).not.toBe(
      store.get('alice', 'claude')?.placeholder,
    );
  }, 30_000);

  it('carries a Dev Tunnels login as its access token', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg);
    store.put(
      '',
      'devtunnels',
      'oauth',
      JSON.stringify({ access_token: 'ghu_theaccesstoken', refresh_token: 'ghr_refresh' }),
    );
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(cfg, material, rows(store), [], []);

    expect(policy.credentials).toHaveLength(1);
    expect(policy.credentials[0]?.secret).toBe('ghu_theaccesstoken');
  }, 30_000);

  it('carries an API key a user added, on its hosts and in any header', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg);
    const key = new ApiKeyStore(db, () => {}).put(
      '',
      'OPENROUTER_API_KEY',
      ['openrouter.ai'],
      'sk-or-v1-0123456789abcdef',
    );
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(cfg, material, rows(store), [key], []);

    expect(policy.credentials).toEqual([
      {
        id: 'api-key:OPENROUTER_API_KEY',
        hosts: ['openrouter.ai'],
        headers: [],
        placeholder: key.placeholder,
        secret: 'sk-or-v1-0123456789abcdef',
      },
    ]);
  }, 30_000);

  it('carries each secret of an MCP server on the host of the server and in its header', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg);
    const secrets = new McpSecretStore(db, () => {});
    const agents = new AgentStore(db, dataDir(), undefined, undefined, secrets);
    const work = agents.createSet('alice', 'Work');
    agents.putMcpServer('alice', work.id, {
      name: 'github',
      url: 'https://api.githubcopilot.com/mcp/',
      auth: 'bearer',
      headers: [{ name: 'Authorization', value: 'Bearer ghp_0123', secret: true }],
    });
    const global = agents.globalId('');
    agents.putMcpServer('', global, {
      name: 'todoist',
      url: 'https://ai.todoist.net:8443/mcp',
      auth: 'oauth',
      headers: [],
    });
    agents.putMcpServer('', global, {
      name: 'later',
      url: 'https://later.example.com/mcp',
      auth: 'oauth',
      headers: [],
    });
    secrets.putToken(global, 'todoist', {
      secret: 'Bearer at-1',
      oauth: '{}',
      expires_at: null,
      refreshed_at: 1,
    });
    /**
     * Gives the placeholder of the token row of a server.
     *
     * @param setId The set of the server.
     * @param server The name of the server.
     * @returns The placeholder, or '' when the row does not exist.
     */
    const placeholder = (setId: string, server: string): string =>
      secrets.get(setId, server, 'authorization')?.placeholder ?? '';
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(cfg, material, rows(store), [], [], secrets.listAll());

    // The OAuth server without a login has no secret, so it is absent.
    expect(policy.credentials).toEqual([
      {
        id: `alice/mcp/${work.id}/github/authorization`,
        hosts: ['api.githubcopilot.com:443'],
        headers: ['authorization'],
        placeholder: placeholder(work.id, 'github'),
        secret: 'Bearer ghp_0123',
      },
      {
        id: `mcp/${global}/todoist/authorization`,
        hosts: ['ai.todoist.net:8443'],
        headers: ['authorization'],
        placeholder: placeholder(global, 'todoist'),
        secret: 'Bearer at-1',
        oauth: true,
      },
    ]);
  }, 30_000);

  it('intercepts nothing when the store is empty, and still carries the CA', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg);
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(cfg, material, rows(store), [], []);

    expect(policy.credentials).toEqual([]);
    // A box keeps the CA it was created with for its whole life, and a
    // credential may be added later.
    expect(policy.ca).not.toBeNull();
    expect(policy.ca?.cert).toContain('BEGIN CERTIFICATE');
  }, 30_000);

  it('gives each box its token, its mode and the hosts of its profile', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg);
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(
      cfg,
      material,
      rows(store),
      [],
      [
        boxInput({ id: 'b1', token: 'aa', open: true }),
        boxInput({ id: 'b2', token: 'bb', hosts: ['registry.npmjs.org', '*.example.com:8443'] }),
      ],
    );

    expect(policy.boxes).toEqual([
      { box: 'b1', token: 'aa', open: true, hosts: [] },
      { box: 'b2', token: 'bb', open: false, hosts: ['registry.npmjs.org', '*.example.com:8443'] },
    ]);
  }, 30_000);

  it('adds the hosts of the credentials of the owner, also those the tools need', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg, { claude: CLAUDE_TOKEN, github: GH_TOKEN });
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(
      cfg,
      material,
      store.listAll(),
      [],
      [boxInput({ hosts: ['registry.npmjs.org'] })],
    );
    const hosts = policy.boxes[0]?.hosts ?? [];

    expect(hosts).toContain('registry.npmjs.org');
    expect(hosts).toContain('api.github.com');
    expect(hosts).toContain('platform.claude.com');
    expect(hosts).toContain('codeload.github.com');
  }, 30_000);

  it('adds the hosts of the API keys and the MCP servers of the box', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg);
    const key = new ApiKeyStore(db, () => {}).put(
      '',
      'OPENROUTER_API_KEY',
      ['openrouter.ai'],
      'sk-or-v1-0123456789abcdef',
    );
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(
      cfg,
      material,
      rows(store),
      [key],
      [boxInput({ hosts: ['openrouter.ai'], mcpHosts: ['mcp.example.com:443'] })],
    );

    // A host that is in two lists is in the policy one time.
    expect(policy.boxes[0]?.hosts).toEqual(['openrouter.ai', 'mcp.example.com:443']);
  }, 30_000);

  it('adds no hosts of the credentials and the API keys of other users', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg);
    store.put('alice', 'github', 'token', GH_TOKEN);
    const key = new ApiKeyStore(db, () => {}).put(
      'alice',
      'OPENROUTER_API_KEY',
      ['openrouter.ai'],
      'sk-or-v1-0123456789abcdef',
    );
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(
      cfg,
      material,
      store.listAll(),
      [key],
      [
        boxInput({ id: 'alice-box', owner: 'alice' }),
        boxInput({ id: 'bob-box', owner: 'bob', mcpHosts: ['mcp.example.com:443'] }),
      ],
    );
    /**
     * Gives the hosts of a box in the policy.
     *
     * @param id The id of the box.
     * @returns The hosts, or an empty list for a box that is not in the policy.
     */
    const hostsOf = (id: string): string[] => policy.boxes.find((b) => b.box === id)?.hosts ?? [];

    expect(hostsOf('alice-box')).toContain('api.github.com');
    expect(hostsOf('alice-box')).toContain('openrouter.ai');
    expect(hostsOf('alice-box')).not.toContain('mcp.example.com:443');
    expect(hostsOf('bob-box')).toEqual(['mcp.example.com:443']);
  }, 30_000);

  it('gives each box the upstream CAs of its owner', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg);
    const material = await resolveEgressMaterial(db);
    const row = { host: 'mcp.internal:8443', cert: 'PRIVATE CA', created_at: 1, updated_at: 1 };
    const policy = composePolicy(
      cfg,
      material,
      rows(store),
      [],
      [boxInput({ id: 'alice-box', owner: 'alice' }), boxInput({ id: 'bob-box', owner: 'bob' })],
      [],
      [{ ...row, owner: 'alice' }],
    );

    expect(policy.boxes.find((b) => b.box === 'alice-box')?.upstreamCas).toEqual([
      { host: 'mcp.internal:8443', cert: 'PRIVATE CA' },
    ]);
    expect(policy.boxes.find((b) => b.box === 'bob-box')?.upstreamCas).toBeUndefined();
  }, 30_000);

  it('intercepts the GitLab the deployment names, and only that one', async () => {
    const cfg = configFrom({ GITLAB_HOST: 'gitlab.example.com' });
    const { store, db } = storeWith(cfg, { gitlab: GITLAB_TOKEN });
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(cfg, material, rows(store), [], []);

    const gitlab = policy.credentials.find((c) => c.id === 'gitlab');
    expect(gitlab?.hosts).toEqual(['gitlab.example.com']);
    expect(gitlab?.headers).toEqual(['authorization', 'private-token']);
    expect(gitlab?.secret).toBe(GITLAB_TOKEN);
    expect(gitlab?.placeholder).toMatch(/^glpat-/);
  }, 30_000);

  it('has nothing to swap for a subscription obtained by logging in', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg);
    // `codex login --device-auth` leaves a document, not a header value. It
    // authenticates traffic to chatgpt.com, which the proxy does not intercept.
    store.put('', 'openai', 'oauth', '{"tokens":{"access_token":"a.b.c"}}');
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(cfg, material, rows(store), [], []);

    expect(policy.credentials.find((c) => c.id === 'openai')).toBeUndefined();
    // The row still has a placeholder, because a box gets one for every
    // stored credential, deliverable or not.
    expect(store.get('', 'openai')?.placeholder).toMatch(/^sk-/);
  }, 30_000);

  it('intercepts the OpenAI key host, and only that one', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg, { openai: OPENAI_KEY });
    const material = await resolveEgressMaterial(db);
    const policy = composePolicy(cfg, material, rows(store), [], [boxInput()]);
    const hosts = policy.boxes[0]?.hosts ?? [];

    const openai = policy.credentials.find((c) => c.id === 'openai');
    expect(openai?.hosts).toEqual(['api.openai.com']);
    expect(openai?.headers).toEqual(['authorization']);
    expect(openai?.secret).toBe(OPENAI_KEY);
    expect(openai?.placeholder).toBe(store.get('', 'openai')?.placeholder);

    // Codex logs in and refreshes at auth.openai.com and may talk to
    // chatgpt.com. Both stay reachable in a closed profile, and the key is
    // sent to neither.
    expect(hosts).toContain('auth.openai.com');
    expect(hosts).toContain('chatgpt.com');
    expect(openai?.hosts).not.toContain('chatgpt.com');
    // Only an egress profile adds these hosts.
    expect(hosts).not.toContain('files.openai.com');
    expect(hosts).not.toContain('ab.chatgpt.com');
  }, 30_000);
});

describe('the control channel, from the orchestrator side', () => {
  /**
   * Starts a fake proxy that records each request, and makes a config and a store for it.
   *
   * @param answer The status and the JSON body of each answer.
   * @returns The config, the material, the store and the recorded requests.
   */
  async function fakeProxy(answer: { status: number; body: unknown }): Promise<{
    cfg: Config;
    material: EgressMaterial;
    store: CredentialStore;
    seen: Array<{ method: string; url: string; auth: string; body: string }>;
  }> {
    const seen: Array<{ method: string; url: string; auth: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          auth: String(req.headers.authorization ?? ''),
          body,
        });
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });

    const cfg = configFrom({ EGRESS_CONTROL_URL: `http://127.0.0.1:${port}` });
    const { store, db } = storeWith(cfg, { claude: CLAUDE_TOKEN, github: GH_TOKEN });
    const material = await resolveEgressMaterial(db);
    return { cfg, material, store, seen };
  }

  /** The status of a proxy that applied the policy. */
  const okStatus = {
    applied: true,
    policyHash: 'abc',
    boxCount: 0,
    credentialIds: ['claude', 'github'],
    denials: {},
    uptimeSeconds: 1,
  };

  it('pushes the policy with its bearer', async () => {
    const { cfg, material, store, seen } = await fakeProxy({ status: 200, body: okStatus });
    const policy = composePolicy(cfg, material, rows(store), [], []);

    await expect(pushPolicy(cfg, material, policy)).resolves.toEqual(okStatus);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('/policy');
    expect(seen[0]?.auth).toBe(`Bearer ${material.controlToken}`);
    expect(JSON.parse(seen[0]!.body).credentials[0].secret).toBe(CLAUDE_TOKEN);
  }, 30_000);

  it("reports the proxy's own reason when it refuses a push", async () => {
    const { cfg, material, store } = await fakeProxy({
      status: 400,
      body: { error: 'invalid policy: a bare * ...' },
    });
    await expect(
      pushPolicy(cfg, material, composePolicy(cfg, material, rows(store), [], [])),
    ).rejects.toThrow(/proxy answered 400: invalid policy/);
  }, 30_000);
});

describe('EgressManager', () => {
  it('hands a box a placeholder for every stored credential, and the CA', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg, {
      claude: CLAUDE_TOKEN,
      openai: OPENAI_KEY,
      github: GH_TOKEN,
    });
    const manager = new EgressManager(cfg, store, new ApiKeyStore(db, () => {}), db);
    await manager.prepare();

    const claude = manager.placeholderFor('', 'claude');
    const github = manager.placeholderFor('', 'github');
    const openai = manager.placeholderFor('', 'openai');

    expect(claude).not.toBe(CLAUDE_TOKEN);
    expect(claude.startsWith('sk-ant-oat01-')).toBe(true);
    expect(github).not.toBe(GH_TOKEN);
    expect(github.startsWith('ghp_')).toBe(true);
    expect(openai).not.toBe(OPENAI_KEY);
    expect(openai.startsWith('sk-')).toBe(true);
    expect(manager.caCertificate()).toContain('BEGIN CERTIFICATE');
  }, 30_000);

  it('has the CA before any credential exists, and no placeholder', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg);
    const manager = new EgressManager(cfg, store, new ApiKeyStore(db, () => {}), db);
    await manager.prepare();

    // A box keeps the CA it was created with for its whole life. boxEnv drops
    // a variable with an empty value, so the box gets no credential variable.
    expect(manager.caCertificate()).toContain('BEGIN CERTIFICATE');
    expect(manager.placeholderFor('', 'claude')).toBe('');
    expect(manager.placeholderFor('', 'github')).toBe('');
    expect(manager.placeholderFor('', 'openai')).toBe('');
  }, 30_000);

  it('has nothing for a credential this deployment cannot translate', async () => {
    const cfg = configFrom();
    const { store, db } = storeWith(cfg);
    const manager = new EgressManager(cfg, store, new ApiKeyStore(db, () => {}), db);
    await manager.prepare();

    expect(manager.placeholderFor('', 'gemini')).toBe('');
  }, 30_000);

  it('recomposes from the store on every sync, so a pasted token is live', async () => {
    const seen: string[][] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push(
          (JSON.parse(body) as { credentials: Array<{ id: string }> }).credentials.map((c) => c.id),
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            applied: true,
            policyHash: 'x',
            boxCount: 0,
            credentialIds: [],
            denials: {},
            uptimeSeconds: 1,
          }),
        );
      });
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });

    const cfg = configFrom({ EGRESS_CONTROL_URL: `http://127.0.0.1:${port}` });
    // As in the app, a write to the store pushes the policy.
    let manager: EgressManager | undefined;
    const { store, db } = storeWith(cfg, {}, () => void manager?.sync());
    manager = new EgressManager(cfg, store, new ApiKeyStore(db, () => {}), db);
    await manager.prepare();

    await manager.sync();
    expect(seen.at(-1)).toEqual([]);

    store.put('', 'github', 'token', GH_TOKEN);
    await expect.poll(() => seen.at(-1)).toEqual(['github']);

    store.remove('', 'github');
    await expect.poll(() => seen.at(-1)).toEqual([]);
  }, 30_000);

  it('reports to each user only the credential ids of that user', async () => {
    // The fake proxy reports the ids of the policy that it got.
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const ids = (JSON.parse(body) as { credentials: Array<{ id: string }> }).credentials.map(
          (c) => c.id,
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            applied: true,
            policyHash: 'x',
            boxCount: 0,
            credentialIds: ids,
            denials: {},
            uptimeSeconds: 1,
          }),
        );
      });
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });

    const cfg = configFrom({ EGRESS_CONTROL_URL: `http://127.0.0.1:${port}` });
    const { store, db } = storeWith(cfg, { github: GH_TOKEN });
    store.put('alice', 'github', 'token', GH_TOKEN);
    const apiKeys = new ApiKeyStore(db, () => {});
    apiKeys.put('alice', 'OPENROUTER_API_KEY', ['openrouter.ai'], 'sk-or-v1-0123456789abcdef');
    const manager = new EgressManager(cfg, store, apiKeys, db);
    await manager.sync();

    expect(manager.status()?.credentialIds).toEqual([
      'github',
      'alice/github',
      'api-key:alice/OPENROUTER_API_KEY',
    ]);
    expect(manager.statusFor('alice')?.credentialIds).toEqual([
      'alice/github',
      'api-key:alice/OPENROUTER_API_KEY',
    ]);
    expect(manager.statusFor('')?.credentialIds).toEqual(['github']);
    expect(manager.statusFor('bob')?.credentialIds).toEqual([]);
  }, 30_000);

  it('gives the refused OAuth tokens of a push answer to onRefused, with their rows', async () => {
    const refusal = { status: 401, error: 'invalid_token', scope: null };
    let id = '';
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            applied: true,
            policyHash: 'x',
            boxCount: 0,
            credentialIds: [],
            denials: {},
            uptimeSeconds: 1,
            refusedTokens: [
              { credentialId: id, ...refusal },
              { credentialId: 'mcp/gone/docs/authorization', ...refusal },
            ],
          }),
        );
      });
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });

    const cfg = configFrom({ EGRESS_CONTROL_URL: `http://127.0.0.1:${port}` });
    const { store, db } = storeWith(cfg);
    const secrets = new McpSecretStore(db, () => {});
    const agents = new AgentStore(db, dataDir(), undefined, undefined, secrets);
    const global = agents.globalId('');
    agents.putMcpServer('', global, {
      name: 'docs',
      url: 'https://mcp.example.com/mcp',
      auth: 'oauth',
      headers: [],
    });
    secrets.putToken(global, 'docs', {
      secret: 'Bearer at-1',
      oauth: '{}',
      expires_at: null,
      refreshed_at: 1,
    });
    id = `mcp/${global}/docs/authorization`;
    const refused: RefusedMcpToken[][] = [];
    const manager = new EgressManager(
      cfg,
      store,
      new ApiKeyStore(db, () => {}),
      db,
      () => [],
      () => secrets.listAll(),
      (tokens) => refused.push(tokens),
    );
    await manager.sync();

    expect(refused.length).toBe(1);
    expect(refused[0]?.map((t) => [t.row.server, t.refusal])).toEqual([
      ['docs', { credentialId: id, ...refusal }],
    ]);
  }, 30_000);

  it('records why a push failed, for the health probe', async () => {
    const cfg = configFrom({ EGRESS_CONTROL_URL: 'http://127.0.0.1:1' });
    const { store, db } = storeWith(cfg, { claude: CLAUDE_TOKEN });
    const manager = new EgressManager(cfg, store, new ApiKeyStore(db, () => {}), db);
    await manager.prepare();

    expect(manager.status()).toBeNull();
    await expect(manager.sync()).rejects.toThrow();
    expect(manager.status()).toMatchObject({ inSync: false });
    expect(manager.status()?.error).toBeTruthy();
  }, 30_000);
});
