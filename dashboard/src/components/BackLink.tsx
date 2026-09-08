import { ArrowLeft } from 'lucide-react';
import type { Up } from '@/hooks/use-up';

/**
 * The labelled back link above a stacked page.
 *
 * A page draws this twice — once in the state where it is still loading and
 * once in the state where it has its data — and the two used to disagree: one
 * a text arrow, the other the icon. Leaving is the one thing that works in
 * both states, so it should not move or change shape between them.
 *
 * A real anchor with a real href, so middle click and copy-link work, but the
 * ordinary click pops rather than pushes: see useUp for why nothing labelled
 * back is allowed to push.
 *
 * The back arrow inside a pane header is a different control; see
 * ThreadHeader.
 */
export function BackLink({ up, label }: { up: Up; label: string }) {
  return (
    <a
      href={up.href}
      onClick={up.onClick}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      {label}
    </a>
  );
}
