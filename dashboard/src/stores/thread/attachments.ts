import { generateId, type AttachmentAdapter, type PendingAttachment } from '@assistant-ui/react';
import { api } from '../../api.ts';

/**
 * The composer's attachment adapter: what happens to a file between being
 * dropped on the thread and being part of a prompt.
 *
 * Everything is uploaded into the session's workspace, whatever it is, and
 * nothing travels inside the message. That is what makes this type-agnostic:
 * a PDF, a CSV and a core dump all become a path the agent opens with the
 * tools it already has.
 *
 * What the thread shows is fetched back from the workspace rather than kept
 * from the composer, so an image the user attached looks the same on the
 * phone that sent it and on the desktop that comes to it later.
 *
 * The upload happens on send rather than on drop, which is what keeps the
 * workspace free of files from attachments the user picked and thought
 * better of.
 */

/** Which of assistant-ui's three tiles a file is shown as. */
function kindOf(type: string): PendingAttachment['type'] {
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('text/') || type === 'application/pdf' || type === 'application/json') {
    return 'document';
  }
  return 'file';
}

/**
 * Builds the adapter for one session.
 *
 * `onError` is how a failed upload becomes something the user can read: the
 * composer's send button does not await the promise it starts, so an
 * adapter that only threw would restore the draft and say nothing about
 * why.
 */
export function createAttachmentAdapter(
  sessionId: string,
  onError: (message: string) => void,
): AttachmentAdapter {
  return {
    // Every type. What a session can do with a file is the agent's business,
    // and a picker that refuses the thing the user wanted to hand over is a
    // worse answer than an agent saying it cannot read it.
    accept: '*',

    async add({ file }) {
      return {
        id: generateId(),
        type: kindOf(file.type),
        name: file.name,
        contentType: file.type || 'application/octet-stream',
        file,
        status: { type: 'requires-action', reason: 'composer-send' },
      };
    },

    async send(attachment) {
      try {
        const stored = await api.uploadAttachment(sessionId, attachment.file);
        return {
          ...attachment,
          status: { type: 'complete' },
          // Where the file went, and nothing else. `sourceType: 'id'` is
          // assistant-ui's shape for "a reference, not the bytes", which is
          // exactly what a workspace path is.
          content: [
            {
              type: 'file' as const,
              data: stored.path,
              mimeType: attachment.contentType || 'application/octet-stream',
              filename: stored.name,
              sourceType: 'id' as const,
            },
          ],
        };
      } catch (err) {
        onError(`${attachment.name}: ${(err as Error).message}`);
        throw err;
      }
    },

    // Nothing to undo: a removed attachment was never uploaded.
    async remove() {},
  };
}
