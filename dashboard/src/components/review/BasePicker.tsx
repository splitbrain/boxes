import { GitCompareArrows } from 'lucide-react';
import { useState } from 'react';
import type { ReviewBase, ReviewRepo } from '../../../../shared/types.ts';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * Which revision the review is compared against.
 *
 * Without one, the diff is against each repository's own working tree: what
 * has not been committed yet. With one, it is against the merge base of that
 * revision and that repository's HEAD, so a whole branch's work reads as the
 * change — and commits made on the base branch after branching off do not.
 *
 * One expression for the whole workspace, resolved separately in every
 * repository it holds: `main` means main-in-each. A revision can name a branch
 * in one repository and nothing at all in the dependency checked out beside
 * it, so the picker says where it landed rather than pretending to a single
 * commit — and a revision that resolves nowhere is the only one refused.
 *
 * A popover with a free-text field rather than a list of branches: the
 * orchestrator does not enumerate refs, and "main" or "HEAD~3" is quicker to
 * type than a list is to scroll on a phone.
 */
export function BasePicker({
  base,
  repos,
  busy,
  onSet,
}: {
  base: ReviewBase;
  /** The workspace's repositories, each carrying where the revision landed. */
  repos: ReviewRepo[];
  busy: boolean;
  onSet: (rev: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rev, setRev] = useState(base.rev);

  const active = base.rev !== '';
  const landed = repos.filter((repo) => repo.baseCommit !== '');

  const submit = (): void => {
    const wanted = rev.trim();
    if (wanted === '') return;
    setOpen(false);
    onSet(wanted);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Re-seeded on open rather than kept: the field should show what is
        // active, not what was last typed and abandoned.
        if (next) setRev(base.rev);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={active ? 'outline' : 'ghost'}
          size="sm"
          className="shrink-0 gap-1.5"
          disabled={busy}
          title={
            active
              ? `Comparing against ${base.rev}${whereLanded(landed.length, repos.length)}`
              : 'Comparing against the working tree'
          }
        >
          <GitCompareArrows className="size-3.5" />
          {/* The status line says which base is active, the way the desktop
              tool's does. On a narrow header the icon alone carries it. */}
          <span className="hidden max-w-24 truncate sm:inline">
            {active ? base.rev : 'HEAD'}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Compare against a branch, tag or commit. The merge base with HEAD is used, so work
            done on the base branch since is not counted as a change here.
          </p>
          <input
            value={rev}
            onChange={(event) => setRev(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="main, v1.2.0, HEAD~3…"
            aria-label="Base revision"
            spellCheck={false}
            autoCapitalize="off"
            className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || rev.trim() === ''}
              onClick={submit}
            >
              Compare
            </Button>
            {active ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  onSet(null);
                }}
              >
                Back to HEAD
              </Button>
            ) : null}
          </div>
          {active ? (
            <ul className="flex list-none flex-col gap-0.5 font-mono text-xs text-muted-foreground">
              {repos.map((repo) => (
                <li key={repo.path} className="flex items-baseline justify-between gap-2">
                  <span className="truncate">{repo.name}</span>
                  {/* A repository the revision names nothing in is compared
                      against its own working tree rather than failing the
                      whole request, so it says so instead of a commit. */}
                  <span className={repo.baseCommit === '' ? 'text-warn' : undefined}>
                    {repo.baseCommit === '' ? 'working tree' : repo.baseCommit.slice(0, 8)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** " in 2 of 3 repositories", or nothing at all when there is only one. */
function whereLanded(landed: number, total: number): string {
  if (total <= 1) return '';
  return `, in ${landed} of ${total} repositories`;
}
