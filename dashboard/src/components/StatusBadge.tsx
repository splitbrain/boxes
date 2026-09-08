import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** What a badge reports, which picks its colour. */
export type BadgeKind = 'running' | 'turn' | 'task' | 'waiting' | 'error' | 'idle';

/**
 * The dot colour for each kind; the label itself stays plain.
 *
 * Exported because the dot is also worn on its own, as the bullet of a thread
 * row, where there is no room for a label and the colour is the whole of what
 * is said. One table, so the two cannot come to disagree about what amber is.
 */
export const DOT: Record<BadgeKind, string> = {
  running: 'bg-ok',
  turn: 'bg-primary animate-pulse',
  // Work going on with nobody talking about it: the turn's colour, and still,
  // because the thread itself is not saying anything.
  task: 'bg-primary/60',
  waiting: 'bg-warn animate-pulse',
  error: 'bg-danger',
  idle: 'bg-idle',
};

/** A coloured dot with a label. */
export function StatusBadge({ kind, label }: { kind: BadgeKind; label: string }) {
  return (
    <Badge variant="outline" className="gap-1.5 py-1 font-normal">
      <span className={cn('size-1.5 rounded-full', DOT[kind])} />
      {label}
    </Badge>
  );
}
