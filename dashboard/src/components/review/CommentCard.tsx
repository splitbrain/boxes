import { Pencil, Trash2 } from 'lucide-react';
import type { ReviewAnnotation } from '../../../../shared/types.ts';
import { Button } from '@/components/ui/button';

/**
 * One comment, as a card under the line it is about.
 *
 * Inline on every screen size, GitHub-style, rather than in a right-hand
 * sidebar: a sidebar is the first thing a phone has to reflow away, and once
 * it is gone the comment has to live somewhere anyway. This is that somewhere,
 * so there is only one of it.
 *
 * The comment is agent-influenceable text — the agent can write into
 * REVIEW.md — so it is rendered as a text node and nothing else:
 * `whitespace-pre-wrap` keeps the reviewer's own line breaks without
 * interpreting anything.
 */
export function CommentCard({
  annotation,
  busy,
  onEdit,
  onDelete,
}: {
  annotation: ReviewAnnotation;
  /** True while a write is in flight, so a double tap cannot act twice. */
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-md border bg-card px-3 py-2 font-sans text-sm">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{annotation.comment}</p>
        <div className="flex shrink-0 gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            onClick={onEdit}
            aria-label={`Edit the comment on line ${annotation.line}`}
            title="Edit"
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            onClick={onDelete}
            aria-label={`Delete the comment on line ${annotation.line}`}
            title="Delete"
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      {annotation.outdated ? (
        <p className="mt-1 text-xs text-muted-foreground">
          The code this was written about has changed, so the line may no longer be the right
          one.
        </p>
      ) : null}
    </div>
  );
}
