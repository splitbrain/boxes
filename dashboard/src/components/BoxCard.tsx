import { FileSearch, HardDrive, Info, Plus, Square, SquareTerminal } from 'lucide-react';
import { type PointerEvent, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { BoxWorkList } from '@/components/BoxWorkList';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { NewThreadDialog } from '@/components/NewThreadDialog';
import { Card } from '@/components/ui/card';
import { JOBS, jobsLabel } from '@/lib/activity';
import { harnessLabel } from '@/lib/harness';
import { shortAge, shortSize } from '@/lib/rough';
import { threadName } from '@/lib/threads';
import { cn } from '@/lib/utils';
import type { BoxSummary, BoxWork, ThreadSummary } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { refresh, useBoxes } from '../stores/boxes.ts';
import { type BadgeKind, DOT, StatusBadge } from './StatusBadge';

/** The time in milliseconds that a touch must stay on a thread row to toggle its done mark. */
const LONG_PRESS_MS = 500;

/** The time in milliseconds after its last activity that a thread marked done moves into the folded list. */
const DONE_FOLD_MS = 7 * 86_400_000;

/**
 * A count with the thing it counts: "1 approval", "3 approvals".
 *
 * @param count The number of things.
 * @param noun The singular noun, which an "s" turns into the plural.
 * @returns The label.
 */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * True while the agent works on a thread or waits for an approval.
 *
 * @param thread The thread.
 * @returns True when the thread works.
 */
function working(thread: ThreadSummary): boolean {
  return thread.turnActive || thread.speaking || thread.backgroundBusy || thread.pendingCount > 0;
}

/**
 * Compares two threads for the list order: idle threads by last activity, oldest first, then the threads that work.
 *
 * The threads that work keep their creation order, because each update from the agent changes their last activity.
 *
 * @param a The first thread.
 * @param b The second thread.
 * @returns A negative number when a comes first, a positive number when b comes first.
 */
function byAge(a: ThreadSummary, b: ThreadSummary): number {
  if (working(a) !== working(b)) return working(a) ? 1 : -1;
  if (working(a)) return a.ordinal - b.ordinal;
  return a.lastActiveAt - b.lastActiveAt || a.ordinal - b.ordinal;
}

/**
 * Builds the status badges for a box.
 *
 * The turn, task and approval badges cover every thread of the box, so one
 * busy thread makes the box show as busy.
 *
 * @param s The box.
 * @returns The badges in display order.
 */
export function boxBadges(s: BoxSummary): Array<{ kind: BadgeKind; label: string }> {
  const badges: Array<{ kind: BadgeKind; label: string }> = [];
  if (s.pendingCount > 0) {
    badges.push({ kind: 'waiting', label: counted(s.pendingCount, 'approval') });
  }
  // Uses `speaking`, because a prompt that stays open for a background subagent
  // does not mean that the agent thinks.
  if (s.speaking) badges.push({ kind: 'turn', label: 'thinking' });
  if (s.backgroundBusy) badges.push({ kind: 'task', label: jobsLabel(s.backgroundCount) });
  if (s.tunnels.length > 0) {
    badges.push({ kind: 'shared', label: counted(s.tunnels.length, 'tunnel') });
  }
  if (s.status === 'error') badges.push({ kind: 'error', label: 'error' });
  else if (s.runtimeState === 'running') badges.push({ kind: 'running', label: 'up' });
  else badges.push({ kind: 'idle', label: s.status });
  if (s.attachedCount > 0) {
    badges.push({ kind: 'idle', label: counted(s.attachedCount, 'viewer') });
  }
  return badges;
}

/**
 * Card for one box in the list, with a row per thread.
 *
 * A row opens its thread. A right click or a long press on a row toggles the
 * done mark of the thread. The card itself opens nothing. The info corner
 * leads to the details and controls of the box.
 *
 * @param box The box.
 */
export function BoxCard({ box }: { box: BoxSummary }) {
  const navigate = useNavigate();
  /** True while a thread call or a stop is in flight, so a double tap cannot start two. */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** True while the new-thread dialog is open. */
  const [starting, setStarting] = useState(false);
  /** True while the stop of all work in the box waits for confirmation. */
  const [stopping, setStopping] = useState(false);
  /**
   * The processes in the box for the stop confirmation, 'reading' while the
   * request runs, or 'unreadable' after it failed.
   */
  const [boxWork, setBoxWork] = useState<BoxWork[] | 'reading' | 'unreadable'>('reading');
  // The harness labels come from the health probe that the list already polls.
  const { harnesses } = useBoxes();
  /**
   * The current touch on a thread row. `timer` is its long press timer, and `fired` is
   * true after the press toggled the done mark.
   */
  const press = useRef<{ timer: number; fired: boolean } | null>(null);

  /**
   * Runs one thread call and opens the thread it made.
   *
   * @param work The call that creates the thread.
   * @param replace True to replace the current history entry, false to push an entry. The
   *   dialog uses it, so the thread takes the entry the open dialog pushed.
   *   Otherwise back from the new thread would land on the list twice.
   * @returns True when the thread opened, so a caller knows if it must close its dialog.
   */
  async function open(work: () => Promise<ThreadSummary>, replace = false): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const created = await work();
      // The card's thread list comes from the poll, so this refresh shows the
      // new thread on the way back.
      void refresh();
      await navigate(`/boxes/${box.id}/threads/${created.id}`, { replace });
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Toggles the done mark of a thread and refreshes the box list.
   *
   * @param thread The thread.
   */
  async function toggleDone(thread: ThreadSummary): Promise<void> {
    setError(null);
    try {
      await api.setThreadDone(box.id, thread.id, !thread.done);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * Toggles the done mark once per press.
   *
   * A long press on Android sends a context menu event and also runs out the timer.
   *
   * @param thread The thread of the pressed row.
   */
  function pressMark(thread: ThreadSummary): void {
    const current = press.current;
    if (current) {
      if (current.fired) return;
      current.fired = true;
      window.clearTimeout(current.timer);
    }
    void toggleDone(thread);
  }

  /**
   * Starts the long press timer for a touch on a thread row.
   *
   * iOS sends no context menu event for a long press, so the timer toggles the mark.
   *
   * @param event The pointer event.
   * @param thread The thread of the row.
   */
  function pressStart(event: PointerEvent, thread: ThreadSummary): void {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
    if (event.pointerType !== 'touch') return;
    press.current = {
      fired: false,
      timer: window.setTimeout(() => pressMark(thread), LONG_PRESS_MS),
    };
  }

  /** Stops the long press timer when the touch ends or the page scrolls. */
  function pressEnd(): void {
    if (press.current) window.clearTimeout(press.current.timer);
  }

  /**
   * Opens the stop confirmation and reads the processes in the box.
   *
   * The box list does not contain the processes, so the function fetches the box detail.
   */
  async function askToStop(): Promise<void> {
    setBoxWork('reading');
    setStopping(true);
    try {
      setBoxWork((await api.getBox(box.id)).boxWork);
    } catch {
      // The dialog reports the failure, because the reader is looking at it.
      setBoxWork('unreadable');
    }
  }

  /**
   * Stops the work that the orchestrator finds in the box, then refreshes the
   * box list.
   *
   * The card shows the box as busy until a later reading finds none of the processes.
   */
  async function stopEverything(): Promise<void> {
    setStopping(false);
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.stopBoxWork(box.id);
      void refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * True when the box is busy with work that no thread claims.
   *
   * An adapter knows only the tasks it announced. After a respawn, only the
   * orchestrator's reading of the process table sees what the old adapter
   * left running.
   */
  const orphaned = box.backgroundBusy && !box.threads.some((t) => t.backgroundBusy);
  // Read at render. The list poll re-renders the card every five seconds,
  // which is often enough for ages in whole minutes.
  const now = Date.now();
  const threads = [...box.threads].sort(byAge);
  // Threads marked done that were not active for a while fold away above the others.
  const old = (t: ThreadSummary) => t.done && now - t.lastActiveAt > DONE_FOLD_MS;
  const folded = threads.filter(old);
  // A single folded thread would take the same space as the summary.
  const shown = folded.length > 1 ? threads.filter((t) => !old(t)) : threads;

  /**
   * Renders the row of one thread.
   *
   * @param thread The thread.
   * @returns The row, a link that opens the thread.
   */
  function threadRow(thread: ThreadSummary) {
    const dot = threadDot(thread);
    return (
      <Link
        key={thread.id}
        to={`/boxes/${box.id}/threads/${thread.id}`}
        onPointerDown={(e) => pressStart(e, thread)}
        onPointerUp={pressEnd}
        onPointerCancel={pressEnd}
        onContextMenu={(e) => {
          e.preventDefault();
          pressMark(thread);
        }}
        onClick={(e) => {
          // The release of a long press must not open the thread.
          if (press.current?.fired) e.preventDefault();
          press.current = null;
        }}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm no-underline select-none [-webkit-touch-callout:none] hover:bg-accent"
      >
        <span
          role="img"
          aria-label={dot.label}
          title={dot.label}
          className={cn('size-1.5 shrink-0 rounded-full', DOT[dot.kind])}
        />
        {/* A thread marked done is struck through. It still opens and runs. */}
        <span className={cn('min-w-0 flex-1 truncate', thread.done && 'line-through')}>
          {threadName(thread)}
        </span>
        {harnessLabel(harnesses, thread.harness) ? (
          <span className="shrink-0 text-xs opacity-70">
            {harnessLabel(harnesses, thread.harness)}
          </span>
        ) : null}
        <time
          dateTime={new Date(thread.lastActiveAt).toISOString()}
          title={`Last active ${new Date(thread.lastActiveAt).toLocaleString()}`}
          className="shrink-0 tabular-nums opacity-70"
        >
          {shortAge(now - thread.lastActiveAt)}
        </time>
      </Link>
    );
  }

  return (
    <Card className="relative gap-0 overflow-hidden py-0">
      <div className="flex flex-col gap-1 px-4 pt-4 pb-3">
        <div className="flex items-baseline gap-2 pr-9">
          <span className="truncate font-medium">{box.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{box.id}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {boxBadges(box).map((b) => (
            <StatusBadge key={b.label} kind={b.kind} label={b.label} />
          ))}
          {/* Disk use, shown as plain text because it is a measurement, not a state. */}
          {box.diskBytes === null ? null : (
            <span
              className="inline-flex items-center gap-1 text-xs text-muted-foreground"
              title={`Disk use of workspace, home and Nix store, measured ${new Date(box.diskMeasuredAt ?? 0).toLocaleString()}`}
            >
              <HardDrive className="size-3" aria-hidden />
              {shortSize(box.diskBytes)}
            </span>
          )}
        </div>
      </div>
      <Link
        to={`/boxes/${box.id}/info`}
        aria-label={`Details and controls for ${box.name}`}
        className="absolute top-3 right-3 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Info className="size-4" />
      </Link>

      <div className="flex flex-col border-t px-2 py-2">
        {folded.length > 1 ? (
          <details>
            <summary className="cursor-pointer rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent">
              {counted(folded.length, 'older done thread')}
            </summary>
            <div className="flex flex-col">{folded.map(threadRow)}</div>
          </details>
        ) : null}
        {shown.map(threadRow)}

        <div className="flex gap-1 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => setStarting(true)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
          >
            <Plus className="size-3.5" />
            New thread
          </button>
          {/* Shown for a stopped box too. The orchestrator starts the box when the review reads it. */}
          <Link
            to={`/boxes/${box.id}/review`}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground"
          >
            <FileSearch className="size-3.5" />
            Review
          </Link>
          <Link
            to={`/boxes/${box.id}/terminal`}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground"
          >
            <SquareTerminal className="size-3.5" />
            Terminal
          </Link>
          {/* A task that a thread claims is stopped from that thread's bar. */}
          {orphaned ? (
            <button
              type="button"
              disabled={busy}
              aria-label="Stop everything running in this box"
              onClick={() => void askToStop()}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
            >
              <Square className="size-3.5" />
              Stop everything
            </button>
          ) : null}
        </div>

        {error ? (
          <div className="px-2 pt-1 text-xs text-danger" role="alert">
            {error}
          </div>
        ) : null}

        {stopping ? (
          <ConfirmDialog
            title="Stop everything running in this box?"
            description={
              'Kills every command still running in it, except the agents, and anything ' +
              'those commands started. Half-done work stays half-done, and nothing will ' +
              'report back. The box itself keeps running.'
            }
            confirmLabel="Stop"
            danger
            busy={busy}
            onConfirm={() => void stopEverything()}
            onCancel={() => setStopping(false)}
          >
            {boxWork === 'reading' ? (
              <p className="text-xs text-muted-foreground">Reading what is running in it…</p>
            ) : boxWork === 'unreadable' ? (
              <p className="text-xs text-muted-foreground">
                What is running in it could not be read. Stopping signals whatever the orchestrator
                finds.
              </p>
            ) : boxWork.length === 0 ? (
              /* The badge is up to a poll old, so the work may have ended since. */
              <p className="text-xs text-muted-foreground">
                Nothing was running in it at the last reading.
              </p>
            ) : (
              <BoxWorkList work={boxWork} />
            )}
          </ConfirmDialog>
        ) : null}

        {starting ? (
          <NewThreadDialog
            busy={busy}
            onCancel={() => setStarting(false)}
            // Closes only on failure. Closing first would pop the dialog's
            // history entry after the navigation and undo it.
            onCreate={(options) =>
              open(() => api.createThread(box.id, options ? { options } : {}), true).then(
                (opened) => {
                  if (!opened) setStarting(false);
                  return opened;
                },
              )
            }
          />
        ) : null}
      </div>
    </Card>
  );
}

/**
 * Picks the status dot for a thread's row.
 *
 * The checks run in priority order: a waiting approval, then the agent
 * thinking, then background work.
 *
 * @param thread The thread.
 * @returns The dot's kind and its accessible label.
 */
function threadDot(thread: ThreadSummary): { kind: BadgeKind; label: string } {
  if (thread.pendingCount > 0) return { kind: 'waiting', label: 'approval' };
  if (thread.speaking) return { kind: 'turn', label: 'thinking' };
  if (thread.backgroundBusy) return { kind: 'task', label: JOBS };
  return { kind: 'idle', label: 'idle' };
}
