/**
 * The SQLite database of the orchestrator, in WAL mode. The runtime holds the
 * runtime state of the boxes, and the adapter holds the transcripts.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type {
  AgentMcpAuth,
  BoxStatus,
  HarnessCatalog,
  HarnessId,
  ThreadConfigOption,
  ThreadModeState,
} from '../../shared/types.ts';

/** A row of the boxes table. */
export interface BoxRow {
  /** The box id, which the orchestrator makes. */
  id: string;
  /** The display name. */
  name: string;
  /**
   * The username of the owner, or the empty user. The box uses the credentials,
   * the agent sets and the settings of its owner.
   */
  owner: string;
  /** The credential profile. Every box is DEFAULT. */
  profile: string;
  /**
   * The revision that the review compares against, as the user gave it, for
   * example a branch, a tag or a short id. Null means the HEAD of each
   * repository. Each repository in the workspace resolves it separately, for
   * each request.
   */
  review_base_rev: string | null;
  /** The lifecycle state. A deleted box keeps its row as a tombstone. */
  status: BoxStatus;
  /**
   * The extra agent set of this box, or null for only the global set. The
   * database clears it when the set is deleted.
   */
  agent_set_id: string | null;
  /** The bearer token that a WebSocket upgrade must give. It opens only this box. */
  ws_token: string;
  /**
   * The egress profile of this box, or null for the default profile of the
   * owner. The database clears it when the profile is deleted.
   */
  egress_profile_id: string | null;
  /**
   * The token that identifies the box at the egress proxy. It is the password
   * in the proxy URL of the box, and it identifies only this box.
   */
  proxy_token: string;
  /** Epoch milliseconds of creation. */
  created_at: number;
  /** Epoch milliseconds of the last activity. The idle reaper reads it. */
  last_active_at: number;
  /** The last measured disk usage in bytes, or null before the first measurement. */
  disk_bytes: number | null;
  /** Epoch milliseconds of the last disk measurement, or null before the first. */
  disk_measured_at: number | null;
  /**
   * Epoch milliseconds of the end of the setup after the last container start,
   * or null while the box is not ready.
   */
  ready_at: number | null;
  /**
   * The merged MCP servers of the agent sets of the box at its last start, as a
   * JSON array of McpSnapshotEntry.
   */
  mcp_servers: string;
}

/** One stored thread of a box. */
export interface ThreadRow {
  /** The thread id. */
  id: string;
  /** The box the thread belongs to. */
  box_id: string;
  /**
   * The harness id of the agent of this thread. Each thread has its own
   * harness, because one box can run both agents, and only the adapter that
   * wrote a transcript can load it.
   */
  harness: HarnessId;
  /**
   * The session id of the thread in the adapter, or null while the adapter has
   * none. A thread without a prompt loses its session at an adapter restart.
   */
  acp_session_id: string | null;
  /**
   * The title of the thread. It is the title that the agent makes at the end
   * of a turn, or the first line of a prompt while the thread has no title.
   * Null for a thread without a prompt.
   */
  title: string | null;
  /** The number of the thread in its box, never used again. It names a thread without a title. */
  ordinal: number;
  /** 1 while a prompt turn is running on this thread, else 0. */
  turn_active: number;
  /**
   * The source thread of a fork, until the first prompt of the fork. The
   * adapter writes the transcript of a fork only at that prompt, so until then
   * the replay comes from the source thread.
   */
  inherits_from: string | null;
  /**
   * The intended mode of this thread, or null for the default of the
   * deployment. The row stores it, because an adapter that starts again loads
   * the session without its mode.
   */
  mode_id: string | null;
  /**
   * The other options of the thread, for example the model, as a JSON map from
   * the option id of the adapter to its value. The row stores them, because an
   * adapter that starts again loads the session without them. An option that
   * repeats the mode is not stored here, so the two values cannot differ.
   */
  config: string;
  /**
   * 1 when the user marked this thread done, else 0. The mark changes only how
   * the dashboard shows the thread.
   */
  done: number;
  /** Epoch milliseconds of creation. */
  created_at: number;
  /** Epoch milliseconds of the last activity. */
  last_active_at: number;
}

/** A permission request for which the adapter still waits. */
export interface PendingRequestRow {
  /** The row id. */
  id: number;
  /** The box of the adapter that asked. */
  box_id: string;
  /**
   * The ACP session that asked, so a browser gets only the requests for the
   * thread that it shows. Null when the request names no session.
   */
  acp_session_id: string | null;
  /** The JSON-RPC method of the request. */
  method: string;
  /** The JSON-encoded params of the request. */
  params: string;
  /** Epoch milliseconds of arrival. */
  created_at: number;
}

/** One browser that subscribed to push notifications. */
export interface PushSubscriptionRow {
  /**
   * The opaque URL of the push service for this subscription, and the key of
   * the row. A browser that subscribes again gets the same endpoint.
   */
  endpoint: string;
  /** The public key of the subscriber, uncompressed P-256, base64url. */
  p256dh: string;
  /** The authentication secret of the subscriber, base64url. */
  auth: string;
  /** The name that the browser gave at registration, for the UI only. */
  label: string | null;
  /** Epoch milliseconds of the first registration. */
  created_at: number;
  /** Epoch milliseconds of the last successful push. */
  last_used_at: number;
  /**
   * The VAPID public key of the subscription, or null when the row has none. A
   * push signed with another key is refused.
   */
  vapid_key: string | null;
  /** The username of the user who subscribed, or the empty user. */
  owner: string;
}

/**
 * One named agent set, with an AGENTS.md and any number of skills.
 *
 * The global set of a user applies to every box of that user. A box can name
 * one more set at creation, and the orchestrator merges its content over the
 * global set.
 */
export interface AgentSetRow {
  /** The set id. */
  id: string;
  /** The username of the owner, or the empty user. */
  owner: string;
  /** 1 for the global set of the owner, else 0. Each owner has at most one. */
  global: number;
  /** The display name. */
  name: string;
  /** The AGENTS.md of this set, or '' when it has none. */
  agents_md: string;
  /** Epoch milliseconds of creation. */
  created_at: number;
  /** Epoch milliseconds of the last change. */
  updated_at: number;
}

/** A row of the egress_profiles table. */
export interface EgressProfileRow {
  /** The profile id. */
  id: string;
  /** The username of the owner, or the empty user. */
  owner: string;
  /** 1 for the default profile of the owner, else 0. Each owner has at most one. */
  is_default: number;
  /** The display name. */
  name: string;
  /** 1 for the open mode, 0 for the closed mode. */
  open: number;
  /** The host patterns of the profile, as a JSON array. */
  hosts: string;
  /** Epoch milliseconds of creation. */
  created_at: number;
  /** Epoch milliseconds of the last change. */
  updated_at: number;
}

/** One remote MCP server of an agent set. */
export interface AgentMcpServerRow {
  /** The set the server belongs to. */
  set_id: string;
  /** The name of the server, unique in its set. */
  name: string;
  /** The URL of the server. */
  url: string;
  /** The way the agent authenticates at the server. */
  auth: AgentMcpAuth;
  /**
   * The headers as a JSON array of AgentMcpHeader. A secret header has an
   * empty value, and agent_mcp_secrets holds the value.
   */
  headers: string;
  /** Epoch milliseconds of creation. */
  created_at: number;
  /** Epoch milliseconds of the last change. */
  updated_at: number;
}

/** One skill of an agent set. */
export interface AgentItemRow {
  /** The set the skill belongs to. */
  set_id: string;
  /** The skill name, which is safe as one path component. */
  name: string;
  /** The SKILL.md content. */
  content: string;
  /** Epoch milliseconds of creation. */
  created_at: number;
  /** Epoch milliseconds of the last change. */
  updated_at: number;
}

/** One git repository that an agent set takes skills from. */
export interface AgentRepoRow {
  /** The repository id, which also names its directory under DATA_DIR. */
  id: string;
  /** The set the repository belongs to. */
  set_id: string;
  /** The HTTPS URL for the fetch. */
  url: string;
  /** The branch, tag or commit to fetch, or '' for the default branch. */
  ref: string;
  /** The commit of the current checkout, or null before the first good pull. */
  commit_sha: string | null;
  /** The skills found in the current checkout, as a JSON array of RepoSkill. */
  skills: string;
  /** Epoch milliseconds of the last pull, good or failed, or null before the first. */
  pulled_at: number | null;
  /** The reason of the last failed pull, or null when the pull worked. */
  error: string | null;
  /** Epoch milliseconds of creation. */
  created_at: number;
}

/**
 * The schema migrations, applied in order and tracked by user_version. The
 * array is exported, so a test can build a database at an earlier version.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    profile        TEXT NOT NULL DEFAULT 'DEFAULT',
    repo_url       TEXT,
    image          TEXT NOT NULL,
    agent_cmd      TEXT NOT NULL,
    container_id   TEXT,
    network_name   TEXT NOT NULL,
    subnet         TEXT NOT NULL,
    ws_volume      TEXT NOT NULL,
    home_volume    TEXT NOT NULL,
    status         TEXT NOT NULL,
    acp_session_id TEXT,
    turn_active    INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL
  );
  CREATE TABLE pending_requests (
    id INTEGER PRIMARY KEY, session_id TEXT NOT NULL,
    upstream_id TEXT NOT NULL, method TEXT NOT NULL,
    params TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE acp_log (
    id INTEGER PRIMARY KEY, session_id TEXT, direction TEXT,
    ts INTEGER, payload TEXT
  );
  CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  CREATE INDEX idx_pending_session ON pending_requests(session_id);
  CREATE INDEX idx_acp_log_session ON acp_log(session_id, id);
  `,
  `
  CREATE TABLE exec_log (
    id          INTEGER PRIMARY KEY,
    session_id  TEXT NOT NULL,
    command     TEXT NOT NULL,
    output      TEXT NOT NULL,
    exit_code   INTEGER,
    truncated   INTEGER NOT NULL DEFAULT 0,
    timed_out   INTEGER NOT NULL DEFAULT 0,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER NOT NULL
  );
  CREATE INDEX idx_exec_log_session ON exec_log(session_id, id);
  `,
  `
  ALTER TABLE sessions DROP COLUMN repo_url;
  `,
  // Adds the threads table. The migration copies the acp_session_id of each
  // session into one thread row, points the session at that thread, and drops
  // the column.
  `
  CREATE TABLE threads (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL,
    acp_session_id TEXT,
    title          TEXT,
    ordinal        INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL
  );
  CREATE INDEX idx_threads_session ON threads(session_id, ordinal);
  ALTER TABLE sessions ADD COLUMN current_thread_id TEXT;

  INSERT INTO threads (id, session_id, acp_session_id, title, ordinal,
                       created_at, last_active_at)
    SELECT 't' || id, id, acp_session_id, NULL, 1, created_at, last_active_at
      FROM sessions WHERE acp_session_id IS NOT NULL;
  UPDATE sessions SET current_thread_id = 't' || id
    WHERE acp_session_id IS NOT NULL;

  ALTER TABLE sessions DROP COLUMN acp_session_id;
  `,
  // Adds the turn flag of each thread and the session id of each pending
  // request, and drops the turn flag of the session. The migration copies no
  // data, because no turn survives a restart, and the orchestrator clears
  // pending_requests at each boot.
  `
  ALTER TABLE threads ADD COLUMN turn_active INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pending_requests ADD COLUMN acp_session_id TEXT;
  ALTER TABLE sessions DROP COLUMN turn_active;
  `,
  // Adds the table of the browsers that subscribed to Web Push, with the
  // endpoint of the push service as key. The migration must stay at this index,
  // because a deployment that applied it is at user_version 6.
  `
  CREATE TABLE push_subscriptions (
    endpoint     TEXT PRIMARY KEY,
    p256dh       TEXT NOT NULL,
    auth         TEXT NOT NULL,
    label        TEXT,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  );
  `,
  // Adds the workspace directory of each session on the data volume.
  `
  ALTER TABLE sessions ADD COLUMN workspace_dir TEXT;
  `,
  // Adds the review state of each session. REVIEW.md in the workspace holds
  // the annotations.
  `
  ALTER TABLE sessions ADD COLUMN review_root TEXT;
  ALTER TABLE sessions ADD COLUMN review_base_rev TEXT;
  ALTER TABLE sessions ADD COLUMN review_base_commit TEXT;
  `,
  // Adds the agent sets with an AGENTS.md, skills and slash commands, and
  // inserts the `global` set. A deleted set clears the references of the boxes
  // that named it.
  `
  CREATE TABLE agent_sets (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    agents_md  TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE agent_items (
    set_id     TEXT NOT NULL REFERENCES agent_sets(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('skill', 'command')),
    name       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (set_id, kind, name)
  );
  INSERT INTO agent_sets (id, name, agents_md, created_at, updated_at)
    VALUES ('global', 'Global', '', 0, 0);
  ALTER TABLE sessions ADD COLUMN agent_set_id TEXT
    REFERENCES agent_sets(id) ON DELETE SET NULL;
  `,
  // Adds the source thread of a fork, whose transcript stands in until the
  // first prompt.
  `
  ALTER TABLE threads ADD COLUMN inherits_from TEXT;
  `,
  // Adds the intended mode and model of a thread, for an adapter respawn. NULL
  // means the default of the deployment, so the migration fills in no value.
  `
  ALTER TABLE threads ADD COLUMN mode_id TEXT;
  ALTER TABLE threads ADD COLUMN model_id TEXT;
  `,
  // Drops pending_requests.upstream_id, which nothing reads.
  `
  ALTER TABLE pending_requests DROP COLUMN upstream_id;
  `,
  // Drops the review root and the base commit. The review covers the whole
  // workspace, and each repository resolves the base itself. A REVIEW.md in a
  // subdirectory stays as an ordinary file.
  `
  ALTER TABLE sessions DROP COLUMN review_root;
  ALTER TABLE sessions DROP COLUMN review_base_commit;
  `,
  // Adds the home directory of each session on the data volume.
  `
  ALTER TABLE sessions ADD COLUMN home_dir TEXT;
  `,
  // Adds the thread of each local command. The migration deletes the stored
  // rows, because they name no thread.
  `
  DELETE FROM exec_log;
  ALTER TABLE exec_log ADD COLUMN thread_id TEXT;
  `,
  // Adds the done mark of a thread.
  `
  ALTER TABLE threads ADD COLUMN done INTEGER NOT NULL DEFAULT 0;
  `,
  // Adds the id of the transcript entry that a command was typed after, for replay.
  `
  ALTER TABLE exec_log ADD COLUMN after_id TEXT;
  `,
  // Adds a WebSocket token for each box. SQLite runs randomblob for each row,
  // so each stored box gets its own token.
  `
  ALTER TABLE sessions ADD COLUMN ws_token TEXT NOT NULL DEFAULT '';
  UPDATE sessions SET ws_token = lower(hex(randomblob(32)));
  `,
  // Drops acp_log, which has no reader or writer. The orchestrator logs ACP
  // messages to stderr.
  `
  DROP INDEX IF EXISTS idx_acp_log_session;
  DROP TABLE IF EXISTS acp_log;
  `,
  // Adds the VAPID key that a browser subscribed under, so the rows of another
  // key can be dropped. The stored rows get no key.
  `
  ALTER TABLE push_subscriptions ADD COLUMN vapid_key TEXT;
  `,
  // Drops exec_log, which has no reader or writer.
  `
  DROP INDEX IF EXISTS idx_exec_log_session;
  DROP TABLE IF EXISTS exec_log;
  `,
  // Adds the credentials and the settings of the settings page. The secret is
  // stored unencrypted, because the orchestrator must give it to the proxy at
  // each boot. The migration also adds the harness of each thread and the
  // harness catalogue.
  `
  CREATE TABLE credentials (
    id           TEXT PRIMARY KEY,
    method       TEXT NOT NULL,
    secret       TEXT NOT NULL,
    account      TEXT,
    expires_at   INTEGER,
    refreshed_at INTEGER,
    status       TEXT NOT NULL DEFAULT 'ok',
    last_error   TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- The agent of each thread, and its options beyond the mode. The stored
  -- threads get Claude. Both adapters call the model option "model".
  ALTER TABLE threads ADD COLUMN harness TEXT NOT NULL DEFAULT 'claude';
  ALTER TABLE threads ADD COLUMN config  TEXT NOT NULL DEFAULT '{}';
  UPDATE threads SET config = json_object('model', model_id) WHERE model_id IS NOT NULL;
  ALTER TABLE threads DROP COLUMN model_id;

  -- Drops the adapter argv of the session. The harness registry holds it.
  ALTER TABLE sessions DROP COLUMN agent_cmd;

  -- The catalogue that each adapter last advertised, for a dialog that has no
  -- thread to ask and must not start a box to find out.
  CREATE TABLE harness_catalog (
    harness        TEXT PRIMARY KEY,
    modes          TEXT NOT NULL,
    config_options TEXT NOT NULL,
    seen_at        INTEGER NOT NULL
  );
  `,
  // Renames sessions to boxes, so the name does not collide with ACP sessions.
  // `acp_session_id` keeps its name, because it holds the id of the adapter.
  `
  ALTER TABLE sessions RENAME TO boxes;
  ALTER TABLE threads RENAME COLUMN session_id TO box_id;
  ALTER TABLE pending_requests RENAME COLUMN session_id TO box_id;
  DROP INDEX IF EXISTS idx_pending_session;
  DROP INDEX IF EXISTS idx_threads_session;
  CREATE INDEX idx_pending_box ON pending_requests(box_id);
  CREATE INDEX idx_threads_box ON threads(box_id, ordinal);
  `,
  // Drops the current thread of a box. A caller that names no thread gets the
  // most recently active thread.
  `
  ALTER TABLE boxes DROP COLUMN current_thread_id;
  `,
  // Adds the dev tunnels that boxes hosted, so the orchestrator can delete the
  // tunnels that no box hosts. A row stays after its box on purpose.
  `
  CREATE TABLE tunnels (
    id             TEXT PRIMARY KEY,
    cluster        TEXT NOT NULL,
    box_id         TEXT NOT NULL,
    ports          TEXT NOT NULL,
    unserved_since INTEGER,
    created_at     INTEGER NOT NULL
  );
  `,
  // Drops the volume and directory columns. Each box keeps its workspace and
  // home in directories under DATA_DIR, named by its id.
  `
  ALTER TABLE boxes DROP COLUMN ws_volume;
  ALTER TABLE boxes DROP COLUMN home_volume;
  ALTER TABLE boxes DROP COLUMN workspace_dir;
  ALTER TABLE boxes DROP COLUMN home_dir;
  `,
  // Drops the kind of an agent item and deletes the stored slash commands, so
  // each item is a skill.
  `
  CREATE TABLE agent_items_new (
    set_id     TEXT NOT NULL REFERENCES agent_sets(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (set_id, name)
  );
  INSERT INTO agent_items_new (set_id, name, content, created_at, updated_at)
    SELECT set_id, name, content, created_at, updated_at
      FROM agent_items WHERE kind = 'skill';
  DROP TABLE agent_items;
  ALTER TABLE agent_items_new RENAME TO agent_items;
  `,
  // Adds the git repositories that an agent set takes skills from.
  `
  CREATE TABLE agent_repos (
    id         TEXT PRIMARY KEY,
    set_id     TEXT NOT NULL REFERENCES agent_sets(id) ON DELETE CASCADE,
    url        TEXT NOT NULL,
    ref        TEXT NOT NULL,
    commit_sha TEXT,
    skills     TEXT NOT NULL DEFAULT '[]',
    pulled_at  INTEGER,
    error      TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_agent_repos_set ON agent_repos(set_id, created_at);
  `,
  // Adds the table of the keys that the orchestrator makes for itself, one JSON
  // value for each key. Adds the placeholder of each credential, and gives each
  // stored credential a placeholder with the prefix of a real token of the service.
  `
  CREATE TABLE app_keys (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  ALTER TABLE credentials ADD COLUMN placeholder TEXT NOT NULL DEFAULT '';
  UPDATE credentials SET placeholder =
    CASE id
      WHEN 'claude'     THEN 'sk-ant-oat01-'
      WHEN 'openai'     THEN 'sk-'
      WHEN 'github'     THEN 'ghp_'
      WHEN 'gitlab'     THEN 'glpat-'
      WHEN 'devtunnels' THEN 'ghu_'
    END || hex(randomblob(18));
  `,
  // Adds the last measured disk usage of each box and its time. The file
  // service in the box measures it, so a stopped box keeps the value of its
  // last measurement.
  `
  ALTER TABLE boxes ADD COLUMN disk_bytes INTEGER;
  ALTER TABLE boxes ADD COLUMN disk_measured_at INTEGER;
  `,
  // Adds the time at which the setup finished after the last container start,
  // so a restart of the orchestrator does not run the setup again. The
  // migration marks each stored box as ready until its next start.
  `
  ALTER TABLE boxes ADD COLUMN ready_at INTEGER;
  UPDATE boxes SET ready_at = created_at;
  `,
  // Drops the image, container, network and subnet columns and the counters
  // table. The runtime finds the container, the network and the image of a box
  // by the box id, and picks the subnet of a new network from the free ones.
  `
  ALTER TABLE boxes DROP COLUMN image;
  ALTER TABLE boxes DROP COLUMN container_id;
  ALTER TABLE boxes DROP COLUMN network_name;
  ALTER TABLE boxes DROP COLUMN subnet;
  DROP TABLE counters;
  `,
  // Adds the API keys for services without a credential in Boxes. Each key
  // reaches every box as a placeholder in the variable with its name, and the
  // proxy replaces it on its hosts. The hosts are a JSON array.
  `
  CREATE TABLE api_keys (
    name        TEXT PRIMARY KEY,
    hosts       TEXT NOT NULL,
    secret      TEXT NOT NULL,
    placeholder TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  `,
  // Adds the owner of each box, credential, API key, agent set, setting and
  // push subscription. The stored rows get the empty user. The credentials, the
  // API keys and the settings get the owner in their key. The flag `global`
  // replaces the fixed id of the global set. The deployment id moves to
  // app_keys, because it belongs to the deployment.
  `
  ALTER TABLE boxes ADD COLUMN owner TEXT NOT NULL DEFAULT '';
  CREATE INDEX idx_boxes_owner ON boxes(owner);

  CREATE TABLE credentials_new (
    owner        TEXT NOT NULL DEFAULT '',
    id           TEXT NOT NULL,
    method       TEXT NOT NULL,
    secret       TEXT NOT NULL,
    account      TEXT,
    expires_at   INTEGER,
    refreshed_at INTEGER,
    status       TEXT NOT NULL DEFAULT 'ok',
    last_error   TEXT,
    placeholder  TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (owner, id)
  );
  INSERT INTO credentials_new (id, method, secret, account, expires_at, refreshed_at,
                               status, last_error, placeholder, created_at, updated_at)
    SELECT id, method, secret, account, expires_at, refreshed_at,
           status, last_error, placeholder, created_at, updated_at
      FROM credentials;
  DROP TABLE credentials;
  ALTER TABLE credentials_new RENAME TO credentials;

  CREATE TABLE api_keys_new (
    owner       TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL,
    hosts       TEXT NOT NULL,
    secret      TEXT NOT NULL,
    placeholder TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (owner, name)
  );
  INSERT INTO api_keys_new (name, hosts, secret, placeholder, created_at, updated_at)
    SELECT name, hosts, secret, placeholder, created_at, updated_at FROM api_keys;
  DROP TABLE api_keys;
  ALTER TABLE api_keys_new RENAME TO api_keys;

  INSERT INTO app_keys (key, value, created_at)
    SELECT 'deployment.id', json_quote(value), updated_at
      FROM settings WHERE key = 'deployment.id';
  CREATE TABLE settings_new (
    owner      TEXT NOT NULL DEFAULT '',
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, key)
  );
  INSERT INTO settings_new (key, value, updated_at)
    SELECT key, value, updated_at FROM settings WHERE key != 'deployment.id';
  DROP TABLE settings;
  ALTER TABLE settings_new RENAME TO settings;

  ALTER TABLE agent_sets ADD COLUMN owner TEXT NOT NULL DEFAULT '';
  ALTER TABLE agent_sets ADD COLUMN global INTEGER NOT NULL DEFAULT 0;
  UPDATE agent_sets SET global = 1 WHERE id = 'global';
  CREATE INDEX idx_agent_sets_owner ON agent_sets(owner);
  CREATE UNIQUE INDEX idx_agent_sets_global ON agent_sets(owner) WHERE global = 1;

  ALTER TABLE push_subscriptions ADD COLUMN owner TEXT NOT NULL DEFAULT '';
  `,
  // Adds the options of each model of a harness, so the dialog of a new thread
  // can show the options of the selected model.
  `
  ALTER TABLE harness_catalog ADD COLUMN model_options TEXT NOT NULL DEFAULT '{}';
  `,
  // Adds the remote MCP servers of the agent sets, and the merged servers of
  // each box at its last start.
  `
  CREATE TABLE agent_mcp_servers (
    set_id     TEXT NOT NULL REFERENCES agent_sets(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    url        TEXT NOT NULL,
    headers    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (set_id, name)
  );
  ALTER TABLE boxes ADD COLUMN mcp_servers TEXT NOT NULL DEFAULT '[]';
  `,
  // Adds the egress profiles of each user, the selected profile of each box,
  // and the token that identifies a box at the egress proxy.
  `
  CREATE TABLE egress_profiles (
    id         TEXT PRIMARY KEY,
    owner      TEXT NOT NULL,
    is_default INTEGER NOT NULL,
    name       TEXT NOT NULL,
    open       INTEGER NOT NULL,
    hosts      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_egress_profiles_owner ON egress_profiles(owner);
  CREATE UNIQUE INDEX idx_egress_profiles_default ON egress_profiles(owner) WHERE is_default = 1;
  ALTER TABLE boxes ADD COLUMN egress_profile_id TEXT
    REFERENCES egress_profiles(id) ON DELETE SET NULL;
  ALTER TABLE boxes ADD COLUMN proxy_token TEXT NOT NULL DEFAULT '';
  UPDATE boxes SET proxy_token = lower(hex(randomblob(32)));
  `,
  // Adds the auth mode of each MCP server and the secrets of the servers. The
  // migration deletes the stored servers, because their header values hold
  // references to API keys.
  `
  DELETE FROM agent_mcp_servers;
  UPDATE boxes SET mcp_servers = '[]';
  ALTER TABLE agent_mcp_servers ADD COLUMN auth TEXT NOT NULL DEFAULT 'none';
  CREATE TABLE agent_mcp_secrets (
    set_id       TEXT NOT NULL,
    server       TEXT NOT NULL,
    header       TEXT NOT NULL,
    secret       TEXT NOT NULL,
    placeholder  TEXT NOT NULL,
    oauth        TEXT,
    expires_at   INTEGER,
    refreshed_at INTEGER,
    status       TEXT NOT NULL DEFAULT 'ok',
    last_error   TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (set_id, server, header),
    FOREIGN KEY (set_id, server) REFERENCES agent_mcp_servers(set_id, name) ON DELETE CASCADE
  );
  `,
  // Adds the upstream CAs of each user, one for each host pattern.
  `
  CREATE TABLE upstream_cas (
    owner      TEXT NOT NULL,
    host       TEXT NOT NULL,
    cert       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, host)
  );
  `,
];

/** An open database handle. */
export type Db = Database.Database;

/**
 * Opens boxes.db under dataDir, and creates and migrates it as needed.
 *
 * @param dataDir The data directory.
 * @returns The open database.
 * @throws {Error} When a newer build migrated the database.
 */
export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'boxes.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/**
 * Runs each migration that the database has not applied yet, one transaction
 * for each.
 *
 * @param db The database.
 * @throws {Error} When a newer build migrated the database, because no migration goes back.
 */
function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `This database is at version ${current} and this build knows ` +
        `${MIGRATIONS.length}: it was written by a newer build of Boxes.`,
    );
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v];
    if (!sql) continue;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.pragma(`user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * Marks a box active now, which delays the idle reaper. A deleted box stays
 * unchanged, because an upstream can still report after the delete.
 *
 * @param db The database.
 * @param boxId The id of the box.
 */
export function touchBox(db: Db, boxId: string): void {
  db.prepare("UPDATE boxes SET last_active_at = ? WHERE id = ? AND status != 'deleted'").run(
    Date.now(),
    boxId,
  );
}

/**
 * Lists the threads of a box.
 *
 * @param db The database.
 * @param boxId The id of the box.
 * @returns The rows, oldest first.
 */
export function listThreads(db: Db, boxId: string): ThreadRow[] {
  return db
    .prepare('SELECT * FROM threads WHERE box_id = ? ORDER BY ordinal ASC')
    .all(boxId) as ThreadRow[];
}

/**
 * Gives one thread by id, in any box.
 *
 * @param db The database.
 * @param threadId The id of the thread.
 * @returns The row, or undefined when no thread has this id.
 */
export function getThread(db: Db, threadId: string): ThreadRow | undefined {
  return db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) as ThreadRow | undefined;
}

/**
 * Finds one thread by its session id in the adapter, in a box and a harness. A
 * message on the connection of an adapter can only be about a thread of that
 * adapter.
 *
 * @param db The database.
 * @param boxId The id of the box.
 * @param harness The harness of the adapter.
 * @param acpSessionId The session id in the adapter.
 * @returns The row, or undefined when no thread matches.
 */
export function threadByAcpId(
  db: Db,
  boxId: string,
  harness: HarnessId,
  acpSessionId: string,
): ThreadRow | undefined {
  return db
    .prepare('SELECT * FROM threads WHERE box_id = ? AND harness = ? AND acp_session_id = ?')
    .get(boxId, harness, acpSessionId) as ThreadRow | undefined;
}

/**
 * Gives the most recently active thread of a box. A tie goes to the newer thread.
 *
 * @param db The database.
 * @param boxId The id of the box.
 * @returns The row, or undefined when the box has no thread.
 */
export function latestThread(db: Db, boxId: string): ThreadRow | undefined {
  return db
    .prepare(
      `SELECT * FROM threads WHERE box_id = ?
        ORDER BY last_active_at DESC, ordinal DESC LIMIT 1`,
    )
    .get(boxId) as ThreadRow | undefined;
}

/** The data of a new thread. Each field except the harness has a default. */
export interface NewThread {
  /** The agent that runs the thread. */
  harness: HarnessId;
  /** The session id in the adapter, or null for a thread that gets its session later. */
  acpSessionId?: string | null;
  /** The intended mode, or null for the default of its harness. */
  modeId?: string | null;
  /** The options of the thread, by option id. */
  config?: Record<string, string>;
  /** The source thread of a fork, while the fork has no transcript of its own. */
  inheritsFrom?: string | null;
}

/**
 * Inserts a thread and returns its row.
 *
 * The ordinal is one more than the highest ordinal of the box, so a name like
 * "Thread 2" stays with that thread.
 *
 * @param db The database.
 * @param boxId The id of the box.
 * @param thread The data of the new thread.
 * @returns The new row.
 */
export function insertThread(db: Db, boxId: string, thread: NewThread): ThreadRow {
  const now = Date.now();
  const id = `t${randomBytes(6).toString('hex')}`;
  const next = db
    .prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM threads WHERE box_id = ?')
    .get(boxId) as { n: number };
  const row: ThreadRow = {
    id,
    box_id: boxId,
    harness: thread.harness,
    acp_session_id: thread.acpSessionId ?? null,
    title: null,
    ordinal: next.n,
    turn_active: 0,
    inherits_from: thread.inheritsFrom ?? null,
    mode_id: thread.modeId ?? null,
    config: JSON.stringify(thread.config ?? {}),
    done: 0,
    created_at: now,
    last_active_at: now,
  };
  db.prepare(
    `INSERT INTO threads (id, box_id, harness, acp_session_id, title, ordinal,
       turn_active, inherits_from, mode_id, config, done, created_at,
       last_active_at)
     VALUES (@id, @box_id, @harness, @acp_session_id, @title, @ordinal,
       @turn_active, @inherits_from, @mode_id, @config, @done, @created_at,
       @last_active_at)`,
  ).run(row);
  return row;
}

/**
 * Records the session id of a thread in the adapter, or clears it.
 *
 * @param db The database.
 * @param threadId The id of the thread.
 * @param acpSessionId The session id, or null to clear it.
 */
export function setThreadAcpId(db: Db, threadId: string, acpSessionId: string | null): void {
  db.prepare('UPDATE threads SET acp_session_id = ? WHERE id = ?').run(acpSessionId, threadId);
}

/**
 * Removes the link of a fork to its source, when its first prompt gives it a
 * transcript that also holds the history of the source.
 *
 * @param db The database.
 * @param threadId The id of the fork.
 */
export function clearThreadInheritance(db: Db, threadId: string): void {
  db.prepare('UPDATE threads SET inherits_from = NULL WHERE id = ?').run(threadId);
}

/**
 * Records the title of a thread, or clears it, and marks the thread active.
 *
 * @param db The database.
 * @param threadId The id of the thread.
 * @param title The title, or null to clear it.
 */
export function setThreadTitle(db: Db, threadId: string, title: string | null): void {
  db.prepare('UPDATE threads SET title = ?, last_active_at = ? WHERE id = ?').run(
    title,
    Date.now(),
    threadId,
  );
}

/**
 * Records the intended mode of a thread, or clears it back to the default of
 * the deployment.
 *
 * @param db The database.
 * @param threadId The id of the thread.
 * @param modeId The mode id, or null for the default.
 */
export function setThreadMode(db: Db, threadId: string, modeId: string | null): void {
  db.prepare('UPDATE threads SET mode_id = ? WHERE id = ?').run(modeId, threadId);
}

/**
 * Records the other options of a thread and replaces the whole map. The
 * adapter answers a change with its full list of options.
 *
 * @param db The database.
 * @param threadId The id of the thread.
 * @param config The options, by option id.
 */
export function setThreadConfig(db: Db, threadId: string, config: Record<string, string>): void {
  db.prepare('UPDATE threads SET config = ? WHERE id = ?').run(JSON.stringify(config), threadId);
}

/**
 * Parses the config column of a thread. Values that are not strings are
 * removed, and a value that is not a JSON object reads as an empty map.
 *
 * @param row The row of the thread.
 * @returns The options, by option id.
 */
export function threadConfig(row: ThreadRow): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(row.config);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      ([, value]) => typeof value === 'string',
    );
    return Object.fromEntries(entries) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Marks a thread done, or removes the mark. `last_active_at` stays the same,
 * so the mark does not make the thread the latest.
 *
 * @param db The database.
 * @param threadId The id of the thread.
 * @param done True to set the mark, false to remove it.
 */
export function setThreadDone(db: Db, threadId: string, done: boolean): void {
  db.prepare('UPDATE threads SET done = ? WHERE id = ?').run(done ? 1 : 0, threadId);
}

/**
 * Marks a thread active now.
 *
 * @param db The database.
 * @param threadId The id of the thread.
 */
export function touchThread(db: Db, threadId: string): void {
  db.prepare('UPDATE threads SET last_active_at = ? WHERE id = ?').run(Date.now(), threadId);
}

/**
 * Records if a prompt turn runs on the thread with the session id
 * `acpSessionId`, which is the id in the params of a prompt. Marks the thread
 * and its box active.
 *
 * @param db The database.
 * @param boxId The id of the box.
 * @param acpSessionId The session id of the thread in the adapter.
 * @param active True while the turn runs.
 */
export function setThreadTurnActive(
  db: Db,
  boxId: string,
  acpSessionId: string,
  active: boolean,
): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE threads SET turn_active = ?, last_active_at = ?
        WHERE box_id = ? AND acp_session_id = ?`,
    ).run(active ? 1 : 0, Date.now(), boxId, acpSessionId);
    touchBox(db, boxId);
  })();
}

/**
 * Clears the running-turn flag on every thread of a box, after a stop, an
 * adapter exit or boot reconciliation.
 *
 * @param db The database.
 * @param boxId The id of the box.
 */
export function clearBoxTurns(db: Db, boxId: string): void {
  db.prepare('UPDATE threads SET turn_active = 0 WHERE box_id = ?').run(boxId);
}

/**
 * Checks if a thread of a box has a running turn.
 *
 * @param db The database.
 * @param boxId The id of the box.
 * @returns True when a turn runs.
 */
export function boxTurnActive(db: Db, boxId: string): boolean {
  const row = db
    .prepare('SELECT 1 AS hit FROM threads WHERE box_id = ? AND turn_active = 1 LIMIT 1')
    .get(boxId) as { hit: number } | undefined;
  return row !== undefined;
}

/**
 * Finds the boxes with a running turn on one of their threads.
 *
 * @param db The database.
 * @returns The ids of the boxes.
 */
export function boxesWithActiveTurns(db: Db): Set<string> {
  const rows = db
    .prepare('SELECT DISTINCT box_id FROM threads WHERE turn_active = 1')
    .all() as Array<{ box_id: string }>;
  return new Set(rows.map((r) => r.box_id));
}

/**
 * Records the subscription of a browser and replaces the row with the same
 * endpoint. A browser subscribes again at each load with the same endpoint,
 * so the function keeps one row and updates the keys.
 *
 * @param db The database.
 * @param owner The user who subscribed.
 * @param endpoint The URL of the push service.
 * @param p256dh The public key of the subscriber.
 * @param auth The authentication secret of the subscriber.
 * @param label The name that the browser gave, or null.
 * @param vapidKey The current VAPID public key.
 */
export function upsertPushSubscription(
  db: Db,
  owner: string,
  endpoint: string,
  p256dh: string,
  auth: string,
  label: string | null,
  vapidKey: string,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO push_subscriptions
       (endpoint, p256dh, auth, label, created_at, last_used_at, vapid_key, owner)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label,
       vapid_key = excluded.vapid_key, owner = excluded.owner`,
  ).run(endpoint, p256dh, auth, label, now, now, vapidKey, owner);
}

/**
 * Deletes the subscriptions with another key or without a key. The browser
 * subscribes again at its next visit.
 *
 * @param db The database.
 * @param vapidKey The current VAPID public key.
 * @returns The number of deleted subscriptions.
 */
export function dropOtherKeySubscriptions(db: Db, vapidKey: string): number {
  return db.prepare('DELETE FROM push_subscriptions WHERE vapid_key IS NOT ?').run(vapidKey)
    .changes;
}

/**
 * Lists the push subscriptions of one user.
 *
 * @param db The database.
 * @param owner The user.
 * @returns The rows, oldest first.
 */
export function listPushSubscriptions(db: Db, owner: string): PushSubscriptionRow[] {
  return db
    .prepare('SELECT * FROM push_subscriptions WHERE owner = ? ORDER BY created_at ASC')
    .all(owner) as PushSubscriptionRow[];
}

/**
 * Deletes one subscription, for a subscription that the push service removed.
 *
 * @param db The database.
 * @param endpoint The URL of the push service.
 */
export function deletePushSubscription(db: Db, endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

/**
 * Deletes one subscription of a user, for an unsubscribe. A subscription of
 * another user stays.
 *
 * @param db The database.
 * @param owner The user.
 * @param endpoint The URL of the push service.
 */
export function deleteOwnPushSubscription(db: Db, owner: string, endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND owner = ?').run(
    endpoint,
    owner,
  );
}

/**
 * Records a successful push to a subscription now.
 *
 * @param db The database.
 * @param endpoint The URL of the push service.
 */
export function touchPushSubscription(db: Db, endpoint: string): void {
  db.prepare('UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?').run(
    Date.now(),
    endpoint,
  );
}

/**
 * Counts the boxes that are not deleted.
 *
 * @param db The database.
 * @returns The number of boxes.
 */
export function countLiveBoxes(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM boxes WHERE status != 'deleted'").get() as {
    n: number;
  };
  return row.n;
}

/**
 * Counts the subscribed browsers of one user.
 *
 * @param db The database.
 * @param owner The user.
 * @returns The number of subscriptions.
 */
export function countPushSubscriptions(db: Db, owner: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE owner = ?')
    .get(owner) as { n: number };
  return row.n;
}

/** The stored cached answer of one harness. */
export interface HarnessCatalogRow {
  /** The harness id. */
  harness: string;
  /** The `modes` of the last answer as JSON, or `null`. */
  modes: string;
  /** The `configOptions` of the last answer as JSON. */
  config_options: string;
  /** The options of each model as JSON, by model value. */
  model_options: string;
  /** Epoch milliseconds of the last answer. */
  seen_at: number;
}

/**
 * Records the modes and the options that an adapter sent, for its harness.
 *
 * The adapter connection calls it for each `session/new`, `session/load` and
 * `session/fork` answer with one of the lists. A list that the answer leaves
 * out keeps its last stored value.
 *
 * @param db The database.
 * @param harness The harness of the adapter.
 * @param modes The modes of the answer, or null or undefined when it has none.
 * @param configOptions The options of the answer, or null or undefined when it has none.
 */
export function upsertHarnessCatalog(
  db: Db,
  harness: HarnessId,
  modes: ThreadModeState | null | undefined,
  configOptions: ThreadConfigOption[] | null | undefined,
): void {
  const previous = readHarnessCatalog(db, harness);
  const next: Omit<HarnessCatalog, 'modelOptions'> = {
    modes: modes ?? previous?.modes ?? null,
    configOptions: configOptions ?? previous?.configOptions ?? [],
    seenAt: Date.now(),
  };
  db.prepare(
    `INSERT INTO harness_catalog (harness, modes, config_options, seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(harness) DO UPDATE SET modes = excluded.modes,
       config_options = excluded.config_options, seen_at = excluded.seen_at`,
  ).run(harness, JSON.stringify(next.modes), JSON.stringify(next.configOptions), next.seenAt);
}

/**
 * Records the options that an adapter offers for one model of its harness.
 *
 * The list replaces the stored list of the model. The function does nothing
 * for a harness that has no catalogue yet.
 *
 * @param db The database.
 * @param harness The harness of the adapter.
 * @param model The value of the model that was selected when the adapter sent the options.
 * @param options The options other than the model and the mode.
 */
export function recordModelOptions(
  db: Db,
  harness: HarnessId,
  model: string,
  options: ThreadConfigOption[],
): void {
  const previous = readHarnessCatalog(db, harness);
  if (!previous) return;
  const modelOptions = { ...previous.modelOptions, [model]: options };
  db.prepare('UPDATE harness_catalog SET model_options = ? WHERE harness = ?').run(
    JSON.stringify(modelOptions),
    harness,
  );
}

/**
 * Reads the last modes and options of the adapter of one harness.
 *
 * It is a cache, which the first answer of the adapter in a thread corrects. A
 * row that cannot be parsed counts as no row.
 *
 * @param db The database.
 * @param harness The harness.
 * @returns The catalogue, or null on a deployment that never ran the harness.
 */
export function readHarnessCatalog(db: Db, harness: HarnessId): HarnessCatalog | null {
  const row = db.prepare('SELECT * FROM harness_catalog WHERE harness = ?').get(harness) as
    | HarnessCatalogRow
    | undefined;
  if (!row) return null;
  try {
    return {
      modes: JSON.parse(row.modes) as ThreadModeState | null,
      configOptions: JSON.parse(row.config_options) as ThreadConfigOption[],
      modelOptions: JSON.parse(row.model_options) as Record<string, ThreadConfigOption[]>,
      seenAt: row.seen_at,
    };
  } catch {
    return null;
  }
}

/**
 * Reads the stored value under `key`.
 *
 * @param db The database.
 * @param key The name of the key.
 * @returns The value parsed from JSON, or undefined when there is none.
 */
export function readAppKey<T>(db: Db, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM app_keys WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

/**
 * Stores `value` under `key` as JSON, and replaces the old value.
 *
 * @param db The database.
 * @param key The name of the key.
 * @param value The value.
 */
export function writeAppKey(db: Db, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO app_keys (key, value, created_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value), Date.now());
}
