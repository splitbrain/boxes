/**
 * API keys that a user adds for services without a credential in Boxes.
 *
 * In each box of the user, the environment variable with the name of a key holds a
 * placeholder. The egress proxy replaces the placeholder with the key in each
 * header of a request to a host of the key.
 */

import { randomInt } from 'node:crypto';
import type { ApiKeySummary } from '../../shared/types.ts';
import { reservedEnvNames } from './boxenv.ts';
import { accountOf } from './credentials.ts';
import type { Db } from './db.ts';
import { HttpError } from './http-error.ts';
import { parseUpstreamCa, UpstreamCaStore } from './upstream-cas.ts';

/** One row of the api_keys table, with its hosts parsed. */
export interface ApiKeyRow {
  /** The username of the owner, or the empty user. */
  owner: string;
  /** The environment variable that holds the placeholder in each box of the owner. */
  name: string;
  /** The hosts where the egress proxy puts in the key, as allowlist patterns. */
  hosts: string[];
  /** The key, stored unencrypted, because the orchestrator gives it to the egress proxy. */
  secret: string;
  /**
   * The value in the environment of a box in place of the key. It is the
   * prefix of the key, followed by random characters. The random part has the
   * length of the rest of the key, but at least {@link MIN_RANDOM} characters.
   * It stays while the key keeps its shape, so a box created with it keeps working.
   */
  placeholder: string;
  /** Epoch milliseconds of the first store. */
  created_at: number;
  /** Epoch milliseconds of the last write. */
  updated_at: number;
}

/** The pattern of a shell-safe environment variable name. */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The pattern of an exact hostname, or of a hostname with a wildcard for the
 * first label. An optional port follows the hostname, as in `mcp.example.com:8443`.
 */
const HOST_PATTERN =
  /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[1-9][0-9]{0,4})?$/;

/**
 * The pattern of the prefix of a key that a placeholder copies. The prefix is a
 * series of segments of up to eight lowercase letters or digits, each followed
 * by a dash or an underscore, like `sk-or-v1-`. The limit keeps the random part
 * of a key out of its placeholder.
 */
const PREFIX_PATTERN = /^(?:[a-z0-9]{1,8}[-_])*/;

/** The minimum number of random characters in a placeholder. */
const MIN_RANDOM = 16;

/** The characters of the random part of a placeholder. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** The raw row as SQLite returns it, with the hosts still JSON. */
type StoredRow = Omit<ApiKeyRow, 'hosts'> & { hosts: string };

/** The store of the api_keys table. */
export class ApiKeyStore {
  /**
   * @param db The database that holds the api_keys table.
   * @param onChange The function that the store calls after each write.
   * @param upstreamCas The store of the upstream CAs of the hosts of the keys.
   */
  constructor(
    /** The database that holds the api_keys table. */
    private readonly db: Db,
    /** The function that the store calls after each write. */
    private readonly onChange: () => void,
    /** The upstream CAs of the hosts of the keys. */
    private readonly upstreamCas: UpstreamCaStore = new UpstreamCaStore(db, () => undefined),
  ) {}

  /**
   * Gives one key of a user.
   *
   * @param owner The user.
   * @param name The environment variable name of the key.
   * @returns The key, or undefined when no key has this name.
   */
  get(owner: string, name: string): ApiKeyRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM api_keys WHERE owner = ? AND name = ?')
      .get(owner, name) as StoredRow | undefined;
    return row ? parse(row) : undefined;
  }

  /**
   * Lists the keys of a user.
   *
   * @param owner The user.
   * @returns The keys, sorted by name.
   */
  list(owner: string): ApiKeyRow[] {
    const rows = this.db
      .prepare('SELECT * FROM api_keys WHERE owner = ? ORDER BY name')
      .all(owner) as StoredRow[];
    return rows.map(parse);
  }

  /**
   * Lists the keys of every user, for the egress policy.
   *
   * @returns The keys, sorted by owner and name.
   */
  listAll(): ApiKeyRow[] {
    const rows = this.db
      .prepare('SELECT * FROM api_keys ORDER BY owner, name')
      .all() as StoredRow[];
    return rows.map(parse);
  }

  /**
   * Stores a key under a variable name, replacing the one stored there.
   *
   * Without a secret, the stored key stays and only its hosts change. A new
   * key gets a new placeholder when its prefix or its length differs from
   * the old one, so the placeholder keeps the shape of the key.
   *
   * @param owner The user.
   * @param name The environment variable name of the key.
   * @param hosts The hosts of the key, as exact hostnames or `*.` wildcards, each with an
   *   optional port.
   * @param secret The key, or undefined to keep the stored key.
   * @param upstreamCa The upstream CA for all hosts of the key as PEM, an empty string to remove the upstream CA of
   *   the hosts, or undefined to keep the upstream CAs of the hosts.
   * @returns The stored row.
   * @throws {HttpError} A 400 when the name, a host, the secret or the upstream CA is not valid.
   */
  put(
    owner: string,
    name: string,
    hosts: readonly string[],
    secret: string | undefined,
    upstreamCa?: string,
  ): ApiKeyRow {
    if (!NAME_PATTERN.test(name)) {
      throw new HttpError(400, `${name} is not a valid environment variable name`);
    }
    if (reservedEnvNames().has(name)) {
      throw new HttpError(400, `${name} is set by Boxes itself`);
    }
    const patterns = [...new Set(hosts.map((h) => h.trim().toLowerCase()))].filter((h) => h);
    if (patterns.length === 0) throw new HttpError(400, 'hosts: name at least one host');
    for (const pattern of patterns) {
      if (!HOST_PATTERN.test(pattern) || Number(pattern.split(':')[1] ?? 0) > 65535) {
        throw new HttpError(400, `hosts: ${pattern} is not a hostname or a *. wildcard`);
      }
    }

    const ca = upstreamCa === undefined ? undefined : parseUpstreamCa(upstreamCa);

    const existing = this.get(owner, name);
    const key = secret ?? existing?.secret;
    if (!key) throw new HttpError(400, 'secret: must not be empty');
    const keepPlaceholder = existing !== undefined && sameShape(existing.secret, key);

    const now = Date.now();
    const row: ApiKeyRow = {
      owner,
      name,
      hosts: patterns,
      secret: key,
      placeholder: keepPlaceholder ? existing.placeholder : placeholderFor(key),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO api_keys (owner, name, hosts, secret, placeholder, created_at, updated_at)
         VALUES (@owner, @name, @hosts, @secret, @placeholder, @created_at, @updated_at)
         ON CONFLICT(owner, name) DO UPDATE SET
           hosts = excluded.hosts, secret = excluded.secret,
           placeholder = excluded.placeholder, updated_at = excluded.updated_at`,
      )
      .run({ ...row, hosts: JSON.stringify(row.hosts) });
    this.onChange();
    if (ca !== undefined) this.upstreamCas.put(owner, row.hosts, ca);
    this.upstreamCas.prune(owner);
    return row;
  }

  /**
   * Removes a key of a user.
   *
   * @param owner The user.
   * @param name The environment variable name of the key.
   * @throws {HttpError} A 404 when the user has no key with this name.
   */
  remove(owner: string, name: string): void {
    const info = this.db
      .prepare('DELETE FROM api_keys WHERE owner = ? AND name = ?')
      .run(owner, name);
    if (info.changes === 0) throw new HttpError(404, `No API key named ${name}`);
    this.onChange();
    this.upstreamCas.prune(owner);
  }

  /**
   * Makes the form of a key that the API reports. It holds only the last characters of the secret.
   *
   * @param row The stored key.
   * @returns The summary, with the upstream CA that all hosts of the key share and the flag for hosts with different
   *   upstream CAs.
   */
  summarize(row: ApiKeyRow): ApiKeySummary {
    return {
      name: row.name,
      hosts: row.hosts,
      account: accountOf(row.secret),
      upstreamCa: this.upstreamCas.shared(row.owner, row.hosts),
      mixedUpstreamCas: this.upstreamCas.mixed(row.owner, row.hosts),
      updatedAt: row.updated_at,
    };
  }
}

/**
 * Parses the hosts of a stored row.
 *
 * @param row The raw row.
 * @returns The row with its hosts as an array.
 */
function parse(row: StoredRow): ApiKeyRow {
  return { ...row, hosts: JSON.parse(row.hosts) as string[] };
}

/**
 * Gives the prefix of a key that its placeholder copies.
 *
 * @param secret The key.
 * @returns The prefix, or an empty string.
 */
function prefixOf(secret: string): string {
  return PREFIX_PATTERN.exec(secret)?.[0] ?? '';
}

/**
 * Checks if two keys have the same prefix and the same length.
 *
 * @param a The first key.
 * @param b The second key.
 * @returns True when the shapes are the same.
 */
function sameShape(a: string, b: string): boolean {
  return a.length === b.length && prefixOf(a) === prefixOf(b);
}

/**
 * Makes a new placeholder for a key. The placeholder is the prefix of the key,
 * followed by random characters up to the length of the key, but at least
 * {@link MIN_RANDOM} random characters.
 *
 * @param secret The key.
 * @returns The placeholder.
 */
export function placeholderFor(secret: string): string {
  const prefix = prefixOf(secret);
  const length = Math.max(secret.length - prefix.length, MIN_RANDOM);
  let random = '';
  for (let i = 0; i < length; i++) random += ALPHABET[randomInt(ALPHABET.length)];
  return prefix + random;
}
