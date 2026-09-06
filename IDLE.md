# Saying when a thread is waiting for you

Repo state: **implemented**, stages 0 to 5, on top of commit `cfb1833`. Stage
0 was measured against the adapter itself — `@agentclientprotocol/claude-agent-acp`
0.70.0, read out of `/usr/local/lib/node_modules` in a live Boxes session
container — and its answers are in §4. Stage 6 turned out not to be needed,
and one of the answers made the design better: the adapter does say when a
cycle is over, so the timer in §5 became a fallback rather than the
mechanism.

The defect: with background work outstanding, a thread that has finished
talking and is waiting for you was indistinguishable from one that was still
working — and in the worst shape of it, the composer offered a stop button
where the send button belongs.

---

## 1. One boolean, three questions

A thread has exactly one state bit today. `turn_active` is set when the
gateway forwards a `session/prompt` and cleared in that request's `finally`
(`orchestrator/src/gateway/upstream.ts:1097`, `:1123`), told to browsers over
`_boxes/turn_state` (`shared/types.ts:577`), and read back into
`ThreadStore.turnUpstream` (`dashboard/src/stores/thread/thread-store.ts:105`).

Everything the UI says about state is that one bit:

| Surface | Where | What it does with it |
|---|---|---|
| Composer | `thread.aui.tsx:443`, `:458` | send button, or stop button — never both |
| Spinner, follow-output | `thread.aui.tsx:177` | a turn's output is followed; nothing else is |
| Tab title | `lib/tab-title.ts` | `⟳` running, `○` idle |
| Session list | `SessionCard.tsx:28`, `:205` | "running turn" badge |
| Push | `upstream.ts:1130` | "turn finished", when nobody is watching |
| Reaper | `reaper.ts:54` | do not stop a box mid-turn |

Before background work existed, one bit was enough, because three different
questions had the same answer:

1. **Is the agent producing output right now?** (spinner, follow the bottom)
2. **May I type?** (send or stop)
3. **Will anything else happen if I say nothing?** (idle push, `○`, "done")

Background work splits them apart, and the bit follows none of the three.

## 2. What actually happens

**A background subagent.** The adapter defers the prompt's result until the
subagents the turn spawned settle (`ARCHITECTURE.md:804`). So the agent says
its piece, goes quiet, and waits for you — while `turn_active` stays set for
minutes or hours. The tab says `⟳`, the card says "running turn", the composer
shows **stop** and no send at all, and no "turn finished" push is sent until
the last subagent lands. On a phone, which is what Boxes is driven from, the
only button on the screen cancels the work.

**A quiet monitor or a backgrounded command.** The prompt resolves normally,
`turn_active` clears, and `BackgroundWork` (`gateway/background.ts`) holds the
reaper off. Nothing else knows: the tracker's state never leaves the
orchestrator — `backgroundActive` has exactly one reader, the reaper
(`reaper.ts:62`). The thread reads as finished and quiet, and the fact that a
crawl is still running in the box and will interrupt in ten minutes is written
nowhere.

**A task reporting in.** The harness wakes the agent with a `user_message_chunk`
carrying the notification block, and the agent works again — with no prompt in
flight, so `turn_active` is false throughout. Output arrives with no spinner,
and the viewport does not follow it, because only a running turn anchors
(`thread.aui.tsx:177`). The agent is working and the UI says idle: the exact
inverse of the first case, in the same thread, half an hour apart.

**Coming back to it.** A browser is told the turn state after its replay
(`upstream.ts:1050`) and nothing about background work, so re-opening a thread
cannot recover what is outstanding in it even in principle.

## 3. Why this is not a one-line fix

The moment worth reporting is the moment the agent stops talking, and in ACP
**that moment has no event**. No `stopReason` arrives for a deferred prompt,
there is no "the agent is done for now" notification, and silence is not
delivered. It is the same shape as the scroll defect in `SCROLL.md` — the
instant a condition becomes true is exactly the instant nothing happens.

(§4 found that this adapter does say it, in a `usage_update` it sends for its
own reasons. That is a gift rather than a contract, so the design below still
assumes silence and takes the marker where it is offered.)

So the plan is: **measure what the adapter really sends, then stop deriving
three answers from one bit.**

## 4. Step 0 — what the adapter actually does (measured)

Measured on 2026-09-06 by reading the adapter this deployment runs, in a
session container: `/usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp`,
version 0.70.0, `dist/acp-agent.js`. Line numbers below are that file's.

**1. Does it defer a prompt's result for background work? Yes — for subagents
only.** `settleOrDefer` (:1559) records the outcome in `Turn.deferredSettle`
and holds the turn open when `turnAwaitingSubagents` (:1526) is true, which
tests `record.isSubagent && !record.endedPerLevel` against the session's
`liveBackgroundTasks`. The comment at :1532 names the rule outright — the
"shells-never-defer contract". So:

- a background **subagent** holds the prompt open, exactly as this document
  assumed, and that is the headline case;
- a backgrounded **command** or a **Monitor** does not: `task_started`
  registers them (:2328) but only `subagent_type` marks a task as one worth
  deferring for. Their turns end normally, and the only thing that knows they
  are still running is `background.ts`.

**2. Is there a marker for the end of a turn? Yes, and it is used now.** The
result handler emits a `usage_update` (:2675) before it decides whether to
settle or hold, and that one carries `cost: { amount, currency }`. The
`usage_update`s sent while a message streams (:2978) carry only `used` and
`size`. So a cost-bearing `usage_update` is "the agent has stopped", it
arrives for a held turn, and it arrives for a cycle the harness woke on its
own — which the update marks further with `_meta["_claude/origin"]`, one of
`task-notification`, `peer`, `coordinator`, `observer` (:114).

This is better than the timer §5 describes, so `activity.ts` reads it and
keeps the timer as the fallback: the marker is this adapter's, not ACP's, and
it only appears when the backend reported usage.

**3. Can you prompt a thread whose prompt is deferred? Yes.** A new prompt is
enqueued on `turnQueue` (:1032) and its echo hands the held turn off with its
own recorded outcome (:3051): *"the user moving on must not block behind a
long-running subagent, but it must not rewrite the stop reason either."* So
the composer offering **send** in that state is right, nothing has to be
queued client-side, and **stage 6 is unnecessary**. (There is also a `steer`
path (:1108) that injects into a running turn without creating one — not used
by Boxes, and worth knowing about before anybody adds a "type while it works"
feature.)

**4. What does `session/cancel` kill?** A held turn is settled `cancelled`
immediately and *"held open for its background subagents, which the interrupt
below tears down"* (:3527). So cancelling does end the subagents. The bar's
dialog says so.

## 5. The model: three facts, one derived state

Replace the single bit with three independent facts per thread, each with an
owner that actually knows it:

- **`prompting`** — a client prompt is in flight. Exactly today's
  `turn_active`, kept as-is, and no longer shown to anybody directly.
- **`speaking`** — the agent is producing output *now*. Derived in the
  gateway from the update stream.
- **`background`** — what this thread has left running, as a list rather than
  a boolean: tool call id, tool name, the call's title, when it started.

Plus the two the gateway already has: `pendingCount` (a permission request or
a question), and the connection state.

From those, one presentational state per thread, in order of precedence:

| State | When | Reads as |
|---|---|---|
| `asking` | `pendingCount > 0` | waiting for a decision |
| `working` | `speaking` | running |
| `waiting` | quiet, `background` non-empty | **waiting for you — 2 tasks running** |
| `idle` | quiet, nothing outstanding | waiting for you |

`waiting` is the state the product is missing, and the whole point of this
document. Note that `prompting` appears in none of the rows: after this
change, whether a request object is outstanding upstream is the gateway's
business and nobody else's.

### Deriving `speaking`

A new `gateway/activity.ts`, sibling to `background.ts` and fed from the same
`observe` path, per thread, with an injected clock in the style the tracker
already uses. The end-of-cycle marker from §4 ends a turn outright wherever it
arrives; everything below is what happens when it does not:

- an `agent_message_chunk`, `agent_thought_chunk`, `plan`, or a `tool_call`
  the thread starts marks the thread speaking;
- a thread with an **unfinished foreground tool call** counts as speaking
  however long it stays quiet — a two-minute `npm test` emits nothing while
  it runs, and its call is `in_progress`, which is the evidence;
- otherwise the thread stops speaking `QUIET_MS` after the last update.
  Nothing else can say it, so a timer says it — one per thread, reset on
  every update, and this is the only place a heuristic lives;
- **replay is ignored**, through the `whileReplaying` marker that already
  exists (`upstream.ts:378`), or a reconnect would look like a working agent
  for as long as its transcript takes to arrive;
- everything is cleared when the adapter exits, beside the existing
  `background.clear()` (`upstream.ts:1251`).

Two thresholds, not one, because the two consumers want opposite things:

- `AGENT_QUIET_SECONDS` (default 3) flips the UI. Cheap to be wrong: an early
  flip shows a send button while the model is between tool calls, and sending
  is allowed anyway. A late flip costs three seconds of spinner.
- `AGENT_SETTLE_SECONDS` (default 30) gates the push. Expensive to be wrong: a
  premature "turn finished" on a lock screen is a lie you cannot take back.

### Making `background` per thread and legible

`BackgroundWork` keys entries by tool call id alone and answers one question.
It needs to (a) attribute each entry to the thread the update named — the
routing helper `threadOf(params)` in `broadcast.ts` already extracts it — and
(b) keep the tool name and the call's `title`, so the UI can say "npm run
build" rather than "1 task". `active` stays session-scoped for the reaper;
the per-thread list is what browsers get. Expiry is unchanged.

## 6. What goes on the wire

Extend the existing notification rather than inventing a second one. It is
already sent to a browser after its replay and on every transition, and an
ACP client that has never heard of it ignores it — which is what makes it
safe to grow.

```ts
export interface TurnStateParams {
  sessionId: string;
  /** A prompt is in flight upstream. Not what the UI shows. */
  active: boolean;
  /** The agent is producing output now. */
  speaking: boolean;
  /** What this thread has left running; empty for most threads. */
  background: BackgroundTask[];
}
```

`turnState` and `turnStateTo` (`broadcast.ts:184`, `:192`) send the whole
shape, so attaching to a thread with a monitor in it shows the monitor. The
REST summaries gain the same, merged in from the in-memory tracker the way
`attachedCount` already is (`sessions.ts:723`): `ThreadSummary.speaking` and
`ThreadSummary.background`, with `SessionSummary` carrying the session's
totals. `turnActive` stays in the payload for the reaper's sake but stops
being read by the dashboard.

## 7. What the dashboard does with it

- **`ThreadSnapshot`** gains `activity: 'asking' | 'working' | 'waiting' |
  'idle'` and `background: BackgroundTask[]`; `isRunning` becomes
  `activity === 'working'` and stops meaning "a prompt is open". Send and stop
  then follow the agent, not the request object — which is the fix for the
  phone with no send button.
- **A standing chip above the composer** while `background` is non-empty:
  *"2 tasks running in the background"*, expanding to the list with what each
  one is and how long it has been going. This is the answer to "is it done?" —
  the thread is quiet, you may type, and something is still cooking. It stays
  put, unlike the `TaskNotification` rows, which scroll away with the
  transcript.
- **Stop lives in the chip**, not in the composer, once the agent is quiet —
  and is labelled with what step 0 says it actually kills. The composer's stop
  button goes back to meaning "stop the agent talking".
- **Tab title** gains a fourth state between `⟳` and `○` for quiet-with-work
  (`◍`), since a row of tabs is exactly where this question gets asked.
- **Session list**: "running turn" is driven by `speaking`, and a thread with
  outstanding work gets a badge of its own ("1 task running"). The
  quiet-threads-get-no-badge rule (`SessionCard.tsx:188`) keeps its exception
  here: a thread that is waiting for you *and* has work in it is precisely the
  case a badge exists for.
- **Follow-output** follows a wake-up turn, because it follows `speaking`.

## 8. Notifications

`announce('idle')` moves out of the prompt's `finally` and onto the
`speaking → quiet` transition, held for `AGENT_SETTLE_SECONDS`, deduplicated
so one turn produces at most one push. Gate unchanged: only when nobody is
watching that thread. Its wording gains the outstanding work — *"has finished
its turn; 2 tasks still running"* — because that is the difference between
"come back when you like" and "come back, it will interrupt you".

Explicit non-goal: a push per task notification. A chatty monitor would make
Boxes unusable on a phone. If a task's *ending* deserves one, that is a
separate decision with its own setting.

## 9. Tests

- `activity.test.ts`, against an injected clock, in the style of
  `background.test.ts`: output marks a thread speaking; an unfinished tool
  call holds it speaking through silence; a completed one does not; the quiet
  timer fires once; replay marks nothing.
- `background.test.ts` grows thread attribution: two threads, one monitor
  each, neither seeing the other's.
- `broadcast.test.ts`: the state a fresh browser is told after its replay
  includes the outstanding list.
- `upstream.test.ts`: a deferred prompt with a quiet agent reports
  `speaking: false, active: true` — the case the whole document is about.
- `notify` retiming: quiet for the settle window sends one push; a thread that
  starts talking again inside the window sends none.
- e2e, via `stub-gateway.ts`, which will need a script that holds a prompt
  open and goes quiet: the composer offers **send**, the chip names the task,
  and a reload shows the same chip.

## 10. Risks and things deliberately not done

- **The quiet timer is a heuristic**, and it is the only one. It is confined
  to one class with an injected clock, its two thresholds are configuration,
  and both failure directions are cheap by construction (§5). If step 0 finds
  a real end-of-turn marker, this becomes its fallback.
- **The task tracker is best-effort** and stays that way: it reads the
  harness's conventions, not ACP's, and an entry expires after
  `BACKGROUND_TASK_MAX_MINUTES` whatever happens. A stale chip is a wrong
  label; a stale hold on the reaper is a box that stops late. Both are
  survivable, and the second one is already shipped.
- **In-memory**, like the tracker it extends: the tasks are children of an
  adapter this process owns, so an orchestrator that has forgotten them is one
  whose tasks are already gone. Nothing new in the database.
- **Not done here**: cancelling one background task rather than the turn;
  a background-work view outside a thread; per-task push.

## 11. Order of work

Each stage is shippable on its own.

1. **Step 0.** Measure (§4). Write the answers into this file. Every later
   stage is cheaper or different depending on what comes back.
2. **Make the tracker legible.** Per-thread attribution, names and start
   times, exposed through `TurnStateParams` and the REST summaries. No UI yet.
3. **The chip.** Show the outstanding list above the composer, in the card and
   in the tab title. This alone answers "is anything still running?" and is
   worth having before anything else lands.
4. **`speaking`.** Add `activity.ts`, drive `isRunning`, the spinner, follow
   output, and the badges from it. This is what gives the phone its send
   button back.
5. **Retime the push**, and reword it.
6. **Queueing**, only if step 0 says a concurrent prompt is refused. It does
   not: see §4.3. Not built, and not needed.

## 12. What was built, and what is still owed

Every suite passes on this tree: 473 orchestrator tests, 102 dashboard unit
tests, 96 browser tests. (One full e2e run in the course of this failed the
scroll flake `SCROLL.md` records as mode 4 — 80 px — and passed 3/3 re-run
alone and in the two full runs since. It is not this change; the hook is
untouched.)

Built, and covered by tests that pass:

- **`orchestrator/src/gateway/activity.ts`** — whether the agent is talking on
  a thread. The adapter's own end-of-cycle `usage_update` ends a turn where it
  arrives (§4.2); otherwise §5's inference does it — an update from the agent
  marks it working, an open foreground tool call holds it through silence, a
  background call does not, and two timers govern the two thresholds
  (`AGENT_QUIET_SECONDS`, `AGENT_SETTLE_SECONDS`). Fourteen tests against an
  injected clock and an injected timer, in the repo's style — no fake timers,
  no waiting.
- **`background.ts` per thread and legible** — entries carry the thread, the
  tool, the call's title and when it started; `forThread` is what a browser
  is shown. The reaper's question is unchanged.
- **`_boxes/turn_state` carries three facts** — `active`, `speaking`,
  `background[]` — sent after every replay and on every transition. `Broadcast`
  takes the state from the gateway, defaulting to the part it knows itself.
- **The push moved to the quiet moment.** `announce('idle')` no longer runs in
  the prompt's `finally`; it runs when the thread has been quiet for
  `AGENT_SETTLE_SECONDS`, and says what is still running.
- **The dashboard reads `speaking`** for the composer, the spinner, follow
  output, the tab title and the list badges; `BackgroundBar` shows what is
  still running above the composer, with ages, and a confirmed stop.
- **One vocabulary for it** — `lib/tab-title.ts` names the states a tab has to
  choose between, `◍` (waiting for you, with work still running) among them,
  and `lib/activity.ts` holds what the bar and the badges call a task.

Measured since, and folded in: §4. The two unknowns that could have changed
the design are answered — the adapter defers for subagents and only for
subagents, and a prompt sent into a deferred turn is accepted, so stage 6 is
not needed. `activity.ts` also reads the adapter's own end-of-cycle marker
now, which makes the quiet timer a fallback rather than the mechanism.

What is left is smaller, and none of it blocks the change:

1. **None of this is observed on the wire.** §4 is read from the adapter's
   source, which is stronger than a stub and weaker than a capture. The
   cheapest confirmation is `acp_log` for one real turn that spawns a
   background subagent: look for the `usage_update` carrying `cost` arriving
   long before the `session/prompt` response.
2. **`AGENT_QUIET_SECONDS` is still a guess** — 3 seconds. It now only
   matters for an adapter that reports no usage, or a backend that omits it.
3. **A `usage_update` from a subagent's own cycle** would end the parent's
   turn early if one ever reached the client with a cost on it. The adapter
   routes subagent output through `parentToolUseId` and the cost-bearing
   update belongs to the main loop's result, so this looks impossible today;
   it is the thing to check first if a turn ever goes quiet mid-work.
