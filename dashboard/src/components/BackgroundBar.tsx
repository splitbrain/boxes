import { useState } from 'react';
import { ActivityIcon, SquareIcon } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';

/**
 * That this box still has work in it, above the composer, for as long as it
 * does.
 *
 * It matters in the one state Boxes could not otherwise express. The agent
 * has finished, the thread is quiet, the composer is waiting for you — and a
 * monitor is watching a log, or a build has twenty minutes left. Without this
 * that thread is indistinguishable from a finished one, and the only evidence
 * is an old line where the agent promised to report back.
 *
 * It says that and no more. What is running is not knowable from where the
 * answer comes from — the processes alive in the container, which carry the
 * shell the harness wrapped a command in and not the words the agent chose —
 * and the question this exists for is answered without it. The list this used
 * to show was built from a tally of the harness's own start and finish
 * reports, which counted every start and, in production, not one finish; see
 * `orchestrator/src/gateway/background.ts`.
 *
 * Quiet, at the weight of the tool rows: it is a standing fact about the box
 * rather than a thing that just happened, and it sits under whatever the
 * thread is saying.
 */
export function BackgroundBar({
  busy,
  onStop,
}: {
  /** Whether the box still has work running in it. */
  busy: boolean;
  /**
   * Stops the work. This is `session/cancel` on the thread, which is the only
   * lever ACP offers, and it does reach the work: the adapter settles a turn
   * held open for its subagents and tears those subagents down with the
   * interrupt. Named for what it does to the reader — the work stops — and
   * confirmed first, because it is not undoable and half of why this bar
   * exists is that the agent is *not* the thing that needs stopping.
   */
  onStop?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!busy) return null;

  return (
    <div
      data-slot="boxes_background-bar"
      className="mx-auto w-full max-w-(--thread-max-width) px-2"
    >
      <div className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <ActivityIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium">
          Something is still running in the background
        </span>
        {onStop ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground"
          >
            <SquareIcon className="size-3 fill-current" aria-hidden />
            Stop
          </button>
        ) : null}
      </div>

      {confirming && onStop ? (
        <ConfirmDialog
          title="Stop background work?"
          description="Interrupts this conversation, which is what the work is running under: subagents are torn down, and anything half-done stays half-done. Nothing will report back."
          confirmLabel="Stop"
          danger
          onConfirm={() => {
            setConfirming(false);
            onStop();
          }}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}
