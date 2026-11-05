/**
 * Types and constants shared by the orchestrator, the dashboard and the proxy.
 */

/** Lifecycle status of a box, as stored in the boxes table. */
export type BoxStatus = 'creating' | 'running' | 'stopped' | 'error' | 'deleted';

/**
 * The state of a box as the runtime reports it right now, independent of the
 * stored status. `unknown` means that the runtime gave no usable answer.
 */
export type RuntimeState = 'running' | 'stopped' | 'unknown';

/** An agent harness that the orchestrator can run in a box. */
export type HarnessId = 'claude' | 'codex' | 'opencode';

/** A credential the deployment holds, named by the service it authenticates to. */
export type CredentialId = 'claude' | 'openai' | 'github' | 'gitlab' | 'devtunnels';

/**
 * The way a credential was obtained. The method sets the content of the secret. A `token` is a token, such as one
 * from `claude setup-token` or a pasted access token. An `api_key` is an API key. An `oauth` secret is a JSON
 * document with the tokens of a login, such as the document that the Codex CLI wrote.
 */
export type CredentialMethod = 'token' | 'api_key' | 'oauth';

/** The known health of a stored credential. */
export type CredentialStatus = 'ok' | 'expired' | 'failing';

/** One stored credential as the API reports it, without the secret. */
export interface CredentialSummary {
  /** The id of the credential. */
  id: CredentialId;
  /** The way the credential was obtained. */
  method: CredentialMethod;
  /**
   * The name that a person knows the credential by. It is the account name that a login reports, or else the last
   * four characters of the secret. Null for a secret of four characters or fewer.
   */
  account: string | null;
  /** The known health of the credential. */
  status: CredentialStatus;
  /** The reason for the last failure, or null. */
  lastError: string | null;
  /** The expiry time of the secret, in epoch milliseconds, or null for a static secret. */
  expiresAt: number | null;
  /** The time of the last refresh or login, in epoch milliseconds, or null when neither set it. */
  refreshedAt: number | null;
  /** The time the credential was last stored, in epoch milliseconds. */
  updatedAt: number;
}

/** One API key a user added, as the API reports it, without the secret. */
export interface ApiKeySummary {
  /** The environment variable that holds the key's placeholder in each box. */
  name: string;
  /** The hosts for which the egress proxy swaps in the key. */
  hosts: string[];
  /** The last four characters of the key, or null for a key too short to show any. */
  account: string | null;
  /** The time the key was last stored, in epoch milliseconds. */
  updatedAt: number;
}

/** The credential state of one harness. */
export interface HarnessHealth {
  /** The id of the harness. */
  id: HarnessId;
  /** The name that the dashboard shows. */
  label: string;
  /**
   * The stored credential of the harness, or null when there is none. Always null for a harness that runs on the API
   * keys of the user.
   */
  credential: CredentialSummary | null;
  /**
   * True when the stored credential of the harness has the status `ok` and the proxy can put it into a request. For a
   * harness that runs on the API keys of the user, always true.
   */
  runnable: boolean;
}

/**
 * The modes that an adapter advertises for a thread, and the current mode. The
 * shape is the one of ACP, as in the answers to `session/new`, `session/load`
 * and `session/fork`.
 */
export interface ThreadModeState {
  /** The mode the thread is in. */
  currentModeId: string;
  /** Every mode that the adapter offers, each with its id, an optional name and an optional description. */
  availableModes: Array<{ id: string; name?: string; description?: string | null }>;
}

/** One thread setting that a client can change, and its current value. */
export interface ThreadConfigOption {
  /** The id of the option in the adapter. */
  id: string;
  /** The name of the option. */
  name?: string;
  /** The description of the option from the adapter, if it gives one. */
  description?: string | null;
  /**
   * The kind of the option. A `select` has a list of options, and other kinds
   * have none. Absent means a select.
   */
  type?: string;
  /**
   * The purpose of the option. The gateway uses it to find the model selector.
   * The gateway also uses it to keep the mode option out of the config map of a
   * thread, because only `session/set_mode` sets the mode.
   */
  category?: string | null;
  /** The value the option has now. */
  currentValue?: string;
  /** The values that a select offers, each with the value, an optional name and an optional description. */
  options?: Array<{ value: string; name?: string; description?: string | null }>;
}

/**
 * The modes and config options that the adapter of one harness last advertised, cached per harness.
 *
 * A dialog shows these values before the thread exists, so it cannot ask the adapter. Each answer to
 * `session/new`, `session/fork` or `session/load` that holds a list updates that list.
 */
export interface HarnessCatalog {
  /** The modes of the last answer that held modes, or null when no answer held them. */
  modes: ThreadModeState | null;
  /** The config options of the last answer that held them, or empty when no answer held them. */
  configOptions: ThreadConfigOption[];
  /**
   * The options other than the model and the mode, by model value. Each list is the last one that the adapter sent
   * while that model was selected.
   */
  modelOptions: Record<string, ThreadConfigOption[]>;
  /** The arrival time of the last answer, in epoch milliseconds. */
  seenAt: number;
}

/** One harness with the data that the form of a new box and the dialog of a new thread need. */
export interface HarnessInfo extends HarnessHealth {
  /** The mode of a new thread of this harness. */
  defaultModeId: string;
  /** The mode of a fork of a thread of this harness. */
  forkModeId: string;
  /** The config option values of a new thread, by option id. */
  defaultConfig: Record<string, string>;
  /** The values that the adapter last advertised, or null when the deployment has never run the adapter. */
  catalog: HarnessCatalog | null;
}

/**
 * The last choices for one harness in the form of a new box or in the dialog of a new thread. The next form or
 * dialog starts with the same choices on any device. The dashboard reads and writes them, and the orchestrator
 * stores them.
 */
export interface ThreadDialogDefaults {
  /** The mode chosen last. */
  modeId?: string;
  /** The config option values chosen last, by option id. */
  config?: Record<string, string>;
}

/**
 * The settings of the deployment that are not secrets.
 */
export interface Settings {
  /** The git author name for commits in every box. */
  gitName: string;
  /** The git author email address for commits in every box. */
  gitEmail: string;
  /** The last choices for a new box or a new thread, by harness id. */
  dialogs: Record<string, ThreadDialogDefaults>;
}

/** Body of a request to store a credential by pasting its secret. */
export interface PutCredentialBody {
  /** The kind of the secret. */
  method: CredentialMethod;
  /** The pasted secret. */
  secret: string;
}

/**
 * The state of a login, which the settings page polls.
 *
 * For a harness login, the orchestrator runs the CLI of the harness in a temporary
 * container. Codex prints a URL and a one-time code, and then waits. Claude
 * prints a URL, and then waits for the code that the login page gives the user.
 * For Dev Tunnels, the orchestrator runs the GitHub device flow itself.
 */
export type LoginState =
  /** The login has no URL yet. */
  | { state: 'starting' }
  /** The login waits for a browser. `code` is the one-time code of Codex or GitHub, if there is one. */
  | { state: 'awaiting_browser'; url: string; code: string | null }
  /**
   * The CLI waits for the code that the page sends back. `error` is the message
   * of the CLI about the last code that it refused, or null before a refusal.
   */
  | { state: 'awaiting_code'; url: string; error: string | null }
  /** The credential is stored. */
  | { state: 'done' }
  /** The login failed. `error` gives the reason as a sentence for the user. */
  | { state: 'failed'; error: string };

/** The answer to a request that starts a login. */
export interface StartLoginResponse {
  /** The id of the login. Each later call for the login uses it. */
  loginId: string;
}

/** Body of the request that sends back the code from the login page. */
export interface LoginCodeBody {
  /** The code, as pasted. */
  code: string;
}

/**
 * One task that a conversation left running in its box, as the adapter
 * announced it.
 *
 * The adapter sends a spawn when the task starts and a state update when it
 * ends. A task without an end update is dropped when its adapter process
 * exits.
 */
export interface BackgroundProcess {
  /** The asyncTaskId of the adapter. A stop request uses it. */
  id: string;
  /** The name of the task from the adapter: the command for a shell, or else a description. */
  command: string;
  /**
   * The kind from the adapter. Claude sends `shell`, `workflow`, `monitor`, `task` or another type name of the
   * harness. Codex sends `shell`.
   */
  kind: string;
  /** `canStop` from the spawn. */
  stoppable: boolean;
  /** The arrival time of the spawn, in epoch milliseconds. */
  startedAt: number;
}

/**
 * One process that a read of the process table of a box found.
 *
 * It has no task and no conversation. It shows why a box is busy when it has no tasks.
 */
export interface BoxWork {
  /**
   * The pid at the time of the read. It tells two equal command lines apart.
   * A stop looks up the pid again in the box and does not signal this pid.
   */
  pid: number;
  /** The full command line, which identifies the process. */
  command: string;
  /** The run time of the process, in whole seconds. */
  elapsedSeconds: number;
}

/** One conversation of a box, as the API reports it. */
export interface ThreadSummary {
  /** The thread's id. */
  id: string;
  /**
   * The harness of the thread. Each thread has its own harness, so two agents
   * can work on one checkout.
   */
  harness: HarnessId;
  /**
   * The stored mode of the thread, or null for the default of its harness. The
   * current mode of the adapter comes over ACP. A respawn sets the adapter back
   * to this mode.
   */
  modeId: string | null;
  /**
   * The other config option values of the thread, such as the model or the
   * effort level, by the option id of the adapter. The mode option is not in
   * this map.
   */
  config: Record<string, string>;
  /**
   * True when the adapter of the thread advertised `sessionCapabilities.fork` in
   * its `initialize` answer. False before the first connection to the adapter.
   */
  canFork: boolean;
  /**
   * The id of the thread in the adapter, or null before the adapter creates the thread. The orchestrator also sets
   * it to null when a load finds that the adapter no longer holds the thread. A thread that never got a prompt has
   * no transcript, so a stop of the container removes it.
   */
  acpSessionId: string | null;
  /**
   * The title of the thread: the title from the agent, or else the first line
   * of a prompt on the thread. Null before the first prompt, and after the agent clears its title.
   */
  title: string | null;
  /** The number of the thread in its box, never used again. It names a thread without a title. */
  ordinal: number;
  /**
   * True while a prompt that the gateway forwarded is open on this thread.
   *
   * A turn that started a background subagent can stay open after the agent
   * stops its output. Use `speaking` to see if the agent works.
   */
  turnActive: boolean;
  /**
   * True while this conversation has work running in its box outside of a
   * turn.
   */
  backgroundBusy: boolean;
  /**
   * True while the agent produces output on this thread, such as text,
   * thoughts or its own tool calls.
   *
   * The value is independent of `turnActive`. A task report can wake a thread,
   * which then speaks with no open prompt. A thread that holds the turn of a
   * subagent open is silent with an open prompt.
   */
  speaking: boolean;
  /** Permission requests from this thread waiting for a browser to answer. */
  pendingCount: number;
  /**
   * True when the user marked this conversation as finished. The mark changes
   * the list only, and a thread marked done still accepts prompts.
   */
  done: boolean;
  /** The creation time of the thread, in epoch milliseconds. */
  createdAt: number;
  /** The time of the last activity on the thread, in epoch milliseconds. */
  lastActiveAt: number;
}

/** One port of a dev tunnel in a box. */
export interface BoxTunnel {
  /** The tunnel id. */
  id: string;
  /** The region of the tunnel, such as `euw`. */
  cluster: string;
  /** The port in the box the tunnel forwards to. */
  port: number;
  /** The public URL of the port. */
  url: string;
}

/** A box as returned by the list endpoint. */
export interface BoxSummary {
  /** The id of the box. */
  id: string;
  /** The name the user gave the box. */
  name: string;
  /** The profile stored with the box. */
  profile: string;
  /** Lifecycle status, as stored. */
  status: BoxStatus;
  /** The live state of the box, read from the runtime on every request. */
  runtimeState: RuntimeState;
  /**
   * True while a prompt that the gateway forwarded is open on a thread of the
   * box. The value comes from the threads of the box.
   */
  turnActive: boolean;
  /** True while the agent produces output on a thread of the box. */
  speaking: boolean;
  /**
   * True while the box has work running outside of a turn, such as a command
   * or a monitor. {@link TurnStateParams.background} tells what runs and which
   * thread owns it.
   */
  backgroundBusy: boolean;
  /**
   * The number of background work items in the box: the tasks that its
   * adapters announced, or else the processes that the read of the box found.
   * Zero while {@link BoxSummary.backgroundBusy} is false.
   */
  backgroundCount: number;
  /** Permission requests on all threads that wait for an answer from a browser. */
  pendingCount: number;
  /**
   * The number of browsers attached to the box, over all of its threads. Two
   * tabs on two threads count as two.
   */
  attachedCount: number;
  /**
   * The bearer token that a client sends in the subprotocol list to authenticate the WebSocket upgrade of the ACP
   * endpoint or the terminal endpoint. The token opens this box only.
   */
  wsToken: string;
  /** All threads of the box, oldest first. */
  threads: ThreadSummary[];
  /**
   * The agent set that the user selected when the box was created, or null
   * for the global set only. The value is also null when the set was deleted
   * later.
   */
  agentSetId: string | null;
  /** The current name of the agent set, for the UI. Null when `agentSetId` is null. */
  agentSetName: string | null;
  /**
   * The disk space of the box in bytes: its workspace, its home and its Nix
   * store together. Null before the first measurement.
   *
   * The value comes from the last measurement. The orchestrator measures a box before each stop. It also measures
   * a running box when it reads the summary and the last measurement is older than fifteen minutes.
   */
  diskBytes: number | null;
  /** The time of the measurement of `diskBytes`, in epoch milliseconds. Null when `diskBytes` is null. */
  diskMeasuredAt: number | null;
  /**
   * The dev tunnel ports in the box, from the last read of the orchestrator. The orchestrator reads them every
   * minute while a Dev Tunnels credential is stored. Empty when there are none.
   */
  tunnels: BoxTunnel[];
  /** The creation time of the box, in epoch milliseconds. */
  createdAt: number;
  /** The time of the last activity in the box, in epoch milliseconds. */
  lastActiveAt: number;
}

/** A single box with the extra detail the detail view needs. */
export interface BoxDetail extends BoxSummary {
  /**
   * Facts that the runtime knows about the box, as label and value, such as
   * the container and the network. A fact that the runtime cannot read is
   * not in the list.
   */
  runtimeDetails: Array<[string, string]>;
  /** The adapter id of the most recently active thread of the box, or null before a thread exists. */
  acpSessionId: string | null;
  /**
   * True when the runtime finds the network isolation of the box complete. With complete isolation, the container
   * of the box can connect only to the egress proxy. False also when the runtime cannot read the isolation.
   */
  isolated: boolean;
  /**
   * The processes that the last read found in the box. A stop of the whole box reads the process table again and
   * signals the processes that it finds then. Empty when the box is not running or was not read yet. Only the
   * detail has this field.
   */
  boxWork: BoxWork[];
  /** The id of the egress profile that the box uses. It is the default profile when the user selected none. */
  egressProfileId: string;
  /** The current name of the egress profile, for the UI. */
  egressProfileName: string;
}

/**
 * The harness and the settings of a new thread. An absent field means the
 * default of the harness.
 */
export interface ThreadOptions {
  /** The harness of the thread. */
  harness: HarnessId;
  /** The mode of the thread. Absent means the default from the registry. */
  modeId?: string;
  /** The config option values, by option id. Absent means the `defaultConfig` of the harness. */
  config?: Record<string, string>;
}

/** Body of a request to add a thread to a box. */
export interface CreateThreadBody {
  /**
   * The id of the thread to fork. The new thread gets its context. Absent
   * means a new, empty thread on the same workspace.
   */
  from?: string;
  /**
   * The options of the new thread. Ignored when `from` is set, because only
   * the adapter that wrote a transcript can load it. So a fork keeps the
   * harness of its source. Absent means Claude with its defaults.
   */
  options?: ThreadOptions;
}

/** Body of a request to mark a thread done, or to take the mark off again. */
export interface ThreadDoneBody {
  /** True to mark the thread done, false to take the mark off. */
  done: boolean;
}

/** Body of a create-box request. */
export interface CreateBoxBody {
  /** The name the user gives the box. */
  name: string;
  /**
   * Ignored. Every box gets the profile `DEFAULT`, because all boxes use the credentials of the deployment.
   */
  profile?: string;
  /**
   * The id of the agent set whose AGENTS.md and skills are merged over the
   * global ones for this box. Absent, empty or the id of the global set means
   * the global set only.
   */
  agentSet?: string | null;
  /** The id of the egress profile of the box. Absent or null means the default profile of the user. */
  egressProfile?: string | null;
  /**
   * The options of the first thread of the box. The orchestrator creates each box with one thread. Absent means
   * Claude with its defaults.
   */
  thread?: ThreadOptions;
}

/**
 * The build of one image that the deployment runs.
 *
 * On Docker, the digest is the manifest digest of the registry, if there is one. An image built on this host was
 * never in a registry, so it gets its config digest. On Kubernetes, the digest is the image id that the kubelet
 * reports, and the other fields are null.
 */
export interface ImageInfo {
  /** The `sha256:...` digest of the image. */
  digest: string;
  /** The build time of the image, in epoch milliseconds, or null when the runtime does not report it. */
  builtAt: number | null;
  /**
   * The disk space of the image on this host, in bytes, or null when the
   * runtime does not report it.
   *
   * Docker gives the uncompressed size of all layers, not the download
   * size. A layer that another image shares is also counted here.
   */
  sizeBytes: number | null;
}

/** The images of a deployment. Each is null when the runtime cannot read the image. */
export interface DeploymentImages {
  /** The image of the orchestrator. */
  orchestrator: ImageInfo | null;
  /** The image of the egress proxy. */
  proxy: ImageInfo | null;
  /** The image of the boxes. */
  box: ImageInfo | null;
}

/** Answer to a health probe. */
export interface HealthResponse {
  /** Always true, because an answer means that the orchestrator is up. */
  ok: boolean;
  /** The version of the orchestrator. */
  version: string;
  /**
   * The username of the request, or null in single user mode and for a request
   * without a username.
   */
  user: string | null;
  /** The number of boxes that are not deleted. */
  boxes: number;
  /** Box ids whose network isolation the repair loop could not complete. */
  isolationWarnings: string[];
  /** The egress policy state, or null before the first push attempt. */
  egress: EgressHealth | null;
  /**
   * The harnesses whose credential is in the credential set of the configuration, each with its credential state.
   */
  harnesses: HarnessHealth[];
  /** All stored credentials, GitHub included, without their secrets. */
  credentials: CredentialSummary[];
  /** The number of browsers that are registered for Web Push. */
  pushSubscriptions: number;
  /** The build of each image of the deployment. */
  images: DeploymentImages;
}

/** The progress of an image pull. */
export interface PullProgress {
  /** The image reference that is pulled. */
  image: string;
  /** The layers of the image. */
  layers: {
    /** The number of downloaded layers. */
    downloaded: number;
    /** The number of layers that are unpacked on the host. */
    done: number;
    /** The number of layers that the daemon has named so far. */
    total: number;
  };
  /**
   * The download progress of the layers in bytes. The daemon gives the size of
   * a layer when its download starts, so the total can increase.
   */
  bytes: {
    /** The downloaded bytes. */
    current: number;
    /** The bytes to download, as far as they are known. */
    total: number;
  };
  /**
   * The progress of the layer that the daemon unpacks now, or null when it
   * unpacks no layer. The daemon unpacks one layer at a time, in order.
   */
  unpacking: {
    /** The current value, in the unit. */
    current: number;
    /** The value at the end, or 0 when the daemon does not give it. */
    total: number;
    /** The unit of the values. Some daemons give only the seconds since the start. */
    unit: 'bytes' | 'seconds';
  } | null;
}

/** The answer of the orchestrator during its start and after it. */
export interface BootResponse {
  /** True once the orchestrator serves the dashboard and the API. */
  ready: boolean;
  /** The last pull of the box image during the start, or null when there was none. */
  pull: PullProgress | null;
}

/**
 * The answer of the readiness probe.
 *
 * The status code gives the same answer, so a probe can read the code only.
 * The body shows a person the reason.
 */
export interface ReadyResponse {
  /** True when all checks passed. */
  ready: boolean;
  /** The version of the orchestrator. */
  version: string;
  /** The checks that must pass before the orchestrator can serve a box. */
  checks: {
    /** True when the database answered a query. */
    database: boolean;
    /** True when the proxy holds the egress policy that this orchestrator composed. */
    egress: boolean;
    /** True when the runtime answered. */
    runtime: boolean;
  };
}

/** The VAPID public key of the deployment, which a browser uses to subscribe. */
export interface PushKeyResponse {
  /** An uncompressed P-256 point, as base64url. It is not a secret. */
  publicKey: string;
}

/**
 * Body of a push registration. It has the shape of PushSubscription.toJSON()
 * in the browser, so the page can send it unchanged.
 */
export interface PushSubscribeBody {
  /** The push service URL that the browser got. */
  endpoint: string;
  /** The keys that encrypt messages to the browser: the public key `p256dh` and the secret `auth`. */
  keys: { p256dh: string; auth: string };
  /** A name for the browser, for reference in the deployment. */
  label?: string;
}

/** Body of any 4xx or 5xx answer from the API. */
export interface ApiError {
  /** The description of the error. */
  error: string;
}

/** One file the user attached to a prompt, as the upload endpoint reports it back. */
export interface StoredAttachment {
  /** The stored file name. It is sanitised, and a name collision gets a suffix. */
  name: string;
  /**
   * The path relative to the workspace, with slashes. A client puts it in the
   * prompt, and the agent uses it in a tool call.
   */
  path: string;
  /** Size in bytes. */
  size: number;
}

/**
 * One credential the proxy swaps in on the wire.
 *
 * A box holds `placeholder`. Only the orchestrator and the proxy hold
 * `secret`. The proxy rewrites a request to one of `hosts` that carries
 * `placeholder` in one of `headers` to carry `secret`. It sends all other
 * values unchanged.
 */
export interface EgressCredential {
  /** A stable id for logs and status. It is not secret. */
  id: string;
  /**
   * The hostnames for which the proxy intercepts TLS to swap in this
   * credential. The grammar is the same as for the hosts of a box.
   */
  hosts: string[];
  /**
   * The lowercase names of the headers that can carry the credential. Empty
   * means that any header can carry it.
   */
  headers: string[];
  /** The value in the box. It has the format of the real credential but gives no access. */
  placeholder: string;
  /** The real credential. */
  secret: string;
  /**
   * True for the token of an OAuth login. The proxy reports a refused token of such a credential to the
   * orchestrator.
   */
  oauth?: boolean;
}

/**
 * The full configuration of the proxy. The proxy keeps it in memory only, and
 * has no configuration until the orchestrator pushes it.
 */
export interface EgressPolicy {
  /** The policy of each live box. */
  boxes: EgressBoxPolicy[];
  /** The `key` and the `cert` of the CA from which the proxy makes leaf certificates for interception, or null. */
  ca: { key: string; cert: string } | null;
  /** The credentials that the proxy swaps in. Empty means that the proxy intercepts nothing. */
  credentials: EgressCredential[];
}

/**
 * The hosts that one box can reach. The proxy identifies the box from the user
 * and the password in its proxy URL.
 */
export interface EgressBoxPolicy {
  /** The id of the box. It is the user in the proxy URL. */
  box: string;
  /** The token of the box. It is the password in the proxy URL. */
  token: string;
  /** True when the box can reach every public host on the ports 80 and 443. */
  open: boolean;
  /**
   * The host patterns that the box can reach in both modes. A pattern is an
   * exact name or a wildcard for one label, with an optional port.
   */
  hosts: string[];
}

/** The status that the proxy reports on the control channel. It holds no secret. */
export interface EgressStatus {
  /** False before the first policy push. */
  applied: boolean;
  /** The fingerprint of the applied policy. */
  policyHash: string;
  /** The number of boxes in the applied policy. */
  boxCount: number;
  /** The ids of the credentials that the proxy swaps in. */
  credentialIds: string[];
  /** Denials since the proxy booted, counted by category. */
  denials: Record<string, number>;
  /** Seconds since the proxy booted. */
  uptimeSeconds: number;
}

/**
 * A server answer that refused an OAuth token, which the proxy put into a request. The answer is a 401, or a 403 with
 * a Bearer challenge.
 */
export interface EgressRefusedToken {
  /** The id of the credential. */
  credentialId: string;
  /** The HTTP status of the answer. */
  status: number;
  /** The `error` parameter of the Bearer challenge, or null. */
  error: string | null;
  /** The `scope` parameter of the Bearer challenge, or null. */
  scope: string | null;
}

/**
 * The answer of the proxy to a policy push. The proxy reports each refused token once, so the list holds the refusals
 * since the last push, at most one for each credential.
 */
export interface EgressPushAnswer extends EgressStatus {
  /** The refused OAuth tokens since the last push. */
  refusedTokens: EgressRefusedToken[];
}

/** The egress half of a health probe, as the orchestrator sees the proxy. */
export interface EgressHealth {
  /** True when the proxy applied the last push of the composed policy. */
  inSync: boolean;
  /** The ids of the credentials that the proxy swaps in, without the values. */
  credentialIds: string[];
  /** Denials the proxy has counted since it booted, by category. */
  denials: Record<string, number>;
  /** The reason for the failure of the last push, or null. */
  error: string | null;
}

/**
 * One target that the egress proxy refused for a box, because the egress
 * profile of the box does not allow it.
 */
export interface EgressDenial {
  /** The hostname or the IP literal of the target. */
  host: string;
  /** The port of the target. */
  port: number;
  /**
   * The denial category. It is allowlist for a host that the profile does not allow on port 80 or 443,
   * port for another port that no pattern of the profile names, and private-address for a host with a private
   * address that no pattern of the profile names.
   */
  category: string;
  /** The number of refused attempts of the target while it is in the list of the box. */
  count: number;
  /** The time of the last refused attempt, in epoch milliseconds. */
  lastAt: number;
}

/** An egress profile as the list endpoint reports it, without the hosts. */
export interface EgressProfileSummary {
  /** The id of the profile. */
  id: string;
  /** The name the user gave the profile. */
  name: string;
  /** True for the one profile that a box without a selected profile uses. It cannot be deleted. */
  isDefault: boolean;
  /** True for the open mode, where a box can reach every public host on the ports 80 and 443. */
  open: boolean;
  /** The number of live boxes that use the profile. */
  boxCount: number;
  /** The creation time of the profile, in epoch milliseconds. */
  createdAt: number;
  /** The time of the last change to the profile, in epoch milliseconds. */
  updatedAt: number;
}

/** An egress profile with its hosts, as the editor loads it. */
export interface EgressProfileDetail extends EgressProfileSummary {
  /** The host patterns that a box with this profile can always reach. */
  hosts: string[];
}

/** Body of a create-profile request. */
export interface CreateEgressProfileBody {
  /** The name of the new profile. */
  name: string;
  /** The mode of the new profile. Absent means the closed mode. */
  open?: boolean;
  /** The host patterns of the new profile. Absent means none. */
  hosts?: string[];
}

/** Body of a profile update. An absent field stays unchanged. */
export interface UpdateEgressProfileBody {
  /** The new name of the profile. */
  name?: string;
  /** The new mode of the profile. */
  open?: boolean;
  /** The new host patterns of the profile. */
  hosts?: string[];
}

/** Body of a request that selects the egress profile of a box. */
export interface BoxEgressProfileBody {
  /** The id of the profile, or null for the default profile of the user. */
  egressProfile: string | null;
}

/** The git status of a file, as the review tree colours it. */
export type ReviewFileStatus =
  | 'modified'
  | 'staged'
  | 'untracked'
  | 'added'
  | 'deleted'
  | 'conflict';

/** The change to a line of a file, relative to the base revision. */
export type ReviewLineChange = 'added' | 'modified';

/**
 * One repository in the workspace. A review covers the whole workspace,
 * which can hold more than one repository.
 */
export interface ReviewRepo {
  /**
   * The path of the repository relative to the workspace, with slashes. Empty
   * when the workspace is the repository.
   */
  path: string;
  /** The directory name of the repository. */
  name: string;
  /** The commit of HEAD, or '' before the first commit. */
  head: string;
  /**
   * The commit of the base revision of the review in this repository, or ''
   * when there is no base or the revision names nothing in this repository.
   * With '', the review compares the working tree against HEAD.
   */
  baseCommit: string;
}

/**
 * The revision that a review compares against. It is one expression for the whole workspace. The orchestrator
 * resolves it in each repository to the merge base of the revision and HEAD, or to the revision itself when the
 * two have no common ancestor.
 *
 * An empty revision compares each repository against its own HEAD, which is
 * the default. {@link ReviewRepo.baseCommit} holds the resolved commit.
 */
export interface ReviewBase {
  /** The revision that the user entered, such as a branch, a tag or a short commit id. */
  rev: string;
}

/**
 * One entry of a review directory: a file or a folder.
 *
 * A folder shows the state of its whole subtree, so a closed folder still
 * shows that it holds something to look at. The optional fields are absent
 * instead of empty, because a phone can get a directory of a thousand files.
 */
export interface ReviewDirEntry {
  /** The name of the entry in its directory. */
  name: string;
  /** The path relative to the workspace, with slashes. */
  path: string;
  /** True for a folder. */
  isDir: boolean;
  /** A file's git status. Absent when it has none, and on a folder. */
  status?: ReviewFileStatus;
  /** The number of comments on a file. Absent when it has none, and on a folder. */
  comments?: number;
  /** True on a folder whose subtree holds a changed file. Absent elsewhere. */
  changed?: boolean;
  /** True on a folder whose subtree holds a commented file. Absent elsewhere. */
  commented?: boolean;
  /** True on the folder a repository is rooted at. Absent elsewhere. */
  repo?: boolean;
}

/**
 * The facts of a review that do not depend on one file.
 *
 * Each directory answer includes them, so the first screen needs one request
 * and the header does not wait for a second request.
 */
export interface ReviewFacts {
  /** All repositories in the workspace, sorted by path. */
  repos: ReviewRepo[];
  /** False when the workspace holds no repository at all. */
  hasGit: boolean;
  /** The revision the review compares against. */
  base: ReviewBase;
  /** True when the workspace holds a REVIEW.md. */
  hasReview: boolean;
  /** The date the review was started, or '' when there is no REVIEW.md or it records no date. */
  started: string;
  /** The number of comments in the whole review, over all files. */
  commentCount: number;
}

/** One directory of the review, and the facts the whole view needs. */
export interface ReviewDirResponse extends ReviewFacts {
  /** The directory listed, relative to the workspace. Empty for the root. */
  path: string;
  /** The children: folders first, then files, each in name order. */
  entries: ReviewDirEntry[];
  /** True when the directory has more entries than the cap, and the list does not include the rest. */
  truncated: boolean;
}

/** One comment on one line, as the API reports it. */
export interface ReviewAnnotation {
  /** The line the comment is on, counted from 1. */
  line: number;
  /** The text of the comment. */
  comment: string;
  /** True when the code that the comment was written for is gone. */
  outdated: boolean;
}

/** A diff hunk, with the range of lines it covers in the current file. */
export interface ReviewDiffHunk {
  /** First line of the current file the hunk covers. */
  startLine: number;
  /** Last line of the current file the hunk covers. */
  endLine: number;
  /** The raw diff text of the hunk, which the hunk sheet shows. */
  diff: string;
}

/**
 * A block of deleted lines between two lines of the current file. The hunk
 * that it points to shows the deleted lines.
 */
export interface ReviewDiffDeletion {
  /** The deletion is after this line. 0 means the top of the file. */
  afterLine: number;
  /** The index into the `hunks` of the response. */
  hunkIndex: number;
}

/** The diff markers a file view draws in its gutter. */
export interface ReviewFileDiff {
  /** The changed lines, keyed by line number as a string, because JSON keys are strings. */
  lines: Record<string, ReviewLineChange>;
  /** The diff hunks of the file. */
  hunks: ReviewDiffHunk[];
  /** The places of the deleted lines. */
  deletions: ReviewDiffDeletion[];
}

/** The whole file view in one response. */
export interface ReviewFileResponse {
  /** The path of the file, relative to the workspace. */
  path: string;
  /**
   * The path of the repository of this file, or null when the file is in no
   * repository. A file without a repository has no status and no diff.
   */
  repo: string | null;
  /** The content as plain text. The browser tokenizes it. */
  content: string;
  /**
   * A hash of the file at the time of the read. A save sends it back, so that
   * a write over an edit of the agent fails. Empty when the file does not
   * exist.
   */
  hash: string;
  /** True when the file is longer than the cap, and the content does not include the rest. */
  truncated: boolean;
  /** True when the file holds a NUL byte. The content is then empty. */
  binary: boolean;
  /**
   * True when the change under review deleted the file. The tree still lists
   * it, but the file is not on disk.
   */
  deleted: boolean;
  /** The real size of the file in bytes, independent of the returned content. */
  size: number;
  /** The number of lines in the returned content. */
  lines: number;
  /** The guessed language for the highlighter, or '' when there is none. */
  language: string;
  /** The git status of the file, or null when it has none. */
  status: ReviewFileStatus | null;
  /** The diff markers for the gutter. */
  diff: ReviewFileDiff;
  /** The comments on the file. */
  annotations: ReviewAnnotation[];
}

/** The comments on a file, as the mutation endpoints return them. */
export interface ReviewAnnotationsResponse {
  /** The path of the file, relative to the workspace. */
  path: string;
  /** All comments on the file after the change. */
  annotations: ReviewAnnotation[];
}

/** Body of a create-or-update annotation request. */
export interface ReviewAnnotationBody {
  /** The path of the file, relative to the workspace. */
  path: string;
  /** The line to comment on. */
  line: number;
  /** The text of the comment. */
  comment: string;
}

/** Body of a save-file request. */
export interface ReviewFileBody {
  /** The path of the file, relative to the workspace. */
  path: string;
  /** The new content of the file. */
  content: string;
  /**
   * The hash that the browser last read. The save fails when the file on disk
   * does not match it.
   */
  hash: string;
}

/** Body of a set-base request. */
export interface ReviewBaseBody {
  /** The revision to compare against. Null clears the base, so that the review compares against HEAD. */
  rev: string | null;
}

/**
 * The answer to a set-base request. A revision can resolve in one repository
 * and name nothing in another.
 */
export interface ReviewBaseResponse {
  /** The expression as stored, or '' when the base was cleared. */
  rev: string;
  /** Every repository, with the commit the base resolved to in it. */
  repos: ReviewRepo[];
}

/**
 * The name for the global agent set in a request that creates a box. Such a
 * request is the same as a request without an agent set.
 */
export const GLOBAL_AGENT_SET = 'global';

/** One skill of an agent set, as stored and as the API reports it. */
export interface AgentItem {
  /**
   * The directory name of the skill, as in `skills/<name>/SKILL.md`. The
   * skill is invoked as `/<name>`. The name holds only lowercase letters,
   * digits and dashes, so it is safe as a path component.
   */
  name: string;
  /** The full SKILL.md. */
  content: string;
  /** The time the skill was last written, in epoch milliseconds. */
  updatedAt: number;
}

/** An agent set as the list endpoint reports it, without the content. */
export interface AgentSetSummary {
  /** The id of the set. */
  id: string;
  /** The name the user gave the set. */
  name: string;
  /** True for the one set that every box of its owner gets. It cannot be deleted. */
  global: boolean;
  /** True when this set contributes an AGENTS.md of its own. */
  hasAgentsMd: boolean;
  /** The number of skills in the set, without the skills of its repositories. */
  skillCount: number;
  /** The number of repositories that the set takes skills from. */
  repoCount: number;
  /** The number of live boxes that were created with this set. */
  boxCount: number;
  /** The creation time of the set, in epoch milliseconds. */
  createdAt: number;
  /** The time of the last change to the set or one of its items, in epoch milliseconds. */
  updatedAt: number;
}

/** An agent set with all of its content, as the editor loads it. */
export interface AgentSetDetail extends AgentSetSummary {
  /** The AGENTS.md of the set, or '' when it has none. */
  agentsMd: string;
  /** The skills of the set, by name. */
  items: AgentItem[];
  /** The repositories that the set takes more skills from, in the order they were added. */
  repos: AgentRepo[];
  /** The remote MCP servers of the set, by name. */
  mcpServers: AgentMcpServerState[];
}

/**
 * The way the agent authenticates at a remote MCP server. The mode is fixed after the user creates the server.
 *
 * With `none`, the server has no headers. With `bearer`, it has one secret `Authorization` header. With `headers`, each
 * header is literal or secret. With `oauth`, it has no headers, and the orchestrator adds the `Authorization` header
 * with the token of the OAuth login.
 */
export type AgentMcpAuth = 'none' | 'bearer' | 'headers' | 'oauth';

/** One header that the agent sends to a remote MCP server. */
export interface AgentMcpHeader {
  /** The header name. */
  name: string;
  /**
   * The value. The API returns an empty value for a secret header. In a save, an empty value of a secret header keeps
   * the stored value.
   */
  value: string;
  /** True when the orchestrator stores the value as a secret, and the box gets only a placeholder. */
  secret: boolean;
}

/**
 * A remote MCP server of an agent set. The agent reaches it with the Streamable
 * HTTP transport.
 */
export interface AgentMcpServer {
  /** The name of the server. It holds lowercase letters, digits and dashes, and at most 32 characters. */
  name: string;
  /** The http or https URL of the server. It is fixed after the user creates the server. */
  url: string;
  /** The way the agent authenticates at the server. */
  auth: AgentMcpAuth;
  /** The headers that the agent sends to the server. */
  headers: AgentMcpHeader[];
}

/**
 * The status of the OAuth token of a remote MCP server. With `disconnected`, the server has no token.
 */
export type AgentMcpTokenStatus = 'ok' | 'failing' | 'disconnected';

/** A remote MCP server of an agent set, as the editor shows it. */
export interface AgentMcpServerState extends AgentMcpServer {
  /** The status of the OAuth token, or null for a server without OAuth. */
  status: AgentMcpTokenStatus | null;
  /** The reason of the last failure of the OAuth token, or null. */
  lastError: string | null;
}

/** Body of a request that starts the OAuth login of a remote MCP server. */
export interface McpConnectBody {
  /** The origin of the dashboard, for the redirect URI of the login. */
  origin: string;
  /** The client ID that the user registered at the authorization server, or undefined to use a stored or new client. */
  clientId?: string;
  /** The client secret of the client ID, or undefined for a client without a secret. */
  clientSecret?: string;
}

/**
 * Answer to the start of an OAuth login. It holds the URL that the browser opens, or the request for a client ID,
 * together with the redirect URI that the client needs.
 */
export type McpConnectAnswer =
  | { authorizationUrl: string }
  | { needsClient: true; redirectUri: string };

/** Body of the request that ends an OAuth login, with the parameters of the redirect to the dashboard. */
export interface McpCallbackBody {
  /** The `state` parameter. */
  state: string;
  /** The `code` parameter, or undefined when the authorization server sent an error. */
  code?: string;
  /** The `iss` parameter, or undefined when the authorization server sent none. */
  iss?: string;
  /** The `error` parameter, or undefined. */
  error?: string;
  /** The `error_description` parameter, or undefined. */
  errorDescription?: string;
}

/** Answer to the end of an OAuth login. */
export interface McpCallbackAnswer {
  /** The id of the agent set of the server, so the dashboard can open the set. */
  setId: string;
}

/** A git repository an agent set takes skills from. */
export interface AgentRepo {
  /** The id of the repository in the deployment. */
  id: string;
  /** The HTTPS URL of the repository. */
  url: string;
  /** The branch, tag or commit to fetch, or '' for the default branch. */
  ref: string;
  /** The commit the skills come from, or null before the first good pull. */
  commit: string | null;
  /** Names of the skills found in that commit. */
  skills: string[];
  /** The time of the last pull, with or without success, in epoch milliseconds, or null before the first pull. */
  pulledAt: number | null;
  /** The reason for the failure of the last pull, or null when the last pull worked. */
  error: string | null;
}

/** Body of a create-set request. */
export interface CreateAgentSetBody {
  /** The name of the new set. */
  name: string;
}

/** Body of a set update. An absent field stays unchanged. */
export interface UpdateAgentSetBody {
  /** The new name of the set. */
  name?: string;
  /** The new AGENTS.md of the set. */
  agentsMd?: string;
}

/** Body of a repository add. */
export interface AgentRepoBody {
  /** The HTTPS URL to fetch. */
  url: string;
  /** The branch, tag or full commit hash to fetch. Absent or '' means the default branch. */
  ref?: string;
}

/** Body of a skill write. The write creates the skill, or replaces the skill with the same name. */
export interface AgentItemBody {
  /** The name of the skill. */
  name: string;
  /** The full SKILL.md of the skill. */
  content: string;
}

/**
 * The merged agent configuration of one box: the global set, with the
 * selected set merged over it.
 */
export interface AgentBundlePreview {
  /** The global AGENTS.md and the AGENTS.md of the set, each trimmed, joined by a blank line. */
  agentsMd: string;
  /** All skills of the box after the overrides, by name. */
  skills: AgentBundleSkill[];
  /**
   * The names of the skills of the selected set, its repositories included, that replace skills of the global
   * set.
   */
  overrides: string[];
  /** All remote MCP servers of the box after the overrides, by name. */
  mcpServers: { name: string; url: string }[];
  /** The names of the MCP servers of the selected set that replace servers of the global set. */
  mcpOverrides: string[];
}

/** One skill of a merged configuration. */
export interface AgentBundleSkill {
  /** The name of the skill. */
  name: string;
  /** The URL of the repository of the skill, or null for a skill of a set. */
  repo: string | null;
}

/**
 * The method of the notification that tells a browser the state of the thread that it watches.
 *
 * In ACP, a client knows that a turn runs while its own prompt is open. A
 * browser that reconnects did not send the prompt. The gateway sends the
 * notification after the replay and again at each change. The underscore is
 * the ACP prefix for extensions, so a client that does not know the method
 * ignores it.
 */
export const TURN_STATE_METHOD = '_boxes/turn_state';

/**
 * Params of a `_boxes/turn_state` notification: the state of a thread that a
 * browser cannot find out itself.
 */
export interface TurnStateParams {
  /** The id of the thread in the adapter, as all ACP messages name it. */
  sessionId: string;
  /**
   * True while a prompt that the gateway forwarded is open on the thread.
   *
   * An adapter can keep a prompt open until the background subagents of the
   * turn finish, so the value can stay true after the agent stops its output.
   */
  active: boolean;
  /** True while the agent produces output on the thread. */
  speaking: boolean;
  /** The work that this conversation left running in the box. */
  background: BackgroundProcess[];
}

/**
 * The method of the notification that the gateway sends a browser when it
 * opens a thread. The notification tells if the updates that follow start at
 * the resume point of the browser.
 *
 * It arrives before the first update. A browser that gets the whole thread drops the messages that it holds. A
 * browser that gets the tail keeps the messages before the resume point. The underscore is the ACP prefix for
 * extensions, so a client that does not know the method ignores it.
 */
export const REPLAY_METHOD = '_boxes/replay';

/** Params of a `_boxes/replay` notification. */
export interface ReplayParams {
  /** The id in the adapter of the thread that the gateway opens. */
  sessionId: string;
  /**
   * True when the updates that follow start at the resume point of the
   * browser. False when they are the whole thread. The gateway sends the whole
   * thread when the browser gave no resume point, or when the gateway does not
   * hold the message of the resume point.
   */
  resumed: boolean;
  /**
   * True when the gateway does not hold the start of the thread, so the
   * updates do not include the oldest messages. A browser can ask for the full
   * history with {@link LoadMeta.full}.
   */
  truncated: boolean;
}

/**
 * The `_meta` key that holds the `session/load` options of a browser. The gateway reads the options when it
 * answers the load itself.
 */
export const BOXES_META = 'boxes';

/** The `session/load` options of a browser, under `_meta.boxes`. */
export interface LoadMeta {
  /**
   * The adapter id of the last message that the browser holds. The gateway
   * sends the thread from that message on. When absent, the gateway sends the
   * whole thread.
   */
  resumeFrom?: string;
  /**
   * True to ask for the full history of the thread, which the adapter replays again. The gateway refuses the
   * request while a prompt is open, the agent produces output or a background task runs. It also refuses it for a
   * fork that has no prompt of its own yet.
   */
  full?: boolean;
}
