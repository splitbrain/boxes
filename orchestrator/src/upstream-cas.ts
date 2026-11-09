/**
 * The private certificate authorities that a user adds for the hosts of API keys and MCP servers.
 *
 * The egress proxy trusts the CA of a host, in addition to the public CAs, in requests from the boxes of the user. A
 * CA belongs to a host pattern, so all API keys and MCP servers of the user that name the pattern share it.
 */

import { X509Certificate } from 'node:crypto';
import type { Db } from './db.ts';
import { HttpError } from './http-error.ts';
import { mcpHostPattern } from './mcp-servers.ts';

/** One row of the upstream_cas table. */
export interface UpstreamCaRow {
  /** The username of the owner, or the empty user. */
  owner: string;
  /** The host pattern, as an API key or an MCP server names it. */
  host: string;
  /** One or more certificates, as PEM. */
  cert: string;
  /** Epoch milliseconds of the first store. */
  created_at: number;
  /** Epoch milliseconds of the last write. */
  updated_at: number;
}

/** The maximum length of the PEM text of one upstream CA. */
const MAX_PEM = 65_536;

/** The pattern of one PEM certificate. */
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * Checks the PEM text of an upstream CA that a user entered.
 *
 * @param pem The PEM text. Text around the certificates is allowed, e.g., the output of openssl.
 * @returns The certificates, one after another, or an empty string for an empty text.
 * @throws {HttpError} A 400 when the text is too long, holds no certificate, or holds a certificate that does not
 *   parse.
 */
export function parseUpstreamCa(pem: string): string {
  if (pem.trim() === '') return '';
  if (pem.length > MAX_PEM) {
    throw new HttpError(400, `upstreamCa: longer than ${MAX_PEM} characters`);
  }
  const blocks = pem.match(PEM_CERTIFICATE) ?? [];
  if (blocks.length === 0) throw new HttpError(400, 'upstreamCa: holds no PEM certificate');
  for (const block of blocks) {
    try {
      new X509Certificate(block);
    } catch (err) {
      throw new HttpError(
        400,
        `upstreamCa: a certificate does not parse: ${(err as Error).message}`,
      );
    }
  }
  return `${blocks.join('\n')}\n`;
}

/** The store of the upstream_cas table. */
export class UpstreamCaStore {
  /**
   * @param db The database that holds the upstream_cas table.
   * @param onChange The function that the store calls after each write.
   */
  constructor(
    /** The database that holds the upstream_cas table. */
    private readonly db: Db,
    /** The function that the store calls after each write. */
    private readonly onChange: () => void,
  ) {}

  /**
   * Gives the upstream CA that a set of hosts of a user shares.
   *
   * @param owner The user.
   * @param hosts The host patterns.
   * @returns The CA, or null when a host has none or the hosts have different ones.
   */
  shared(owner: string, hosts: readonly string[]): string | null {
    const [cert, ...rest] = this.distinct(owner, hosts);
    return rest.length === 0 ? (cert ?? null) : null;
  }

  /**
   * Checks if a set of hosts of a user has different upstream CAs. A host without an upstream CA differs from a host
   * with one.
   *
   * @param owner The user.
   * @param hosts The host patterns.
   * @returns True when two of the hosts differ.
   */
  mixed(owner: string, hosts: readonly string[]): boolean {
    return this.distinct(owner, hosts).length > 1;
  }

  /**
   * Gives the distinct upstream CAs of a set of hosts of a user.
   *
   * @param owner The user.
   * @param hosts The host patterns.
   * @returns The distinct certificates, with null for a host without an upstream CA.
   */
  private distinct(owner: string, hosts: readonly string[]): Array<string | null> {
    const query = this.db.prepare('SELECT cert FROM upstream_cas WHERE owner = ? AND host = ?');
    return [
      ...new Set(
        hosts.map((host) => (query.get(owner, host) as { cert: string } | undefined)?.cert ?? null),
      ),
    ];
  }

  /**
   * Lists the upstream CAs of every user, for the egress policy.
   *
   * @returns The rows, sorted by owner and host.
   */
  listAll(): UpstreamCaRow[] {
    return this.db
      .prepare('SELECT * FROM upstream_cas ORDER BY owner, host')
      .all() as UpstreamCaRow[];
  }

  /**
   * Sets the upstream CA of hosts of a user, or removes it.
   *
   * @param owner The user.
   * @param hosts The host patterns.
   * @param cert The CA as {@link parseUpstreamCa} returns it, or an empty string to remove the CA of the hosts.
   */
  put(owner: string, hosts: readonly string[], cert: string): void {
    const now = Date.now();
    const write =
      cert === ''
        ? this.db.prepare('DELETE FROM upstream_cas WHERE owner = ? AND host = ?')
        : this.db.prepare(
            `INSERT INTO upstream_cas (owner, host, cert, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(owner, host) DO UPDATE SET
               cert = excluded.cert, updated_at = excluded.updated_at`,
          );
    this.db.transaction(() => {
      for (const host of hosts) {
        if (cert === '') write.run(owner, host);
        else write.run(owner, host, cert, now, now);
      }
    })();
    this.onChange();
  }

  /**
   * Keeps only the upstream CAs of a user for the hosts that an API key or an MCP server of the user names.
   *
   * @param owner The user.
   */
  prune(owner: string): void {
    const keys = this.db.prepare('SELECT hosts FROM api_keys WHERE owner = ?').all(owner) as {
      hosts: string;
    }[];
    const servers = this.db
      .prepare(
        `SELECT m.url AS url FROM agent_mcp_servers m
           JOIN agent_sets a ON a.id = m.set_id
          WHERE a.owner = ?`,
      )
      .all(owner) as { url: string }[];
    const used = new Set([
      ...keys.flatMap((key) => JSON.parse(key.hosts) as string[]),
      ...servers.flatMap((server) => mcpHostPattern(server.url) ?? []),
    ]);

    const rows = this.db.prepare('SELECT host FROM upstream_cas WHERE owner = ?').all(owner) as {
      host: string;
    }[];
    const unused = rows.map((row) => row.host).filter((host) => !used.has(host));
    if (unused.length === 0) return;
    const remove = this.db.prepare('DELETE FROM upstream_cas WHERE owner = ? AND host = ?');
    this.db.transaction(() => {
      for (const host of unused) remove.run(owner, host);
    })();
    this.onChange();
  }
}
