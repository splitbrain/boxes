import type { ThreadMessageLike, ToolApprovalOption } from '@assistant-ui/react';
import { imageSrc, type PermissionOption, type PermissionOptionKind } from './acp-types.ts';
import { attachmentUrl, isThumbnailable } from '../../lib/attachments.ts';
import { TASK_NOTIFICATION_PART } from '../../lib/task-notifications.ts';
import {
  toolOutputText,
  type ApprovalState,
  type AttachmentPart,
  type Message,
  type TaskPart,
  type ToolPart,
} from './translate.ts';

/**
 * Our message model, in the shape the runtime reads.
 *
 * The two vocabularies line up almost exactly; the only translation with any
 * content is the permission one, and even that is a rename.
 */

/**
 * ACP permission kinds are assistant-ui's approval kinds with underscores.
 * The rest of the option is a rename too: optionId → id, name → label.
 */
const KIND: Record<PermissionOptionKind, ToolApprovalOption['kind']> = {
  allow_once: 'allow-once',
  allow_always: 'allow-always',
  reject_once: 'reject-once',
  reject_always: 'reject-always',
};

/** One ACP permission option as an approval option. */
function approvalOption(option: PermissionOption): ToolApprovalOption {
  return {
    id: option.optionId,
    // An adapter may offer a kind this build predates; pass it through rather
    // than guessing, which is what the open union is for.
    kind: KIND[option.kind] ?? option.kind,
    label: option.name,
  };
}

/** An approval as the tool-call part carries it. */
function approval(state: ApprovalState): NonNullable<
  Extract<ThreadMessageLike['content'][number] & object, { type: 'tool-call' }>['approval']
> {
  const options = state.options.map(approvalOption);
  const chosen = state.optionId
    ? state.options.find((o) => o.optionId === state.optionId)
    : undefined;
  return {
    id: state.id,
    options,
    ...(state.optionId ? { optionId: state.optionId } : {}),
    ...(chosen ? { approved: chosen.kind.startsWith('allow') } : {}),
    ...(state.resolution ? { resolution: state.resolution } : {}),
  };
}

/**
 * A tool call's raw input as an args object.
 *
 * The value arrived as JSON over the wire, so it is JSON by construction,
 * and the cast says that rather than re-validating a parsed tree. Anything
 * that is not a plain object has no args to show.
 */
type JsonObject = NonNullable<
  Extract<ThreadMessageLike['content'][number] & object, { type: 'tool-call' }>['args']
>;

function asArgs(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

/**
 * Whether the permission question on a call is still open.
 *
 * Mirrors the runtime's own test: an approval counts as answered once it
 * carries the option that was picked, or the resolution that cancelled it.
 */
function awaitingApproval(part: ToolPart): boolean {
  const state = part.approval;
  return state !== undefined && state.optionId === undefined && state.resolution === undefined;
}

/** One tool part as a tool-call message part. */
function toolPart(part: ToolPart) {
  const output = toolOutputText(part);
  // A call still waiting on its permission question has no result, whatever
  // content it has already sent: what an unapproved edit carries is the diff
  // it proposes, not work it did. The runtime reads any result at all as
  // proof the call finished, and a finished call is never the one being
  // asked about, so reporting one here hides the question and leaves the
  // turn blocked with no way to answer it.
  //
  // An empty result on a finished call is still a result: it says the tool
  // produced nothing, which is different from still running.
  const finished =
    !awaitingApproval(part) &&
    (output !== '' || part.status === 'completed' || part.status === 'failed');
  return {
    type: 'tool-call' as const,
    toolCallId: part.toolCallId,
    // The programmatic name when the adapter sends one, else the title it
    // does send. The header needs something to say either way.
    toolName: part.name ?? part.title,
    args: asArgs(part.rawInput),
    ...(part.rawInput === undefined ? {} : { argsText: JSON.stringify(part.rawInput) }),
    ...(finished ? { result: output } : {}),
    ...(part.status === 'failed' ? { isError: true } : {}),
    ...(part.approval ? { approval: approval(part.approval) } : {}),
  };
}

/** One part as an image part, in the shape the runtime reads. */
function imagePart(src: string) {
  return { type: 'image' as const, image: src };
}

/**
 * An attached file as a part the thread can draw.
 *
 * An image becomes the picture itself, loaded from the endpoint that serves
 * the session's workspace — which is what makes a screenshot readable in the
 * thread that sent it without the bytes ever going through the transcript.
 * Everything else becomes a chip naming the file, and carrying the same
 * endpoint so it can be opened: a PDF in the browser's viewer, anything else
 * as the download it is. `sourceType: 'id'` says the data is a reference
 * rather than the bytes, which is what stops assistant-ui offering a
 * download of something the browser never had.
 *
 * Without a session there is nothing to fetch from, so everything is a chip.
 * That is the shape a test reads, and it loses only the picture.
 */
function attachmentPart(part: AttachmentPart, sessionId?: string) {
  if (sessionId && isThumbnailable(part.mimeType)) {
    return { type: 'image' as const, image: attachmentUrl(sessionId, part.path) };
  }
  return {
    type: 'file' as const,
    // The endpoint when there is a session to read it from, which is what
    // the chip opens; otherwise the path, which at least says where it went.
    data: sessionId ? attachmentUrl(sessionId, part.path) : part.path,
    mimeType: part.mimeType,
    filename: part.name,
    sourceType: 'id' as const,
  };
}

/**
 * A background task's report, as a data part the thread has a renderer for.
 *
 * assistant-ui's message parts are a closed set of prose, pictures, files and
 * tool calls, and this is none of those — so it travels as the one part kind
 * that carries an application's own vocabulary: a name the renderer is keyed
 * by, and the notification itself as its data. The part's `type` discriminant
 * is dropped on the way, because `name` is what does that job here.
 */
function taskPart({ type: _type, ...notification }: TaskPart) {
  return { type: 'data' as const, name: TASK_NOTIFICATION_PART, data: notification };
}

/**
 * The images a tool call produced, as parts of their own.
 *
 * A tool-call part cannot contain an image — assistant-ui's message parts are
 * flat — so a screenshot arrives as a sibling just after the card that
 * produced it. That is also where it reads best: the card says what was run,
 * and the picture is the answer, in the transcript rather than folded away
 * behind a disclosure nobody opens.
 *
 * Derived on every conversion rather than stored, so a tool_call_update that
 * replaces the call's content — which is what the schema says an update does
 * — replaces its images too, with nothing to keep in step.
 *
 * One consequence to expect rather than fix: the thread coalesces adjacent
 * tool calls into one "n tool calls" group, and an image between two of them
 * ends the first group. Two calls that each produced a screenshot therefore
 * read as two groups with a picture under each.
 */
function toolImages(part: ToolPart) {
  return part.content.flatMap((c) => {
    if (c.type !== 'content') return [];
    const src = imageSrc(c.content);
    return src ? [imagePart(src)] : [];
  });
}

/**
 * One part of a message, in the shape the runtime reads.
 *
 * Named because one of our parts can convert to more than one of these, and
 * an inferred element type from the first branch of that is not the union.
 */
type ConvertedPart = ThreadMessageLike['content'][number] & object;

/**
 * One of our messages, as the runtime reads it.
 *
 * `sessionId` is what an attachment is fetched back from; a caller with none
 * gets the same message with its attachments named rather than shown.
 */
export function convertMessage(message: Message, sessionId?: string): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: message.parts.flatMap((part): ConvertedPart[] => {
      if (part.type === 'text') return [{ type: 'text' as const, text: part.text }];
      if (part.type === 'reasoning') return [{ type: 'reasoning' as const, text: part.text }];
      if (part.type === 'image') return [imagePart(part.src)];
      if (part.type === 'attachment') return [attachmentPart(part, sessionId)];
      if (part.type === 'task') return [taskPart(part)];
      return [toolPart(part), ...toolImages(part)];
    }),
  };
}
