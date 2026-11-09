import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCACertificate } from 'mockttp';
import { afterEach, beforeAll, beforeEach, test } from 'vitest';
import { ApiKeyStore, placeholderFor } from './api-keys.ts';
import { type Db, openDb } from './db.ts';
import { HttpError } from './http-error.ts';
import { UpstreamCaStore } from './upstream-cas.ts';

/** The temporary data directory of each test. */
let dir: string;
/** The database of each test. */
let db: Db;
/** The number of calls of the change callback. */
let changes: number;
/** The store under test. */
let store: ApiKeyStore;
/** The store of the upstream CAs that the store under test writes. */
let cas: UpstreamCaStore;
/** A CA certificate as PEM. */
let caOne: string;
/** Another CA certificate as PEM. */
let caTwo: string;

/** A key in the format of OpenRouter. */
const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

beforeAll(async () => {
  caOne = (await generateCACertificate({ subject: { commonName: 'CA one' } })).cert;
  caTwo = (await generateCACertificate({ subject: { commonName: 'CA two' } })).cert;
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-api-keys-'));
  db = openDb(dir);
  changes = 0;
  cas = new UpstreamCaStore(db, () => undefined);
  store = new ApiKeyStore(
    db,
    () => {
      changes += 1;
    },
    cas,
  );
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a key is stored with its hosts and shown as its last four characters', () => {
  store.put('', 'OPENROUTER_API_KEY', ['OpenRouter.ai', ' openrouter.ai '], KEY);

  const row = store.get('', 'OPENROUTER_API_KEY');
  assert.equal(row?.secret, KEY);
  assert.deepEqual(row?.hosts, ['openrouter.ai']);
  assert.deepEqual(store.summarize(row!), {
    name: 'OPENROUTER_API_KEY',
    hosts: ['openrouter.ai'],
    account: 'cdef',
    upstreamCa: null,
    mixedUpstreamCas: false,
    updatedAt: row!.updated_at,
  });
  assert.equal(changes, 1);
});

test('a placeholder copies the prefix and the length of the key, never the key', () => {
  const placeholder = placeholderFor(KEY);

  assert.match(placeholder, /^sk-or-v1-[A-Za-z0-9]{32}$/);
  assert.equal(placeholder.length, KEY.length);
  assert.notEqual(placeholder, KEY);
});

test('a placeholder leaves out what looks like the random part of a key', () => {
  // The underscore sits in the random part, after a segment too long for a prefix.
  assert.match(placeholderFor('sk-proj-AbCdEfGhIjK_LmNoPqRsTuVwXyZ'), /^sk-proj-[A-Za-z0-9]+$/);
  assert.match(placeholderFor('abcdefghijklmnop_qrstuv'), /^[A-Za-z0-9]{23}$/);
});

test('a short key gets a placeholder with enough random characters', () => {
  assert.match(placeholderFor('ab-12'), /^ab-[A-Za-z0-9]{16}$/);
});

test('the placeholder stays while the key keeps its shape, and changes with it', () => {
  const first = store.put('', 'OPENROUTER_API_KEY', ['openrouter.ai'], KEY).placeholder;

  const sameShape = KEY.replace('0123', '9999');
  assert.equal(
    store.put('', 'OPENROUTER_API_KEY', ['openrouter.ai'], sameShape).placeholder,
    first,
  );

  const longer = `${KEY}0000`;
  const second = store.put('', 'OPENROUTER_API_KEY', ['openrouter.ai'], longer).placeholder;
  assert.notEqual(second, first);
  assert.equal(second.length, longer.length);
});

test('without a secret only the hosts change', () => {
  const first = store.put('', 'OPENROUTER_API_KEY', ['openrouter.ai'], KEY);
  const second = store.put(
    '',
    'OPENROUTER_API_KEY',
    ['openrouter.ai', '*.openrouter.ai'],
    undefined,
  );

  assert.equal(second.secret, KEY);
  assert.equal(second.placeholder, first.placeholder);
  assert.deepEqual(second.hosts, ['openrouter.ai', '*.openrouter.ai']);
});

test('a new key needs a secret', () => {
  assert.throws(() => store.put('', 'OPENROUTER_API_KEY', ['openrouter.ai'], undefined), /secret/);
});

test('a name must be a variable name that Boxes does not set itself', () => {
  assert.throws(() => store.put('', '1KEY', ['openrouter.ai'], KEY), /not a valid/);
  assert.throws(() => store.put('', 'MY-KEY', ['openrouter.ai'], KEY), /not a valid/);
  const taken = ['GH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'HTTPS_PROXY', 'PATH'];
  for (const name of taken) {
    assert.throws(() => store.put('', name, ['openrouter.ai'], KEY), /set by Boxes/, name);
  }
  assert.equal(changes, 0);
});

test('hosts must be hostnames or one-label wildcards', () => {
  assert.throws(() => store.put('', 'KEY', [], KEY), /at least one host/);
  assert.throws(() => store.put('', 'KEY', ['*'], KEY), /not a hostname/);
  assert.throws(() => store.put('', 'KEY', ['api.*.com'], KEY), /not a hostname/);
  assert.throws(() => store.put('', 'KEY', ['https://openrouter.ai'], KEY), /not a hostname/);
  assert.doesNotThrow(() => store.put('', 'KEY', ['*.example.com', 'api.example.com'], KEY));
});

test('a host can name a port', () => {
  assert.deepEqual(store.put('', 'KEY', ['mcp.example.com:8443'], KEY).hosts, [
    'mcp.example.com:8443',
  ]);
  assert.throws(() => store.put('', 'KEY', ['mcp.example.com:0'], KEY), /not a hostname/);
  assert.throws(() => store.put('', 'KEY', ['mcp.example.com:65536'], KEY), /not a hostname/);
  assert.throws(() => store.put('', 'KEY', ['mcp.example.com:'], KEY), /not a hostname/);
});

test('removing a key forgets it, and an unknown name is a 404', () => {
  store.put('', 'OPENROUTER_API_KEY', ['openrouter.ai'], KEY);
  store.remove('', 'OPENROUTER_API_KEY');

  assert.equal(store.get('', 'OPENROUTER_API_KEY'), undefined);
  assert.deepEqual(store.list(''), []);
  assert.throws(() => store.remove('', 'OPENROUTER_API_KEY'), /No API key/);
});

test('an upstream CA goes to each host of a key, and the summary shows it', () => {
  const row = store.put(
    '',
    'KUBE_TOKEN',
    ['a.kube.example:6443', 'b.kube.example:6443'],
    KEY,
    caOne,
  );

  assert.equal(cas.shared('', ['a.kube.example:6443']), `${caOne.trim()}\n`);
  assert.equal(store.summarize(row).upstreamCa, `${caOne.trim()}\n`);
});

test('a key shows no upstream CA when its hosts have different ones', () => {
  store.put('', 'KUBE_TOKEN', ['a.kube.example:6443'], KEY, caOne);
  store.put('', 'OTHER_TOKEN', ['b.kube.example:6443'], KEY, caTwo);
  const row = store.put('', 'KUBE_TOKEN', ['a.kube.example:6443', 'b.kube.example:6443'], KEY);

  assert.equal(store.summarize(row).upstreamCa, null);
  assert.equal(store.summarize(row).mixedUpstreamCas, true);
  assert.equal(cas.shared('', ['b.kube.example:6443']), `${caTwo.trim()}\n`);
});

test('an empty upstream CA removes the CA of the hosts of a key', () => {
  store.put('', 'KUBE_TOKEN', ['a.kube.example:6443'], KEY, caOne);
  const row = store.put('', 'KUBE_TOKEN', ['a.kube.example:6443'], undefined, '');

  assert.equal(store.summarize(row).upstreamCa, null);
  assert.equal(store.summarize(row).mixedUpstreamCas, false);
});

test('an upstream CA stays while a key or an MCP server names its host', () => {
  store.put('', 'KUBE_TOKEN', ['a.kube.example:6443', 'b.kube.example:6443'], KEY, caOne);
  store.put('', 'OTHER_TOKEN', ['b.kube.example:6443'], KEY);

  store.put('', 'KUBE_TOKEN', ['a.kube.example:6443'], undefined);
  assert.equal(cas.shared('', ['b.kube.example:6443']), `${caOne.trim()}\n`);

  store.remove('', 'OTHER_TOKEN');
  assert.equal(cas.shared('', ['b.kube.example:6443']), null);
  assert.equal(cas.shared('', ['a.kube.example:6443']), `${caOne.trim()}\n`);
});

test('an upstream CA belongs to its user', () => {
  store.put('alice', 'KUBE_TOKEN', ['a.kube.example:6443'], KEY, caOne);
  store.put('bob', 'KUBE_TOKEN', ['a.kube.example:6443'], KEY);

  assert.equal(store.summarize(store.get('bob', 'KUBE_TOKEN')!).upstreamCa, null);
});

test('a key with an upstream CA that is not a certificate is not stored', () => {
  assert.throws(
    () => store.put('', 'KUBE_TOKEN', ['a.kube.example:6443'], KEY, 'not a certificate'),
    (err: unknown) => err instanceof HttpError && err.statusCode === 400,
  );
  assert.equal(store.get('', 'KUBE_TOKEN'), undefined);
});
