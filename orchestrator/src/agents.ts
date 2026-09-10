import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import {
  GLOBAL_AGENT_SET,
  type AgentBundlePreview,
  type AgentItem,
  type AgentItemBody,
  type AgentItemKind,
  type AgentSetDetail,
  type AgentSetSummary,
} from '../../shared/types.ts';
import type { AgentItemRow, AgentSetRow, Db } from './db.ts';
import { HttpError } from './http-error.ts';
import { chownToAgent } from './workspaces.ts';

/**
 * What the agent is configured with, and how a session gets it.
 *
 * Three things go in: an `AGENTS.md`, skills, and slash commands. They live in
 * named sets. One set — `global` — is applied to every session; a session may
 * name one more, and the two are merged, the named set winning where both
 * define a skill or a command of the same name.
 *
 * The database is the source of truth and the files are derived from it. At
 * every create and every start, a session's merged set is written out as a
 * directory under `${DATA_DIR}/agents/<id>`, bind-mounted read-only into the
 * container, and installed into `~/.claude` by the entrypoint. That hop is
 * needed because `~/.claude` is on the home volume, which the orchestrator
 * has no path to, and Claude reads its user configuration from there alone.
 *
 * Editing a set therefore reaches a session at its next start rather than
 * while it runs.
 */

/** Where the merged sets are materialized, under DATA_DIR. */
export const AGENTS_SUBDIR = 'agents';

/**
 * A name that is safe as a single path component and is what the agent will
 * call the thing: a skill directory, or the word after the slash.
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Longest a set's display name may be. */
const MAX_SET_NAME = 100;

/** Longest an AGENTS.md or one item's content may be. */
export const MAX_CONTENT = 100_000;

/** Most items of one kind a single set may hold. */
const MAX_ITEMS_PER_KIND = 100;

/** The parent of every materialized set. */
export function agentsRoot(dataDir: string): string {
  return join(dataDir, AGENTS_SUBDIR);
}

/** Where a session's merged configuration is written, as this process sees it. */
export function agentConfigPath(dataDir: string, sessionId: string): string {
  return join(agentsRoot(dataDir), sessionId);
}

/**
 * The same directory as the Docker daemon sees it, which is what a bind source
 * has to name. Bind sources are resolved by the daemon rather than by the
 * process asking for the mount.
 */
export function hostAgentConfigPath(hostDataDir: string, sessionId: string): string {
  return posix.join(hostDataDir, AGENTS_SUBDIR, sessionId);
}

/** Creates the parent of every materialized set, mode 0700. */
export function ensureAgentsRoot(dataDir: string): void {
  mkdirSync(agentsRoot(dataDir), { recursive: true, mode: 0o700 });
}

/**
 * Sets, their items, and the merged bundle a session is given.
 *
 * Every mutation returns the whole set, so a client needs one round trip per
 * screen rather than one per field.
 */
export class AgentStore {
  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
  ) {}

  // --- reading --------------------------------------------------------------

  /** Every set, the global one first and the rest by name. */
  listSets(): AgentSetSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_sets ORDER BY (id = ?) DESC, name COLLATE NOCASE ASC')
      .all(GLOBAL_AGENT_SET) as AgentSetRow[];
    return rows.map((row) => this.summarize(row));
  }

  /** One set with everything in it, or a 404. */
  getSet(id: string): AgentSetDetail {
    const row = this.mustGet(id);
    return {
      ...this.summarize(row),
      agentsMd: row.agents_md,
      items: this.items(id),
    };
  }

  /** The stored row for a set, or a 404. */
  private mustGet(id: string): AgentSetRow {
    const row = this.db.prepare('SELECT * FROM agent_sets WHERE id = ?').get(id) as
      | AgentSetRow
      | undefined;
    if (!row) throw new HttpError(404, 'Agent set not found');
    return row;
  }

  /** A set's items, skills before commands and each kind by name. */
  private items(setId: string): AgentItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_items WHERE set_id = ?
          ORDER BY kind DESC, name COLLATE NOCASE ASC`,
      )
      .all(setId) as AgentItemRow[];
    return rows.map((row) => ({
      kind: row.kind,
      name: row.name,
      content: row.content,
      updatedAt: row.updated_at,
    }));
  }

  /** Counts and flags, without loading any content. */
  private summarize(row: AgentSetRow): AgentSetSummary {
    const counts = this.db
      .prepare(
        `SELECT
           SUM(kind = 'skill')   AS skills,
           SUM(kind = 'command') AS commands
         FROM agent_items WHERE set_id = ?`,
      )
      .get(row.id) as { skills: number | null; commands: number | null };
    const used = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM sessions WHERE agent_set_id = ? AND status != 'deleted'",
      )
      .get(row.id) as { n: number };
    return {
      id: row.id,
      name: row.name,
      global: row.id === GLOBAL_AGENT_SET,
      hasAgentsMd: row.agents_md.trim() !== '',
      skillCount: counts.skills ?? 0,
      commandCount: counts.commands ?? 0,
      sessionCount: used.n,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Whether a set exists, without loading it. */
  has(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM agent_sets WHERE id = ?').get(id) !== undefined;
  }

  /** A set's display name, or null when it is gone. */
  nameOf(id: string | null): string | null {
    if (!id) return null;
    const row = this.db.prepare('SELECT name FROM agent_sets WHERE id = ?').get(id) as
      | { name: string }
      | undefined;
    return row?.name ?? null;
  }

  // --- writing --------------------------------------------------------------

  /** Adds a set. Its id is server-generated: user input never names a path. */
  createSet(name: string): AgentSetDetail {
    const clean = validSetName(name);
    const now = Date.now();
    const id = `as${randomBytes(5).toString('hex')}`;
    this.db
      .prepare(
        `INSERT INTO agent_sets (id, name, agents_md, created_at, updated_at)
         VALUES (?, ?, '', ?, ?)`,
      )
      .run(id, clean, now, now);
    return this.getSet(id);
  }

  /** Renames a set, or replaces its AGENTS.md. An absent field is left alone. */
  updateSet(id: string, body: { name?: unknown; agentsMd?: unknown }): AgentSetDetail {
    const row = this.mustGet(id);
    const name = body.name === undefined ? row.name : validSetName(body.name);
    const agentsMd =
      body.agentsMd === undefined ? row.agents_md : validContent(body.agentsMd, 'agentsMd');
    this.db
      .prepare('UPDATE agent_sets SET name = ?, agents_md = ?, updated_at = ? WHERE id = ?')
      .run(name, agentsMd, Date.now(), id);
    return this.getSet(id);
  }

  /**
   * Removes a set. The global one stays, because it is the thing every
   * session gets.
   *
   * Sessions that named it are not blocked and not touched. Their files are
   * already materialized; the column clears itself and they fall back to the
   * global set alone at their next start.
   */
  deleteSet(id: string): void {
    this.mustGet(id);
    if (id === GLOBAL_AGENT_SET) {
      throw new HttpError(400, 'The global set is applied to every session and cannot be deleted');
    }
    this.db.prepare('DELETE FROM agent_sets WHERE id = ?').run(id);
  }

  /** Creates a skill or command, or replaces the one already under that name. */
  putItem(id: string, body: AgentItemBody | undefined): AgentSetDetail {
    this.mustGet(id);
    const kind = validKind(body?.kind);
    const name = validItemName(body?.name);
    const content = validContent(body?.content, 'content');
    const now = Date.now();

    const existing = this.db
      .prepare('SELECT 1 FROM agent_items WHERE set_id = ? AND kind = ? AND name = ?')
      .get(id, kind, name);
    if (!existing) {
      const count = this.db
        .prepare('SELECT COUNT(*) AS n FROM agent_items WHERE set_id = ? AND kind = ?')
        .get(id, kind) as { n: number };
      if (count.n >= MAX_ITEMS_PER_KIND) {
        throw new HttpError(
          400,
          `A set holds at most ${MAX_ITEMS_PER_KIND} ${kind}s`,
        );
      }
    }

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO agent_items (set_id, kind, name, content, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(set_id, kind, name) DO UPDATE SET
             content = excluded.content, updated_at = excluded.updated_at`,
        )
        .run(id, kind, name, content, now, now);
      this.db.prepare('UPDATE agent_sets SET updated_at = ? WHERE id = ?').run(now, id);
    })();
    return this.getSet(id);
  }

  /** Removes one skill or command. Removing what is not there is a 404. */
  deleteItem(id: string, kind: unknown, name: unknown): AgentSetDetail {
    this.mustGet(id);
    const info = this.db
      .prepare('DELETE FROM agent_items WHERE set_id = ? AND kind = ? AND name = ?')
      .run(id, validKind(kind), validItemName(name));
    if (info.changes === 0) throw new HttpError(404, 'No such skill or command');
    this.db.prepare('UPDATE agent_sets SET updated_at = ? WHERE id = ?').run(Date.now(), id);
    return this.getSet(id);
  }

  // --- merging --------------------------------------------------------------

  /**
   * What a session that selected `setId` gets: the global set with that one
   * laid over it.
   *
   * The two kinds of content merge differently. An AGENTS.md is prose and
   * accumulates: the global one comes first and the set's follows, separated
   * by a blank line. A skill or a command is addressed by name, and two files
   * cannot share one, so the set's wins.
   */
  bundle(setId: string | null): AgentBundlePreview {
    const global = this.db
      .prepare('SELECT * FROM agent_sets WHERE id = ?')
      .get(GLOBAL_AGENT_SET) as AgentSetRow | undefined;
    const extra =
      setId && setId !== GLOBAL_AGENT_SET
        ? (this.db.prepare('SELECT * FROM agent_sets WHERE id = ?').get(setId) as
            | AgentSetRow
            | undefined)
        : undefined;

    const agentsMd = [global?.agents_md ?? '', extra?.agents_md ?? '']
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .join('\n\n');

    const byKey = new Map<string, AgentItem>();
    for (const item of global ? this.items(global.id) : []) {
      byKey.set(`${item.kind}/${item.name}`, item);
    }
    const overrides: AgentBundlePreview['overrides'] = [];
    for (const item of extra ? this.items(extra.id) : []) {
      const key = `${item.kind}/${item.name}`;
      if (byKey.has(key)) overrides.push({ kind: item.kind, name: item.name });
      byKey.set(key, item);
    }

    const items = [...byKey.values()].sort(
      (a, b) => b.kind.localeCompare(a.kind) || a.name.localeCompare(b.name),
    );
    return { agentsMd, items, overrides };
  }

  // --- materializing --------------------------------------------------------

  /**
   * Writes a session's merged set to its directory and returns that path.
   *
   * The layout is already the one it takes inside `~/.claude`, so the
   * entrypoint copies rather than interprets: `CLAUDE.md`, `skills/<name>/
   * SKILL.md`, `commands/<name>.md`, and a `manifest` naming each of them.
   * The manifest is what makes the install reversible — the container records
   * it and, at the next start, removes exactly what it put there before, so a
   * skill deleted here disappears from the box rather than staying on its
   * home volume.
   *
   * The directory's own inode is kept and only its contents are replaced: a
   * running container has it bind-mounted, and swapping the directory would
   * leave that container mounted on an unlinked one.
   */
  materialize(sessionId: string, setId: string | null): string {
    const dir = agentConfigPath(this.dataDir, sessionId);
    ensureAgentsRoot(this.dataDir);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    for (const entry of readdirSync(dir)) {
      rmSync(join(dir, entry), { recursive: true, force: true });
    }

    const bundle = this.bundle(setId);
    const manifest: string[] = [];

    if (bundle.agentsMd !== '') {
      // Claude reads its user-level memory from ~/.claude/CLAUDE.md, which is
      // what the dashboard calls AGENTS.md. Landing it here applies it to
      // every directory the agent works in rather than only to /workspace.
      this.write(dir, 'CLAUDE.md', bundle.agentsMd);
      manifest.push('CLAUDE.md');
    }
    for (const item of bundle.items) {
      const rel =
        item.kind === 'skill' ? `skills/${item.name}` : `commands/${item.name}.md`;
      this.write(dir, item.kind === 'skill' ? `${rel}/SKILL.md` : rel, item.content);
      manifest.push(rel);
    }
    this.write(dir, 'manifest', manifest.join('\n'));

    chownToAgent(dir);
    return dir;
  }

  /** Writes one file under the materialized directory, agent-owned. */
  private write(dir: string, rel: string, content: string): void {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    // Every directory on the way down has to be traversable by the agent user,
    // not only the leaf.
    for (let at = dirname(path); relative(dir, at) !== ''; at = dirname(at)) {
      chownToAgent(at);
    }
    writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`, { mode: 0o644 });
    chownToAgent(path);
  }

  /** Drops a session's materialized directory, when the session is deleted. */
  removeMaterialized(sessionId: string): void {
    rmSync(agentConfigPath(this.dataDir, sessionId), { recursive: true, force: true });
  }
}

// --- validation ---------------------------------------------------------------
//
// These names become path components inside the container and the word after a
// slash in the composer, so they are checked against a pattern rather than
// sanitized: a rejected name is a message, a sanitized one is a surprise.

/** Checks a set's display name. */
function validSetName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name === '') throw new HttpError(400, 'name is required');
  if (name.length > MAX_SET_NAME) {
    throw new HttpError(400, `name must be ${MAX_SET_NAME} characters or fewer`);
  }
  return name;
}

/** Checks a skill or command name. */
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

/** Checks which kind of item is meant. */
function validKind(value: unknown): AgentItemKind {
  if (value !== 'skill' && value !== 'command') {
    throw new HttpError(400, "kind must be 'skill' or 'command'");
  }
  return value;
}

/** Checks a file's content, which may legitimately be empty. */
function validContent(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  if (value.length > MAX_CONTENT) {
    throw new HttpError(400, `${field} must be ${MAX_CONTENT} characters or fewer`);
  }
  // A lone CR or a CRLF pair reaches a file the agent reads; normalise here so
  // what is stored is what the editor showed.
  return value.replace(/\r\n?/g, '\n');
}
