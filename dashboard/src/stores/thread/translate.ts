import {
  blockText,
  imageFallbackText,
  imageSrc,
  type AvailableCommand,
  type ContentBlock,
  type PermissionOption,
  type PlanEntry,
  type SessionConfigOption,
  type SessionModeState,
  type SessionUpdate,
  type ToolCallContent,
  type ToolCallLocation,
  type ToolCallStatus,
  type ToolCallUpdate,
  type ToolKind,
} from './acp-types.ts';
import { parseEnvelope } from '../../lib/attachments.ts';
import {
  parseTaskNotifications,
  type TaskNotification,
} from '../../../../shared/task-notifications.ts';

/**
 * ACP session/update notifications, folded into an append-only message model.
 *
 * Everything here is pure: the same updates in the same order always produce
 * the same model, which is what makes replay and live streaming the same code
 * path. Replay is just the adapter re-sending the history as notifications.
 */

/** A run of assistant or user prose. */
export interface TextPart {
  type: 'text';
  text: string;
}

/** The agent thinking out loud, rendered collapsed. */
export interface ReasoningPart {
  type: 'reasoning';
  text: string;
}

/**
 * An image, as something the browser can load.
 *
 * The block's own shape does not survive into the model: what a renderer
 * needs is one src, and which of the two ACP forms it came from is settled
 * once, on arrival, by `imageSrc`. A block that yields no src never becomes
 * one of these — it is said in words instead.
 */
export interface ImagePart {
  type: 'image';
  src: string;
}

/**
 * A file the user attached, as a chip under their message.
 *
 * Built from the envelope the composer put in the prompt rather than from
 * anything the adapter says, which is what makes it identical live and on
 * replay: the envelope is text, and text is the one thing that survives a
 * transcript unchanged.
 */
export interface AttachmentPart {
  type: 'attachment';
  /** The file's name, which is what the chip shows. */
  name: string;
  /** Workspace-relative, and what the agent was given to open. */
  path: string;
  mimeType: string;
}

/**
 * A background task reporting in, as a row of its own.
 *
 * Built from the block of XML the harness wakes the agent with rather than
 * from anything the adapter says, on the same terms as the attachment chip:
 * the text is what survives a transcript, so live and replayed threads draw
 * the same row.
 */
export interface TaskPart extends TaskNotification {
  type: 'task';
}

/** A permission request attached to the tool call it is about. */
export interface ApprovalState {
  /** Correlates the user's answer with the JSON-RPC request that is blocked. */
  id: string;
  options: PermissionOption[];
  /** Set once answered, or when the adapter gave up on the question. */
  optionId?: string;
  resolution?: 'cancelled';
}

/** One tool call, and everything known about it so far. */
export interface ToolPart {
  type: 'tool';
  toolCallId: string;
  /** The adapter's human-readable title, which is what the header shows. */
  title: string;
  /** The programmatic name when the adapter sends one. */
  name?: string;
  kind?: ToolKind;
  status: ToolCallStatus;
  rawInput?: unknown;
  /** Content blocks, diffs and terminal handles, rendered in order. */
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  approval?: ApprovalState;
}

/** A part of a message. */
export type Part = TextPart | ReasoningPart | ImagePart | AttachmentPart | TaskPart | ToolPart;

/** One message in the thread. */
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  parts: Part[];
}

/** Everything the thread view reads. */
export interface ThreadModel {
  messages: Message[];
  /** The adapter's advertised modes, or null when it advertises none. */
  modes: SessionModeState | null;
  /** The options the adapter lets a client set, such as the model. */
  configOptions: SessionConfigOption[];
  /** The agent's current plan, or null when it has published none. */
  plan: PlanEntry[] | null;
  /** The slash commands the adapter accepts, for the composer to complete. */
  commands: AvailableCommand[];
  /** Updates whose kind this build does not know, kept for forward compatibility. */
  unknown: SessionUpdate[];
}

/** A model with nothing in it. */
export function emptyModel(): ThreadModel {
  return {
    messages: [],
    modes: null,
    configOptions: [],
    plan: null,
    commands: [],
    unknown: [],
  };
}

/** Source of message ids for chunks that arrive without one. */
let nextId = 1;

/** Resets the id counter. Tests only, so ids are predictable per case. */
export function resetIds(): void {
  nextId = 1;
}

/** A new empty message, in the given role. */
function newMessage(role: Message['role'], id?: string | null): Message {
  return { id: id ?? `m${nextId++}`, role, parts: [] };
}

/**
 * The message a chunk belongs to.
 *
 * ACP marks message boundaries with messageId: chunks sharing one are the
 * same message, and a change starts a new one. An adapter that sends no
 * messageId falls back to the role boundary, which is what streaming looks
 * like in practice.
 */
function messageFor(
  model: ThreadModel,
  role: Message['role'],
  messageId: string | null | undefined,
): Message {
  const last = model.messages.at(-1);
  if (last) {
    if (messageId) {
      if (last.id === messageId) return last;
    } else if (last.role === role) {
      return last;
    }
  }
  const created = newMessage(role, messageId);
  model.messages.push(created);
  return created;
}

/** Appends text to the trailing part of that kind, or starts a new one. */
function appendText(message: Message, kind: 'text' | 'reasoning', text: string): void {
  if (!text) return;
  const last = message.parts.at(-1);
  if (last?.type === kind) {
    last.text += text;
    return;
  }
  message.parts.push({ type: kind, text });
}

/**
 * Appends one content block to a message, as a part of the kind it is.
 *
 * An image becomes its own part rather than joining the prose, because it is
 * not prose: two chunks of text on either side of one are two text parts with
 * a picture between them, which is what was said. Everything else is read as
 * text and appended, so a run of chunks still collapses into one part.
 *
 * The same path serves all three chunk kinds, thought included. An image in a
 * thought is not something the adapter sends today, and if it starts, showing
 * it costs nothing and dropping it would be a silence to debug.
 */
function appendBlock(message: Message, kind: 'text' | 'reasoning', content: ContentBlock): void {
  if (content?.type === 'image') {
    const src = imageSrc(content);
    if (src) {
      message.parts.push({ type: 'image', src });
      return;
    }
    appendText(message, kind, imageFallbackText(content));
    return;
  }

  const text = blockText(content);

  // Not the user speaking, however much it looks like it: the harness wakes
  // the agent in the user's own role when a background task has something to
  // report. Only in that role — an agent quoting the format is quoting it.
  const segments = kind === 'text' && message.role === 'user' ? parseTaskNotifications(text) : null;
  if (segments) {
    for (const segment of segments) {
      if (segment.type === 'text') appendText(message, kind, segment.text);
      else message.parts.push({ type: 'task', ...segment.notification });
    }
    return;
  }

  // A block the composer wrote to tell the agent what was attached. It is
  // addressed to the model, so what is shown in its place is the thing the
  // reader attached: the picture, or the file's name.
  const envelope = kind === 'text' ? parseEnvelope(text) : null;
  if (envelope) {
    appendText(message, kind, envelope.before);
    for (const entry of envelope.entries) {
      message.parts.push({
        type: 'attachment',
        name: entry.name,
        path: entry.path,
        mimeType: entry.mimeType,
      });
    }
    appendText(message, kind, envelope.after);
    return;
  }

  appendText(message, kind, text);
}

/** Finds a tool part anywhere in the thread, newest first. */
export function findTool(model: ThreadModel, toolCallId: string): ToolPart | undefined {
  for (let i = model.messages.length - 1; i >= 0; i--) {
    const parts = model.messages[i]!.parts;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]!;
      if (part.type === 'tool' && part.toolCallId === toolCallId) return part;
    }
  }
  return undefined;
}

/**
 * Applies one update to the model, in place, and returns the message it
 * changed so a caller can refresh just that one.
 *
 * An unknown kind is kept and otherwise ignored: a newer adapter must be able
 * to talk to an older dashboard without the thread breaking.
 */
export function applyUpdate(model: ThreadModel, update: SessionUpdate): Message | null {
  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      const u = update as Extract<SessionUpdate, { sessionUpdate: 'user_message_chunk' }>;
      const message = messageFor(model, 'user', u.messageId);
      appendBlock(message, 'text', u.content);
      return message;
    }
    case 'agent_message_chunk': {
      const u = update as Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' }>;
      const message = messageFor(model, 'assistant', u.messageId);
      appendBlock(message, 'text', u.content);
      return message;
    }
    case 'agent_thought_chunk': {
      const u = update as Extract<SessionUpdate, { sessionUpdate: 'agent_thought_chunk' }>;
      const message = messageFor(model, 'assistant', u.messageId);
      appendBlock(message, 'reasoning', u.content);
      return message;
    }
    case 'tool_call': {
      const u = update as Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>;
      // A re-announced call is an update, not a second card: an adapter may
      // resend one, and replay always does.
      return openTool(model, u, u.title);
    }
    case 'tool_call_update': {
      const u = update as Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>;
      // Out of order: an update can arrive before the call it belongs to, and
      // dropping it would lose the tool's result. What it lacks is a title, so
      // the id stands in until the announcement arrives with one.
      return openTool(model, u, u.title ?? u.toolCallId);
    }
    case 'plan': {
      const u = update as Extract<SessionUpdate, { sessionUpdate: 'plan' }>;
      model.plan = u.entries ?? [];
      return null;
    }
    case 'available_commands_update': {
      const u = update as Extract<
        SessionUpdate,
        { sessionUpdate: 'available_commands_update' }
      >;
      model.commands = u.availableCommands ?? [];
      return null;
    }
    case 'config_option_update': {
      const u = update as Extract<SessionUpdate, { sessionUpdate: 'config_option_update' }>;
      // The adapter sends the whole set every time, so this replaces rather
      // than merges.
      model.configOptions = u.configOptions ?? [];
      return null;
    }
    case 'current_mode_update': {
      const u = update as Extract<SessionUpdate, { sessionUpdate: 'current_mode_update' }>;
      if (model.modes) model.modes = { ...model.modes, currentModeId: u.currentModeId };
      return null;
    }
    default:
      model.unknown.push(update);
      return null;
  }
}

/**
 * Folds a tool_call or a tool_call_update into the thread: merged into the
 * call it is about, or started as a fresh card when there is none yet.
 *
 * One path for both, because the two updates differ in exactly one thing —
 * what a card with no title yet is called — and an adapter is free to send
 * either of them first.
 */
function openTool(model: ThreadModel, u: ToolCallUpdate, title: string): Message | null {
  const existing = findTool(model, u.toolCallId);
  if (existing) {
    mergeTool(existing, u);
    return messageOf(model, existing);
  }
  const message = messageFor(model, 'assistant', null);
  message.parts.push({
    type: 'tool',
    toolCallId: u.toolCallId,
    title,
    ...(u.name ? { name: u.name } : {}),
    ...(u.kind ? { kind: u.kind } : {}),
    status: u.status ?? 'pending',
    ...(u.rawInput === undefined ? {} : { rawInput: u.rawInput }),
    content: u.content ?? [],
    locations: u.locations ?? [],
  });
  return message;
}

/** The message a part belongs to. */
function messageOf(model: ThreadModel, part: Part): Message | null {
  return model.messages.find((m) => m.parts.includes(part)) ?? null;
}

/**
 * Merges a tool_call or tool_call_update into an existing part.
 *
 * Null and absent both mean "leave it alone", which is what the schema says
 * an omitted field means.
 */
function mergeTool(part: ToolPart, u: ToolCallUpdate): void {
  if (u.title != null) part.title = u.title;
  if (u.name != null) part.name = u.name;
  if (u.kind != null) part.kind = u.kind;
  if (u.status != null) part.status = u.status;
  if (u.rawInput !== undefined) part.rawInput = u.rawInput;
  // content and locations replace rather than merge, which is what the
  // schema says: an update carries the whole collection.
  if (u.content != null) part.content = u.content;
  if (u.locations != null) part.locations = u.locations;
}

/**
 * Renders a tool call's content as the plain text the fallback shows.
 *
 * An image is named rather than rendered here; the picture itself is shown
 * beside the card. Naming it keeps an image result from reading as a tool
 * that produced nothing.
 */
export function toolOutputText(part: ToolPart): string {
  return part.content
    .map((c) => {
      if (c.type === 'content') {
        return c.content?.type === 'image' ? imageFallbackText(c.content) : blockText(c.content);
      }
      if (c.type === 'diff') return diffText(c);
      return `[terminal ${c.terminalId}]`;
    })
    .filter(Boolean)
    .join('\n');
}

/** A diff as a unified-looking block, which is all the fallback needs to show. */
function diffText(diff: Extract<ToolCallContent, { type: 'diff' }>): string {
  const removed = (diff.oldText ?? '')
    .split('\n')
    .filter((l, i, a) => l !== '' || i < a.length - 1)
    .map((l) => `-${l}`);
  const added = diff.newText
    .split('\n')
    .filter((l, i, a) => l !== '' || i < a.length - 1)
    .map((l) => `+${l}`);
  return [`--- ${diff.path}`, ...removed, ...added].join('\n');
}
