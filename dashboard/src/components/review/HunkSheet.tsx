import type { ReviewDiffHunk } from '../../../../shared/types.ts';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

/**
 * One diff hunk, as its own surface.
 *
 * The desktop tool shows this in a tooltip on gutter hover. There is no hover
 * on a phone and a tooltip cannot be scrolled, so the same content becomes a
 * bottom sheet a gutter tap opens — which is also where the deleted lines
 * live, since the file itself cannot show them.
 *
 * The diff text comes from the workspace and is rendered as text nodes only.
 *
 * Long lines wrap, like the pane's do: a sheet is the narrowest surface in the
 * tool, and a hunk whose ends are off to the right is not showing the change.
 * The continuation of a wrapped line is indented past the +/− column, so the
 * marker that opens a line stays the only thing in it.
 */
export function HunkSheet({
  hunk,
  onClose,
}: {
  /** The hunk to show, or null when the sheet is closed. */
  hunk: ReviewDiffHunk | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={hunk !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent side="bottom" className="max-h-[70vh] gap-0">
        <SheetHeader className="pb-2">
          <SheetTitle className="text-sm">
            {hunk ? `Lines ${hunk.startLine}–${hunk.endLine}` : 'Changes'}
          </SheetTitle>
          <SheetDescription className="text-xs">
            What changed here, as git reports it.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 overflow-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <div className="min-w-full font-mono text-[13px] leading-[1.5]">
            {(hunk?.diff ?? '').split('\n').map((line, i) =>
              // A trailing empty line is the terminator, not a diff line.
              i === (hunk?.diff ?? '').split('\n').length - 1 && line === '' ? null : (
                <div
                  key={i}
                  className={cn(
                    '-indent-3 pr-1 pl-4 break-words whitespace-pre-wrap',
                    line.startsWith('+') && 'bg-ok/12 text-ok',
                    line.startsWith('-') && 'bg-danger/12 text-danger',
                    line.startsWith('\\') && 'text-muted-foreground',
                  )}
                >
                  {line === '' ? '​' : line}
                </div>
              ),
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
