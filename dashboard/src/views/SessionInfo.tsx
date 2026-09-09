import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import type { SessionDetail } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { BackLink } from '@/components/BackLink';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CopyField } from '@/components/CopyField';
import { Notice } from '@/components/Notice';
import { sessionBadges } from '@/components/SessionCard';
import { StatusBadge } from '@/components/StatusBadge';
import { useUp } from '@/hooks/use-up';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { pollWhileVisible } from '@/lib/poll';
import { shortSize } from '@/lib/rough';
import { wsUrlFor } from '@/lib/ws-url';
import { refresh } from '../stores/sessions.ts';

/** How often the detail view re-reads the session, while its tab is visible. */
const POLL_MS = 5000;

/** One field of the details grid. */
function Meta({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-mono text-xs">{value}</dd>
    </>
  );
}

/**
 * What a session is made of and what can be done to it. The conversation
 * lives at /sessions/:id; this route is the ops side of the same session.
 *
 * Back goes where the visitor came from, by going back: the entry this view
 * was opened from is still on the stack, whether it was the list or a thread
 * that opened it, so there is nothing to remember and nothing to get wrong.
 * The view used to be told which of the two had sent it and then push that
 * one — which is how a back control ends up pointing the same way as the
 * browser's own.
 *
 * The thread named in the entry's state is the fallback for the case where
 * there is nothing to pop: a pasted link, a notification, a shortcut on a
 * home screen. It has to be the exact thread that was open, because a session
 * has several and whichever one is current is not the one being read.
 */
export function SessionInfo() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const from = useLocation().state as { threadId?: string } | null;
  const up = useUp(
    from?.threadId ? `/sessions/${id}/threads/${from.threadId}` : `/sessions/${id}`,
  );

  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setSession(await api.getSession(id));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
    return pollWhileVisible(() => void load(), POLL_MS);
  }, [load]);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Deletes the session and leaves for the list. Not through act, which
   * reloads the session it just acted on: there is nothing left to reload,
   * and asking for it again would only answer 404.
   */
  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteSession(id);
      await refresh();
      // The list takes this entry's place rather than sitting on top of it:
      // the view that acted is gone with what it acted on, and one back press
      // out of a list is not a press back into a session that no longer
      // exists. Entries further down may still name it — history belongs to
      // the browser — and those land on the page that says so.
      void navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (!session) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink up={up} label="Back" />
        {error ? (
          <Notice className="rounded-md border px-3 py-2">{error}</Notice>
        ) : (
          <div className="text-sm text-muted-foreground">Loading…</div>
        )}
      </div>
    );
  }

  const running = session.dockerState === 'running';

  return (
    <div className="flex flex-col gap-4">
      <BackLink up={up} label="Back" />

      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">{session.name}</h1>
        <div className="flex flex-wrap gap-1.5">
          {sessionBadges(session).map((b) => (
            <StatusBadge key={b.label} kind={b.kind} label={b.label} />
          ))}
        </div>
      </div>

      {error ? (
        <Notice className="rounded-md border px-3 py-2">{error}</Notice>
      ) : null}

      {running && !session.proxyAttached ? (
        <Notice tone="warn" className="rounded-md border px-3 py-2">
          The egress proxy is not attached to this session&apos;s network — the agent has no
          internet access until the reconcile loop reattaches it.
        </Notice>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2">
            <Meta label="Session" value={session.id} />
            <Meta label="ACP thread" value={session.acpSessionId ?? 'not started'} />
            <Meta
              label="Container"
              value={session.containerId ? session.containerId.slice(0, 12) : '—'}
            />
            <Meta label="Network" value={`${session.networkName} (${session.subnet})`} />
            {/* Which agent set this box was created with. The global one is
                applied on top of it either way, so "global only" is the
                truthful reading of no set rather than "none". */}
            <Meta label="Agent set" value={session.agentSetName ?? 'global only'} />
            <Meta label="Last active" value={new Date(session.lastActiveAt).toLocaleString()} />
            {/* What the card shows in one word, with the reason it can be
                absent said out loud: a session still on a named volume has no
                directory for the orchestrator to measure. */}
            <Meta
              label="Workspace"
              value={
                session.workspaceBytes === null
                  ? 'not measured'
                  : `${shortSize(session.workspaceBytes)} on disk`
              }
            />
          </dl>
        </CardContent>
      </Card>

      {/* The dashboard needs none of this — it derives both from the page and
          the session list. It is here for an external ACP client. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Connect an external ACP client</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Any ACP client that speaks JSON-RPC over a WebSocket can attach to this session.
            The token travels as a <code className="font-mono">bearer.&lt;token&gt;</code>{' '}
            subprotocol entry, because a browser cannot set headers on a WebSocket.
          </p>
          <CopyField label="WebSocket URL" value={wsUrlFor(session.id)} />
          <CopyField label="Bearer token" value={session.wsToken} masked />
        </CardContent>
      </Card>

      <div className="flex gap-2">
        {running ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => api.stopSession(id))}
          >
            Stop
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => api.startSession(id))}
          >
            Start
          </Button>
        )}
        <Button
          type="button"
          variant="destructive"
          disabled={busy}
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </Button>
      </div>

      {confirmDelete ? (
        <ConfirmDialog
          title={`Delete ${session.name}?`}
          description="The container, the network, the workspace directory and the home volume are removed, so the files and the thread history go with them."
          confirmLabel="Delete"
          danger
          busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void remove()}
        />
      ) : null}
    </div>
  );
}
