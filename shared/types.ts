/**
 * REST API shapes shared by the orchestrator handlers and the dashboard.
 */

/** Lifecycle status of a Boxes session, as stored in the sessions table. */
export type SessionStatus =
  | 'creating'
  | 'running'
  | 'stopped'
  | 'error'
  | 'deleted';

/** What Docker reports right now, independent of what the DB believes. */
export type DockerState = 'running' | 'exited' | 'missing' | 'unknown';

/**
 * One thing a conversation has left running in its box.
 *
 * Read from the processes alive in the container rather than reported by
 * anything: nothing tells Boxes when a build finishes, and the tally that
 * tried to keep score of it drifted permanently the first time a report went
 * missing. See `orchestrator/src/gateway/background.ts`.
 */
export interface BackgroundProcess {
  /**
   * Stable for as long as the process lives, and what a stop names.
   *
   * Not the pid: `docker top` reads the host's numbering and the box has its
   * own, so the pid Boxes sees is not one the box could be told to kill. This
   * is derived from the command line, which is the same string in both.
   */
  id: string;
  /** What the agent asked for — "npm run build" — as far as it can be read. */
  command: string;
  /**
   * When it started, in epoch milliseconds, or null where the host's `ps`
   * would not say. A build with twenty minutes behind it and one started ten
   * seconds ago are different news.
   */
  startedAt: number | null;
}

/** One conversation of a session, as the API reports it. */
export interface ThreadSummary {
  id: string;
  /**
   * The adapter's own id for the thread, or null while the adapter has
   * forgotten it. A thread minted and never prompted does not survive the
   * adapter restarting.
   */
  acpSessionId: string | null;
  /**
   * What the thread is called: the agent's own title, or the first line of a
   * prompt sent on it while it has none. Null until it has been prompted.
   */
  title: string | null;
  /** Per session and never reused; what an untitled thread is called. */
  ordinal: number;
  /**
   * True while a prompt this gateway forwarded is still open on this thread.
   *
   * Which is not the same as the agent working: a turn that spawned a
   * background subagent stays open long after the agent has said its piece
   * and gone quiet. `speaking` is the one to show a reader; this is here for
   * the reaper and for anybody debugging the pair.
   */
  turnActive: boolean;
  /**
   * Whether this conversation has work still running in its box, with no turn
   * to say so.
   *
   * Whose work it is comes off the process; see
   * `orchestrator/src/gateway/background.ts`. Which is what makes this worth
   * carrying on a thread at all: a list of a box's conversations can say which
   * one is holding it up, rather than only that something is.
   */
  backgroundBusy: boolean;
  /**
   * True while the agent is producing output on this thread — text, thinking,
   * a tool call of its own.
   *
   * The honest answer to "is it working", and the only one that survives
   * background work: a thread woken by a task reporting in is speaking with
   * no prompt open, and a thread holding a subagent's turn open is silent
   * with one. See `orchestrator/src/gateway/activity.ts`.
   */
  speaking: boolean;
  /** Permission requests from this thread waiting for a browser to answer. */
  pendingCount: number;
  createdAt: number;
  lastActiveAt: number;
}

/** A session as returned by the list endpoint. */
export interface SessionSummary {
  id: string;
  name: string;
  profile: string;
  status: SessionStatus;
  /** Live container state, resolved against Docker on every request. */
  dockerState: DockerState;
  /**
   * True while a prompt this gateway forwarded is open on any of the
   * session's threads. Derived from them rather than stored beside them, so
   * the two can never disagree.
   */
  turnActive: boolean;
  /** True while the agent is producing output on any of them. */
  speaking: boolean;
  /**
   * Whether the box still has work running in it — a command left running, a
   * monitor watching something — with no turn to say so.
   *
   * About the box rather than any one conversation, which is the question a
   * card in a list is answering and the one the idle reaper asks. What is
   * running, and whose it is, is per thread and goes to the thread that owns
   * it; see `TurnStateParams.background`.
   */
  backgroundBusy: boolean;
  /** Permission requests waiting for a browser to answer them, on any thread. */
  pendingCount: number;
  /**
   * Number of browsers currently attached to the session, across all of its
   * threads. Two tabs on two threads is two attachments.
   */
  attachedCount: number;
  /**
   * Bearer token an ACP client authenticates the WebSocket upgrade with,
   * carried in the subprotocol. One token covers the whole deployment, and
   * the list carries it so opening a thread needs no further request.
   */
  wsToken: string;
  /** Every conversation this session owns, oldest first. */
  threads: ThreadSummary[];
  /**
   * The thread a connection that names none gets — `/sessions/:id`, the short
   * WebSocket path, an external ACP client, a bookmark from before per-thread
   * routes existed. A default rather than the truth about what is loaded, and
   * null before the session has any thread at all.
   */
  currentThreadId: string | null;
  /**
   * True when the adapter advertised `sessionCapabilities.fork`. The capability
   * is unstable in the ACP schema, so the UI offers forking only when it is
   * there, and false is also what an adapter that has not yet been reached
   * reports.
   */
  canFork: boolean;
  /**
   * The agent set selected when this session was created, or null for the
   * global set alone. Null is also what a session whose set has since been
   * deleted reports.
   */
  agentSetId: string | null;
  /** That set's current name, for the UI. Null whenever `agentSetId` is. */
  agentSetName: string | null;
  /**
   * How much disk this session is taking up, in bytes, or null when there is
   * no answer yet.
   *
   * Its workspace and its home together — the agent's files, and the thread
   * history, tool caches and runtime installs that on a box which has been
   * working are usually the larger half. One number, because the question a
   * card is answering is how big this box has got.
   *
   * Rough on purpose, and a reading rather than a tally: the orchestrator
   * walks the directories in the background and answers list requests from
   * what it last measured. A running box is re-measured at most every quarter
   * of an hour, and a stopped one is measured once and then not again —
   * nothing is running in it, so nothing in it is changing. Null covers both
   * "not measured yet" — the first poll after the orchestrator started — and
   * a session with no directory to walk at all. Zero would be a claim; null
   * is the absence of one. See `orchestrator/src/diskusage.ts`.
   */
  diskBytes: number | null;
  createdAt: number;
  lastActiveAt: number;
}

/** A single session with the extra detail the detail view needs. */
export interface SessionDetail extends SessionSummary {
  image: string;
  containerId: string | null;
  networkName: string;
  subnet: string;
  /**
   * The named volume that used to hold the workspace, and still does for a
   * session created before workspaces became directories. Empty once the
   * session is directory-backed, which it becomes at its next start.
   */
  wsVolume: string;
  /**
   * Where the session's files are on the orchestrator's own filesystem, or
   * null while the session is still volume-backed — which is also what says
   * the review surface cannot read it yet.
   */
  workspaceDir: string | null;
  /**
   * The named volume that used to hold the home, and still does for a session
   * created before homes became directories. Empty once the session is
   * directory-backed, which every session created since is.
   */
  homeVolume: string;
  /**
   * Where the session's home is on the orchestrator's own filesystem — its
   * thread history, its tool caches, whatever a login inside the box wrote —
   * or null for one still backed by a named volume.
   */
  homeDir: string | null;
  /** The adapter's id for the session's default thread, or null before one exists. */
  acpSessionId: string | null;
  /** True when the egress proxy is attached to this session's network. */
  proxyAttached: boolean;
}

/** Body of a request to add a thread to a session. */
export interface CreateThreadBody {
  /**
   * Fork this thread, carrying its context into the new one. Absent means a
   * fresh, empty thread on the same workspace.
   */
  from?: string;
}

/** Body of a create-session request. */
export interface CreateSessionBody {
  name: string;
  profile?: string;
  /**
   * Id of the agent set whose AGENTS.md, skills and commands are merged over
   * the global ones for this session. Absent, empty or the global set's own id
   * all mean "the global set alone" — it is applied either way.
   */
  agentSet?: string | null;
}

/** One tapped ACP message from the debug log. */
export interface AcpLogEntry {
  id: number;
  direction: 'up' | 'down' | 'stderr';
  ts: number;
  payload: string;
}

/** A page of debug log entries. */
export interface AcpLogPage {
  entries: AcpLogEntry[];
  /** Pass as the after parameter to poll for newer entries. */
  cursor: number;
}

/** Answer to a health probe. */
export interface HealthResponse {
  ok: boolean;
  version: string;
  sessions: number;
  /** Session ids whose network is missing the egress proxy. */
  proxyWarnings: string[];
  /** Egress policy state, or null before the first push has been attempted. */
  egress: EgressHealth | null;
  /**
   * True when the deployment holds a Claude token. False means no session can
   * run a turn unless somebody logs in inside it.
   */
  claudeTokenConfigured: boolean;
  /** How many browsers are registered for Web Push. */
  pushSubscriptions: number;
}

/** The deployment's VAPID public key, which a browser subscribes with. */
export interface PushKeyResponse {
  /** Uncompressed P-256 point, base64url. Not a secret. */
  publicKey: string;
}

/**
 * Body of a push registration, shaped like the browser's own
 * PushSubscription.toJSON() so the page can pass it through unchanged.
 */
export interface PushSubscribeBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** What this browser calls itself, for the deployment's own reference. */
  label?: string;
}

/** Body of any 4xx or 5xx answer from the API. */
export interface ApiError {
  error: string;
}

/**
 * One file the user attached to a prompt, as the upload endpoint reports it
 * back.
 *
 * The path is workspace-relative and slash-separated, which is what a client
 * puts in the prompt and what the agent types into a tool call. The name may
 * differ from the one that was uploaded: it is sanitised, and a collision is
 * suffixed.
 */
export interface StoredAttachment {
  name: string;
  path: string;
  size: number;
}

/** Body of a request to run a local command in the session container. */
export interface ExecRequest {
  /** Run with `bash -lc`, inside the session's own isolation. */
  command: string;
}

/** One finished local command, as the exec log stores it. */
export interface ExecRecord {
  id: number;
  sessionId: string;
  command: string;
  /** Combined stdout and stderr, truncated at the output limit. */
  output: string;
  /** Null when the command was killed before reporting one. */
  exitCode: number | null;
  /** True when output hit the size limit and the rest was dropped. */
  truncated: boolean;
  /** True when the command hit the wall-clock limit and was killed. */
  timedOut: boolean;
  startedAt: number;
  finishedAt: number;
}

/** A page of exec records for one session, oldest first. */
export interface ExecLogPage {
  records: ExecRecord[];
}

// --- egress policy: the orchestrator -> proxy control channel ---------------

/**
 * One credential the proxy swaps in on the wire.
 *
 * A session holds `placeholder`; `secret` never leaves the orchestrator's and
 * the proxy's memory. A request to one of `hosts` carrying `placeholder` in
 * one of `headers` is rewritten to carry `secret`; one carrying anything else
 * there is refused by the proxy rather than forwarded.
 */
export interface EgressCredential {
  /** Stable identifier, used in logs and status. Never secret. */
  id: string;
  /**
   * Hostnames whose TLS is intercepted so this credential can be swapped in.
   * Same grammar as the allowlist: exact names and one-label wildcards.
   */
  hosts: string[];
  /** Header names that may carry it, lowercased. */
  headers: string[];
  /** What the session holds. Shaped like the real thing, worth nothing. */
  placeholder: string;
  /** The real credential. */
  secret: string;
}

/**
 * The proxy's entire configuration. It holds this in memory only, has none of
 * it at rest, and starts with none of it at all until the orchestrator pushes.
 */
export interface EgressPolicy {
  /**
   * Hostnames a session may reach. Empty means every public host, which is
   * the behavior of a deployment that sets no allowlist.
   */
  allowedHosts: string[];
  /** CA the proxy mints interception leaf certificates from, or null. */
  ca: { key: string; cert: string } | null;
  /** Credentials to translate. Empty means nothing is intercepted. */
  credentials: EgressCredential[];
}

/** What the proxy reports back on the control channel. Carries no secret. */
export interface EgressStatus {
  /** False until a policy has been pushed. */
  applied: boolean;
  /** Hash of the applied policy, so the orchestrator can see what is live. */
  policyHash: string;
  /** Number of entries in the applied allowlist; 0 means the allowlist is off. */
  allowedHostCount: number;
  /** Ids of the credentials being translated. */
  credentialIds: string[];
  /** Denials since the proxy booted, counted by reason. */
  denials: Record<string, number>;
  /** Seconds since the proxy booted. */
  uptimeSeconds: number;
}

/** The egress half of a health probe, as the orchestrator sees the proxy. */
export interface EgressHealth {
  /** True when the proxy reports the policy the orchestrator composed. */
  inSync: boolean;
  /** True when an allowlist is configured. */
  allowlistActive: boolean;
  /** Credentials being translated, by id. Never the values. */
  credentialIds: string[];
  /** Denials the proxy has counted since it booted, by reason. */
  denials: Record<string, number>;
  /** Why the last push or status read failed, or null. */
  error: string | null;
}

// --- code review over a session's workspace ---------------------------------

/** The git status of a file, as the review tree colours it. */
export type ReviewFileStatus =
  | 'modified'
  | 'staged'
  | 'untracked'
  | 'added'
  | 'deleted'
  | 'conflict';

/** What happened to a line of a file, relative to the base revision. */
export type ReviewLineChange = 'added' | 'modified';

/** One file or directory of the review tree. */
export interface ReviewTreeEntry {
  name: string;
  /** Path relative to the workspace, slash-separated. */
  path: string;
  isDir: boolean;
  /** Absent on files, which are the bulk of a tree. */
  children?: ReviewTreeEntry[];
  /**
   * True on the directory a repository is rooted at, so the boundaries are
   * visible while scrolling across them. Absent everywhere else.
   */
  repo?: boolean;
}

/**
 * One repository the workspace holds.
 *
 * A review is over the workspace, not over a repository in it, so these are an
 * attribute of the paths in the tree rather than a thing to pick between.
 */
export interface ReviewRepo {
  /**
   * Where it sits relative to the workspace, slash-separated. Empty when the
   * workspace is itself the repository.
   */
  path: string;
  /** What to call it: its own directory name. */
  name: string;
  /** The commit its HEAD names, or '' before its first commit. */
  head: string;
  /**
   * What the review's base revision resolved to here, or '' when there is no
   * base or the revision names nothing in this repository — in which case it
   * is compared against its own working tree.
   */
  baseCommit: string;
}

/**
 * The revision a review is compared against: one expression for the whole
 * workspace, resolved independently in each repository. `main` means
 * main-in-each, through the merge base with that repository's own HEAD.
 *
 * Empty means each repository's own working tree, which is the default. Where
 * it landed is on {@link ReviewRepo.baseCommit}, because it is a different
 * commit in every repository and in some of them none.
 */
export interface ReviewBase {
  /** What the user asked for: a branch, a tag, a short id. */
  rev: string;
}

/**
 * The whole left panel in one response: a phone on a slow link gets one round
 * trip per screen rather than one per piece of it.
 */
export interface ReviewTreeResponse {
  /** Every repository the workspace holds, sorted by path. */
  repos: ReviewRepo[];
  /** False when the workspace holds no repository at all. */
  hasGit: boolean;
  entries: ReviewTreeEntry[];
  /** True when the tree hit the entry cap and was cut short. */
  truncated: boolean;
  /** Git status per workspace-relative path. Empty without any repository. */
  statuses: Record<string, ReviewFileStatus>;
  /** How many comments each annotated file has. */
  counts: Record<string, number>;
  base: ReviewBase;
  /** True when the workspace holds a REVIEW.md. */
  hasReview: boolean;
  /** The date the review was started, or '' when there is no review yet. */
  started: string;
}

/** One comment on one line, as the API reports it. */
export interface ReviewAnnotation {
  line: number;
  comment: string;
  /** True when the code the comment was written against is gone. */
  outdated: boolean;
}

/** A diff hunk, with the range of lines it covers in the current file. */
export interface ReviewDiffHunk {
  startLine: number;
  endLine: number;
  /** The hunk's raw diff text, which is what the hunk sheet shows. */
  diff: string;
}

/**
 * A block of lines deleted between two lines of the current file. How many is
 * not recorded: the hunk it points at shows them.
 */
export interface ReviewDiffDeletion {
  /** The deletion sits after this line; 0 means the top of the file. */
  afterLine: number;
  /** Index into a response's `hunks`. */
  hunkIndex: number;
}

/** The diff markers a file view draws in its gutter. */
export interface ReviewFileDiff {
  /** Changed lines, keyed by line number as a string, since JSON has no int keys. */
  lines: Record<string, ReviewLineChange>;
  hunks: ReviewDiffHunk[];
  deletions: ReviewDiffDeletion[];
}

/** The whole file view in one response. */
export interface ReviewFileResponse {
  /** The file's path, relative to the workspace. */
  path: string;
  /**
   * The path of the repository this file belongs to, or null when no
   * repository claims it — in which case it has no status and no diff.
   */
  repo: string | null;
  /** Plain text. The browser tokenizes it; nothing here is render markup. */
  content: string;
  /** True when the file was longer than the cap and the rest was dropped. */
  truncated: boolean;
  /** True when the file holds a NUL byte, in which case content is empty. */
  binary: boolean;
  /**
   * True when the change under review deleted the file. The tree still lists
   * it, because a deletion is part of what is being reviewed, but there is
   * nothing on disk to show.
   */
  deleted: boolean;
  /** The file's real size in bytes, whatever was returned. */
  size: number;
  /** Lines in what was returned. */
  lines: number;
  /** Language guess for the highlighter, or '' when there is none. */
  language: string;
  /** This file's git status, or null when it has none. */
  status: ReviewFileStatus | null;
  diff: ReviewFileDiff;
  annotations: ReviewAnnotation[];
}

/** A file's comments, as the mutation endpoints answer with. */
export interface ReviewAnnotationsResponse {
  path: string;
  annotations: ReviewAnnotation[];
}

/** Body of a create-or-update annotation request. */
export interface ReviewAnnotationBody {
  path: string;
  line: number;
  comment: string;
}

/** Body of a set-base request. Null clears the base back to the working tree. */
export interface ReviewBaseBody {
  rev: string | null;
}

/**
 * What setting a base answers with: the expression, and where it landed in
 * each repository — a revision can resolve in one and name nothing in another,
 * and the picker says so.
 */
export interface ReviewBaseResponse {
  rev: string;
  repos: ReviewRepo[];
}

// --- agent configuration ----------------------------------------------------

/**
 * The id of the set that is applied to every session.
 *
 * A constant rather than a flag column: there is exactly one, it is seeded by
 * the migration that creates the table, and both ends need to name it.
 */
export const GLOBAL_AGENT_SET = 'global';

/** What an item of an agent set becomes inside the session container. */
export type AgentItemKind = 'skill' | 'command';

/** One skill or one slash command, as stored and as the API reports it. */
export interface AgentItem {
  kind: AgentItemKind;
  /**
   * The name the agent sees: a skill's directory (`skills/<name>/SKILL.md`) and
   * a command's file (`commands/<name>.md`), which is also what invokes it as
   * `/<name>`. Lowercase, digits and dashes, so it is a safe path component.
   */
  name: string;
  /** The file's whole content: a SKILL.md, or a command's markdown. */
  content: string;
  updatedAt: number;
}

/** An agent set as the list endpoint reports it, without the content. */
export interface AgentSetSummary {
  id: string;
  name: string;
  /** True for the one set every session gets. It cannot be deleted. */
  global: boolean;
  /** True when this set contributes an AGENTS.md of its own. */
  hasAgentsMd: boolean;
  skillCount: number;
  commandCount: number;
  /** How many live sessions were created with this set selected. */
  sessionCount: number;
  createdAt: number;
  updatedAt: number;
}

/** An agent set with everything in it, which is what the editor loads. */
export interface AgentSetDetail extends AgentSetSummary {
  /** This set's own AGENTS.md, or '' when it contributes none. */
  agentsMd: string;
  /** Its skills and commands, by kind and then by name. */
  items: AgentItem[];
}

/** Body of a create-set request. */
export interface CreateAgentSetBody {
  name: string;
}

/** Body of a set update. An absent field is left as it stands. */
export interface UpdateAgentSetBody {
  name?: string;
  agentsMd?: string;
}

/** Body of an item write. Creates the item, or replaces it under its name. */
export interface AgentItemBody {
  kind: AgentItemKind;
  name: string;
  content: string;
}

/**
 * What one session's merged configuration comes to: the global set, with the
 * selected set laid over it.
 *
 * Returned by the preview endpoint so the editor can show what a session would
 * actually get, which is the one thing a two-set merge makes non-obvious.
 */
export interface AgentBundlePreview {
  /** The global AGENTS.md and the set's, joined by a blank line. */
  agentsMd: string;
  items: AgentItem[];
  /**
   * Names the selected set took over from the global one, by kind. The editor
   * marks these, since an override is silent otherwise.
   */
  overrides: Array<{ kind: AgentItemKind; name: string }>;
}

// --- the gateway's one ACP extension ----------------------------------------

/**
 * Notification the gateway sends a browser to say whether a prompt turn is
 * running on the thread it is watching.
 *
 * ACP has nothing for this. A client learns a turn is running because it sent
 * the prompt itself and is awaiting the response — which is exactly what a
 * browser that navigated away and came back did not do. The orchestrator is
 * the client of record, so it is the only thing that knows, and this is how
 * it says so: once to each browser after its replay, and again on every
 * transition.
 *
 * The underscore is ACP's extension prefix, and a notification cannot be
 * replied to — so a client that has never heard of this ignores it, which is
 * what keeps the endpoint usable by ACP clients that are not this dashboard.
 */
export const TURN_STATE_METHOD = '_boxes/turn_state';

/**
 * Params of a `_boxes/turn_state` notification: everything the gateway knows
 * about what a thread is doing that a browser cannot work out for itself.
 *
 * Three facts rather than one, because one bit cannot answer the three
 * questions a reader asks — is the agent talking, may I type, will anything
 * happen if I say nothing. Background work is what pulled them apart, and it
 * is the third field. What the UI makes of the three is
 * `dashboard/src/lib/activity.ts`.
 */
export interface TurnStateParams {
  /** The adapter's own id for the thread, as every ACP message names it. */
  sessionId: string;
  /**
   * True while a prompt the gateway forwarded is still open on that thread.
   *
   * Not what a reader is shown: the adapter holds a prompt open until the
   * background subagents its turn spawned settle, so this stays true through
   * however long the agent then spends waiting for somebody to type.
   */
  active: boolean;
  /** True while the agent is producing output on that thread, now. */
  speaking: boolean;
  /**
   * What this conversation has left running in the box, and nothing another
   * conversation left there.
   *
   * It was a boolean about the whole box once, sent to every thread, which
   * made a shell one conversation forgot about into "something is still
   * running" on a thread opened a minute ago — with a stop button beside it
   * that could not reach the work.
   */
  background: BackgroundProcess[];
}
