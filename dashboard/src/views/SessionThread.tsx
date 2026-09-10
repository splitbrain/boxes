import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
} from '@assistant-ui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { SessionDetail, ThreadSummary } from '../../../shared/types.ts';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { BackgroundBar } from '@/components/BackgroundBar';
import { Notice } from '@/components/Notice';
import { SlashCommandsProvider } from '@/components/SlashCommands';
import { TokenWarning } from '@/components/TokenWarning';
import { TooltipProvider } from '@/components/ui/tooltip';
import { api } from '../api.ts';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useUp } from '@/hooks/use-up';
import { takeStagedPrompt } from '@/lib/staged-prompt';
import { threadTitle, type TabState } from '@/lib/tab-title';
import { useSessions } from '../stores/sessions.ts';
import { createAttachmentAdapter } from '../stores/thread/attachments.ts';
import type { ContentBlock } from '../stores/thread/acp-types.ts';
import { convertMessage } from '../stores/thread/convert.ts';
import { bangCommand } from '../stores/thread/exec.ts';
import type { Message } from '../stores/thread/translate.ts';
import { useThread } from '../stores/thread/use-thread.ts';
import { threadName } from '@/lib/threads';
import { buildEnvelope, formatBytes, type AttachmentEntry } from '@/lib/attachments';
import { Shelf } from '@/components/Shelf';
import { ThreadLoading } from '@/components/ThreadLoading';
import { ThreadHeader } from '@/components/ThreadHeader';
import { useScrollAway } from '@/hooks/use-scroll-away';
import { useViewportLock } from '@/hooks/use-viewport-lock';

/** The prose of a composer submission, without its attachments. */
function textOf(message: AppendMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

/**
 * One composer submission as the content blocks of an ACP prompt.
 *
 * The note saying what was attached comes first, then what the user typed:
 * context, then the question about it. Nothing carries a file — attachments
 * arrive already uploaded, and what the prompt holds is where they went. See
 * stores/thread/attachments.ts.
 */
function blocksOf(message: AppendMessage): ContentBlock[] {
  const entries: AttachmentEntry[] = [];

  for (const attachment of message.attachments ?? []) {
    for (const part of attachment.content ?? []) {
      if (part.type !== 'file') continue;
      entries.push({
        path: part.data,
        name: part.filename ?? attachment.name,
        mimeType: part.mimeType,
        size: formatBytes(attachment.file?.size ?? 0),
      });
    }
  }

  const text = textOf(message);
  return [
    ...(entries.length > 0 ? [{ type: 'text' as const, text: buildEnvelope(entries) }] : []),
    ...(text ? [{ type: 'text' as const, text }] : []),
  ];
}

/**
 * One of a session's conversations, inside the dashboard.
 *
 * The browser speaks plain ACP to the gateway; the store turns the adapter's
 * session/update notifications into messages and this route mounts them into
 * the installed assistant-ui components.
 *
 * Two routes land here: `/sessions/:id/threads/:threadId` is that thread, and
 * `/sessions/:id` is whichever one the session has current. The thread is
 * part of the connection's own URL, so two tabs on two threads of one box
 * each get their own conversation and neither sees the other's stream.
 */
export function SessionThread() {
  const { id = '', threadId } = useParams();
  /**
   * Text the review view staged in the composer on its way here — "read
   * REVIEW.md and address the comments in it". Staged, never sent: what to do
   * with a review is the reviewer's call, and a prompt that fires itself on
   * navigation is a prompt nobody agreed to.
   *
   * Taken from beside the router rather than out of the history entry's
   * state, which the browser replays: back and then forward used to re-stage
   * it, and a turn nobody typed would reappear in the composer.
   */
  const [prefill, setPrefill] = useState<string | null>(null);
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The thread a fork just made, revealed as a link rather than opened. */
  const [forked, setForked] = useState<ThreadSummary | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);
  const [forking, setForking] = useState(false);
  const { claudeTokenConfigured } = useSessions();

  // The WS token comes from the session API, behind the deployment's auth.
  useEffect(() => {
    let live = true;
    api
      .getSession(id)
      .then((s) => live && setSession(s))
      .catch((err: Error) => live && setLoadError(err.message));
    return () => {
      live = false;
    };
  }, [id]);

  // On arrival, and once: taking it clears it, and the guard is what makes a
  // second run — React mounting effects twice in development — harmless.
  useEffect(() => {
    const staged = takeStagedPrompt(id);
    if (staged !== null) setPrefill(staged);
  }, [id]);

  /** The way out of the thread: the session list, popped rather than pushed. */
  const up = useUp('/');

  const { store, state } = useThread(id, threadId ?? null, session?.wsToken ?? null);

  // Which of the session's conversations this is, named always rather than
  // only when there is more than one: two tabs on one session are otherwise
  // indistinguishable, which is the whole point of a thread in the URL.
  const threads = session?.threads ?? [];
  const thread = threads.find((t) => t.id === (threadId ?? session?.currentThreadId));
  const threadLabel = thread ? threadName(thread) : null;

  /**
   * What this tab is doing, for its title.
   *
   * A question outranks a running turn because it is the one that stopped:
   * the two cannot both be true anyway — a thread waiting on an answer is not
   * running, which is the whole point of the request. Below those, a thread
   * that has stopped talking with work still running in it is its own state:
   * it is your turn, and it is not over.
   */
  const tabState: TabState =
    state.awaiting ??
    (state.isRunning ? 'running' : state.background.length > 0 ? 'waiting' : 'idle');
  useDocumentTitle(threadTitle(tabState, session?.name ?? id, threadLabel));

  // The thread's viewport is the only scroller this route has; the document
  // scrolling too is what used to take the header off the top of the screen.
  useViewportLock();

  // And now that the document cannot move it, reading down through the thread
  // can: the header steps aside on a downward run and comes back on the first
  // upward one. A turn's own output moves nothing, because the viewport stays
  // against its bottom for the whole of one.
  const { away, container } = useScrollAway('[data-slot="aui_thread-viewport"]');

  /**
   * Branches this conversation and reveals the result as a link.
   *
   * A `window.open` after the await is the thing to reach for, and it is what
   * popup blockers exist to stop. One extra tap is cheaper than an unreliable
   * one — and this thread stays exactly where it is either way, because no
   * connection is pinned to the session's default any more.
   */
  const onFork = useCallback(() => {
    if (!thread || forking) return;
    setForking(true);
    setForked(null);
    setForkError(null);
    api
      .createThread(id, { from: thread.id })
      .then(setForked)
      // Reported where the action was, rather than in the bar that means the
      // session itself could not be read.
      .catch((err: Error) => setForkError(err.message))
      .finally(() => setForking(false));
  }, [id, thread, forking]);

  /**
   * Marks this conversation done, or takes the mark off again.
   *
   * The answer is the row as the orchestrator now has it, and only the mark
   * is taken from it: the rest of the summary was read once on arrival and
   * whatever it says about a running turn is older than this browser's own
   * view of one.
   */
  const onSetDone = useCallback(
    (next: boolean) => {
      if (!thread) return;
      api
        .setThreadDone(id, thread.id, next)
        .then((updated) =>
          setSession((current) =>
            current === null
              ? current
              : {
                  ...current,
                  threads: current.threads.map((t) =>
                    t.id === updated.id ? { ...t, done: updated.done } : t,
                  ),
                },
          ),
        )
        // Nothing was marked, so nothing is drawn as marked. It goes where the
        // rest of this thread's trouble goes.
        .catch((err: Error) => store?.reportError(err.message));
    },
    [id, thread, store],
  );

  /**
   * Kills what this conversation left running: one command, or all of them.
   *
   * Nothing is done here with the answer, and the bar is not touched. What it
   * shows is the gateway's own reading of the box, and the row goes away when
   * a reading says the process has — a couple of seconds later, once what was
   * signalled has had time to be gone. Guessing here would be this browser
   * inventing an ending for work it cannot see.
   *
   * A stop that found nothing left to kill is not a failure either: the work
   * ended between the reading and the tap. A stop that could not be *made* is,
   * and it goes where the rest of this thread's trouble goes.
   */
  const stopBackground = useCallback(
    async (forThread: string, processId?: string): Promise<void> => {
      try {
        await api.stopBackgroundWork(id, forThread, processId);
      } catch (err) {
        store?.reportError((err as Error).message);
      }
    },
    [id, store],
  );

  // Commands already run in this session, appended once the thread is up.
  // ACP replay carries no timestamps, so they go after the transcript rather
  // than interleaved into it.
  useEffect(() => {
    if (!store || state.connection !== 'ready') return;
    void store.loadExecHistory();
  }, [store, state.connection]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      if (!store) return;
      const text = textOf(message);
      const attachments = message.attachments ?? [];
      // A !bang line is intercepted here and never reaches the adapter, so
      // it costs no tokens and cannot be read as an instruction. It runs a
      // command rather than saying anything, so an attachment on one has
      // nothing to attach to and the line is sent as the prompt it looks
      // like instead.
      const command = attachments.length === 0 ? bangCommand(text) : null;
      if (command) {
        await store.runCommand(command);
        return;
      }
      await store.send(blocksOf(message));
    },
    [store],
  );

  /**
   * The composer's attachment adapter, which uploads into this session's
   * workspace. Rebuilt with the store so a failed upload has somewhere to
   * report to; the composer holds the attachments themselves, so nothing is
   * lost when it is.
   */
  const attachmentAdapter = useMemo(
    () => createAttachmentAdapter(id, (message) => store?.reportError(message)),
    [id, store],
  );

  // Bound to the session because an attachment is fetched back from it: the
  // thread's own pictures are served from its workspace, not carried in the
  // transcript.
  const convert = useCallback((message: Message) => convertMessage(message, id), [id]);

  const runtime = useExternalStoreRuntime<Message>({
    messages: state.messages as Message[],
    convertMessage: convert,
    isRunning: state.isRunning,
    isSendDisabled: !store || state.connection !== 'ready',
    onNew,
    onCancel: async () => store?.cancel(),
    onRefetchThread: async () => store?.refetch(),
    adapters: { attachments: attachmentAdapter },
    onRespondToToolApproval: ({ approvalId, approved, optionId }) => {
      // A decision with no option id is a plain refusal to choose; the store
      // turns that into ACP's cancelled outcome.
      store?.respondToApproval(approvalId, approved || optionId ? optionId : undefined);
    },
  });

  // Once, on arrival. Not in a dependency on the runtime, which is rebuilt on
  // every message: that would keep overwriting whatever is being typed.
  const staged = useRef(false);
  useEffect(() => {
    if (!prefill || staged.current) return;
    staged.current = true;
    runtime.thread.composer.setText(prefill);
  }, [prefill, runtime]);

  return (
    <TooltipProvider>
      <AssistantRuntimeProvider runtime={runtime}>
        <SlashCommandsProvider commands={state.commands}>
          <div ref={container} className="flex h-dvh flex-col">
            {/* The header is the part that gives way. The notices below it are
                not: a missing token, a fork to open, an error to read are all
                things to act on, and none of them is in the way of anything. */}
            <Shelf away={away}>
              <ThreadHeader
                sessionId={id}
                threadId={thread?.id ?? null}
                up={up}
                name={session?.name ?? id}
                threadLabel={threadLabel}
                // Nothing is connecting while the session itself could not be
                // read, and a dot that pulses forever says the opposite.
                connection={loadError ? 'closed' : state.connection}
                modes={state.modes}
                configOptions={state.configOptions}
                done={thread?.done === true}
                canFork={session?.canFork === true && thread !== undefined}
                forking={forking}
                onFork={onFork}
                // Nothing to mark until the session has been read and said
                // which of its threads this is; the header drops the button
                // rather than offering one that marks nothing.
                onSetDone={thread ? onSetDone : undefined}
                onSetMode={(modeId) => void store?.setMode(modeId)}
                onSetConfigOption={(configId, value) =>
                  void store?.setConfigOption(configId, value)
                }
              />
            </Shelf>
            {claudeTokenConfigured ? null : <TokenWarning className="border-b px-4 py-2" />}
            {forked ? (
              <div className="flex flex-wrap items-center gap-2 border-b bg-muted px-4 py-2 text-sm">
                {/* It opens on this conversation: the gateway replays what
                    was said here into it until it has said something of its
                    own. What it carries and what it shows are the same thing,
                    so there is nothing to warn about. */}
                <span>
                  {threadName(forked)} branched from this conversation. It opens on everything
                  said here so far and goes its own way from there.
                </span>
                {/* A real click on a real link, so the browser opens the tab
                    rather than a script asking it to. */}
                <Link
                  to={`/sessions/${id}/threads/${forked.id}`}
                  target="_blank"
                  rel="noopener"
                  className="font-medium underline"
                >
                  Open it in a new tab
                </Link>
                <button
                  type="button"
                  onClick={() => setForked(null)}
                  className="ml-auto text-xs text-muted-foreground hover:underline"
                >
                  Dismiss
                </button>
              </div>
            ) : null}
            {forkError ? (
              <Notice className="border-b px-4 py-2">
                Could not fork this thread: {forkError}
              </Notice>
            ) : null}
            {state.error ? (
              <Notice className="border-b px-4 py-2">{state.error}</Notice>
            ) : null}
            <div className="min-h-0 flex-1">
              {/* A session that could not be read has no token, so nothing can
                  connect and nothing can be sent. A composer over an empty
                  greeting would say otherwise — which is exactly what a
                  bookmark for a deleted box lands on. */}
              {loadError ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                  <p className="text-sm">{loadError}</p>
                  <p className="text-sm text-muted-foreground">
                    It may have been deleted. Nothing can be sent to it from here.
                  </p>
                  {/* The same step out as the header's, so a session that
                      turned out to be gone is left the same way any other is:
                      whatever sent the visitor here, not a list pushed over
                      it. */}
                  <a href={up.href} onClick={up.onClick} className="text-sm font-medium underline">
                    Back to sessions
                  </a>
                </div>
              ) : state.loading ? (
                // Nothing to type into and nothing to read yet: the box may
                // still be starting, and the conversation arrives in one
                // piece when it has been read. See ThreadLoading.
                <ThreadLoading />
              ) : (
                <Thread
                  aboveComposer={
                    <BackgroundBar
                      processes={state.background}
                      // Nothing to stop with until there is a thread to name;
                      // the bar drops the button rather than offering one
                      // that does nothing.
                      onStop={
                        thread
                          ? (processId) => void stopBackground(thread.id, processId)
                          : undefined
                      }
                    />
                  }
                />
              )}
            </div>
          </div>
        </SlashCommandsProvider>
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}
