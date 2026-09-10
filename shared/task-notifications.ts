/**
 * The block the harness wakes an agent with when a background task reports in.
 *
 * A task started in the background — a command left running, a subagent, a
 * monitor watching something — does not answer into the turn that started it.
 * It reports later, and the harness wakes the agent with a message in the
 * user's role carrying a block of XML:
 *
 *     <task-notification>
 *     <task-id>bnztwmmw5</task-id>
 *     <summary>Monitor event: "crawl progress"</summary>
 *     <event>2200/30321 ok=2193 bad=7 — rate limited, pausing 61s</event>
 *     </task-notification>
 *
 * The block is addressed to the model rather than typed by the user. It
 * travels as text, which is the one thing an adapter's transcript carries
 * unchanged, so a replay reads back what was sent and one parser serves both
 * the live stream and the reconnect.
 *
 * A block this build cannot read is left as the text it is. A notification
 * the harness wrapped in a `<system-reminder>`, which is how the CLI's own
 * transcript carries them, is still read, and the wrapper's own lines stay as
 * text around it. Over ACP they arrive bare.
 */

/** Delimiters of one notification block. */
const OPEN = '<task-notification>';
const CLOSE = '</task-notification>';

/** What a finished task cost, when the harness says. */
export interface TaskUsage {
  /** Tokens the task spent; the harness reports these for a subagent. */
  tokens?: number;
  /** Tool calls the task made. */
  toolUses?: number;
  /** How long the task ran, in milliseconds. */
  durationMs?: number;
}

/** One background task reporting in. */
export interface TaskNotification {
  /** The harness's id for the task, which outlives any one notification. */
  taskId: string;
  /**
   * The tool call that started the task, when the harness names it, which it
   * does for a background command and not for a subagent or a monitor. The
   * same id ACP calls `toolCallId`.
   */
  toolUseId?: string;
  /**
   * `completed`, `failed`, `killed` or `blocked` — and absent on a task that
   * is still going, which is what a monitor's event is.
   */
  status?: string;
  /** One line saying what happened. Always present. */
  summary: string;
  /** What the task said: a subagent's answer, or a monitor's event. */
  body?: string;
  /** What the task cost, when the harness reports it. */
  usage?: TaskUsage;
}

/** A run of message text, as notifications and the prose around them. */
export type NotificationSegment =
  | { type: 'text'; text: string }
  | { type: 'notification'; notification: TaskNotification };

/** The contents of one `<tag>`, trimmed, or undefined when there is none. */
function field(body: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

/** One `<tag>` holding a number, or undefined when it holds anything else. */
function count(body: string, name: string): number | undefined {
  const value = field(body, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The `<usage>` block, or undefined when it is absent or says nothing. */
function usageOf(body: string): TaskUsage | undefined {
  const block = field(body, 'usage');
  if (!block) return undefined;
  const tokens = count(block, 'subagent_tokens');
  const toolUses = count(block, 'tool_uses');
  const durationMs = count(block, 'duration_ms');
  const usage: TaskUsage = {
    ...(tokens === undefined ? {} : { tokens }),
    ...(toolUses === undefined ? {} : { toolUses }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * One block's contents as a notification, or null when this build cannot
 * read it.
 *
 * A block missing either the id or the summary is not one of these.
 */
function notificationOf(body: string): TaskNotification | null {
  const taskId = field(body, 'task-id');
  const summary = field(body, 'summary');
  if (!taskId || !summary) return null;

  // A subagent answers with `result`, a monitor with an `event`.
  const said = [field(body, 'result'), field(body, 'event')].filter(Boolean).join('\n\n');
  const toolUseId = field(body, 'tool-use-id');
  const status = field(body, 'status');
  const usage = usageOf(body);

  return {
    taskId,
    ...(toolUseId ? { toolUseId } : {}),
    ...(status ? { status } : {}),
    summary,
    ...(said ? { body: said } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * A block of message text as the notifications in it and the prose around
 * them, or null when it holds none.
 *
 * Null rather than one text segment, so a caller can tell that there is
 * nothing to do here.
 */
export function parseTaskNotifications(text: string): NotificationSegment[] | null {
  if (!text.includes(OPEN)) return null;

  const segments: NotificationSegment[] = [];
  let read = 0;

  for (;;) {
    const open = text.indexOf(OPEN, read);
    if (open === -1) break;
    const close = text.indexOf(CLOSE, open);
    // An unclosed opening tag is prose about the format rather than a block,
    // and is left as text. The harness sends a notification as one content
    // block, so a block cannot be cut in half here.
    if (close === -1) break;

    const notification = notificationOf(text.slice(open + OPEN.length, close));
    if (!notification) return null;

    const before = text.slice(read, open).trim();
    if (before) segments.push({ type: 'text', text: before });
    segments.push({ type: 'notification', notification });
    read = close + CLOSE.length;
  }

  if (segments.length === 0) return null;

  const after = text.slice(read).trim();
  if (after) segments.push({ type: 'text', text: after });
  return segments;
}


/**
 * Statuses that say the task will not report again.
 *
 * An absent status is a task still going, which is what a monitor's event
 * is. An unknown one is read the same way: a status this build has not heard
 * of is no proof that anything ended.
 */
const TERMINAL = new Set(['completed', 'failed', 'killed']);

/** Whether a notification's status means the task is over. */
export function isTerminalStatus(status: string | undefined): boolean {
  return status !== undefined && TERMINAL.has(status);
}
