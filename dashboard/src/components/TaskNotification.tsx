import { useCallback, useRef, useState } from 'react';
import type { DataMessagePartComponent } from '@assistant-ui/react';
import { ActivityIcon, CheckIcon, ChevronDownIcon, HandIcon, XIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useDisclosureLock } from '@/hooks/use-disclosure-lock';
import type { TaskNotification } from '../../../shared/task-notifications.ts';
import { formatUsage } from '@/lib/task-notifications';
import { cn } from '@/lib/utils';

/**
 * A background task reporting in, drawn where the block of XML it arrived as
 * would otherwise be.
 *
 * Quiet, at the size of the tool rows a working turn is otherwise made of: a
 * task reporting in is news about work going on elsewhere rather than a turn
 * of the conversation, and the thread reads better for not pretending
 * otherwise.
 */

/**
 * How long the body takes to fold, matching the tool rows either side of it.
 * Named twice, because the scroll lock needs the number and the animation
 * needs the utility.
 */
const ANIMATION_DURATION = 200;
const DURATION = 'duration-200 [--tw-duration:200ms]';

/** The icon and colour for each status the harness reports. */
const LOOK: Record<string, { Icon: typeof CheckIcon; tone: string }> = {
  completed: { Icon: CheckIcon, tone: 'text-ok' },
  failed: { Icon: XIcon, tone: 'text-danger' },
  killed: { Icon: XIcon, tone: 'text-muted-foreground' },
  blocked: { Icon: HandIcon, tone: 'text-warn' },
};

/**
 * A status with no icon of its own is a task that has not finished — which is
 * what a monitor's event is, and what an unknown status from a newer harness
 * is treated as.
 */
const RUNNING = { Icon: ActivityIcon, tone: 'text-muted-foreground' };

/** The icon says how the task ended, the summary says what happened. */
export const TaskNotificationPart: DataMessagePartComponent<TaskNotification> = ({ data }) => {
  const { Icon, tone } = (data.status ? LOOK[data.status] : undefined) ?? RUNNING;
  const usage = data.usage ? formatUsage(data.usage) : '';

  return (
    <div
      data-slot="boxes_task-notification"
      className="flex items-start gap-2 py-0.5 text-xs text-muted-foreground"
    >
      <Icon className={cn('mt-0.5 size-3.5 shrink-0', tone)} aria-hidden />
      <div className="min-w-0 flex-1">
        {data.body ? (
          <TaskBody summary={data.summary} body={data.body} finished={data.status !== undefined} />
        ) : (
          <p className="font-medium">{data.summary}</p>
        )}
        {usage ? <p className="mt-1 opacity-80">{usage}</p> : null}
      </div>
    </div>
  );
};

/**
 * The summary, and what the task said under it.
 *
 * A task still going has said the thing worth reading — a monitor exists to
 * report its event, and folding one away leaves a row that says a monitor
 * fired and not what it saw. A finished one has already been summarised by
 * the line above, and what is under it is its whole answer, which can be
 * pages. So the first opens and the second is a click.
 */
function TaskBody({
  summary,
  body,
  finished,
}: {
  summary: string;
  body: string;
  finished: boolean;
}) {
  const [open, setOpen] = useState(!finished);
  const ref = useRef<HTMLDivElement>(null);
  // The lock, minus the fight with a thread following its own output.
  const lockScroll = useDisclosureLock(ref, ANIMATION_DURATION);

  const onOpenChange = useCallback(
    (next: boolean) => {
      lockScroll();
      setOpen(next);
    },
    [lockScroll],
  );

  return (
    <Collapsible ref={ref} open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger
        className={cn(
          'group/trigger flex w-full items-start gap-2 text-start font-medium',
          'transition-colors hover:text-foreground',
        )}
      >
        <span className="min-w-0 flex-1">{summary}</span>
        <ChevronDownIcon
          className={cn(
            'mt-0.5 size-3 shrink-0 -rotate-90 transition-transform',
            'ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
            'group-data-open/trigger:rotate-0',
            DURATION,
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          'overflow-hidden ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none',
          'data-closed:animate-collapsible-up data-open:animate-collapsible-down',
          'data-closed:fill-mode-forwards',
          DURATION,
        )}
      >
        {/* Whatever the task wrote, as it wrote it: a monitor's line of
            counters is aligned and a subagent's answer holds its paragraphs,
            and neither is markdown anybody promised to render. */}
        <p className="mt-1 font-mono break-words whitespace-pre-wrap">{body}</p>
      </CollapsibleContent>
    </Collapsible>
  );
}
