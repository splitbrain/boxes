/** Functions that fold ACP session/update notifications into the message model of the thread. */

import { UPDATE_KIND, type UpdateKind } from '../../../../shared/acp.ts';
import {
  parseTaskNotifications,
  type TaskNotification,
} from '../../../../shared/task-notifications.ts';
import { parseEnvelope } from '../../lib/attachments.ts';
import {
  type AvailableCommand,
  blockText,
  type ContentBlock,
  imageFallbackText,
  imageSrc,
  type PermissionOption,
  type PlanEntry,
  type ThreadConfigOption,
  type ThreadModeState,
  type ThreadUpdate,
  type ToolCallContent,
  type ToolCallLocation,
  type ToolCallStatus,
  type ToolCallUpdate,
  type ToolKind,
} from './acp-types.ts';

/** The member of the update union that carries one kind. */
type UpdateOf<K extends UpdateKind> = Extract<ThreadUpdate, { sessionUpdate: K }>;

/** A run of assistant or user prose. */
interface TextPart {
  /** The part's kind. */
  type: 'text';
  /** The text so far. */
  text: string;
}

/** The agent thinking out loud, rendered collapsed. */
interface ReasoningPart {
  /** The part's kind. */
  type: 'reasoning';
  /** The text so far. */
  text: string;
}

/**
 * An image, as a src the browser can load.
 *
 * `imageSrc` sets the src when the block arrives. A block without a src
 * becomes text instead.
 */
interface ImagePart {
  /** The part's kind. */
  type: 'image';
  /** A data URL, or an https or blob URL. */
  src: string;
}

/**
 * A file the user attached, shown as a chip under the message.
 *
 * Built from the envelope text that the composer put in the prompt. Text survives
 * a transcript unchanged, so live and replayed threads show the same chip.
 */
export interface AttachmentPart {
  /** The part's kind. */
  type: 'attachment';
  /** The file's name, which is what the chip shows. */
  name: string;
  /** The workspace-relative path the agent was given to open. */
  path: string;
  /** The file's media type. */
  mimeType: string;
}

/**
 * The report of a background task, shown as a row of its own.
 *
 * Built from the XML block that the harness wakes the agent with, so live and
 * replayed threads show the same row.
 */
export interface TaskPart extends TaskNotification {
  /** The part's kind. */
  type: 'task';
}

/** A permission request attached to the tool call it is about. */
export interface ApprovalState {
  /** Correlates the user's answer with the JSON-RPC request that is blocked. */
  id: string;
  /** The answers the request offers. */
  options: PermissionOption[];
  /** The option the user picked, once answered. */
  optionId?: string;
  /** Set when the request was cancelled instead of answered. */
  resolution?: 'cancelled';
}

/** One tool call, and everything known about it so far. */
export interface ToolPart {
  /** The part's kind. */
  type: 'tool';
  /** The adapter's id for the call. */
  toolCallId: string;
  /** The adapter's human-readable title, which is what the header shows. */
  title: string;
  /** The programmatic name when the adapter sends one. */
  name?: string;
  /** The category of the tool. */
  kind?: ToolKind;
  /** The progress of the call. */
  status: ToolCallStatus;
  /** The arguments the tool received. */
  rawInput?: unknown;
  /** Content blocks, diffs and terminal handles, rendered in order. */
  content: ToolCallContent[];
  /** The files the call touches. */
  locations: ToolCallLocation[];
  /** The permission request on this call, while one exists. */
  approval?: ApprovalState;
}

/** A part of a message. */
export type Part = TextPart | ReasoningPart | ImagePart | AttachmentPart | TaskPart | ToolPart;

/** One message in the thread. */
export interface Message {
  /** The message id from the adapter, or an id that this model generated. */
  id: string;
  /** The role of the speaker. */
  role: 'user' | 'assistant';
  /** The message content, in order. */
  parts: Part[];
  /**
   * True when the id is the adapter's own.
   *
   * A replay repeats the adapter's ids, so a reconnect can resume from such
   * a message.
   */
  named?: boolean;
}

/** The model that the thread view reads. */
export interface ThreadModel {
  /** The messages of the thread, in order. */
  messages: Message[];
  /** The adapter's advertised modes, or null when it advertises none. */
  modes: ThreadModeState | null;
  /** The options the adapter lets a client set, such as the model. */
  configOptions: ThreadConfigOption[];
  /** The agent's current plan, or null when it has published none. */
  plan: PlanEntry[] | null;
  /** The slash commands the adapter accepts, for the composer to complete. */
  commands: AvailableCommand[];
  /** The prompt that the agent expects the user to send next, or null. */
  promptSuggestion: string | null;
  /**
   * Kinds of update this build does not know, by name.
   *
   * Only the names are kept, because a thread can carry hundreds of thousands
   * of updates.
   */
  unknown: Set<string>;
  /**
   * Every tool call in the thread with the message that holds it, by the
   * adapter's id for the call.
   *
   * A long thread holds thousands of calls, so lookups use this index.
   */
  tools: Map<string, { part: ToolPart; message: Message }>;
}

/**
 * Builds a model with nothing in it.
 *
 * @returns The empty model.
 */
export function emptyModel(): ThreadModel {
  return {
    messages: [],
    modes: null,
    configOptions: [],
    plan: null,
    commands: [],
    promptSuggestion: null,
    unknown: new Set(),
    tools: new Map(),
  };
}

/** The counter for the ids of messages whose chunks arrive without an id. */
let nextId = 1;

/** Resets the id counter, so each test gets predictable ids. */
export function resetIds(): void {
  nextId = 1;
}

/**
 * Creates an empty message in the given role, named when `id` is given.
 *
 * @param role The role of the speaker.
 * @param id The adapter's id for the message, if any.
 * @returns The new message.
 */
function newMessage(role: Message['role'], id?: string | null): Message {
  if (id) return { id, role, parts: [], named: true };
  return { id: `m${nextId++}`, role, parts: [] };
}

/**
 * Finds or creates the message a chunk belongs to.
 *
 * ACP marks message boundaries with messageId. Chunks with the same messageId
 * are one message, and a change starts a new one. Without a messageId, a role
 * change starts a new message.
 *
 * @param model The thread model.
 * @param role The role of the chunk.
 * @param messageId The adapter's id for the message of the chunk, if any.
 * @returns The message, which is the last one in the model.
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

/**
 * Appends text to the last part when that part has the given kind, or starts a new part.
 *
 * @param message The message.
 * @param kind The kind of the part.
 * @param text The text to append.
 */
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
 * Appends one content block to a message.
 *
 * An image becomes its own part between the text parts around it.
 * Everything else is read as text and appended, so a run of chunks
 * collapses into one part. All three chunk kinds use this path, thoughts
 * included.
 *
 * @param message The message.
 * @param kind The kind of the part for text.
 * @param content The content block.
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

  // The harness wakes the agent in the user role when a background task
  // reports. Only that role is checked, so an agent quoting the format stays
  // text.
  const segments = kind === 'text' && message.role === 'user' ? parseTaskNotifications(text) : null;
  if (segments) {
    for (const segment of segments) {
      if (segment.type === 'text') appendText(message, kind, segment.text);
      else message.parts.push({ type: 'task', ...segment.notification });
    }
    return;
  }

  // The composer's envelope tells the agent what was attached. The reader sees
  // the attached files in its place.
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

/**
 * Drops the message that an id names and every message after it, so a replay
 * that starts there builds them again.
 *
 * @param model The thread model.
 * @param messageId The id of the first message to drop.
 * @returns The dropped messages. The result is empty when no message has the
 *   id, and then the model stays unchanged.
 */
export function truncateFrom(model: ThreadModel, messageId: string): Message[] {
  const from = model.messages.findIndex((m) => m.id === messageId);
  if (from < 0) return [];
  const dropped = model.messages.splice(from);
  // The tool index loses the calls of the dropped messages.
  for (const message of dropped) {
    for (const part of message.parts) {
      if (part.type === 'tool') model.tools.delete(part.toolCallId);
    }
  }
  return dropped;
}

/**
 * Finds a tool part anywhere in the thread.
 *
 * @param model The thread model.
 * @param toolCallId The adapter's id for the call.
 * @returns The tool part, or undefined when the thread has no such call.
 */
export function findTool(model: ThreadModel, toolCallId: string): ToolPart | undefined {
  return model.tools.get(toolCallId)?.part;
}

/**
 * Finds the message a tool call sits in.
 *
 * @param model The thread model.
 * @param toolCallId The adapter's id for the call.
 * @returns The message, or null when the thread has no such call.
 */
export function messageOfTool(model: ThreadModel, toolCallId: string): Message | null {
  return model.tools.get(toolCallId)?.message ?? null;
}

/**
 * Applies one update to the model, in place.
 *
 * Replay and live streaming both come through here. An unknown kind is
 * noted by name and otherwise ignored, so a newer adapter does not break an
 * older dashboard.
 *
 * @param model The thread model.
 * @param update The update.
 * @returns The changed message, so a caller can refresh only that message, or
 *   null when the update changed no message.
 */
export function applyUpdate(model: ThreadModel, update: ThreadUpdate): Message | null {
  switch (update.sessionUpdate) {
    case UPDATE_KIND.userMessageChunk: {
      const u = update as UpdateOf<typeof UPDATE_KIND.userMessageChunk>;
      // The user has answered, so the suggestion for this answer is old.
      model.promptSuggestion = null;
      const message = messageFor(model, 'user', u.messageId);
      appendBlock(message, 'text', u.content);
      return message;
    }
    case UPDATE_KIND.agentMessageChunk: {
      const u = update as UpdateOf<typeof UPDATE_KIND.agentMessageChunk>;
      const message = messageFor(model, 'assistant', u.messageId);
      appendBlock(message, 'text', u.content);
      return message;
    }
    case UPDATE_KIND.agentThoughtChunk: {
      const u = update as UpdateOf<typeof UPDATE_KIND.agentThoughtChunk>;
      const message = messageFor(model, 'assistant', u.messageId);
      appendBlock(message, 'reasoning', u.content);
      return message;
    }
    case UPDATE_KIND.toolCall: {
      const u = update as UpdateOf<typeof UPDATE_KIND.toolCall>;
      // A call announced again is an update and not a second card, because an
      // adapter can send a call again, and a replay always does.
      return openTool(model, u, u.title);
    }
    case UPDATE_KIND.toolCallUpdate: {
      const u = update as UpdateOf<typeof UPDATE_KIND.toolCallUpdate>;
      // An update can arrive before the call that it belongs to, and dropping
      // it would lose the result of the tool. The update can lack a title, so
      // the id stands in until the announcement brings one.
      return openTool(model, u, u.title ?? u.toolCallId);
    }
    case UPDATE_KIND.plan: {
      const u = update as UpdateOf<typeof UPDATE_KIND.plan>;
      model.plan = u.entries ?? [];
      return null;
    }
    case UPDATE_KIND.availableCommands: {
      const u = update as UpdateOf<typeof UPDATE_KIND.availableCommands>;
      model.commands = u.availableCommands ?? [];
      return null;
    }
    case UPDATE_KIND.configOption: {
      const u = update as UpdateOf<typeof UPDATE_KIND.configOption>;
      // The adapter sends the whole set every time, so the model replaces the
      // set and does not merge it.
      model.configOptions = u.configOptions ?? [];
      return null;
    }
    case UPDATE_KIND.currentMode: {
      const u = update as UpdateOf<typeof UPDATE_KIND.currentMode>;
      if (model.modes) model.modes = { ...model.modes, currentModeId: u.currentModeId };
      return null;
    }
    case UPDATE_KIND.sessionInfo: {
      const u = update as UpdateOf<typeof UPDATE_KIND.sessionInfo>;
      const suggestion = promptSuggestionOf(u._meta);
      if (suggestion !== undefined) model.promptSuggestion = suggestion;
      return null;
    }
    default:
      model.unknown.add(update.sessionUpdate);
      return null;
  }
}

/** The `_meta` key under which `claude-agent-acp` sends the predicted next prompt. */
export const PROMPT_SUGGESTIONS_META_KEY = 'promptSuggestions';

/**
 * Reads the predicted next prompt from the `_meta` of a session_info_update.
 *
 * The value is `{ suggestions: [{ text }] }`. An empty list clears the prediction.
 *
 * @param meta The `_meta` of the update.
 * @returns The first text that is not blank, null when the update clears the prediction, or undefined when the
 *   update says nothing about it.
 */
function promptSuggestionOf(
  meta: Record<string, unknown> | null | undefined,
): string | null | undefined {
  const value = meta?.[PROMPT_SUGGESTIONS_META_KEY] as { suggestions?: unknown } | undefined;
  if (!value || !Array.isArray(value.suggestions)) return undefined;
  for (const entry of value.suggestions) {
    const text = (entry as { text?: unknown } | null)?.text;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return null;
}

/**
 * Folds a tool_call or a tool_call_update into the thread. The update merges
 * into its call, or starts a new card when the call does not exist yet.
 *
 * An adapter may send either of the two first, so both take this path. The
 * caller passes the title for a new card.
 *
 * @param model The thread model.
 * @param u The tool call or the update.
 * @param title The title for a new card.
 * @returns The message that holds the call.
 */
function openTool(model: ThreadModel, u: ToolCallUpdate, title: string): Message | null {
  const indexed = model.tools.get(u.toolCallId);
  if (indexed) {
    mergeTool(indexed.part, u);
    return indexed.message;
  }
  const message = messageFor(model, 'assistant', null);
  const part: ToolPart = {
    type: 'tool',
    toolCallId: u.toolCallId,
    title,
    ...(u.name ? { name: u.name } : {}),
    ...(u.kind ? { kind: u.kind } : {}),
    status: u.status ?? 'pending',
    ...(u.rawInput === undefined ? {} : { rawInput: u.rawInput }),
    content: u.content ?? [],
    locations: u.locations ?? [],
  };
  message.parts.push(part);
  model.tools.set(u.toolCallId, { part, message });
  return message;
}

/**
 * Merges a tool_call or tool_call_update into an existing part.
 *
 * Null and absent both mean that the field stays unchanged, as the schema
 * defines for an omitted field.
 *
 * @param part The existing part.
 * @param u The tool call or the update.
 */
function mergeTool(part: ToolPart, u: ToolCallUpdate): void {
  if (u.title != null) part.title = u.title;
  if (u.name != null) part.name = u.name;
  if (u.kind != null) part.kind = u.kind;
  if (u.status != null) part.status = u.status;
  if (u.rawInput !== undefined) part.rawInput = u.rawInput;
  // content and locations replace the old values and do not merge, because
  // in the schema an update carries the whole collection.
  if (u.content != null) part.content = u.content;
  if (u.locations != null) part.locations = u.locations;
}

/**
 * Renders the content of a tool call as the plain text that the fallback shows.
 *
 * The text names an image and does not render it. The picture shows beside
 * the card. The name keeps an image result from looking like a tool that
 * produced nothing.
 *
 * @param part The tool part.
 * @returns The text, one line per content entry.
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

/**
 * Renders a diff as a block in unified style, with the removed lines first and then the added lines.
 *
 * @param diff The diff content.
 * @returns The diff text.
 */
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
