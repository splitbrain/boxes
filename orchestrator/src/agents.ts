/**
 * Agent sets for the agent in a box. A set holds an AGENTS.md, skills and
 * remote MCP servers.
 *
 * The database stores the sets. A set can also take skills from git
 * repositories, which the orchestrator pulls into checkouts under DATA_DIR.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { McpServer } from '@agentclientprotocol/sdk';
import { type Pack, pack } from 'tar-stream';
import type {
  AgentBundlePreview,
  AgentItem,
  AgentItemBody,
  AgentMcpServer,
  AgentMcpServerBody,
  AgentMcpServerState,
  AgentRepoBody,
  AgentSetDetail,
  AgentSetSummary,
} from '../../shared/types.ts';
import type { BuiltinSkill } from './builtin-skills.ts';
import type { AgentItemRow, AgentMcpServerRow, AgentRepoRow, AgentSetRow, Db } from './db.ts';
import { HARNESSES } from './harness.ts';
import { HttpError } from './http-error.ts';
import { log } from './log.ts';
import { McpSecretStore, OAUTH_HEADER } from './mcp-secrets.ts';
import {
  MAX_MCP_SERVERS,
  type McpSnapshotEntry,
  mcpHostPattern,
  resolveMcpServers,
  validMcpServer,
} from './mcp-servers.ts';
import {
  fetchRepo,
  findSkills,
  type RepoFetcher,
  type RepoSkill,
  repoDir,
  repoDirIds,
  repoName,
  repoTree,
} from './skill-repos.ts';
import { parseUpstreamCa, UpstreamCaStore } from './upstream-cas.ts';

/**
 * The pattern of a skill name. A name is safe as one path component. The
 * agent uses the name as the skill directory and as the word after the slash.
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The maximum length of the display name of a set. */
const MAX_SET_NAME = 100;

/** The maximum length of an AGENTS.md or of the content of one skill. */
const MAX_CONTENT = 100_000;

/** The maximum number of skills in one set, and in one repository. */
const MAX_ITEMS = 100;

/** The maximum number of repositories in one set. */
const MAX_REPOS = 20;

/** The maximum length of a repository URL. */
const MAX_URL = 500;

/**
 * The pattern of a branch, a tag or a full commit hash. The first character
 * cannot be a dash, so git cannot read the ref as an option.
 */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** The maximum age of the last pull of a repository before the next pull. */
const PULL_EVERY_MS = 24 * 60 * 60_000;

/**
 * One skill of a merged set, with its stored SKILL.md or with its directory in
 * the checkout of a repository.
 */
type BundleSkill =
  | { name: string; repo: null; content: string }
  | { name: string; repo: string; dir: string };

/** A merged set, with the source of each skill. */
interface Bundle {
  /** The merged AGENTS.md. */
  agentsMd: string;
  /** Every skill, sorted by name. */
  skills: BundleSkill[];
  /** The names of the skills in the selected set that replace a skill of the global set. */
  overrides: string[];
  /** Every MCP server, sorted by name. */
  mcpServers: McpSnapshotEntry[];
  /** The names of the MCP servers in the selected set that replace a server of the global set. */
  mcpOverrides: string[];
}

/** The display name of the global set of a user. */
const GLOBAL_SET_NAME = 'Global';

/**
 * The store of agent sets, with their skills, repositories and MCP servers.
 *
 * Each set belongs to one user. Each user has one global set. Each change
 * returns the whole set, so a client needs one request per screen.
 */
export class AgentStore {
  /**
   * @param db The database that stores the sets.
   * @param dataDir The DATA_DIR that holds the repository checkouts.
   * @param fetcher The function that fetches a repository into its checkout for the owner of its set.
   * @param builtins The function that returns the built-in skills of the orchestrator for a user.
   * @param secrets The store of the secrets of the MCP servers.
   * @param upstreamCas The store of the upstream CAs of the hosts of the MCP servers.
   */
  constructor(
    /** Where the sets are stored. */
    private readonly db: Db,
    /** The DATA_DIR the repository checkouts are written under. */
    private readonly dataDir: string,
    /** Fetches a repository into its checkout, for the owner of its set. */
    private readonly fetcher: OwnedRepoFetcher = (dir, url, ref, keep) =>
      fetchRepo(dir, url, ref, null, keep),
    /** Returns the built-in skills of the orchestrator for a user. */
    private readonly builtins: (owner: string) => BuiltinSkill[] = () => [],
    /** The secrets of the MCP servers. */
    private readonly secrets: McpSecretStore = new McpSecretStore(db, () => undefined),
    /** The upstream CAs of the hosts of the MCP servers. */
    private readonly upstreamCas: UpstreamCaStore = new UpstreamCaStore(db, () => undefined),
  ) {}

  /** The pulls running now, by repository id. */
  private readonly pulls = new Map<string, Promise<void>>();

  /**
   * Lists the sets of a user.
   *
   * @param owner The user.
   * @returns The summaries of the sets, the global set first and the rest by name.
   */
  listSets(owner: string): AgentSetSummary[] {
    this.globalId(owner);
    const rows = this.db
      .prepare(
        'SELECT * FROM agent_sets WHERE owner = ? ORDER BY global DESC, name COLLATE NOCASE ASC',
      )
      .all(owner) as AgentSetRow[];
    return rows.map((row) => this.summarize(row));
  }

  /**
   * Gives the id of the global set of a user, and makes the set when the user has none.
   *
   * @param owner The user.
   * @returns The id of the global set.
   */
  globalId(owner: string): string {
    const row = this.globalRow(owner);
    if (row) return row.id;
    const id = `as${randomBytes(5).toString('hex')}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO agent_sets (id, owner, global, name, agents_md, created_at, updated_at)
         VALUES (?, ?, 1, ?, '', ?, ?)`,
      )
      .run(id, owner, GLOBAL_SET_NAME, now, now);
    return id;
  }

  /**
   * Gives the row of the global set of a user.
   *
   * @param owner The user.
   * @returns The row, or undefined when the user has no global set yet.
   */
  private globalRow(owner: string): AgentSetRow | undefined {
    return this.db.prepare('SELECT * FROM agent_sets WHERE owner = ? AND global = 1').get(owner) as
      | AgentSetRow
      | undefined;
  }

  /**
   * Gives one set of a user with its AGENTS.md, skills, repositories and MCP servers.
   *
   * @param owner The user.
   * @param id The id of the set.
   * @returns The set.
   * @throws {HttpError} A 404 when the user has no set with this id.
   */
  getSet(owner: string, id: string): AgentSetDetail {
    const row = this.mustGet(owner, id);
    return {
      ...this.summarize(row),
      agentsMd: row.agents_md,
      items: this.items(id),
      repos: this.repoRows(id).map((repo) => ({
        id: repo.id,
        url: repo.url,
        ref: repo.ref,
        commit: repo.commit_sha,
        skills: repoSkills(repo).map((skill) => skill.name),
        pulledAt: repo.pulled_at,
        error: repo.error,
      })),
      mcpServers: this.mcpServers(id).map((server) => this.mcpState(owner, server)),
    };
  }

  /**
   * Gives the stored row of a set of a user.
   *
   * @param owner The user.
   * @param id The id of the set.
   * @returns The row.
   * @throws {HttpError} A 404 when the user has no set with this id.
   */
  private mustGet(owner: string, id: string): AgentSetRow {
    const row = this.db
      .prepare('SELECT * FROM agent_sets WHERE id = ? AND owner = ?')
      .get(id, owner) as AgentSetRow | undefined;
    if (!row) throw new HttpError(404, 'Agent set not found');
    return row;
  }

  /**
   * Gives the stored skills of a set.
   *
   * @param setId The id of the set.
   * @returns The skills, sorted by name.
   */
  private items(setId: string): AgentItem[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_items WHERE set_id = ? ORDER BY name COLLATE NOCASE ASC')
      .all(setId) as AgentItemRow[];
    return rows.map((row) => ({
      name: row.name,
      content: row.content,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Gives the stored MCP servers of a set.
   *
   * @param setId The id of the set.
   * @returns The servers, sorted by name.
   */
  private mcpServers(setId: string): McpSnapshotEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_mcp_servers WHERE set_id = ? ORDER BY name')
      .all(setId) as AgentMcpServerRow[];
    return rows.map((row) => ({
      setId,
      name: row.name,
      url: row.url,
      auth: row.auth,
      headers: JSON.parse(row.headers) as AgentMcpServer['headers'],
    }));
  }

  /**
   * Gives a stored MCP server in the form that the editor shows, with the
   * status of its OAuth token and the upstream CA of its host.
   *
   * @param owner The owner of the set of the server.
   * @param server The stored server.
   * @returns The server.
   */
  private mcpState(owner: string, { setId, ...server }: McpSnapshotEntry): AgentMcpServerState {
    const token =
      server.auth === 'oauth' ? this.secrets.get(setId, server.name, OAUTH_HEADER) : undefined;
    const host = mcpHostPattern(server.url);
    return {
      ...server,
      status: token?.status ?? null,
      lastError: token?.last_error ?? null,
      upstreamCa: host === null ? null : this.upstreamCas.shared(owner, [host]),
    };
  }

  /**
   * Gives one stored MCP server of a set of a user.
   *
   * @param owner The user.
   * @param setId The id of the set.
   * @param name The name of the server.
   * @returns The server.
   * @throws {HttpError} A 404 when the user has no such set or the server does not exist.
   */
  mcpServer(owner: string, setId: string, name: string): AgentMcpServer {
    this.mustGet(owner, setId);
    const found = this.mcpServers(setId).find((server) => server.name === name);
    if (!found) throw new HttpError(404, 'No such MCP server');
    const { setId: _, ...server } = found;
    return server;
  }

  /**
   * Gives the repository rows of a set.
   *
   * @param setId The id of the set.
   * @returns The rows, in the order of addition.
   */
  private repoRows(setId: string): AgentRepoRow[] {
    return this.db
      .prepare('SELECT * FROM agent_repos WHERE set_id = ? ORDER BY created_at, rowid')
      .all(setId) as AgentRepoRow[];
  }

  /**
   * Gives the row of one repository.
   *
   * @param repoId The id of the repository.
   * @returns The row, or undefined when the repository does not exist.
   */
  private repoRow(repoId: string): AgentRepoRow | undefined {
    return this.db.prepare('SELECT * FROM agent_repos WHERE id = ?').get(repoId) as
      | AgentRepoRow
      | undefined;
  }

  /**
   * Makes the summary of a set, with counts and flags but without the content.
   *
   * @param row The stored row of the set.
   * @returns The summary.
   */
  private summarize(row: AgentSetRow): AgentSetSummary {
    const counts = this.db
      .prepare('SELECT COUNT(*) AS skills FROM agent_items WHERE set_id = ?')
      .get(row.id) as { skills: number };
    const repos = this.db
      .prepare('SELECT COUNT(*) AS n FROM agent_repos WHERE set_id = ?')
      .get(row.id) as { n: number };
    const used = this.db
      .prepare("SELECT COUNT(*) AS n FROM boxes WHERE agent_set_id = ? AND status != 'deleted'")
      .get(row.id) as { n: number };
    return {
      id: row.id,
      name: row.name,
      global: row.global === 1,
      hasAgentsMd: row.agents_md.trim() !== '',
      skillCount: counts.skills,
      repoCount: repos.n,
      boxCount: used.n,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Checks if a user has a set.
   *
   * @param owner The user.
   * @param id The id of the set.
   * @returns True when the set exists and belongs to the user.
   */
  has(owner: string, id: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM agent_sets WHERE id = ? AND owner = ?').get(id, owner) !==
      undefined
    );
  }

  /**
   * Gives the display name of a set.
   *
   * @param id The id of the set, or null.
   * @returns The name, or null when the id is null or the set does not exist.
   */
  nameOf(id: string | null): string | null {
    if (!id) return null;
    const row = this.db.prepare('SELECT name FROM agent_sets WHERE id = ?').get(id) as
      | { name: string }
      | undefined;
    return row?.name ?? null;
  }

  /**
   * Adds a set for a user. The orchestrator makes the id, so user input never names a path.
   *
   * @param owner The user.
   * @param name The display name of the set.
   * @returns The new set.
   * @throws {HttpError} A 400 when the name is empty or too long.
   */
  createSet(owner: string, name: string): AgentSetDetail {
    const clean = validSetName(name);
    const now = Date.now();
    const id = `as${randomBytes(5).toString('hex')}`;
    this.db
      .prepare(
        `INSERT INTO agent_sets (id, owner, name, agents_md, created_at, updated_at)
         VALUES (?, ?, ?, '', ?, ?)`,
      )
      .run(id, owner, clean, now, now);
    return this.getSet(owner, id);
  }

  /**
   * Renames a set, or replaces its AGENTS.md. A field that is absent stays the same.
   *
   * @param owner The user.
   * @param id The id of the set.
   * @param body The new name, the new AGENTS.md, or both.
   * @returns The changed set.
   * @throws {HttpError} A 404 when the user has no such set, or a 400 when a field is not valid.
   */
  updateSet(
    owner: string,
    id: string,
    body: { name?: unknown; agentsMd?: unknown },
  ): AgentSetDetail {
    const row = this.mustGet(owner, id);
    const name = body.name === undefined ? row.name : validSetName(body.name);
    const agentsMd =
      body.agentsMd === undefined ? row.agents_md : validContent(body.agentsMd, 'agentsMd');
    this.db
      .prepare('UPDATE agent_sets SET name = ?, agents_md = ?, updated_at = ? WHERE id = ?')
      .run(name, agentsMd, Date.now(), id);
    return this.getSet(owner, id);
  }

  /**
   * Removes a set and the checkouts of its repositories. The global set cannot
   * be removed, because every box of its owner gets it.
   *
   * The database clears the set from each box that uses it. At its next
   * start, such a box gets only the global set.
   *
   * @param owner The user.
   * @param id The id of the set.
   * @throws {HttpError} A 404 when the user has no such set, or a 400 for the global set.
   */
  deleteSet(owner: string, id: string): void {
    const row = this.mustGet(owner, id);
    if (row.global === 1) {
      throw new HttpError(
        400,
        'The global set is applied to every box of its owner and cannot be deleted',
      );
    }
    const repos = this.repoRows(id);
    this.db.prepare('DELETE FROM agent_sets WHERE id = ?').run(id);
    this.upstreamCas.prune(owner);
    for (const repo of repos)
      rmSync(repoDir(this.dataDir, repo.id), { recursive: true, force: true });
  }

  /**
   * Creates a skill, or replaces the skill with the same name.
   *
   * @param owner The user.
   * @param id The id of the set.
   * @param body The name and the content of the skill.
   * @returns The changed set.
   * @throws {HttpError} A 404 when the user has no such set, or a 400 when a field is not valid or
   *   the set is full.
   */
  putItem(owner: string, id: string, body: AgentItemBody | undefined): AgentSetDetail {
    this.mustGet(owner, id);
    const name = validItemName(body?.name);
    const content = validContent(body?.content, 'content');
    const now = Date.now();

    const existing = this.db
      .prepare('SELECT 1 FROM agent_items WHERE set_id = ? AND name = ?')
      .get(id, name);
    if (!existing) {
      const count = this.db
        .prepare('SELECT COUNT(*) AS n FROM agent_items WHERE set_id = ?')
        .get(id) as { n: number };
      if (count.n >= MAX_ITEMS) {
        throw new HttpError(400, `A set holds at most ${MAX_ITEMS} skills`);
      }
    }

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO agent_items (set_id, name, content, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(set_id, name) DO UPDATE SET
             content = excluded.content, updated_at = excluded.updated_at`,
        )
        .run(id, name, content, now, now);
      this.db.prepare('UPDATE agent_sets SET updated_at = ? WHERE id = ?').run(now, id);
    })();
    return this.getSet(owner, id);
  }

  /**
   * Removes one skill.
   *
   * @param owner The user.
   * @param id The id of the set.
   * @param name The name of the skill.
   * @returns The changed set.
   * @throws {HttpError} A 404 when the user has no such set or the skill does not exist, or a 400
   *   for a name that is not valid.
   */
  deleteItem(owner: string, id: string, name: unknown): AgentSetDetail {
    this.mustGet(owner, id);
    const info = this.db
      .prepare('DELETE FROM agent_items WHERE set_id = ? AND name = ?')
      .run(id, validItemName(name));
    if (info.changes === 0) throw new HttpError(404, 'No such skill');
    this.db.prepare('UPDATE agent_sets SET updated_at = ? WHERE id = ?').run(Date.now(), id);
    return this.getSet(owner, id);
  }

  /**
   * Creates an MCP server, or changes the headers of the server with the same
   * name. The server and its secret rows change in one transaction.
   *
   * @param owner The user.
   * @param id The id of the set.
   * @param body The name, the URL, the auth mode, the headers and the upstream CA of the server.
   * @returns The changed set.
   * @throws {HttpError} A 404 when the user has no such set, or a 400 when a field is not valid,
   *   the URL or the auth mode of the stored server differs, or the set is full.
   */
  putMcpServer(owner: string, id: string, body: AgentMcpServerBody): AgentSetDetail {
    this.mustGet(owner, id);
    const { upstreamCa, ...fields } = body;
    const server = validMcpServer(fields);
    const ca = upstreamCa === undefined ? undefined : parseUpstreamCa(upstreamCa);
    const https = new URL(server.url).protocol === 'https:';
    if (ca && !https) {
      throw new HttpError(400, 'upstreamCa: a server without https has no TLS to check');
    }
    const now = Date.now();

    const existing = this.db
      .prepare('SELECT * FROM agent_mcp_servers WHERE set_id = ? AND name = ?')
      .get(id, server.name) as AgentMcpServerRow | undefined;
    if (existing && (existing.url !== server.url || existing.auth !== server.auth)) {
      throw new HttpError(
        400,
        'The URL and the auth mode of an MCP server are fixed. Delete the server and add it again',
      );
    }
    if (!existing) {
      const count = this.db
        .prepare('SELECT COUNT(*) AS n FROM agent_mcp_servers WHERE set_id = ?')
        .get(id) as { n: number };
      if (count.n >= MAX_MCP_SERVERS) {
        throw new HttpError(400, `A set holds at most ${MAX_MCP_SERVERS} MCP servers`);
      }
    }

    // The values of the secret headers go into the secret rows only.
    const stored = server.headers.map((header) =>
      header.secret ? { ...header, value: '' } : header,
    );
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO agent_mcp_servers (set_id, name, url, auth, headers, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(set_id, name) DO UPDATE SET
             headers = excluded.headers, updated_at = excluded.updated_at`,
        )
        .run(id, server.name, server.url, server.auth, JSON.stringify(stored), now, now);
      this.secrets.writeForServer(id, server.name, server.auth, server.headers);
      this.db.prepare('UPDATE agent_sets SET updated_at = ? WHERE id = ?').run(now, id);
    })();
    const host = mcpHostPattern(server.url);
    // The host of a server without https can belong to an API key, so its upstream CA stays.
    if (ca !== undefined && https && host !== null) this.upstreamCas.put(owner, [host], ca);
    return this.getSet(owner, id);
  }

  /**
   * Removes one MCP server, together with its secret rows.
   *
   * @param owner The user.
   * @param id The id of the set.
   * @param name The name of the server.
   * @returns The changed set.
   * @throws {HttpError} A 404 when the user has no such set or the server does not exist.
   */
  deleteMcpServer(owner: string, id: string, name: unknown): AgentSetDetail {
    this.mustGet(owner, id);
    const info = this.db
      .prepare('DELETE FROM agent_mcp_servers WHERE set_id = ? AND name = ?')
      .run(id, typeof name === 'string' ? name.trim().toLowerCase() : '');
    if (info.changes === 0) throw new HttpError(404, 'No such MCP server');
    this.db.prepare('UPDATE agent_sets SET updated_at = ? WHERE id = ?').run(Date.now(), id);
    this.upstreamCas.prune(owner);
    return this.getSet(owner, id);
  }

  /**
   * Adds a repository to a set and pulls it. A failed pull is recorded on the
   * repository, which stays in the set.
   *
   * @param owner The user.
   * @param setId The id of the set.
   * @param body The URL and the ref of the repository.
   * @returns The changed set.
   * @throws {HttpError} A 404 when the user has no such set, or a 400 when a field is not valid or
   *   the set has the maximum number of repositories.
   */
  async addRepo(
    owner: string,
    setId: string,
    body: AgentRepoBody | undefined,
  ): Promise<AgentSetDetail> {
    this.mustGet(owner, setId);
    const url = validRepoUrl(body?.url);
    const ref = validRef(body?.ref);
    const count = this.db
      .prepare('SELECT COUNT(*) AS n FROM agent_repos WHERE set_id = ?')
      .get(setId) as { n: number };
    if (count.n >= MAX_REPOS) {
      throw new HttpError(400, `A set takes skills from at most ${MAX_REPOS} repositories`);
    }

    const id = `ar${randomBytes(5).toString('hex')}`;
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO agent_repos (id, set_id, url, ref, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, setId, url, ref, now);
      this.db.prepare('UPDATE agent_sets SET updated_at = ? WHERE id = ?').run(now, setId);
    })();
    await this.pullRepo(id);
    return this.getSet(owner, setId);
  }

  /**
   * Removes a repository from a set, with its checkout.
   *
   * @param owner The user.
   * @param setId The id of the set.
   * @param repoId The id of the repository.
   * @returns The changed set.
   * @throws {HttpError} A 404 when the user has no such set or the repository does not exist.
   */
  deleteRepo(owner: string, setId: string, repoId: string): AgentSetDetail {
    this.mustGet(owner, setId);
    const info = this.db
      .prepare('DELETE FROM agent_repos WHERE id = ? AND set_id = ?')
      .run(repoId, setId);
    if (info.changes === 0) throw new HttpError(404, 'No such repository');
    rmSync(repoDir(this.dataDir, repoId), { recursive: true, force: true });
    this.db.prepare('UPDATE agent_sets SET updated_at = ? WHERE id = ?').run(Date.now(), setId);
    return this.getSet(owner, setId);
  }

  /**
   * Pulls one repository of a set now.
   *
   * @param owner The user.
   * @param setId The id of the set.
   * @param repoId The id of the repository.
   * @returns The set after the pull.
   * @throws {HttpError} A 404 when the user has no such set or the set does not have the repository.
   */
  async refreshRepo(owner: string, setId: string, repoId: string): Promise<AgentSetDetail> {
    this.mustGet(owner, setId);
    if (this.repoRow(repoId)?.set_id !== setId) throw new HttpError(404, 'No such repository');
    await this.pullRepo(repoId);
    return this.getSet(owner, setId);
  }

  /**
   * Removes the checkouts that no repository owns. Then pulls, one after the
   * other, each repository that has no pull or a pull older than {@link PULL_EVERY_MS}.
   *
   * @param now The current time in milliseconds since the epoch.
   */
  async pullDue(now = Date.now()): Promise<void> {
    const ids = this.db.prepare('SELECT id FROM agent_repos').all() as Array<{ id: string }>;
    const known = new Set(ids.map((row) => row.id));
    for (const id of repoDirIds(this.dataDir)) {
      if (!known.has(id)) rmSync(repoDir(this.dataDir, id), { recursive: true, force: true });
    }

    const due = this.db
      .prepare(
        `SELECT id FROM agent_repos WHERE pulled_at IS NULL OR pulled_at <= ?
          ORDER BY created_at, rowid`,
      )
      .all(now - PULL_EVERY_MS) as Array<{ id: string }>;
    for (const { id } of due) await this.pullRepo(id);
  }

  /**
   * Pulls one repository. When a pull of the repository runs already, the method gives that pull.
   *
   * @param repoId The id of the repository.
   * @returns A promise that settles when the pull ends.
   */
  pullRepo(repoId: string): Promise<void> {
    const running = this.pulls.get(repoId);
    if (running) return running;
    const pull = this.fetchAndRecord(repoId).finally(() => this.pulls.delete(repoId));
    this.pulls.set(repoId, pull);
    return pull;
  }

  /**
   * Fetches one repository and records its commit and skills. A failed fetch
   * is recorded, not thrown, and the last good checkout stays in use. The
   * fetcher gets the owner of the set.
   *
   * @param repoId The id of the repository.
   */
  private async fetchAndRecord(repoId: string): Promise<void> {
    const row = this.repoRow(repoId);
    if (!row) return;
    const exists = (): boolean => this.repoRow(repoId) !== undefined;
    const set = this.db.prepare('SELECT owner FROM agent_sets WHERE id = ?').get(row.set_id) as
      | { owner: string }
      | undefined;
    if (!set) return;

    let commit: string;
    try {
      commit = await this.fetcher(
        repoDir(this.dataDir, repoId),
        row.url,
        row.ref,
        exists,
        set.owner,
      );
    } catch (err) {
      const error = (err as Error).message;
      log.warn('could not pull a skill repository', { url: row.url, ref: row.ref, error });
      this.db
        .prepare('UPDATE agent_repos SET pulled_at = ?, error = ? WHERE id = ?')
        .run(Date.now(), error, repoId);
      return;
    }
    if (!exists()) return;

    const skills = findSkills(
      repoTree(this.dataDir, repoId),
      repoName(row.url),
      (name) => NAME_PATTERN.test(name),
      MAX_ITEMS,
    );
    this.db
      .prepare(
        `UPDATE agent_repos SET commit_sha = ?, skills = ?, pulled_at = ?, error = NULL
          WHERE id = ?`,
      )
      .run(commit, JSON.stringify(skills), Date.now(), repoId);
  }

  /**
   * Gives the merged set for a box, in the form that the editor shows.
   *
   * @param owner The owner of the box.
   * @param setId The id of the set that the box selected, or null for only the global set.
   * @returns The merged AGENTS.md, the skills with their sources, and the overridden skill names.
   */
  bundle(owner: string, setId: string | null): AgentBundlePreview {
    const { agentsMd, skills, overrides, mcpServers, mcpOverrides } = this.merge(owner, setId);
    return {
      agentsMd,
      skills: skills.map((skill) => ({ name: skill.name, repo: skill.repo })),
      overrides,
      mcpServers: mcpServers.map((server) => ({ name: server.name, url: server.url })),
      mcpOverrides,
    };
  }

  /**
   * Gives the merged MCP servers for a box. The adapters of the box use this
   * list until its next start.
   *
   * @param owner The owner of the box.
   * @param setId The id of the set that the box selected, or null for only the global set.
   * @returns The servers, sorted by name.
   */
  mcpSnapshot(owner: string, setId: string | null): McpSnapshotEntry[] {
    return this.merge(owner, setId).mcpServers;
  }

  /**
   * Makes the `mcpServers` list for an adapter from the servers of a box, with
   * the placeholders of their secret rows. A server without a stored secret is
   * left out, with a warning in the log.
   *
   * @param owner The owner of the box.
   * @param servers The servers that the box got at its start.
   * @returns The list for the adapter.
   */
  mcpServersFor(owner: string, servers: readonly McpSnapshotEntry[]): McpServer[] {
    return resolveMcpServers(
      servers,
      (setId, server, header) => {
        const row = this.secrets.get(setId, server, header);
        return row && row.secret !== '' ? row.placeholder : undefined;
      },
      (server, header) =>
        log.warn('left out an MCP server, because it has no secret for a header', {
          owner,
          server,
          header,
        }),
    );
  }

  /**
   * Merges the selected set over the global set of the owner.
   *
   * The merged AGENTS.md is the global AGENTS.md, then a blank line, then the
   * AGENTS.md of the selected set. A skill or an MCP server of the selected set
   * replaces a skill or a server of the global set with the same name. A
   * selected set of another user counts as no selection.
   *
   * @param owner The owner of the box.
   * @param setId The id of the selected set, or null for only the global set.
   * @returns The merged set.
   */
  private merge(owner: string, setId: string | null): Bundle {
    const global = this.globalRow(owner);
    const extra = setId
      ? (this.db
          .prepare('SELECT * FROM agent_sets WHERE id = ? AND owner = ? AND global = 0')
          .get(setId, owner) as AgentSetRow | undefined)
      : undefined;

    const agentsMd = [global?.agents_md ?? '', extra?.agents_md ?? '']
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .join('\n\n');

    const byName = global ? this.skillsOf(global.id) : new Map<string, BundleSkill>();
    const overrides: string[] = [];
    for (const skill of extra ? this.skillsOf(extra.id).values() : []) {
      if (byName.has(skill.name)) overrides.push(skill.name);
      byName.set(skill.name, skill);
    }

    const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

    const servers = new Map(
      (global ? this.mcpServers(global.id) : []).map((server) => [server.name, server]),
    );
    const mcpOverrides: string[] = [];
    for (const server of extra ? this.mcpServers(extra.id) : []) {
      if (servers.has(server.name)) mcpOverrides.push(server.name);
      servers.set(server.name, server);
    }
    const mcpServers = [...servers.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { agentsMd, skills, overrides, mcpServers, mcpOverrides };
  }

  /**
   * Collects the skills of one set. A stored skill of the set replaces a skill
   * of its repositories. A repository has priority over the repositories added
   * after it.
   *
   * @param setId The id of the set.
   * @returns The skills by name.
   */
  private skillsOf(setId: string): Map<string, BundleSkill> {
    const byName = new Map<string, BundleSkill>();
    for (const repo of this.repoRows(setId)) {
      const tree = repoTree(this.dataDir, repo.id);
      for (const skill of repoSkills(repo)) {
        if (byName.has(skill.name)) continue;
        byName.set(skill.name, { name: skill.name, repo: repo.url, dir: join(tree, skill.path) });
      }
    }
    for (const item of this.items(setId)) {
      byName.set(item.name, { name: item.name, repo: null, content: item.content });
    }
    return byName;
  }

  /**
   * Packs the merged set of a box as a tar stream. The file service in the box
   * installs the tar into the home, so each path is relative to the home.
   *
   * The tar holds the set once for each harness, in the layout of that
   * harness, because a box can hold threads of each harness. A skill folder
   * that two harnesses share is in the tar only once. The tar also
   * holds the built-in skills of the orchestrator, except where the set has a
   * skill with the same name.
   *
   * @param owner The owner of the box.
   * @param setId The id of the set that the box selected, or null for only the global set.
   * @returns The tar stream.
   */
  pack(owner: string, setId: string | null): Readable {
    const bundle = this.merge(owner, setId);
    const names = new Set(bundle.skills.map((skill) => skill.name));
    for (const skill of this.builtins(owner)) {
      if (!names.has(skill.name))
        bundle.skills.push({ name: skill.name, repo: null, content: skill.content });
    }
    const tar = pack();
    const skillDirs = new Set<string>();
    for (const { layout } of Object.values(HARNESSES)) {
      if (bundle.agentsMd !== '') addText(tar, layout.agentsMd, bundle.agentsMd);
      if (skillDirs.has(layout.skills)) continue;
      skillDirs.add(layout.skills);
      for (const skill of bundle.skills) {
        const rel = `${layout.skills}/${skill.name}`;
        if (skill.repo === null) {
          addText(tar, `${rel}/SKILL.md`, skill.content);
        } else if (existsSync(skill.dir)) {
          // A pull may have replaced the checkout this skill was found in.
          addTree(tar, skill.dir, rel);
        }
      }
    }
    tar.finalize();
    return Readable.from(tar);
  }
}

/**
 * Fetches a repository into its checkout, like {@link RepoFetcher}, with the
 * owner of the set of the repository as the last argument. The owner selects
 * the credential of the fetch.
 */
export type OwnedRepoFetcher = (
  ...args: [...Parameters<RepoFetcher>, owner: string]
) => ReturnType<RepoFetcher>;

/**
 * Gives the skills that the last good pull of a repository found.
 *
 * @param row The row of the repository.
 * @returns The skills.
 */
function repoSkills(row: AgentRepoRow): RepoSkill[] {
  return JSON.parse(row.skills) as RepoSkill[];
}

/**
 * Adds one text file to the tar, with a final newline.
 *
 * @param tar The tar to add to.
 * @param name The path of the file in the tar.
 * @param content The text of the file.
 */
function addText(tar: Pack, name: string, content: string): void {
  const text = content.endsWith('\n') ? content : `${content}\n`;
  tar.entry({ name, mode: 0o644, size: Buffer.byteLength(text) }, text);
}

/**
 * Adds a skill's directory from a checkout to the tar. Files keep their
 * mode, so a script stays executable. Links are left out, because they could
 * point anywhere on this host.
 *
 * @param tar The tar to add to.
 * @param src The directory to add.
 * @param name The path of the directory in the tar.
 */
function addTree(tar: Pack, src: string, name: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = `${name}/${entry.name}`;
    if (entry.isDirectory()) {
      addTree(tar, from, to);
    } else if (entry.isFile()) {
      const bytes = readFileSync(from);
      tar.entry({ name: to, mode: statSync(from).mode & 0o777, size: bytes.length }, bytes);
    }
  }
}

/**
 * Checks the display name of a set.
 *
 * @param value The name from the request.
 * @returns The trimmed name.
 * @throws {HttpError} A 400 when the name is empty or too long.
 */
function validSetName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name === '') throw new HttpError(400, 'name is required');
  if (name.length > MAX_SET_NAME) {
    throw new HttpError(400, `name must be ${MAX_SET_NAME} characters or fewer`);
  }
  return name;
}

/**
 * Checks a skill name after trim and lowercase. A name that does not match
 * {@link NAME_PATTERN} is refused, because the name becomes a path component.
 *
 * @param value The name from the request.
 * @returns The trimmed name in lowercase.
 * @throws {HttpError} A 400 when the name does not match.
 */
function validItemName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!NAME_PATTERN.test(name)) {
    throw new HttpError(
      400,
      'name must be lowercase letters, digits and dashes, start with a letter or digit, ' +
        'and be 64 characters or fewer',
    );
  }
  return name;
}

/**
 * Checks a repository URL. Only HTTPS URLs are accepted. Credentials in the
 * URL are refused, because the orchestrator stores and shows the URL.
 *
 * @param value The URL from the request.
 * @returns The trimmed URL.
 * @throws {HttpError} A 400 when the URL is not valid.
 */
function validRepoUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'url must be an HTTPS URL');
  }
  if (url.protocol !== 'https:') throw new HttpError(400, 'url must be an HTTPS URL');
  if (raw.length > MAX_URL) {
    throw new HttpError(400, `url must be ${MAX_URL} characters or fewer`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new HttpError(400, 'url must not contain credentials');
  }
  return raw;
}

/**
 * Checks a branch, tag or commit hash.
 *
 * @param value The ref from the request.
 * @returns The trimmed ref, or an empty string for the default branch.
 * @throws {HttpError} A 400 when the ref is not valid.
 */
function validRef(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, 'ref must be a string');
  const ref = value.trim();
  if (ref !== '' && !REF_PATTERN.test(ref)) {
    throw new HttpError(400, 'ref must be a branch, a tag or a full commit hash');
  }
  return ref;
}

/**
 * Checks the content of a file. Empty content is valid.
 *
 * @param value The content from the request.
 * @param field The name of the field, for the error message.
 * @returns The content with LF line endings.
 * @throws {HttpError} A 400 when the content is not a string or is too long.
 */
function validContent(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  if (value.length > MAX_CONTENT) {
    throw new HttpError(400, `${field} must be ${MAX_CONTENT} characters or fewer`);
  }
  // Line endings become LF, so what is stored is what the editor showed.
  return value.replace(/\r\n?/g, '\n');
}
