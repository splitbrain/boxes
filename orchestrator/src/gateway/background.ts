import { isTerminalStatus, parseTaskNotifications } from '../../../shared/task-notifications.ts';
import type { BackgroundTask } from '../../../shared/types.ts';

/**
 * The background work one session has started and not seen finish, so the
 * idle reaper does not stop a box with work going on inside it.
 *
 * A turn that leaves something running in the background ends like any other:
 * the agent says it will report back, the thread goes quiet, and — with the
 * browser closed — every test the reaper makes says the session is idle. Half
 * an hour later the container is stopped, and with it the build, the crawl or
 * the monitor watching them. Nothing says so afterwards: the thread's last
 * line is still the agent promising to report, and the report never comes.
 *
 * Two things already cover some of this and neither covers it all. A
 * background *subagent* holds its turn open — the adapter defers the prompt's
 * result until the subagents it spawned settle — so the session counts as
 * running a turn for as long as one is alive. And a task that keeps talking
 * keeps its box awake by talking: every adapter update marks the session
 * active. What is left is the quiet task: a command compiling for two hours,
 * or a monitor watching a log that says nothing.
 *
 * So this watches the same updates the browsers get, and holds the reaper off
 * while it believes something is still running. Held off, not disabled: an
 * entry expires after `maxAgeMs` whatever happens, because both ends of this
 * are the harness's own conventions rather than anything ACP promises, and a
 * missed ending must cost a box that stops later than it should rather than
 * one that never stops at all.
 *
 * It is also read by people now, which is why an entry is a list item rather
 * than a tick in a box: what the work is, which conversation started it, and
 * when. A thread that has gone quiet with a build still running in it looks
 * exactly like a finished one otherwise — see `activity.ts` for the other
 * half of that question and `BackgroundBar` for where the two are shown.
 *
 * The state is deliberately in memory. A background task is a child of the
 * adapter, the adapter is a docker exec this process owns, and both die with
 * it — so an orchestrator that has forgotten a task is an orchestrator whose
 * task is already gone.
 */

/** Claude Code tools that run in the background whatever their input says. */
const ALWAYS_BACKGROUND = new Set(['Monitor', 'Workflow']);

/** One live entry: what the call is, and when it was first seen. */
interface Entry extends BackgroundTask {
  /** The thread the call was made on, which is the one it reports back to. */
  acpThreadId: string;
}

export class BackgroundWork {
  /** Every live background call, by its tool call id. */
  private readonly live = new Map<string, Entry>();

  /**
   * @param maxAgeMs How long one entry may hold the reaper off.
   * @param now Present so a test can move time without waiting for it.
   */
  constructor(
    private readonly maxAgeMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Reads one `session/update` for what it says about background work.
   *
   * Two things say it, and both are Claude Code's rather than ACP's: a tool
   * call whose input asks for the background or whose tool is only ever run
   * there, and the notification the harness sends when a task is over. An
   * adapter that says neither leaves this empty, which is the behaviour Boxes
   * had before any of it.
   *
   * `acpThreadId` is the thread the update was about, so an entry belongs to
   * the conversation that started it: with two threads live, "something is
   * still running" has to say which of them it is running for.
   */
  observe(acpThreadId: string, update: unknown): void {
    if (!update || typeof update !== 'object') return;
    const u = update as {
      sessionUpdate?: string;
      toolCallId?: string;
      title?: unknown;
      name?: string;
      rawInput?: unknown;
      content?: unknown;
      _meta?: { claudeCode?: { toolName?: string } };
    };

    switch (u.sessionUpdate) {
      case 'tool_call':
      case 'tool_call_update':
        // Only the first sighting of a call counts: the adapter re-announces
        // one as its input streams in, and replay sends every one again.
        if (u.toolCallId && !this.live.has(u.toolCallId) && startsBackgroundWork(u)) {
          this.live.set(u.toolCallId, {
            toolCallId: u.toolCallId,
            acpThreadId,
            tool: toolOf(u),
            // The call's own title, which is what the agent chose to call the
            // work: "npm run build", "watch the crawl". A first sighting
            // sometimes has none, and a name is worth less than knowing the
            // work is there, so a nameless one is still an entry.
            title: typeof u.title === 'string' && u.title ? u.title : null,
            startedAt: this.now(),
          });
        }
        return;
      case 'user_message_chunk':
        this.settle(u);
        return;
      default:
        return;
    }
  }

  /** Drops the calls the notifications in this chunk say are finished. */
  private settle(update: { content?: unknown }): void {
    const content = update.content as { type?: string; text?: string } | undefined;
    if (content?.type !== 'text' || !content.text) return;
    const segments = parseTaskNotifications(content.text);
    if (!segments) return;

    for (const segment of segments) {
      if (segment.type !== 'notification') continue;
      const { toolUseId, status } = segment.notification;
      // Only a report that names its own call ends anything: a monitor's and
      // a subagent's name none, and guessing which entry a nameless one meant
      // would stop a box for the sake of tidying a map. Those expire instead.
      if (toolUseId && isTerminalStatus(status)) this.live.delete(toolUseId);
    }
  }

  /** Forgets everything, for a session whose adapter is gone. */
  clear(): void {
    this.live.clear();
  }

  /**
   * Whether this session is believed to have background work in it, which is
   * what holds the reaper off. Expired entries are dropped as it is asked.
   */
  get active(): boolean {
    this.expire();
    return this.live.size > 0;
  }

  /** How many tasks the whole session is believed to have running. */
  get count(): number {
    this.expire();
    return this.live.size;
  }

  /**
   * What one thread has running, oldest first — which is what a browser is
   * shown, and the order the work was started in.
   */
  forThread(acpThreadId: string): BackgroundTask[] {
    this.expire();
    return [...this.live.values()]
      .filter((entry) => entry.acpThreadId === acpThreadId)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(({ toolCallId, tool, title, startedAt }) => ({
        toolCallId,
        tool,
        title,
        startedAt,
      }));
  }

  /** Every thread with something running, for telling their browsers. */
  get threads(): string[] {
    this.expire();
    return [...new Set([...this.live.values()].map((entry) => entry.acpThreadId))];
  }

  /** Drops whatever has outlived the cap. Cheap, and every reader asks. */
  private expire(): void {
    const oldest = this.now() - this.maxAgeMs;
    for (const [toolCallId, entry] of this.live) {
      if (entry.startedAt <= oldest) this.live.delete(toolCallId);
    }
  }
}

/**
 * Whether a tool call leaves something running after the turn that made it.
 *
 * Exported because the other half of this question is asked in activity.ts: a
 * call that runs in the background is exactly the call whose silence says
 * nothing about whether the agent is still working, and the two must agree
 * about which those are.
 */
export function startsBackgroundWork(update: {
  name?: string;
  rawInput?: unknown;
  _meta?: { claudeCode?: { toolName?: string } };
}): boolean {
  const input = update.rawInput;
  if (
    input &&
    typeof input === 'object' &&
    (input as { run_in_background?: unknown }).run_in_background === true
  ) {
    return true;
  }
  const tool = toolOf(update);
  return typeof tool === 'string' && ALWAYS_BACKGROUND.has(tool);
}

/**
 * The tool a call runs, by the programmatic name this adapter carries in its
 * own metadata and a future one may carry where the ACP schema has it.
 */
function toolOf(update: { name?: string; _meta?: { claudeCode?: { toolName?: string } } }): string | null {
  return update._meta?.claudeCode?.toolName ?? update.name ?? null;
}
