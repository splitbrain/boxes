# Architecture

Boxes runs AI coding-agent sessions in isolated Docker containers and lets a
browser drive them over the Agent Client Protocol (ACP). One orchestrator
process owns everything: the REST API, the web assets, the agent connections,
the container lifecycle and the database.

This document describes how the system is put together. [`README.md`](./README.md)
covers running it and the risks that come with it.

## The property everything else serves

**A running agent turn continues when the browser disconnects.**

The orchestrator, not the browser, is the ACP client of record. It holds one
persistent stdio connection per session to the `claude-agent-acp` adapter
inside the session container. Browsers attach and detach as views, and nothing
a browser does reaches the adapter except the messages the gateway forwards.

Two consequences shape the rest of the design:

- The agent connection outlives any browser, so a long-lived process has to own
  it and be able to rebuild it without losing the thread.
- Thread history is replayed by the adapter's own `session/load` from the
  session's home volume, so the orchestrator stores no transcript of its own.

A session owns several *threads* — ACP calls one conversation a session, and
this document calls it a thread to keep it apart from a Boxes session. The
container, the workspace, the home volume, the network and the egress policy
are the session's and are shared, so a second thread costs nothing but its own
transcript. Each
connection is pinned to one thread, so two of them can be watched at once; see
[Several threads per session](#several-threads-per-session).

## Processes

```
                        phone or desktop browser
                                  │ https / wss
                    ┌─────────────▼─────────────┐
                    │  any reverse proxy        │  TLS and authentication,
                    │  (optional)               │  except on /ws
                    └─────────────┬─────────────┘
              ┌───────────────────▼───────────────────┐
              │            orchestrator               │
              │  /  dashboard   /api  REST            │
              │                 /ws   ACP gateway     │
              │                                       │
              │  SQLite · reaper · Docker client      │
              └───┬───────────────────────────────┬───┘
                  │ /var/run/docker.sock          │ docker exec, stdio
                  │      ▲ policy push (compose network, bearer)
   ┌──────────────▼──────┴───────┐                │
   │       egress proxy          │                │
   │  attached to every session  │                │
   │  network under the alias    │                │
   │  "proxy"; holds the policy  │                │
   │  and the credentials in     │                │
   │  memory, nothing at rest    │                │
   └──────┬───────────────┬──────┘                │
          │               │                       │
   ┌──────▼───────┐ ┌─────▼────────┐              │
   │ session-a1b2 │ │ session-c3d4 │◄─────────────┘
   │ net sn-a1b2  │ │ net sn-c3d4  │  claude-agent-acp runs as a
   │ (internal)   │ │ (internal)   │  long-lived exec, not as PID 1
   └──────────────┘ └──────────────┘
```

| Process | Built from | Role |
|---|---|---|
| orchestrator | `orchestrator/Dockerfile` | Serves every route, owns the sessions, holds the Docker socket |
| egress proxy | `proxy/Dockerfile` | The only route out of a session network, and where credentials are put on the wire |
| session container | `session-image/Dockerfile` | Runs the agent and the ACP adapter, one container per session |

The orchestrator and the proxy are compose services. Session containers are
created at runtime through the Docker API, so they appear in no compose file.

That makes the session image the orchestrator's to keep, not compose's: it
pulls `SESSION_IMAGE` when it is missing and again every
`SESSION_IMAGE_PULL_MINUTES`, and a session moves onto what arrived the next
time it is *started* — never while it runs, where recreating the container
would kill the adapter exec mid-turn. Recreating is otherwise cheap and is how
a session container changes anything about itself: the rootfs is read-only and
everything durable is in the two mounts, so the workspace and the thread
history come across untouched. For the same reason nothing outside the
orchestrator may recreate one — the container id in the database and the
runtime proxy attachment would both be lost — so the template carries
`com.centurylinklabs.watchtower.enable=false`.

`compose.yaml` publishes one port, on loopback, and names no reverse proxy:
what sits in front is a deployment decision, not part of the system. The one
constraint it places on that decision is that `/ws` must not be behind HTTP
authentication — see below.

## One origin, one port

The orchestrator serves everything a browser needs:

| Path | Handler |
|---|---|
| `/` | Dashboard bundle, with a single-page fallback |
| `/api/...` | REST |
| `/ws/sessions/:id/acp` | ACP gateway |
| `/healthz` | Version, session count, proxy warnings and whether a Claude token is configured |

A GET that matches no route falls back to the dashboard's `index.html`, so
client-side routes survive a reload. Anything under `/api` or `/ws` gets a
404 instead.

The dashboard is the only frontend, and it is served from the orchestrator's
own image. Two things follow:

- The browser derives the WebSocket URL from its own location, so no
  deployment setting can make it wrong and the API carries no endpoint URL.
- The whole stack runs behind one published port, with no reverse proxy.

## REST API

`orchestrator/src/app.ts` defines the routes; `SessionManager` does the work.
Request and response shapes live in `shared/types.ts`, which both the
orchestrator handlers and the dashboard's `api.ts` import.

| Method and path | Does |
|---|---|
| `GET /api/sessions` | Summaries of every live session |
| `POST /api/sessions` | Creates a session and returns it |
| `GET /api/sessions/:id` | One session with its Docker object names |
| `POST /api/sessions/:id/start` | Starts a stopped container |
| `POST /api/sessions/:id/stop` | Stops the container and drops the upstream |
| `DELETE /api/sessions/:id` | Deletes the session, its workspace and home volume included |
| `GET /api/sessions/:id/threads` | Every conversation the session owns |
| `POST /api/sessions/:id/threads` | Adds one and makes it the session's default; `{"from":"<threadId>"}` forks that one instead of starting empty |
| `POST /api/sessions/:id/threads/:threadId/select` | Makes one the session's default |
| `GET /api/sessions/:id/log?after=&limit=` | A page of tapped ACP messages |
| `POST /api/sessions/:id/attachments?name=` | Stores one file, raw bytes, in the session's workspace |
| `GET /api/sessions/:id/attachments/:name` | Serves one back; images and PDFs as themselves, everything else as a download |
| `POST /api/sessions/:id/exec` | Runs one command in the container, streaming its output |
| `GET /api/sessions/:id/exec` | Commands already run in this session |
| `GET /api/sessions/:id/review/tree` | Tree, git status per path, comment counts, the workspace's repositories and the base — the whole left panel |
| `GET /api/sessions/:id/review/file?path=` | Content, diff markers, the owning repository and comments — the whole file view |
| `PUT /api/sessions/:id/review/annotations` | Creates or replaces one line's comment |
| `DELETE /api/sessions/:id/review/annotations?path=&line=` | Deletes one comment |
| `PUT /api/sessions/:id/review/base` | Sets the revision the review is compared against, or clears it; answers with where it resolved in each repository |
| `DELETE /api/sessions/:id/review` | Deletes `REVIEW.md` — "New review" |
| `GET /api/agent-sets` | Every agent set, the global one first |
| `POST /api/agent-sets` | Adds a set |
| `GET /api/agent-sets/:setId` | One set with its `AGENTS.md`, skills and commands |
| `PATCH /api/agent-sets/:setId` | Renames a set, or replaces its `AGENTS.md` |
| `DELETE /api/agent-sets/:setId` | Deletes a set. The global one is refused |
| `PUT /api/agent-sets/:setId/items` | Creates a skill or command, or replaces the one under that name |
| `DELETE /api/agent-sets/:setId/items?kind=&name=` | Deletes one |
| `GET /api/agent-sets/:setId/preview` | What a session naming this set would get, global set merged in |
| `GET /api/push/key` | The deployment's VAPID public key, which a browser subscribes with |
| `POST /api/push/subscribe` | Registers a browser for Web Push, or refreshes what is stored for it |
| `DELETE /api/push/subscribe` | Forgets one browser's subscription |

The API carries no authentication of its own; a reverse proxy is expected to
provide it for `/` and `/api`, and the published port binds to loopback so
that an unproxied deployment is not an exposed one. `/ws` is the exception in
both directions: it must *not* be behind HTTP authentication, because a
browser cannot attach Basic credentials to a WebSocket upgrade, and it does
not need to be, because the gateway authenticates the upgrade itself.

### Local commands

A composer line starting with `!` is a local command: the dashboard
intercepts it, so it never reaches the model, costs no tokens, and cannot be
read as an instruction.

`exec.ts` runs it as `bash -lc <command>` inside the session container, as the
non-root `agent` user, in the container's existing isolation — internal
network, read-only rootfs, capabilities dropped. No new privilege is
introduced, and nothing shell-executes on the host: the command travels as an
argument to the container's own shell and never reaches a host command line.

The response is chunked `text/plain` rather than JSON, so the browser can
render the output as it arrives, and ends with a trailer line carrying the
exit code and whether either limit was hit. Both limits are enforced by the
orchestrator rather than trusted to the container: 120 seconds of wall clock
and 256 KiB of output, after which the exec is killed. Finished runs go into
`exec_log`, ring-pruned per session.

The browser writes the output straight into the thread as a code block, which
grows as the chunks arrive. Output is what the command was run for, so it is
shown rather than folded away behind a tool call that has to be opened first.
The fence is grown past the longest run of backticks in the output, so output
carrying a fence of its own cannot break out of the block.

The browser appends stored runs *after* whatever the replay produced rather
than interleaving them. ACP replay carries no timestamps, so where they belong
in the transcript is not recoverable.

### Attachments

A file attached to a prompt is uploaded into the session's own workspace, at
`.boxes/attachments/`, and the prompt then says so. That is the whole design,
and what makes it type-agnostic: a PDF, a CSV or a heap dump becomes a path
the agent opens with the tools it already has, where anything carried inside
the message could only ever be the handful of things a model reads directly.
A workspace is a plain directory the orchestrator owns, so the upload is a
file write — no container is involved, and a stopped session takes
attachments as a running one does.

Nothing travels inside the message. What the prompt carries is one block of
text naming every attachment, and then what the user typed — context, then
the question about it:

```
<attachments>
The user attached these files to this message. They are saved in the
workspace at the paths below; read them if they are relevant.
- .boxes/attachments/shot.png (image/png, 1.2 MB)
- .boxes/attachments/report.pdf (application/pdf, 840.0 KB)
</attachments>
```

An image the user attached is still shown in the thread: the chip is a
picture, loaded from `GET /api/sessions/:id/attachments/:name`, which reads
it back out of the workspace. So the bytes cross the wire once, on the way
up, and the thread looks the same on the phone that sent the screenshot and
on the desktop that comes to it an hour later.

That endpoint reads out of a tree the agent controls, so it is contained the
way the review's file endpoint is and by the same code — `resolveInRoot` in
`review/fs.ts`, which refuses a path that leaves the directory or is reached
through a link. That is the containment that matters here: a link planted in
the attachments directory would otherwise serve whatever the orchestrator's
own uid can read, `/data` included.

What it serves is declared rather than sniffed. What a browser can show is
served as itself — images, SVG included, and PDF — and everything else as an
`application/octet-stream` download. HTML is the deliberate omission: served
as itself it runs as this origin, and unlike an SVG there is no way to show
it that does not.

Every response carries `nosniff` and `default-src 'none'`, with `sandbox` on
all but the PDF. That CSP is load-bearing rather than decorative: it is what
lets an SVG — which can carry script, and which an agent can write — be
served as an SVG. Opened as a document it has no script, no origin and no
network; behind the `<img>` the thread draws it with, a browser runs nothing
in it anyway. The PDF is the exception because it is rendered by the
browser's own viewer rather than by the page, and a sandboxed document is one
a browser may decline to hand over — which would turn opening it into a
download, the one thing serving it inline was for.

Non-image attachments read as a chip in the thread, and the chip is a link to
that endpoint: a PDF opens in a tab, anything else downloads.

**Text, and not ACP's `resource_link`.** The protocol has a block for naming
a file, and the Claude adapter renders it as `[@name](file://…)` — a bare
markdown link, with no mime type, no size, and nothing saying whether to open
it. The deciding part is what comes back afterwards: an adapter stores that
rendering, not the block, so a reconnected thread would not look like the one
that was sent. Text round-trips through any adapter's transcript exactly as
written, which is what lets the dashboard read this same envelope back —
live from the gateway's echo, or on replay from the adapter — and draw the
attachment in its place, as a picture where it can and as a chip naming the
file otherwise. An envelope this build cannot parse is left alone as text, because showing
the model's own instructions is a better failure than dropping a file the
reader is looking for.

Uploaded names are sanitised to letters, digits, dot, dash and underscore,
with any leading dot dropped. That settles two things at once: as a path
component a name cannot climb out of the directory, and as prompt text it
cannot forge a line of the list it is quoted into — a newline in a filename
would otherwise end its entry early and let the rest read as another. A
`.gitignore` holding `*` goes into `.boxes/`, so attachments do not show up
as untracked files in a repository the agent is working in, and the
repository's own `.gitignore` — a file the user owns — is left alone.

Two limits are set deliberately rather than inherited. `MAX_ATTACHMENT_MB`
(25 by default) bounds one upload, which the orchestrator buffers before
writing out. The gateway's WebSocket takes a 16 MiB frame, where `ws`
defaults to 100 MiB — nothing the dashboard sends approaches either, but the
gateway answers any ACP client, and an ACP prompt may carry an image inline.

## The frontend

One React app, served at `/`. The session list is the thread list: a thread is
`/sessions/:id/threads/:threadId`, and `/sessions/:id` is whichever thread the
session has current — so every older link and bookmark still works. The ops
that used to share that page — start, stop, delete, the details, the
connection fields for an external ACP client — live at `/sessions/:id/info`.
What the agent is configured with belongs to the deployment rather than to any
one box, so it hangs off the list instead: `/agents` lists the sets and
`/agents/:setId` edits one.

Each card carries its session's threads under its badges, the default one
marked, so the list is the tree. Each row is a plain link to that thread,
because opening one is a plain navigation now: the connection names its own
thread, so nothing has to be switched first. Opening a thread still makes it
the session's default, as a fire-and-forget POST that neither blocks the
navigation nor disturbs anybody. A row carries its own badges — a running
turn, a waiting approval — because with two threads live that is the only
place that says which one is busy. **New thread** and **Fork** sit under them,
the second only when the adapter offers it.

The thread view names which thread it is on beside the session's name,
*always* rather than only when the session has more than one: two tabs on one
session are otherwise indistinguishable, which is the whole point. It also
carries its own **Fork**, because that is where the motion starts — you are in
a thread doing something long and you want a second one to ask about it. The
button posts and then reveals the new thread as a link with `target="_blank"`,
so the working thread stays where it is and the new tab is opened by a real
click. A `window.open` after the await is the thing to reach for, and it is
what popup blockers exist to stop.

That header gets out of the way while you read, and so does the review's —
one hook and one wrapper serve both, because a thread and a code pane are the
same shape of thing: a full-viewport route whose one scroller is the thing you
came for. A downward run of thirty-odd pixels collapses the row, and two dozen
back up returns it; the space goes straight to the content, which is `flex-1`
below it. Going is a decision about the reading you are doing and coming back
is a request that should not have to be repeated, so the two distances are not
the same. Runs are measured from the last change of direction rather than the
last event, which is what makes a pixel of finger jitter mean nothing and a
slow drift down mean something. The notices under the header do not collapse:
a missing token, a fork to open, an error to read are things to act on rather
than things in the way.

Three things are not reading, and the hook (`use-scroll-away.ts`) declines to
read them as such. A view against the bottom of its scroller is following its
own output — a thread streaming a reply, or writing what a `!bang` command
returned — and stays there for the whole of it, so nothing decides down there.
That question is asked of the scroller rather than of the app on purpose: the
thread's `isRunning` clears while the last chunks are still landing, measured
rather than guessed, so a header that trusted it moved on its own at the end
of every turn. A single step longer than three hundred pixels is a jump — a
review restoring where a file was left, a hunk being centred — and no hand
produces one. And the collapse itself moves the scroller: growing it by the
header's height makes Chrome nudge `scrollTop` to hold anchored content still,
which arrives as an upward run, which is the signal to come back, which grows
the scroller again. That one is a feedback loop, and it flapped until steps
small enough to be the nudge stopped counting for as long as the transition
runs. In every case the position is kept and the intent is dropped.

The row is collapsed rather than slid over the content: on a phone the point
is the fifty pixels, and chrome floating over the first message covers the
message instead of yielding. Its height is measured with a `ResizeObserver`,
because a two-line title beside two selects is not a number to hardcode and
`auto` is not a value CSS will animate from — and it is `inert` while away, so
nothing in it is tabbable, readable by a screen reader, or clickable through
the clip. That last one has a cost worth knowing: below md the only way to the
review's file tree is the button in its header, so switching files from deep
in a file takes a flick up first.

None of that is the browser's own hiding of its chrome, which is what the
header used to be at the mercy of. A thread is one dynamic viewport tall with
its own scroller inside, so the document has nothing to scroll — but `100dvh`
is measured against chrome that slides in and out, and every mismatch (the URL
bar expanding, the keyboard opening under a focused composer, rounding on iOS)
left the document taller than the screen. The browser scrolled the difference
away to keep the focused thing in view, and what went off the top was the
header — stranded on a scroller no gesture reaches, because every touch lands
in the thread's instead. So the full-viewport routes mark the document
unscrollable for as long as they are mounted (`use-viewport-lock.ts`), and the
viewport meta asks the keyboard to resize the content rather than slide over
it. What moves the header now is the app, on purpose.

Where a turn is read from is the runtime's business, up to a point. A turn
anchors the prompt that started it to the top of the viewport and writes the
answer underneath, paying for the space an unwritten answer does not fill yet
with a reserve element it shrinks as the answer arrives. That lasts one
screenful. Past it the anchor has nothing left to give — and it only ever
held a position, never followed one — so a long turn, which is a run of tool
calls and reasoning and rarely anything else, went on writing below the fold
and left it all there until it ended. `use-follow-output.ts` takes over at
that handover and keeps the viewport against the bottom for the rest of the
turn. It watches the scroller and what it holds, because content arriving is
not the only thing that grows a thread: a disclosure animates its height for a
fifth of a second without touching the DOM again.

A reader who takes the scroller away from the bottom is left where they put
it, and arriving back at the bottom rejoins. Which of the two a scroll was is
asked of the input rather than of the position, because the position cannot
answer it: a reader going up a hundred pixels and the browser holding the page
still while a block above them collapses by a hundred both subtract the same
hundred from `scrollTop`, and the turn writing into the same frame moves the
numbers again underneath both. Nothing the browser does to a scroller of its
own accord arrives with a wheel or a finger attached. A key is not counted
among those, however much it looks like input — the composer sits inside the
viewport, so every letter typed into it, and the Return that starts the turn,
arrives at the scroller too.

Which is also why a disclosure does not hold the viewport still while any of
that is going on (`use-disclosure-lock.ts`). The registry's `useScrollLock`
pins `scrollTop` for the length of a collapse, so the line under the reader's
eye stays where it was, and it pins by putting the position back on every
scroll event of the next two hundred milliseconds — including the ones a
thread following its own output makes. The runtime reads that reset as a
reader flicking upward and stops following for good, and a working turn is
disclosures opening and closing, so following survived about one of them. A
thread that has moved with its output in the last second has nothing to hold
still and is not held. One being read at the bottom of a finished turn does,
and still is: opening a tool call there unfolds it below rather than taking
the view to the end of what it printed, which is what the lock is for.

The chat itself is [assistant-ui](https://www.assistant-ui.com/). Its
components are installed into `src/components/assistant-ui/` by the official
CLI, in the shadcn distribution model: the sources are committed and are ours
to edit, and an upgrade is a CLI re-run reviewed as a diff rather than a
version bump that changes the UI silently. The edits that are ours are marked
`Boxes edit` in the source, with the reason at the point of the change —
`grep` is the list, because a count in prose here would rot. They are of three
kinds: terminal habits the chat did not have (ArrowUp history on the composer,
returning focus after a send, the slash-command list below), facts about this
deployment the components could not know (a tool call in a session container
cannot be answered from a browser, so only a real question opens a group and
offers buttons), and
the look — the reasoning disclosure drawn as quietly as the tool calls beside
it, and one spinner (`components/Spinner.tsx`) wherever the registry shipped a
rotating icon.

Because those components are written in Tailwind utilities, Tailwind is a
build dependency rather than a style choice, and it compiles from source on
every build. `globals.css` is the whole design system: the tokens, and the
`@theme inline` block bridging them into Tailwind colours. That bridge is a
correctness requirement, not theming polish — Tailwind v4 emits a utility only
for a colour its theme defines, so without it `bg-background` and every other
token utility the installed components use would silently vanish.

The browser speaks plain ACP to the gateway, so it is a client like any other
and the gateway stays client-agnostic. That is not only tidiness: this
dashboard replaced a separate chat application served alongside it, and the
gateway needed no protocol change to swap one for the other. An external ACP
client still attaches to the same endpoint, with the URL and token from
`/sessions/:id/info`.

```
AcpClient    ⇄ …/threads/:threadId/acp  JSON-RPC over one WebSocket, one thread
translate.ts   session/update*       →  an append-only message model (pure)
thread-store   the live thread          messages, modes, models, approvals, exec
convert.ts     that model            →  what useExternalStoreRuntime reads
```

An image is the one content block that is not prose, and it becomes a part of
its own. Three things send one: a chunk of what the agent or the user said, and
a tool call's result — which is how a screenshot arrives, the agent reading a
PNG back with `Read` and the adapter carrying it inline as base64. ACP has no
place for an image inside a tool call as far as a renderer is concerned, so
`convert.ts` puts it just after the card that produced it, derived from the
call's content on every conversion rather than stored — an update replaces a
call's content wholesale, and its images have to go with it. A block the
browser cannot load is said in words rather than dropped: assistant-ui admits
a data URL or an https one as a src and refuses the rest, so a plain-http
image becomes the link to it.

A message in the user's role is not always the user speaking. Work started in
the background — a command left running, a subagent, a monitor watching
something — does not answer into the turn that started it: it reports later,
and the way it reports is that the harness wakes the agent with a block of XML
sent as though the user had typed it. Left alone that arrives in the thread as
a bubble on the user's side with the tags still in it, which is what it used
to do. `lib/task-notifications.ts` reads the block back out,
`stores/thread/translate.ts` makes it a part of its own, and the thread draws
a quiet row across the conversation instead: an icon for how the task ended,
the summary, and what the task said. A monitor's event is shown, because
reporting it is the whole point of a monitor; a finished task's result is
folded under its summary, because a subagent's answer runs to pages and the
summary already says what happened. It reaches the runtime as a `data` part —
assistant-ui's one open part kind, keyed by name to the component that draws
it — because prose, pictures, files and tool calls are the whole of the closed
set and this is none of them.

The block travels as text, which is the same bargain the attachment envelope
makes and buys the same thing: it survives the adapter's transcript unchanged,
so a reconnected thread draws the row it drew live. One this build cannot
parse is left as the text it is, because showing the XML is a better failure
than dropping what a task said.

`translate.ts` being pure is what makes replay and live streaming the same
code path: a reconnect repeats the handshake, `session/load` re-sends the
history as ordinary notifications, and folding them rebuilds the thread. An
update kind this build predates is kept and rendered as nothing, so a newer
adapter cannot break an older dashboard.

A replay is folded in silence and published once. The notifications are the
same ones live streaming uses, so the store used to hand the view every
intermediate state of a conversation it was in the middle of re-reading: on
arrival at a box with any history, the thread assembled itself message by
message, the viewport chased the bottom of it, and the reading position ended
up wherever the last render left it. Now the model is built up with nothing
emitted, and the snapshot that ends the replay is the whole conversation —
which the runtime's autoscroll opens at its end, because that is where a
thread is read from. `session/load` answering is what says the replay is over:
the gateway forwards the adapter's notifications as they arrive and returns
the result only afterwards, so the answer means "that was all of it". A replay
that never answers publishes nothing at all: the connection is reconnecting,
the view says so, and half a conversation is not a better answer than the
whole of the previous one.

Until a replay has landed the thread shows a placeholder — a pulsing
conversation shape, and nothing that can be acted on. What was there before is
a composer over *How can I help you today?*, which is a claim that the thread
is empty: true of a box that has never been prompted, and on arrival at one
with a conversation in it both wrong and about to be replaced. A reconnect
mid-session keeps showing what it was showing, since the socket dropping is
not news about the conversation; only a first read shows the placeholder.

`available_commands_update` carries the slash commands this agent accepts, and
the composer completes them: a leading `/` opens the list, each further
character narrows it, and picking one writes the command's name into the
composer. It completes rather than sends, because a command often takes
arguments and running it is the agent's job. The list is whatever the adapter
advertises, so it follows the agent rather than this build.

Two behaviours are worth knowing because they look like bugs otherwise. A turn
blocked on a permission request reports itself as *not running* — it is
waiting for the user, and the runtime derives a message's requires-action
status from its unresolved approval only while the thread is idle, so claiming
otherwise would hide the very question holding up the turn. And ACP's
permission vocabulary maps onto assistant-ui's approval vocabulary by rename
alone: `allow_once` to `allow-once`, `optionId`/`name` to `id`/`label`.

## The ACP gateway

Two halves, in `orchestrator/src/gateway/`.

### Upstream: one connection per session

`upstream.ts` holds the connection to the adapter. `SessionManager` creates one
`UpstreamSession` per session on first use and keeps it for the process's life.

Starting it, in `ensureStarted`:

1. Start the container and make sure the egress proxy is attached.
2. Spawn `claude-agent-acp` as a `docker exec` with `Tty: false`. Docker frames
   stdout and stderr into one stream, so the streams are demuxed. stdout
   carries newline-delimited JSON-RPC; stderr is log-only.
3. Send `initialize` with empty client capabilities: no filesystem, no
   terminal, no elicitation. That confines adapter-to-client traffic to
   `session/update` and `session/request_permission`. The response is cached
   verbatim.
4. Replay the session's *default* thread with `session/load`, or, when it has
   none or the adapter no longer holds it, mint one with `session/new` and
   store its id. Then re-issue `session/load` for every other thread an
   attached browser is watching, so a respawn brings back every conversation
   this connection has to carry rather than only one of them. A watched thread
   the adapter cannot bring back has its browsers' sockets closed, because the
   id they hold is one the adapter would now reject; each reconnects and pins
   whatever that thread is next.

Every thread is then put in the mode and on the model it is meant to have:
what its row records, or this deployment's default — `auto` and `opus` — when
it records nothing. A fresh thread records nothing, which is what an empty
column is for. A fork is the exception and says so: it starts in `plan`,
because it shares the thread it came from's checkout and the point of one is
to ask about work the original is still doing, so it starts in a mode that
reads rather than writes. That does not fix the shared workspace; it stops the
common accident, and flipping the fork to `auto` is the header's settings. An
adapter offering no such mode is left in whichever mode it starts in, and a
switch that fails is logged rather than failing the spawn.

Both are on the thread's row (`threads.mode_id`, `threads.model_id`) because
the adapter forgets them. A mode lives in that process and nothing else, so
every respawn — an idle stop and a return, a deploy, an adapter that died —
used to hand the conversation back in whatever mode the adapter starts in,
which is how a thread left in `auto` came back on manual approvals half an
hour later. `session/load` brings the conversation back and nothing else, and
this is the other half of that: the row is read on every load, not only on
the mint that used to be the one place a mode was ever set.

The row is written wherever the answer changes. A `session/set_mode` the
adapter accepts is recorded as it passes through the gateway, because that is
the request the user actually made. `current_mode_update` and
`config_option_update` are recorded as they arrive, because the adapter also
changes both on its own — leaving `plan` when a plan is accepted, falling back
to another model under load — and a thread should come back where it ended up
rather than where it was last sent. Which config option is the model is read
from its `category`, never from the adapter's id for it.

Every one of those calls — `session/new`, `session/fork` and `session/load`
alike — carries the same `_meta.claudeCode.options.thinking`, which is where
the adapter reads options to lay over the ones it hands the Claude Agent SDK.
It asks for `display: 'summarized'`. Current models default that to
`omitted`, which streams thinking blocks carrying a signature and no text, so
the adapter has nothing to put in an `agent_thought_chunk` and the reasoning
disclosure in the thread never appears at all — the agent was thinking and
saying so, and the words were not on the wire. The budgeted `enabled` form
rather than `adaptive`: on a current model the two are the same thing, and
`adaptive` is a flag an older one can reject, while which model a thread runs
is chosen from the header's settings long after this is fixed.

A spawn that fails is retried three times, waiting 1, 3 and 8 seconds. After
that the session's status becomes `error`.

The guard on `ensureStarted` is the cached `initialize` response rather than
the connection object. The connection exists as soon as the exec stream is
wired up, but its handshake takes a few hundred milliseconds, and a browser
arriving inside that window has to wait rather than be told the upstream is
unavailable.

A `session/load` that comes back with `resourceNotFound` is not a failure. The
agent SDK writes a transcript only once a prompt has run, so an id minted by
`session/new` and never prompted does not survive the container stopping. Only
that thread's row loses its adapter id and gets a freshly minted conversation;
the session's other threads have transcripts of their own and are untouched.
Any other error is rethrown, which keeps a transient fault from discarding a
live thread.

When the adapter exits on its own, the connection is torn down and nothing
reconnects immediately. The next forwarded message calls `ensureStarted` again,
which re-spawns and re-issues `session/load`. A deliberate stop sets a flag
that suppresses even that.

### Downstream: one connection per browser

`downstream.ts` speaks ACP as an agent toward browsers. JSON-RPC terminates on
both sides, so each connection runs its own id space and the SDK correlates
request and response within it.

There are two upgrade paths, and each connection is **pinned to one thread**
for its whole life. `/ws/sessions/:id/threads/:threadId/acp` is a connection
to that conversation; `/ws/sessions/:id/acp` names none and means whichever
thread the session has current. The short path is what an external ACP client
and every link from before this existed use, so their contract does not change
at all — only the dashboard learns the longer one. A path naming a thread that
is not the session's is refused at the handshake, as a 404 before a WebSocket
exists, the same way an unknown session is: a connection is pinned for its
whole life, so there is no later point at which to find this out.

The upgrade is authenticated on the handshake. A browser cannot set an
`Authorization` header on a WebSocket, so a client offers the token as a
`bearer.<token>` subprotocol entry alongside `acp.v1`. The gateway compares it
against `WS_AUTH_TOKEN` in constant time and selects `acp.v1` explicitly,
rather than relying on the client to list it first.

Which thread the connection is on is settled once, at attach, and needs the
adapter first: a thread minted and never prompted has no adapter-side
conversation until one is made, and pinning to an id the adapter has forgotten
would leave every prompt on it failing. The handle counts as attached from the
moment the socket opens — that is what the reaper counts — and nothing is
routed to it until its thread is settled.

Three methods are answered or reshaped rather than forwarded:

- `initialize` returns the cached upstream response, so its `_meta` extensions
  reach the browser intact.
- `session/new` returns the ACP id of the thread this connection is pinned to.
  Which thread that is, is decided outside ACP, so a browser or an external
  ACP client speaks the same contract either way: a `session/new` that hands
  back an id the client did not choose.
- `$/ping`, which some ACP clients send every 25 seconds, is dropped before the
  SDK sees it. JSON-RPC forbids replying to a notification. The dashboard
  sends none.

Everything else in `FORWARDED_REQUESTS` and `FORWARDED_NOTIFICATIONS` goes
upstream untouched, `_meta` included. Detaching removes the handle from the
broadcast set and touches nothing else.

### Who each update goes to

`broadcast.ts` decides. Sending every update to every browser is almost
right, and wrong in three places that only appear with more than one attached —
a phone and a desktop watching the same session, or two tabs on two threads of
one box.

**Every rule is scoped to a thread**, because every rule is about one
conversation. A connection is pinned to a thread and each `session/update`
carries the thread it is about, so routing is a lookup rather than a guess.

- **An update goes only to the browsers watching its own thread.** One naming
  a thread nobody is watching is dropped rather than broadcast, which is the
  honest reading and also what stops a background thread's stream reaching the
  wrong tab.
- **A forwarded prompt is echoed to every browser on its thread, the sender
  included.** The adapter is only required to replay a prompt later, not to
  echo it live, so without this the browser that sent it shows nothing until
  its next reload. While the gateway is echoing *that thread*, an adapter that
  *does* echo is suppressed, so either kind of adapter produces exactly one
  copy. Replay is exempt: there the adapter is reading back history the
  gateway never saw.
- **A replay goes only to the browser that asked for it, and silences only its
  own thread.** `session/load` is by definition a re-send of the whole thread,
  so broadcasting it rendered every other open tab's conversation twice — but
  a replay of one thread must not hold back another thread's live updates,
  which is the bug two open tabs hit first. A replay one thread *borrowed*
  from another is re-tagged as the borrower's on the way out, because the
  browser reading it is pinned to the borrower — see *Several threads per
  session*.

### Several threads per session

A workspace an agent has already prepared is worth keeping; the context it
built up on the way there is often not. So a Boxes session owns several
threads, and two things make new ones: **New thread** starts an empty one on
the same workspace, and **Fork** branches the one you are on so an
investigation can go two ways without disturbing the original. Everything else
about the session is shared, so an extra thread costs nothing but its own
transcript.

**A connection names its thread, and `current_thread_id` is the default.**
The thread is in the WebSocket URL, so one session's adapter connection
carries every thread anybody is watching and two tabs can hold two
conversations of one box at once. The session row still records a current
thread, but only as what a connection that names none gets — the short
WebSocket path, `/sessions/:id`, an external client, a bookmark from before
this existed. Selecting a thread moves that default and nothing else: no live
connection is pinned to it, so nobody is dropped and nothing reconnects, which
is what makes opening a thread a plain navigation rather than a call.

The motion this exists for: you are in a thread doing something long, you fork
it, and you ask the fork about what it is doing without stopping it or losing
your place. That is narrower than parallelism in general, and it is the benign
case — a thread that reads and answers does not fight the working thread over
the checkout the way two threads both editing would. It is still one
workspace: `plan` mode on a fork narrows that to deliberate acts rather than
removing it, and a user who flips the fork to `auto` and edits gets exactly
the conflict they asked for. A git worktree per thread is the honest fix and a
larger change than this.

Whether the adapter serves two prompts concurrently is not settled here. The
wire allows it — the ACP SDK keys pending responses by JSON-RPC id with no
write queue, so two `session/prompt` calls naming different threads can be in
flight on one connection — but `claude-agent-acp` holds every thread of a
session in one process and may queue the second behind the first. Nothing in
the UI claims otherwise: the per-thread badges report what a thread is doing,
which is true either way.

The adapter is not the source of truth for which threads exist. `session/list`
returns only threads that have a transcript on disk, and a thread minted but
never prompted has none, so Boxes keeps its own record in the `threads` table.
A thread goes by the title the agent generates — the adapter pushes it as a
`session_info_update` at the end of a turn, and it is written to the row the
update's own ACP id names — and until then by its ordinal, which is per
session and never reused.

Forking is offered only when the adapter advertised
`sessionCapabilities.fork` in its `initialize` answer, which the orchestrator
already caches verbatim. The capability is marked unstable in the ACP schema,
so an adapter that drops it costs the dashboard a button rather than a build.

**A fork borrows the transcript it branched from until it has one of its
own.** The adapter branches the conversation in full — the fork knows
everything the source said — but it writes the fork no transcript until the
fork is first prompted, so `session/load` on a fresh one replays nothing and
it would open on a blank screen claiming to know a conversation the reader
cannot see. So `threads.inherits_from` records the source, and a load of a
thread that has it replays the *source's* history, re-tagged as this thread's,
after the fork's own load has come back empty. A fork of a fork follows the
chain: the middle thread has no transcript either, so what both of them came
from is what gets replayed.

That first prompt is where the borrowing stops, and the column is cleared
there rather than later: the adapter starts a transcript for the fork at that
moment, and it opens with everything the source had said — so from then on
the fork replays itself, and replaying the source as well would say all of it
twice. The same column is what re-forks a thread the adapter has forgotten: a
fork that had not been prompted before a respawn is branched again rather than
started empty, because carrying that context is the only reason it exists.

The borrowed replay is one browser's, exactly as its own would be, and it
holds back the source's live updates for its length the same way. A replay of
a thread cannot be told apart from what that thread is saying right now, and
this is the one place where two threads are the same conversation — so a
source mid-turn can lose a moment of its stream to a fork being opened. It
comes back on that browser's next load, and a source that cannot be replayed
at all costs the fork its history and nothing else.

A running turn and a waiting permission request belong to the thread, not the
session. `threads.turn_active` records the first, and the session's answer is
derived as any of its threads — two sources of truth for whether a turn is
running is precisely the thing that goes stale. A permission request records
the thread that asked, goes to a browser watching *that* thread, and queues
when only another thread's browser is attached, exactly as it does with none.

Deleting a thread is not implemented, though the adapter supports
`session/delete`. `!bang` command history, the exec log and the debug log stay
session-scoped: those things happened in the container rather than in a
conversation, so they appear under every thread.

### Permission requests

The adapter blocks on `session/request_permission` until it gets an answer,
which is the behaviour Boxes wants: an unattended turn pauses instead of
proceeding without consent.

- The request goes to the most recently active browser **watching the thread
  that asked**. A browser watching another thread is not asked: it is looking
  at a different conversation, and a question about one thread's tool call
  cannot be answered from another's transcript. If that browser vanishes
  mid-question, the request falls back to the queue rather than failing the
  turn.
- With nobody on that thread, the request is stored in `pending_requests`
  against the thread's ACP id and a notification is pushed. The next browser
  to attach *to that thread* gets its queued requests delivered to it, and
  only those.
- After `PERMISSION_HOLD_MINUTES`, `PERMISSION_FALLBACK` decides. `hold` keeps
  waiting. `deny` answers with a reject option taken from the request's own
  options list, never an invented one, and cancels the request when none is
  offered. Nothing auto-approves.

### Work left running in the background

A turn that backgrounds something ends like any other. The agent says it will
report back, the thread goes quiet, and with the browser closed every test the
reaper makes says the session is idle — so half an hour later the container is
stopped, and the build, the crawl or the monitor inside it goes with it. The
failure is silent: the thread's last line is still the agent promising to
report, and the report never comes.

Two things already covered part of this and neither covered it all. A
background *subagent* holds its turn open — the adapter defers the prompt's
result until the subagents it spawned settle — so the session counts as running
a turn for as long as one is alive. And a task that keeps talking keeps its box
awake by talking, because every adapter update marks the session active. What
was left was the quiet task: a command compiling for two hours, or a monitor
watching a log that says nothing.

`gateway/background.ts` reads the same updates the browsers get and holds the
reaper off while it believes something is still running. A tool call starts an
entry when its input asks for the background or its tool only ever runs there
(`Monitor`, `Workflow`); the notification the harness sends when a task is over
ends it, matched on the tool call id the block carries as `<tool-use-id>` —
which is ACP's `toolCallId`, so the report and the call that started the work
name the same thing. A report naming no call ends nothing, because guessing
which entry a nameless one meant would stop a box for the sake of tidying a
map.

Held off, not disabled. Both ends of this are the harness's conventions rather
than anything ACP promises, so an entry expires after
`BACKGROUND_TASK_MAX_MINUTES` whatever happens: a missed ending costs a box
that stops later than it should rather than one that never stops at all. The
state is deliberately in memory — a background task is a child of the adapter,
the adapter is a docker exec this process owns, and both die with it, so an
orchestrator that has forgotten a task is one whose task is already gone.

### Is the agent talking, or is it your turn

Boxes had one bit per thread — a `session/prompt` this gateway forwarded has
not come back — and read three separate things off it: the agent is producing
output, you may not type, nothing more will happen until you do. Background
work pulls those apart in both directions. A turn that spawns a background
subagent keeps its prompt open long after the agent has finished, so the
browser showed a stop button and no way to send while the thread sat waiting
for its reader; and a task reporting in wakes the agent with no prompt open at
all, so that turn's output arrived while the same bit said the thread was
idle.

ACP has no word for it: no "the agent is done for now" notification, no stop
reason on a prompt being deferred, and the moment worth reporting is by
construction the moment nothing arrives. This adapter does say it sideways,
though — `claude-agent-acp` emits a `usage_update` at the end of every
processing cycle, and that one carries a `cost` where the ones it sends while
a message streams do not. `gateway/activity.ts` reads it, so a held turn and a
cycle the harness woke on its own both end the instant they actually end.

That marker is the adapter's own rather than anything ACP promises, and it
appears only when the backend reported usage, so silence is the fallback and
the same file infers it: an update from the agent says it is working, and
silence lasting `AGENT_QUIET_SECONDS` says it has stopped. The one exception
is a tool call the agent is waiting on, which is evidence where silence is not
— a thread with one open stays speaking however quiet it goes. A call that
runs *in the background* is not counted, which is why this and `background.ts`
share the one predicate that decides which those are.

Which calls hold a prompt open is the adapter's rule, not a guess: it defers a
turn's settlement for the **subagents** it spawned and for nothing else — a
backgrounded command or a monitor never holds one. A prompt sent into a
deferred turn is accepted and hands the held turn off, so the composer is safe
to offer send there. Both were read out of `claude-agent-acp` 0.70.0; `IDLE.md`
§4 records where.

Two thresholds, because the two readers want opposite things. The screen flips
at `AGENT_QUIET_SECONDS` and can afford to be wrong for a moment: an early
flip offers a send button while the model thinks between tool calls, and
sending was allowed anyway. The notification waits for `AGENT_SETTLE_SECONDS`,
because "your turn has finished" on a lock screen is a claim there is no
taking back.

So `_boxes/turn_state` carries three facts rather than one — a prompt is open,
the agent is speaking, and here is what is still running in the background —
and every browser is told all three after its replay and on every transition.
`TurnStateParams` is the shape. The dashboard shows `speaking` wherever it
used to show the prompt bit — the composer's send-or-stop, the spinner,
follow-output, the list badges — and the outstanding tasks in a bar above the
composer, which is a standing fact about the box rather than something that
happened, and so does not belong in the transcript. A tab title has to pick
one word for all of it, and `lib/tab-title.ts` is where the four are named:
`⚠` and `?` for a thread that has stopped and needs an answer, `⟳` for one
that is talking, `◍` for one that is waiting for you with work still running,
`○` for one that is simply waiting.

### Notifications

Two events are worth interrupting somebody for: a permission request has been
queued, and a turn has finished and is waiting for somebody. Both are
announced from the gateway through `notify.ts`, and both are gated on the same
condition — **no browser is watching that thread**. That is not a heuristic about attention, it is the
same test that decides whether a permission request is queued in the first
place, so the two agree about what "you are not here" means. A turn finishing
in front of you is the screen you are already looking at.

The finished turn is announced when the agent goes quiet, not when the prompt
comes back: a request coming back says the request is over, which for a turn
holding a background subagent open happens hours later, and a turn the harness
started on its own has no request to come back at all. See *Is the agent
talking* above.

The announcement names the conversation, not only the box, and says what is
still running in it. With two threads live, "your session needs you" is not
something you can act on from a lock screen, and "two tasks are still running"
is the difference between a thread you can come back to whenever and one that
is about to say something else on its own.

`Notifier` sends one event and the gateway's side awaits none of it. A turn
already waiting on a human must not also wait on a push service, so every
failure inside is logged and swallowed.

- **Web Push** (`push.ts`), to every browser that subscribed: RFC 8291
  `aes128gcm` payload encryption over RFC 8188, authenticated with an RFC 8292
  VAPID assertion. This is what survives the app being closed, which is the
  reason the feature exists — and it is the only channel, deliberately: a
  second one that reached a third party would be Boxes telling somebody else
  which of your boxes wants you and when.

The crypto is implemented on `node:crypto` rather than taken as a dependency.
It is about a hundred lines, and `push.test.ts` drives it against the RFC's
own published example — matching that byte for byte is worth more than a
round-trip test, because an implementation can be self-consistent and still
produce a body no browser can open.

The VAPID keypair is generated into `DATA_DIR/vapid-keys.json` on first use
and reused from then on, the same shape as the WebSocket token in `secret.ts`
and for the same reason: regenerating it would silently invalidate every
subscription anybody had made. It is generated lazily, so a deployment nobody
subscribes from never writes one.

A subscription is one browser, not one user — Boxes has no accounts, so
whatever authenticates `/api` is what decides who may register. An endpoint
must be `https` and must name a host rather than an address literal, so the
route cannot be used to aim the orchestrator at the LAN it can see. A
subscription the push service answers with 404 or 410 is dropped on the spot:
that is the ordinary end of one, not an error.

Delivery needs two things Boxes cannot provide for itself. The Push API does
not exist on a page served over plain HTTP (`http://localhost` excepted), so
push works on the loopback default and behind a TLS reverse proxy and nowhere
else. And iOS exposes it only to a page added to the Home Screen, which is why
the dashboard ships a manifest and why the toggle tells an uninstalled iPhone
to install rather than that it cannot.

### Being installable

Which makes the install a feature rather than a nicety, and it has one
requirement that is nowhere in the manifest. A manifest is fetched with
credentials omitted unless the link says otherwise, so behind the
authenticating proxy every deployment past loopback is supposed to have, the
single request that decides whether a browser offers the install is the single
request that arrives without the session cookie. The proxy answers it with a
redirect to a login page, the browser is left with no manifest, and nothing
else on the page is affected — the failure is a missing offer, not an error.
`index.html` asks with `crossorigin="use-credentials"`, and `e2e/pwa.test.ts`
puts the stub orchestrator behind a cookie check and asks Chrome itself,
over CDP, whether it would install what it found. That test needs a real
profile: Chrome refuses to install from an incognito context, which every
`newContext()` is, so `launchProfile` in `e2e/browser.ts` gives it one.

iOS is told twice. Safari offers Add to Home Screen whether or not a manifest
loaded, and an icon that opens a browser tab has a browser tab's Push API, so
`apple-mobile-web-app-capable` states standalone in the markup where nothing
can fail to fetch it, and `apple-mobile-web-app-title` names the app before
the document title starts tracking what a thread is doing.

The service worker is registered on load, by `installWorker`, and not by the
push toggle. Registering it from `refreshPush` would have skipped exactly the
browsers that need it: that function returns at the first blocker, and the
blockers are an iPhone that has not installed yet and a user who has declined
notifications once.

## Session lifecycle

Creating a session, in `SessionManager.create`:

1. Validate the name, and the agent set if one was named.
2. Make sure the session image is on the host, pulling it if it is not. Before
   anything is allocated, so a deployment whose first pull failed gets one
   clear answer rather than a half-created session and a teardown.
3. Generate a session id server-side. User input never reaches a Docker object
   name.
4. Allocate a `/24` out of `SESSION_SUBNET_POOL` and insert the row as
   `creating`.
5. Create the network `sn-<id>`, attach the egress proxy, create the workspace
   directory `${DATA_DIR}/workspaces/<id>`, write the merged agent
   configuration to `${DATA_DIR}/agents/<id>`, create the volume `home-<id>`,
   create the container `session-<id>`, and start it.

Any failed step tears the whole session down and marks it `error`.

The container's `HostConfig` is a fixed template that user input never reaches.
It runs as `SESSION_UID:SESSION_GID` — numbers rather than the image's `agent`,
so one setting decides who a session is. The default is 1020, deliberately off
the 1000 the `ubuntu` base account holds, as does a host's first login user.
The session image builds its `agent` user on the same numbers, because a
session's home is a named volume Docker ownership-initialises from the image
and nothing outside the container can chown it afterwards; `ensureSessionImage`
reads the image's own user back and warns when the two have drifted. Pointing
the orchestrator's own user at `SESSION_UID` is what lets it drop root, since
the workspace chown then has nothing to do.

It runs non-root with `ReadonlyRootfs`, `CapDrop: ALL`,
`no-new-privileges`, a tmpfs `/tmp`, memory, CPU and pids limits, and
`Init: true`. That last one matters: the kernel discards default-disposition
signals for PID 1, so without docker-init the entrypoint's `sleep` would never
see SIGTERM and every stop would wait out the grace period. The only
caller-supplied values are the session id and the profile secrets.

The entrypoint installs the agent configuration into `~/.claude`, sets the git
and gh identity, and then holds the container open.
The adapter is spawned separately by the gateway, so browser churn never
restarts the container. Both run in `/workspace`, which is the session's own
workspace directory and starts empty.

| Status | Means |
|---|---|
| `creating` | The row exists, the Docker objects are being built |
| `running` | The container is up |
| `stopped` | Stopped deliberately, reaped, or found missing at boot |
| `error` | Creation failed, or the adapter would not start |
| `deleted` | Removed. Nothing moves a row out of this state |

Deleting stops and removes the container, detaches the proxy, removes the
network, the workspace directory, the materialized agent configuration and the
home volume, and clears the session's pending requests and log rows. Nothing refers to either once the session is
gone, so they go with it rather than being left orphaned.

At boot, `reconcile` lists containers by the `boxes.session` label and aligns
the stored rows with them: live containers are adopted, missing ones are marked
stopped, and every running session's proxy attachment is re-checked. Turn flags
are cleared, because a turn cannot survive the restart that killed the
connection owning it.

## Where a session's files live

A session's workspace is a directory under the orchestrator's own data
directory — `${DATA_DIR}/workspaces/<id>` — bind-mounted at `/workspace` in
the session container. It used to be the named volume `ws-<id>`, mounted only
into that container, which left the orchestrator with no filesystem path to
the agent's work at all: reaching a file meant a `docker exec`.

The change is what makes reviewing a session's code possible without an exec
round trip per read, without booting a stopped container, and with git run as
an ordinary child process. It grants the orchestrator no privilege it did not
already have — it holds the Docker socket — but it does expose that process to
hostile *content*, which is why the review layer keeps symlink containment and
git hardening as maintained invariants, each in one file with a test.

The home volume stays a named volume. It holds thread transcripts and whatever
credentials a login inside the session created; nothing outside the container
reads it, and review has no business there.

**Naming the bind source.** Bind sources are resolved by the Docker daemon,
not by the process asking for the mount, so the orchestrator cannot hand the
daemon its own `/data/workspaces/<id>`. At boot it identifies its own
container — from `/proc/self/mountinfo`, `/proc/self/cgroup` or
`/etc/hostname`, whichever answers — and takes the `Source` of the mount whose
`Destination` is `DATA_DIR`. With the shipped compose that is
`/var/lib/docker/volumes/boxes-data/_data`, a plain daemon-side directory that
binds the same way on Linux and inside Docker Desktop's VM. Outside a
container the two paths are the same and the inspection is skipped. Where
neither works — a nested or rootless daemon, a compose file mounting a real
host directory — `HOST_DATA_DIR` names it outright. Getting this wrong would
be silent, since the daemon would create an empty directory at the unresolved
path and mount that, so a failure to resolve it is fatal at boot.

**Ownership.** A bind mount, unlike a named volume, is not
ownership-initialised by Docker, so every path the orchestrator creates in a
workspace is chowned to uid 1000 — the session image's `agent` user, named as
a constant in `workspaces.ts`. That is what lets the agent write in its own
workspace, and lets it edit or delete the `REVIEW.md` the review surface
writes there. `workspaces/` itself is 0700: one session's files are not
another's, and the only thing that reads across all of them is this process.

**Sessions from before the change** keep their `ws_volume` and a null
`workspace_dir`, and migrate at their next start, which is the only moment a
container can be recreated with a different mount. The order loses nothing at
any step: create the directory, copy the volume into it through a one-shot
helper container that can see both (`cp -a`, which preserves the agent's
ownership), recreate the session container with the bind, start it, and only
then delete the volume. A crash before the row is updated leaves a
volume-backed session that migrates again on the next attempt. A *running*
legacy session is left alone and comes through at its next stop/start cycle.

## What the agent is configured with

An `AGENTS.md`, skills and slash commands are managed from the dashboard and
stored in the database, in named *sets*. The set `global` is seeded by the
migration that creates the tables and goes into every session; a session may
name one more, and `agents.ts` merges the two. `AGENTS.md` files are
concatenated, global first — prose accumulates, and a set should add to the
house rules rather than silently replace them. Skills and commands are a union
by name, the named set winning, because two files cannot share one name and
"the same command, but for this project" is the thing the second set exists to
express.

**The database is the truth and the files are derived from it.** At every
create and every start, a session's merged set is written to
`${DATA_DIR}/agents/<id>` and bind-mounted **read-only** at `/boxes/agent`. The
layout is already the one it takes under `~/.claude` — `CLAUDE.md`,
`skills/<name>/SKILL.md`, `commands/<name>.md` — so the entrypoint copies and
interprets nothing.

**Why the copy exists at all.** `~/.claude` is on the home volume, which the
orchestrator has no path to and has no business in: it holds the transcripts
and whatever a login inside the box created. Mounting over it read-only would
break the box; mounting it writable would let the agent edit what the dashboard
says is configured. So the configuration arrives beside `~/.claude` and the
entrypoint installs it.

**The manifest is what makes the install reversible.** The materialized
directory carries a `manifest` naming every path in it. The entrypoint removes
exactly what the *previous* start recorded in `~/.claude/.boxes-managed`,
installs the current manifest, and leaves a copy of it behind. So a skill
deleted in the dashboard disappears from the box, while anything the agent
itself put in `~/.claude` is never touched. Manifest lines are checked, not
trusted: they decide what gets deleted.

**An edit reaches a box at its next start**, and the UI says so. A half-live
mechanism that reloaded an `AGENTS.md` but not a skill would be worse than a
rule anyone can state.

Two details follow from Docker rather than from the design. The materialized
directory's contents are replaced in place and its inode kept, because a
running container has it bind-mounted and swapping the directory would leave
that container mounted on an unlinked one. And a session created before this
existed has no such mount — mounts are fixed when a container is created — so
`start` recreates its container once, the same trade `migrateWorkspace` and
`rollOntoCurrentImage` make and cheap for the same reason. That check runs
*after* the image roll, because a roll recreates the container from
`containerSpec`, which already binds the configuration: a session that moves
image comes back with the mount and the check finds nothing left to do. The
other order would recreate the same container twice.

Deleting a set is not blocked. Sessions that named it keep running and keep
what is installed in them; the foreign key clears the column and they fall back
to the global set alone at their next start.

## Code review

The review surface browses a session's workspace, shows a file highlighted,
takes a comment on a line, and writes all of it to `/workspace/REVIEW.md`. The
format is the desktop [`review`](https://github.com/splitbrain/review) tool's —
`orchestrator/src/review/fixtures/` holds files that tool wrote, and the tests
assert the bytes — though byte compatibility is no longer a design constraint:
the paths in it are workspace-relative, and the file sits above any repository
rather than inside one.

What it buys over running that tool separately is that the review lives where
the agent works. `REVIEW.md` is a file of the workspace under review, so
"address the comments in REVIEW.md" is a one-line prompt, and the review view
and the thread close a loop rather than being two applications.

**REVIEW.md is the single source of truth.** There is no annotation table.
Every mutation is read → parse → apply → serialize → write-tmp-then-rename,
under a per-session lock, with the file's hash checked between the read and the
write. A moved hash means the agent edited the file mid-mutation, and the whole
thing is re-read and re-applied once. A lost race costs one visible refresh
rather than data, because every write re-serializes the whole parsed file. What
is written is chowned to uid 1000, so the agent can edit or delete it.

**The workspace is the review.** A session's workspace is not one repository:
the agent clones what it was pointed at, forks and clones a second thing to
compare against, checks a dependency out beside it, and sometimes ends up with
a repository inside a repository. So the root is always `/workspace`, there is
nothing to pick and nothing to switch between, and every file under it is
browsable in one tree. A repository is an attribute of a *path* rather than the
unit of the thing being reviewed: each file is shown with the status and diff
of the closest enclosing one.

That whole mechanism is a longest-prefix lookup over the discovered
repositories (`review/repos.ts`):

    repoFor('repo-a/src/x.ts')    -> repo-a
    repoFor('repo-a/inner/b.txt') -> repo-a/inner   (nested wins)
    repoFor('notes/todo.md')      -> null           (no repository)

A nested repository needs no special case — it is a longer prefix that wins —
and a file no repository claims is shown without git, which is the old
no-git-for-the-whole-session behaviour narrowed to the one file.

**Discovery** walks the workspace pruning the same ignore list the tree uses,
never following a symlink, bounded by a depth limit and a cap on directories
scanned. A directory holding a `.git` entry — file *or* directory, so
submodules and linked worktrees count — is a candidate, confirmed by comparing
`rev-parse --show-toplevel` **realpath to realpath**: git resolves symlinks, so
comparing its answer against a raw path silently loses git for every session of
any deployment whose workspace path has a linked component. Pruning the ignore
list means a repository deliberately cloned into `vendor/` is not found, which
is the right trade against an agent's `npm install`. The map is cached per
session and rediscovered by the tree fetch.

**The tree** is merged from each repository's `ls-files` with its own prefix
prepended, a walk of the space no repository claims, and the files each
repository's status reports as deleted. One filter runs over all of it: an
entry contributed by repository `P` for path `p` is dropped when
`repoFor(P + '/' + p) !== P`. That single rule makes the repositories a
partition of the workspace rather than overlapping views of it — it is what
stops an outer repository's `--others` reporting an inner work tree as one
nameless `inner/` row, and what stops the duplicate once the inner repository
contributes the same files. The merged list is sorted before the entry cap, so
a truncated tree is deterministic rather than "whichever repository was read
first". Ignored files stay hidden inside repositories and loose files all show
outside them: inside one the project has said what is noise, outside one nobody
has.

**One base expression, resolved per repository.** `main` means main-in-each,
through the merge base with that repository's own HEAD. A repository the
revision names nothing in falls back to its own working tree rather than
failing the request; a 400 comes back only when it resolves nowhere. Only the
expression is stored — what it resolves to is a different commit in each
repository and in some of them none, so it is derived.

**`REVIEW.md` is at `/workspace`**, outside every repository, so it cannot be
accidentally committed or show up in a repository's own status, and "address
the comments in REVIEW.md" stays one line however many repositories there are.
Its paths are workspace-relative (`repo-a/src/x.ts`). Byte compatibility with
the desktop tool's format is kept but is no longer a design constraint.

**Nothing here starts a container.** Reads and git both run in the
orchestrator, so the natural moment to review — the agent is done, the box has
idled out — costs nothing, and none of these endpoints touches a session's
activity timestamp: polling a review must not hold off the reaper.

**Freshness is the fetch.** There is no poll and no fingerprint endpoint. Every
review fetch already reads the filesystem on the spot — the tree endpoint runs
`ls-files` and `status` per request, the file endpoint reads the file, and
drift recomputes on both — so what matters is being fresh *on arrival*, and
arrival is three moments: the view mounting, a file closing back to the tree,
and the tab becoming visible again. The last of those is skipped while a
composer is open or a write is in flight, which is the one piece of the poll's
logic worth keeping.

The poll it replaced was described here as three cheap local hashes; it was
three git processes, and under a merged tree it would have been roughly
`1 + 2N` for N repositories every five seconds per open review. More to the
point, a poll keeps a view fresh *while the reviewer sits on it*, which is the
desktop tool's situation — Boxes is driven from a phone and the reviewer is in
the thread or in the review, not both. Idle cost is now zero.

The residual is that a background task can be working while the review is open.
Drift already covers the consequence: a comment whose code moved follows it, and
one whose code is gone is marked `(outdated)`. If that ever proves insufficient
the answer is a refresh button, not a watcher — Node's recursive `fs.watch` on
Linux is one inotify watch per directory, `fs.inotify.max_user_watches` is a
host sysctl a container cannot raise, and an agent running `npm install` makes
tens of thousands of directories.

**Drift** ports from the desktop tool as-is: each annotation stores three lines
of context above and below the annotated line, and a check compares the stored
context against the current source, relocating on an exact match elsewhere and
marking `(outdated)` when it is gone. It runs on a file fetch and, across every
annotated file, on a tree fetch.

**Two invariants, one file each**, because the orchestrator now reads a tree
the agent controls:

- Symlink containment lives in `review/fs.ts`. Every client path resolves
  through `realpath` and must land under the workspace's own realpath; a symlink
  final component is refused outright, since what it points at can change after
  the tree was listed. The rule is unchanged by the review spanning a whole
  workspace — what changes is that a contained path may now be in any
  repository, or in none. The residual `realpath`/open race is documented where
  the check is, along with what closing it would cost.
- Git hardening lives in `review/git.ts`. Repo-local config executes commands
  on exactly the operations review runs — `core.fsmonitor` on status, external
  diff drivers and `textconv` on diff. Every invocation takes its argv prefix
  and environment from one builder there, and a test plants both configs in a
  repository and asserts the hook never ran. The prefix is built per
  invocation, so `safe.directory` is scoped to the repository being asked
  rather than to one root.

### The review view

`/sessions/:id/review`, with the open file in the search string
(`?path=src/app.ts`) so a file is linkable and the back button works — which on
a phone is also one step of the navigation stack: sessions → thread → file list
→ file, out of each by the back button in the header and by no other control.
From `md` up the list and the file are one view, so the stack is a step shorter
there and back always leaves the review. Entry points: a
Review action in the thread header next to Fork, and one on the session card,
where it works whether or not the box is running. The view owns the whole
viewport the way the thread view does.

Boxes is driven from a phone, so the desktop tool's three panels and hover
interactions do not survive. The feature set does; the layout does not. What
replaces it is one set of components in two arrangements rather than two
parallel UIs:

- **The tree** is a column from `md` up and the screen before the file below
  it. Same component, same status colours and comment badges. It is one tree
  over the whole workspace with the repository roots marked, so the boundaries
  are visible while scrolling across them; the header says which repository the
  open file belongs to. Below `md` it is a step of the stack rather than a
  drawer over the file: a drawer would be a second door to the screen back
  already reaches, and the two disagree about where you are.
- **Comments are inline**, GitHub-style, on every screen size. There is no
  right-hand sidebar to reflow away.
- **Tap replaces hover.** Tapping a line's gutter is how a comment starts;
  tapping a gutter marker opens the diff hunk as a sheet, which is also the
  only place deleted lines exist. Gutter targets are 44 px on touch.
- **Prev/next replaces the scrollbar minimap.** Annotation markers on a
  scrollbar are unusable on touch, and "the next thing that needs me" is what
  the minimap was for — so the toolbar says it directly, with counts and paired
  step buttons for changes and comments.
- **The code pane** is a CSS grid per line: a sticky line-number gutter, the
  code cell scrolling horizontally as one block, and a wrap toggle that starts
  on — a phone is narrower than most source files, so the alternative default
  puts the end of every long line off screen. Every line
  being its own element is what makes it addressable at all.

Highlighting is client-side, with Shiki: the API ships plain text and the
browser tokenizes it. Both themes are tokenized at once and travel as
`--shiki-light`/`--shiki-dark` custom properties on each span, so a light/dark
switch costs no re-tokenize. The engine is Shiki's JavaScript regex engine, so
there is no wasm fetch, and grammars load per file type on demand. The whole
review route is lazily imported, so none of it — the pane, the tree, the sheet
primitives, the engine, the grammars — is in the bundle a browser opening a
conversation downloads.

Server-side highlighting was considered and dropped: it puts render markup on
the wire, couples the orchestrator to presentation, and the phone still has to
paint it.

Beyond that: paths are validated against the tree, not merely against the root,
so the API serves what the browser was offered; every refusal is the same 404;
file reads are capped at 2 MiB and binaries are refused by a NUL sniff; and
file content and comments are agent-influenced, so the frontend renders them as
text nodes only.

## Network isolation

Two legs, both in Docker's own primitives. Nothing touches the host firewall
and no service needs `NET_ADMIN`.

Every session network is created `internal`: no NAT, no default route. An agent
has no L3 path to the LAN, the internet, or another session. The egress proxy
is then attached to that network under the alias `proxy`, and the container
gets `HTTP_PROXY` and `HTTPS_PROXY` pointing at it. Every proxy-aware client
honours those; anything else has no route out, which is the intended failure
mode.

The proxy itself (`proxy/src/`) runs three listeners:

| Listener | Bound to | Role |
|---|---|---|
| front door | `0.0.0.0:3128` | Faces the sessions: allowlist, vetting, and the choice between an opaque tunnel and interception |
| interception engine | loopback, ephemeral | Terminates TLS for translated hosts and swaps the credential (`inject.ts`, on mockttp) |
| upstream tunnel | loopback, ephemeral | The one place a connection actually leaves, so both routes out are vetted identically |

The front door (`forward.ts`) handles plain HTTP with an absolute request URI
and CONNECT. Only ports 80 and 443 are allowed. Its critical rule is in
`vetTarget`: check the allowlist, resolve the hostname, reject if **any**
resolved address is private, then connect to one **vetted address** without
resolving again. Checking every answer and pinning the connection is what
closes DNS rebinding, since a hostname must not pass with a public record and
connect with a private one. `cidr.ts` holds the range checks; v4-mapped and
v4-compatible IPv6 forms are vetted as the IPv4 address they reach, and
unparseable input fails closed.

The design fails closed. If the proxy is down or detached, sessions have no
egress at all, because there is no direct route to fall back to.

### The allowlist

`EGRESS_ALLOWED_HOSTS` is one deployment-wide list, checked at CONNECT before
any DNS lookup. Exact names and one-label wildcards — `*.example.com` matches
`a.example.com` and neither `example.com` nor `a.b.example.com` — matched
case-insensitively, with address literals matched only as literals. Empty is
off: any public host, private ranges still denied. A configured credential's
hosts are implied members, so a narrow list cannot sever the traffic the proxy
exists to authenticate. The grammar lives in `policy.ts` as pure functions.

### Token translation

A session holds placeholders. Real credentials exist only in the
orchestrator's environment and in the proxy's memory.

A host becomes a *translated host* when its credential is configured. Reaching
one, the front door hands the CONNECT to the interception engine instead of
tunnelling it — by replaying the CONNECT on loopback, so the engine picks the
certificate for the host the client actually asked for. The engine terminates
TLS under the deployment CA and `decideCredentials` rules on the request:

| The request carries | What happens |
|---|---|
| the deployment's placeholder | rewritten to carry the real credential |
| any other credential | 403 from the proxy; nothing reaches the host |
| no credential | forwarded unauthenticated, as it always was |

The swap is value-level: the placeholder is replaced wherever it appears in the
credential header, which covers `Bearer <p>`, `token <p>`, a bare value, and
the HTTP Basic pair git's credential helper produces — one mechanism instead of
a rule per tool.

Everything else stays an opaque tunnel that never reaches the engine, so
interception is bounded by policy rather than by trust in the engine. And every
request the engine forwards leaves through the upstream tunnel, so the vetting
above governs the connection that actually happens: decrypting a host buys it
no way around the checks.

`api.anthropic.com`, `github.com`, `api.github.com` and
`*.githubusercontent.com` are the translated hosts, fixed in `config.ts`
alongside the headers each credential travels in. They are facts about the
services rather than preferences, so they are not configurable.

### The control channel

The proxy has no configuration file, no database and no CA on disk. It boots
empty and the orchestrator pushes it a policy — the allowlist, the CA key and
certificate, and the credential map — over an HTTP endpoint on the compose
network, held in memory only.

Two things keep it out of a session's reach. It binds to the compose network
alone: sessions sit on internal networks with no route to that address, because
the proxy bridges them at L7 and does not route. `control.ts` finds that
address by asking the kernel which local address the default route uses, which
is an exact description of the compose interface, since internal networks
install no default route; failing that it binds to loopback, because no control
channel is a safe failure and an exposed one is not. And it requires a bearer
token that nobody configures: the first push over that interface claims the
channel and every later push must match it.

The orchestrator's side is `egress.ts`. The CA and the placeholders are
generated once and persisted in `DATA_DIR` at mode 0600, beside the generated
WebSocket token — regenerating them per boot would strand every running
session, which holds the old certificate in its trust file. Rotation is
deleting that file.

## State, and where truth lives

Docker is the runtime truth. SQLite holds metadata, and the two are reconciled
at boot and on every read that reports container state.

`orchestrator/src/db.ts` opens the database in WAL mode under `DATA_DIR` and
applies migrations tracked by `user_version`.

| Table | Holds |
|---|---|
| `sessions` | One row per session: names, Docker object names, status, which thread is the default, timestamps |
| `threads` | One row per conversation: which session owns it, the adapter's id for it, the agent's title, its ordinal, whether a turn is running on it |
| `pending_requests` | Permission requests waiting for a browser, each recording the thread that asked |
| `acp_log` | A debug tap of forwarded messages, ring-pruned to 5000 rows per session. An image or audio block's base64 payload is replaced by its size on the way in — a screenshot is a megabyte of it, the row is truncated at 64,000 characters anyway, and the bytes were never what the log is read for |
| `exec_log` | Local commands and their output, ring-pruned to 200 rows per session |
| `push_subscriptions` | One row per browser registered for Web Push, keyed by the push service's endpoint |
| `agent_sets` | One row per named set of agent configuration, plus its `AGENTS.md`. The row `global` is seeded and applied to every session |
| `agent_items` | The skills and slash commands of a set, keyed by set, kind and name |
| `counters` | The subnet allocation counter |

Two kinds of state deliberately stay out of the database. Secrets live only in
the environment, in the session containers, and in the generated token file;
`log.ts` redacts anything credential-shaped before it reaches stderr. Thread
transcripts live in the session's home volume, read back by the adapter.

Pending requests are the one place where the database and memory both matter.
The row lets the dashboard show that something is waiting and survives a
restart; the resolver that answers the request is in memory only, so
`clearStale` drops rows left behind by a previous process.

## Background loops

| Loop | Interval | Does |
|---|---|---|
| Reaper (`reaper.ts`) | 60s | Stops sessions that are idle on all five counts: no running turn on any thread, no waiting permission request, no attached browser, no background task still believed to be running, and no activity for `IDLE_STOP_MINUTES`. It never deletes. The turn count is derived from the threads; the rest stay session-scoped, because they are about the box rather than the conversation |
| Proxy reconciler (`reaper.ts`) | 60s | Re-asserts both halves of the proxy's state: its attachment to every running session's network, which `compose up` can drop by recreating the container, and the policy it holds, which a restart erases entirely. Both show up in `/healthz` |
| Maintenance | 60s, with the reaper | Prunes each session's debug log to its ring size |

The dashboard polls `GET /api/sessions` every 5 seconds while its tab is
visible, and pauses while it is hidden.

## Configuration and secrets

`config.ts` parses the environment once at boot with zod, so a misconfigured
deployment fails at startup rather than at first use. Every setting has a
working default, which is why the stack runs with no `.env` at all.

That file is the only place a default is written down, and the only place
that knows which settings exist. `compose.yaml` hands the orchestrator an env
file wholesale (`BOXES_ENV`, defaulting to `.env` and optional), so adding a
setting means editing the schema and nothing else. It sets no value at all.
The one thing it names is the two credentials, listed with no value so that
they can be exported in a shell rather than written down at all. The cost is
that `environment` overrides `env_file` whether or not the shell has a value,
so those two names cannot come from a `BOXES_ENV` file outside the repo —
they come from the shell or from `./.env`, which compose reads for both.
Every other setting is unaffected. Where compose has to agree with a default
— `/data`
for the volume mount, `boxes-egress-proxy` for the container the orchestrator
attaches to session networks — it agrees by using the same value, not by
restating it as configuration, and the comment at each site says which
default it is matching.

`DATA_DIR` and the rest stay configurable because the orchestrator also runs
outside a container, under `npm run dev` and in its own tests. Inside the
image every default is already the right answer, which is why compose passes
an env file and otherwise stays out of it.

An empty value counts as unset. `SESSION_MEM_LIMIT=` in an env file arrives
as an empty string, and failing the boot on a setting nobody set would be a
poor way to read it.

`WS_AUTH_TOKEN` is the exception, because a shipped default for a secret would
be a published password. Left unset, `secret.ts` generates a token on first
boot and writes it to `DATA_DIR/ws-auth-token` with mode 0600, so it survives
restarts and rebuilds. Setting the variable wins, which is also how the token
is rotated.

The same reasoning covers the egress material. `egress.ts` generates the CA,
the placeholders and the control-channel bearer on first boot and stores them
in `DATA_DIR/egress-secrets.json` at mode 0600. They are generated rather than
configured, and they persist rather than being regenerated, because running
sessions hold them.

Profile credentials — the Claude token, the GitHub token and the git identity —
are injected into a session container at create time and nowhere else. With
translation on, what is injected is a placeholder: the real value never enters
a session container, and never reaches a filesystem outside the orchestrator's
own data volume. The CA certificate travels the same path, as
`BOXES_PROXY_CA`, which the entrypoint writes to `~/.boxes/proxy-ca.crt` for
the four CA-trust variables to point at.

## Build-time pins

The ACP adapter version is pinned in `session-image/Dockerfile` rather than in
configuration, so the running agent is the one this commit names and no `.env`
entry can change it.

Frontend dependencies are pinned in `dashboard/package.json` and resolved by
`package-lock.json`, which every Docker stage installs with `npm ci` rather
than `npm install`. `@assistant-ui/react` and `@assistant-ui/react-markdown`
carry exact versions rather than ranges: the composer's history behaviour
comes from a hook upstream documents as unstable, so the version that behaves
is the version that ships.

Every package type-checks before it bundles, in its own Docker stage, so an
image cannot be built from code that fails `tsc --noEmit`.

## Code map

```
orchestrator/src/
  index.ts              Boot, the WS upgrade, the background loops, shutdown
  app.ts                REST routes, the exec endpoint, the static bundle
  exec.ts               Local commands: limits, streaming, the exec log
  config.ts             Environment parsing, and the translatable credential set
  secret.ts             WS auth token: configured, stored, or generated
  notify.ts             "A thread wants you", pushed to every subscribed browser
  push.ts               VAPID and RFC 8291 payload encryption, on node:crypto
  egress.ts             CA and placeholders, the policy, and the push to the proxy
  db.ts                 SQLite, schema migrations, the debug log
  sessions.ts           Session lifecycle, the owner of every UpstreamSession
  workspaces.ts         Workspace directories on the data volume: paths, ownership
  agents.ts             Agent sets: AGENTS.md, skills, commands; the merge and the materialized bundle
  docker.ts             Containers, networks, volumes, the adapter exec
  review/
    service.ts          Per-session façade: the repo map, the REVIEW.md read-modify-write, the routing
    repos.ts            Which repositories the workspace holds, and which owns a path
    store.ts            REVIEW.md: parse, serialize, mutate, drift (pure)
    gitstatus.ts        Porcelain and name-status parsing, base resolution, the merged workspace layer
    difflines.ts        Unified diff to line markers, hunks and deletion markers (pure)
    tree.ts             Per-repository ls-files plus a walk of what none of them claims, merged
    fs.ts               Contained reads and writes under the workspace: the symlink invariant
    git.ts              The one place a git process is spawned: fixed argv, scrubbed env
  subnet.ts             Per-session /24 allocation
  reaper.ts             The idle reaper and the proxy reconciler
  log.ts                Structured stderr logging with secret redaction
  gateway/
    activity.ts         Whether the agent is talking on a thread, which silence is the only evidence of
    background.ts       What a session left running in the background, so the reaper waits for it
    upstream.ts         One persistent ACP client per session, carrying every watched thread
    downstream.ts       One ACP agent connection per browser, pinned to one thread
    broadcast.ts        Which browsers each adapter update goes to, routed by thread
    pending.ts          Permission requests waiting for an answer

proxy/src/
  main.ts               The three listeners, the in-memory policy, the denial tally
  forward.ts            Absolute-URI HTTP and CONNECT: allowlist, vetting, pinning
  policy.ts             Allowlist grammar and the credential decision, as pure functions
  inject.ts             TLS interception and the swap, on mockttp
  control.ts            The authenticated policy push, and where it may be reached
  cidr.ts               Resolved-IP vetting, the security boundary

dashboard/
  index.html            Vite entry; the dark class before first paint, and what makes the app installable
  public/               Served from the bundle root: the service worker, the manifest, the icons
  vite.config.ts        React, Tailwind, the dev proxy, both test projects
  components.json       Where the shadcn and assistant-ui CLIs install to
  e2e/                  Browser tests, and the stub orchestrator and gateway
  src/
    main.tsx            React mount and the routes
    globals.css         The whole design system: tokens and the @theme bridge
    api.ts              Typed fetch client
    stores/
      sessions.ts       Polled session list and health, read by useSyncExternalStore
      push.ts           Web Push registration: the service worker, the subscription, the toggle's state
      thread/
        acp-types.ts    The slice of the ACP schema the browser speaks
        acp-client.ts   JSON-RPC over the WebSocket, and the handshake
        translate.ts    session/update notifications → a message model (pure)
        thread-store.ts The live thread: messages, modes, models, approvals, exec
        convert.ts      That model in the shape the runtime reads
        exec.ts         !bang commands against the exec endpoint
    hooks/              What the views share: the header stepping aside, a thread following its own output
    views/              SessionList, SessionCreate, SessionThread, SessionInfo, AgentSets
    components/
      Spinner.tsx       The one thing that says "working": blocks-wave, in every running state
      assistant-ui/     Installed registry sources, ours to edit
      ui/               Installed shadcn primitives

shared/
  types.ts              REST shapes and the control-channel contract
  task-notifications.ts How a background task reports in, read by both sides
session-image/          The per-session container image and its entrypoint
scripts/                Security smoke test and credentialed live test
```

## Testing

`scripts/smoke-test.sh` is the security gate and needs no credentials. It
creates two throwaway sessions and asserts the isolation properties from inside
one of them: no proxy-bypassing egress, no private-range access through the
proxy, no cross-session reachability, no docker socket, a read-only root
filesystem, a contained fork bomb, and that the intended egress and writes do
work. Every probe passes `curl -f`, so a 403 from the proxy leaves a non-zero
exit status.

`scripts/live-test.sh` covers what only a real inference call can prove:
subscription auth inside the container, a turn running to completion after the
browser leaves, the thread replaying on reattach, and a permission request held
with nobody watching.

The review surface is tested at three levels, because it has three kinds of
thing to get wrong. The format is asserted byte-for-byte against REVIEW.md
files the desktop tool's own Go code wrote (`orchestrator/src/review/fixtures/`,
with its own README on provenance), the same reviews being rebuilt from the same
inputs and each file round-tripped. The invariants have tests that are the
attacks: a symlink out of the workspace, a symlink through a directory, and a
traversal all coming back as the same 404, and a repository-local
`core.fsmonitor` and `textconv` planted in a real repository with an assertion
that neither ever ran. The seven routes are driven over their real handlers, a
real database and a real git repository in a temp directory — no Docker at all,
which is what stage one bought for the tests as much as for the feature —
covering root resolution, drift, concurrent writes and that none of them touches
a session's activity timestamp.

Unit tests cover the pure logic that is easiest to get quietly wrong: the
proxy's range checks, subnet allocation, the WebSocket upgrade check, update
routing with two browsers attached — including two on *two* threads, where an
update for one must not reach the other, a replay of one must not silence the
other's live updates, and an update nobody is watching is dropped — the exec
limits, the schema migrations that turned one thread per session into several
and then moved the running turn onto them, the spawn path against a stand-in
adapter — a forgotten thread costing the session only that thread, a turn
recorded against its own thread, a permission request reaching only a browser
on the asking thread, a turn announced only when nobody was watching it, and a
respawn reloading every watched thread — and the translation of ACP
notifications into the thread's message model — including replay, out-of-order
tool updates, and an update kind this build predates.

Web Push is the one piece tested against somebody else's numbers: `push.ts`
has to produce a body a browser can open, and no round-trip test can show
that, so `push.test.ts` reproduces the worked example in RFC 8291 byte for
byte and verifies the VAPID assertion against the key it advertises.

The dashboard also runs a browser suite. It builds the production bundle and
serves it the way the orchestrator does, from a stub orchestrator and a stub
ACP gateway that speaks the agent side from canned scripts — including its
own several threads per session with each socket pinned to one by its upgrade
path, so a fresh thread starting empty, a fork carrying the source's messages,
a switch bringing the first thread's transcript back, and two tabs on two
threads each keeping to their own conversation are asserted against a gateway
that behaves like the real one.
The review pages are in that suite too, on a phone viewport and a desktop one,
because the two arrangements are different enough that one passing says little
about the other: browse the tree, open a file, tap a gutter marker for the hunk,
comment on a line and see the write reach the API, edit and delete it, set a
base revision, and hand the review to the agent with the prompt staged unsent.
The degraded shapes are there as well — no git, an empty workspace, and a
session whose workspace is still a volume.
That is what asserts the UX properties this frontend exists for, and it is
where a component upgrade is reviewed: `/playground` renders every part kind over a
canned store, so a registry re-run shows up on one page.

One runner throughout: `npm test` in each package is `vitest run`.
