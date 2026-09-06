import { useEffect, useState } from 'react';
import { ActivityIcon, ChevronDownIcon, SquareIcon } from 'lucide-react';
import type { BackgroundTask } from '../../../shared/types.ts';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { taskName, tasksRunning } from '@/lib/activity';
import { formatDuration } from '@/lib/task-notifications';
import { cn } from '@/lib/utils';

/**
 * What this thread has left running, above the composer, for as long as it is
 * running.
 *
 * The thread already shows a task reporting in — one quiet row where its
 * block of XML arrived (see TaskNotification). That answers "what did it
 * say", and it scrolls away with everything else. This answers the other
 * question, the one that has no place in a transcript because it is not
 * something that happened: *is anything still going on?*
 *
 * It matters most in the state Boxes could not previously express. The agent
 * has finished, the thread is quiet, the composer is waiting for you — and a
 * monitor is watching a log, or a build has twenty minutes left. Without this
 * that thread is indistinguishable from a finished one, and the only evidence
 * is an old line where the agent promised to report back.
 *
 * Quiet, at the weight of the tool rows: it is a standing fact about the box
 * rather than a thing that just happened, and it sits under whatever the
 * thread is saying.
 */

/** How often the ages are re-read. A minute's work is not timed to the second. */
const TICK_MS = 15_000;

/** Now, roughly, re-read while there is something whose age is being shown. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function BackgroundBar({
  tasks,
  onStop,
}: {
  tasks: readonly BackgroundTask[];
  /**
   * Stops the work. This is `session/cancel` on the thread, which is the only
   * lever ACP offers, and it does reach the work: the adapter settles a turn
   * held open for its subagents and tears those subagents down with the
   * interrupt. Named for what it does to the reader — the tasks stop — and
   * confirmed first, because it is not undoable and half of why this bar
   * exists is that the agent is *not* the thing that needs stopping.
   */
  onStop?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const now = useNow(tasks.length > 0);
  if (tasks.length === 0) return null;

  return (
    <div
      data-slot="boxes_background-bar"
      className="mx-auto w-full max-w-(--thread-max-width) px-2"
    >
      <Collapsible className="rounded-lg border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <ActivityIcon className="size-3.5 shrink-0" aria-hidden />
          <CollapsibleTrigger className="group/tasks flex min-w-0 flex-1 items-center gap-2 text-start">
            <span className="min-w-0 flex-1 truncate font-medium">
              {tasksRunning(tasks.length)} in the background
            </span>
            <ChevronDownIcon
              className={cn(
                'size-3 shrink-0 -rotate-90 transition-transform duration-200',
                'ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
                'group-data-open/tasks:rotate-0',
              )}
            />
          </CollapsibleTrigger>
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
        <CollapsibleContent
          className={cn(
            'overflow-hidden ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none',
            'data-closed:animate-collapsible-up data-open:animate-collapsible-down',
            'data-closed:fill-mode-forwards duration-200 [--tw-duration:200ms]',
          )}
        >
          <ul className="mt-1.5 flex flex-col gap-1">
            {tasks.map((task) => (
              <li key={task.toolCallId} className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate">{taskName(task)}</span>
                {/* Since it started, not since it last said anything: a task
                    that has said nothing for an hour is the one this is for. */}
                <span className="shrink-0 tabular-nums opacity-80">
                  {formatDuration(Math.max(now - task.startedAt, 0))}
                </span>
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>

      {confirming && onStop ? (
        <ConfirmDialog
          title={tasks.length === 1 ? 'Stop this background task?' : 'Stop background work?'}
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
