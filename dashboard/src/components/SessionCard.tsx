import { FileSearch, GitBranch, Info, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { SessionSummary, ThreadSummary } from '../../../shared/types.ts';
import { DOT, StatusBadge, type BadgeKind } from './StatusBadge';
import { Card } from '@/components/ui/card';
import { api } from '../api.ts';
import { STILL_RUNNING } from '@/lib/activity';
import { threadName } from '@/lib/threads';
import { refresh } from '../stores/sessions.ts';
import { cn } from '@/lib/utils';

/**
 * Builds the badges for a session: waiting approvals, a running turn, the
 * session's own state, and how many browsers are watching.
 *
 * The turn and approval counts are the session's, derived from every thread
 * it owns, so a box with one busy thread reads as busy. Which thread that is
 * is the rows' job, below.
 */
export function sessionBadges(s: SessionSummary): Array<{ kind: BadgeKind; label: string }> {
  const badges: Array<{ kind: BadgeKind; label: string }> = [];
  if (s.pendingCount > 0) {
    badges.push({
      kind: 'waiting',
      label: s.pendingCount === 1 ? 'waiting for approval' : `${s.pendingCount} approvals waiting`,
    });
  }
  // What the agent is doing, rather than whether a request is open upstream:
  // a prompt held open for a background subagent is not a running turn to
  // anybody reading this list. See lib/activity.ts.
  if (s.speaking) badges.push({ kind: 'turn', label: 'running turn' });
  if (s.backgroundBusy) badges.push({ kind: 'task', label: STILL_RUNNING });
  if (s.status === 'error') badges.push({ kind: 'error', label: 'error' });
  else if (s.dockerState === 'running') badges.push({ kind: 'running', label: 'up' });
  else badges.push({ kind: 'idle', label: s.status });
  if (s.attachedCount > 0) {
    badges.push({
      kind: 'idle',
      label: s.attachedCount === 1 ? '1 viewer' : `${s.attachedCount} viewers`,
    });
  }
  return badges;
}

/**
 * One session in the list, with its conversations under it. Tapping the card
 * opens whichever one is current; tapping a thread opens that one.
 *
 * The thread rows are plain links, because opening a thread is now a plain
 * navigation: the connection names its own thread, so nothing has to be
 * switched first. Opening one still makes it the session's default, but as a
 * fire-and-forget POST that neither blocks the navigation nor disturbs
 * anybody — no live connection is pinned to the default.
 *
 * Ops live behind the info corner, and the two sit side by side rather than
 * nested, because an anchor inside an anchor is invalid markup. Where the
 * details view goes back to is not something this link has to say: it goes
 * back, and the entry it goes back to is this list.
 */
export function SessionCard({ session }: { session: SessionSummary }) {
  const navigate = useNavigate();
  /** Held while a thread call is in flight, so a double tap cannot fork twice. */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Runs one thread call, then opens the thread it made. */
  async function open(work: () => Promise<ThreadSummary>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await work();
      // The card's own thread list comes from the poll, so a change made here
      // is visible on the way back rather than a reload later.
      void refresh();
      await navigate(`/sessions/${session.id}/threads/${created.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const current = session.threads.find((t) => t.id === session.currentThreadId);

  return (
    <Card className="relative gap-0 overflow-hidden py-0 transition-colors hover:border-ring">
      <Link
        to={`/sessions/${session.id}`}
        className="flex flex-col gap-1 px-4 pt-4 pb-3 no-underline"
      >
        <div className="flex items-baseline gap-2 pr-9">
          <span className="truncate font-medium">{session.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{session.id}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {sessionBadges(session).map((b) => (
            <StatusBadge key={b.label} kind={b.kind} label={b.label} />
          ))}
        </div>
      </Link>
      <Link
        to={`/sessions/${session.id}/info`}
        aria-label={`Details and controls for ${session.name}`}
        className="absolute top-3 right-3 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Info className="size-4" />
      </Link>

      <div className="flex flex-col border-t px-2 py-2">
        {session.threads.map((thread) => {
          const dot = threadDot(thread);
          return (
            <Link
              key={thread.id}
              to={`/sessions/${session.id}/threads/${thread.id}`}
              // Selecting is a side effect of opening, not a step before it:
              // the navigation does not wait for it, and nothing breaks if it
              // never lands.
              onClick={() => void api.selectThread(session.id, thread.id).catch(() => {})}
              aria-current={thread.id === session.currentThreadId ? 'true' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm no-underline hover:bg-accent',
                thread.id === session.currentThreadId ? 'font-medium' : 'text-muted-foreground',
              )}
            >
              {/* Which thread this is is said by the weight of the row and by
                  aria-current; the bullet is what it is doing. */}
              <span
                role="img"
                aria-label={dot.label}
                title={dot.label}
                className={cn('size-1.5 shrink-0 rounded-full', DOT[dot.kind])}
              />
              <span className="truncate">{threadName(thread)}</span>
              {/* With two threads live this is where a question and a running
                  turn are named, rather than only coloured. */}
              {threadBadges(thread).map((b) => (
                <StatusBadge key={b.label} kind={b.kind} label={b.label} />
              ))}
            </Link>
          );
        })}

        <div className="flex gap-1 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => void open(() => api.createThread(session.id))}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
          >
            <Plus className="size-3.5" />
            New thread
          </button>
          {/* Reviewing works whether or not the box is running: the files are
              a directory the orchestrator reads, so a stopped session — the
              natural moment, once the agent is done — needs no start. */}
          <Link
            to={`/sessions/${session.id}/review`}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground"
          >
            <FileSearch className="size-3.5" />
            Review
          </Link>
          {/* Forking needs a thread to fork and an adapter that advertised the
              capability, which is unstable in the ACP schema and may be
              absent. */}
          {session.canFork && current ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void open(() => api.createThread(session.id, { from: current.id }))}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
            >
              <GitBranch className="size-3.5" />
              Fork
            </button>
          ) : null}
        </div>

        {error ? (
          <div className="px-2 pt-1 text-xs text-danger" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * The bullet on a thread's row: what that conversation is doing, in one dot.
 *
 * It said which thread was the session's default until now — green for the
 * current one, grey for the rest — which the row already says twice, in its
 * weight and in `aria-current`, and which spent the colour that means "the
 * container is up" on something that is not a state a thread can be in. Being
 * up is a precondition of every one of these.
 *
 * The order is what outranks what, and it is the reader's order rather than
 * the machine's: a question stops everything, talking is the next most
 * interesting, and work still running is the quiet one worth seeing — it is
 * the thread holding the box awake. Labelled as well as coloured, because a
 * dot with no label is nothing at all to a screen reader.
 */
export function threadDot(thread: ThreadSummary): { kind: BadgeKind; label: string } {
  if (thread.pendingCount > 0) return { kind: 'waiting', label: 'waiting for approval' };
  if (thread.speaking) return { kind: 'turn', label: 'running a turn' };
  if (thread.backgroundBusy) return { kind: 'task', label: 'something still running' };
  return { kind: 'idle', label: 'idle' };
}

/**
 * What one thread is doing, if anything: a turn running on it, and a question
 * waiting on it.
 *
 * A quiet thread gets nothing. Its row already carries its name and whether
 * it is the session's default, and a badge on every row would say only that
 * threads exist.
 */
export function threadBadges(
  thread: ThreadSummary,
): Array<{ kind: BadgeKind; label: string }> {
  const badges: Array<{ kind: BadgeKind; label: string }> = [];
  if (thread.pendingCount > 0) {
    badges.push({
      kind: 'waiting',
      label:
        thread.pendingCount === 1
          ? 'waiting for approval'
          : `${thread.pendingCount} approvals waiting`,
    });
  }
  if (thread.speaking) badges.push({ kind: 'turn', label: 'running turn' });
  // Work still running gets no badge of its own: it is the quietest of the
  // three and the bullet already says it, in the same colour this would.
  return badges;
}
