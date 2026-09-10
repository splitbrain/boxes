import { useEffect, useState } from 'react';
import { ActivityIcon, ChevronDownIcon, SquareIcon } from 'lucide-react';
import type { BackgroundProcess } from '../../../shared/types.ts';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { commandsRunning } from '@/lib/activity';
import { formatDuration } from '@/lib/task-notifications';
import { cn } from '@/lib/utils';

/**
 * What this thread has left running, above the composer, for as long as it is
 * running.
 *
 * It covers the one state nothing else expresses: the agent has finished, the
 * thread is quiet, the composer is free, and a monitor is watching a log or a
 * build has twenty minutes left. Without it such a thread looks finished, and
 * the only evidence is an old line where the agent promised to report back.
 *
 * This thread's work and nobody else's: what is listed is what runs under
 * this conversation's own agent process.
 *
 * Quiet, at the weight of the tool rows, because it is a standing fact about
 * the box rather than a thing that just happened.
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
  processes,
  onStop,
}: {
  /** What this conversation is running, as the gateway last read it. */
  processes: readonly BackgroundProcess[];
  /**
   * Kills it: one process and the tree under it, or everything this thread is
   * running when given no id.
   *
   * A kill rather than an interrupt. The composer's own stop sends
   * `session/cancel`, which ends a turn and tears down the subagents it was
   * being held open for — and does nothing at all to a command still running,
   * because that is a child of the agent's process that outlives the turn by
   * design. This bar borrowed that button once and so offered a stop that
   * stopped nothing.
   */
  onStop?: (processId?: string) => void;
}) {
  /** The process a confirmation is open for, or 'all', or nothing. */
  const [confirming, setConfirming] = useState<BackgroundProcess | 'all' | null>(null);
  const now = useNow(processes.length > 0);
  if (processes.length === 0) return null;

  const stop = (): void => {
    if (!confirming || !onStop) return;
    setConfirming(null);
    onStop(confirming === 'all' ? undefined : confirming.id);
  };

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
              {commandsRunning(processes.length)}
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
              aria-label="Stop everything still running"
              onClick={() => setConfirming('all')}
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground"
            >
              <SquareIcon className="size-3 fill-current" aria-hidden />
              {processes.length === 1 ? 'Stop' : 'Stop all'}
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
            {processes.map((process) => (
              <li key={process.id} className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate font-mono">{process.command}</span>
                {/* Since it started, not since it last said anything: a
                    command that has printed nothing for an hour is the one
                    this bar is for. */}
                {process.startedAt === null ? null : (
                  <span className="shrink-0 tabular-nums opacity-80">
                    {formatDuration(Math.max(now - process.startedAt, 0))}
                  </span>
                )}
                {onStop ? (
                  <button
                    type="button"
                    aria-label={`Stop ${process.command}`}
                    onClick={() => setConfirming(process)}
                    className="inline-flex shrink-0 items-center rounded-md px-1 py-0.5 hover:bg-accent hover:text-accent-foreground"
                  >
                    <SquareIcon className="size-2.5 fill-current" aria-hidden />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>

      {confirming && onStop ? (
        <ConfirmDialog
          title={confirming === 'all' && processes.length > 1 ? 'Stop everything?' : 'Stop this?'}
          description={
            confirming === 'all'
              ? 'Kills what this conversation is still running, and anything those commands started. Half-done work stays half-done, and nothing will report back.'
              : `Kills "${confirming.command}", and anything it started. Half-done work stays half-done, and nothing will report back.`
          }
          confirmLabel="Stop"
          danger
          onConfirm={stop}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
    </div>
  );
}
