# Boxes

Boxes runs AI coding-agent sessions in isolated Docker containers and gives you
a mobile-friendly web UI to drive them. Each session is a long-lived container
with its own workspace directory, its own internal network, and no route out
except through a proxy that vets every destination.

Agent turns keep running when your browser goes away. The orchestrator — not
the browser — is the agent's client of record, so you can lock your phone
mid-task and find the finished thread when you come back.

- **Isolated sessions.** One container, one network, one workspace per session.
  Non-root, read-only rootfs, no capabilities, no host mounts, no published
  ports.
- **Vetted egress only.** Session networks are `internal`; the sole way out is
  an egress proxy that rejects private addresses, pins the connection to a
  vetted IP, and can be given a host allowlist.
- **No credentials in the sandbox.** Sessions hold placeholder tokens. The
  proxy swaps in the real ones on the wire, and refuses any other credential
  to those hosts — so a leaked placeholder is worth nothing.
- **One service, one port.** The orchestrator serves the UI, the REST API and
  the WebSocket gateway on `:3000`. No second origin, nothing to configure.
- **Claude Code today**, other agents later — sessions speak the Agent Client
  Protocol (ACP).

`ARCHITECTURE.md` describes how it is built.

## Requirements

- Docker with Compose v2, on Linux or macOS
- A Claude token from `claude setup-token` (subscription-based, inference only)
- Node 22+ — only if you want to develop on Boxes itself

## Install

```sh
git clone https://github.com/splitbrain/experiments.git boxes
cd boxes

docker compose up -d
```

The session image is deliberately **not** part of `compose.yaml` — the
orchestrator creates session containers at runtime, so it fetches that image
itself: once at boot when it is missing, and again every
`SESSION_IMAGE_PULL_MINUTES` so a moving tag moves here too. A session adopts
what has arrived the next time it is started.

To run one you built rather than one you pull, build it and turn the refresh
off — there is no registry to pull a local tag from:

```sh
docker build -t boxes-session:latest session-image/
echo SESSION_IMAGE_PULL_MINUTES=0 >> .env
```

Boxes is now on <http://localhost:3000>, bound to loopback because it ships
with no authentication of its own. See
[Behind a reverse proxy](#behind-a-reverse-proxy) before moving it.

### Who a session runs as

`SESSION_UID` and `SESSION_GID` are the uid and gid every session process runs
as, and therefore the owner of every file in a workspace. They default to
**1020** rather than 1000: 1000 is the `ubuntu` account the base image
carries and what a host usually gives its first login user, and a service
sharing a uid with a person is what a per-service uid exists to avoid.

One thing has to agree with them: the session image builds its `agent` user on
the same numbers, through `AGENT_UID` and `AGENT_GID` build args whose defaults
match. A session's home is a named volume, and Docker ownership-initialises a
new one from the image's own `/home/agent` — so an image built on a different
uid leaves the agent unable to write its own home, and nothing outside the
container can chown a named volume afterwards. The orchestrator reads the
image's user back at boot and warns when the two have drifted.

To run on some other uid, set both and build to match:

```sh
docker build --build-arg AGENT_UID=1000 --build-arg AGENT_GID=1000 \
  -t boxes-session:latest session-image/
echo SESSION_UID=1000 >> .env
echo SESSION_GID=1000 >> .env
```

Sessions created before a change keep the old ownership, so changing this on a
live deployment means recreating them.

### The orchestrator does not need root

It has needed it for one thing: giving each workspace directory away to the
session uid, which only root can do. Set the orchestrator's own user to
`SESSION_UID` and there is nothing to give away — `chownToAgent` returns
immediately — so it can run as an ordinary user:

```yaml
services:
  orchestrator:
    user: "1020:1020"
    group_add:
      - "<the host's docker gid>"     # getent group docker | cut -d: -f3
```

`group_add` is what keeps the Docker socket reachable. Two caveats worth being
clear about: the data directory has to be owned by that uid already
(`chown -R 1020:1020` on it), and this is tidiness rather than containment —
a process holding the Docker socket is root-equivalent on the host whatever
uid it runs as, so the authentication in front of `/api` is still what matters.

### Published images

Every push to `main` builds the three images and pushes them to GHCR, so a
deployment needs no checkout and no build:

| Image | Is |
|---|---|
| `ghcr.io/splitbrain/boxes/orchestrator` | What `compose.yaml` builds from `orchestrator/Dockerfile` |
| `ghcr.io/splitbrain/boxes/egress-proxy` | The same for `proxy/Dockerfile` |
| `ghcr.io/splitbrain/boxes/session` | The session image, which is a service in no compose file |

Each carries `latest` and an immutable `sha-<short>`. A deployment that wants
to be rolled forward by something like watchtower follows `latest`; one that
must not move under itself pins the sha.

The session image needs nothing special of the deployment: point
`SESSION_IMAGE` at `latest` and the orchestrator keeps it current itself. What
it must **not** have is an outside updater, because compose does not own those
containers and recreating one loses the id the orchestrator tracks it by and
the proxy attachment that is the session's only way out. Session containers
therefore carry `com.centurylinklabs.watchtower.enable=false`, which watchtower
and the tools that copy it honour.

`.github/workflows/publish.yml` is the workflow, and the test suites gate it.
A pull request runs the same suites and builds all three images without
pushing any of them.

A deployment fronted by watchtower can be told to pull rather than left to
find out on its next poll. Set two things on the repository and the last job
of every publishing run pings it:

| Setting | Is |
|---|---|
| `WATCHTOWER_URL` (variable) | The update endpoint, such as `https://watchtower.example.net/v1/update` |
| `WATCHTOWER_HTTP_API_TOKEN` (secret) | What watchtower was started with as `WATCHTOWER_HTTP_API_TOKEN` |

Without the variable the job says there is nothing to notify and passes, so a
fork publishing to its own namespace needs no changes. With it, a ping that is
refused fails the run: the images are already published at that point, and a
deployment that quietly stayed where it was is worth a red check.

## Configure

There is no required configuration — every setting has a working default. To
change one, copy `.env.example` to `.env` and edit it. To keep the file out of
the repo, point at it instead:

```sh
BOXES_ENV=~/.config/boxes.env docker compose up -d
```

To actually run an agent turn you need one credential:

```sh
claude setup-token          # then export it, or put it in ./.env
export PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
docker compose up -d
```

The two credentials are the only settings compose takes from the shell, so
they need never be written down. That is also why they are the only two a
`BOXES_ENV` file cannot carry — use the shell or `./.env` for those, and the
env file for everything else.

Without it, sessions still start and the UI still works — only inference
fails. Alternatively skip the variable and log in inside a session, which
keeps the credential in that session's home volume and out of every file:

```sh
docker exec -it session-<id> claude /login
```

### Settings

| Variable | Default | What |
|---|---|---|
| `BIND_ADDR` | `127.0.0.1` | Interface the port is published on |
| `HOST_PORT` | `3000` | Published port |
| `PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN` | — | Claude token; without it no turn can run |
| `PROFILE_DEFAULT_GH_TOKEN` | — | Classic GitHub PAT for the bot account |
| `PROFILE_DEFAULT_GIT_NAME` | `boxes-bot` | Git author name in sessions |
| `PROFILE_DEFAULT_GIT_EMAIL` | `boxes-bot@users.noreply.github.com` | Git author email |
| `WS_AUTH_TOKEN` | generated | Gateway bearer token; generated on first boot into `/data/ws-auth-token` and reused |
| `SESSION_IMAGE` | `boxes-session:latest` | Image sessions run |
| `SESSION_UID` | `1020` | uid session processes run as, and the owner of every workspace file. The session image must be built on it |
| `SESSION_GID` | `1020` | gid to match |
| `SESSION_IMAGE_PULL_MINUTES` | `60` | How often that image is pulled again; `0` never, for one built on the host |
| `SESSION_SUBNET_POOL` | `10.200.0.0/16` | Pool sessions get a `/24` from |
| `SESSION_MEM_LIMIT` | `4g` | Per-session memory cap |
| `SESSION_CPUS` | `2` | Per-session CPU cap |
| `SESSION_PIDS_LIMIT` | `512` | Per-session pids cap |
| `IDLE_STOP_MINUTES` | `30` | Idle time before a session container is stopped |
| `BACKGROUND_TASK_MAX_MINUTES` | `240` | Longest a background task holds that stop off |
| `MAX_ATTACHMENT_MB` | `25` | Largest single file a prompt may carry into a workspace |
| `PERMISSION_FALLBACK` | `hold` | `hold` or `deny` for an unanswered permission request |
| `PERMISSION_HOLD_MINUTES` | `120` | How long before that fallback applies |
| `PUSH_SUBJECT` | project URL | Contact in the VAPID assertion Web Push carries |
| `DATA_DIR` | `/data` | Database, generated token and session workspaces, inside the volume |
| `HOST_DATA_DIR` | resolved | Host-side path of `DATA_DIR`, which a workspace bind mount has to name. Resolved at boot by inspecting the orchestrator's own container; set it only where that cannot work |
| `EGRESS_PROXY_CONTAINER` | `boxes-egress-proxy` | Proxy container the orchestrator attaches to session networks |
| `EGRESS_ALLOWED_HOSTS` | — | Hosts sessions may reach; empty means every public host |

Everything is parsed and validated at boot, so a bad value fails startup
rather than surfacing later. `orchestrator/src/config.ts` is the full list.

## Run

```sh
docker compose up -d          # start
docker compose logs -f        # follow
docker compose down           # stop
```

Health check and verification:

```sh
curl localhost:3000/healthz
API_BASE=http://localhost:3000 ./scripts/smoke-test.sh
```

The smoke test needs no credentials: it creates throwaway sessions, asserts the
isolation properties from inside a container, and cleans up. Run it after any
change to networking, the proxy, or the session image. Where the deployment
*has* configured credentials or an allowlist, it additionally proves that no
real credential is inside a session and that the allowlist bites.

## Use

Open <http://localhost:3000>.

**Create a session.** Give it a name. The session gets its own container,
network and storage, and its workspace starts empty — tell the agent what to
fetch into it. If the deployment has any agent sets beyond the global one, pick
which of them this box gets.

**Talk to the agent.** Tap a session card to open its thread. That is the whole
interface: type, and the turn runs in the container. Close the tab or lock your
phone whenever you like; reattaching replays the thread from the session's own
history — including a turn that is still running, which comes back mid-flight
rather than looking finished. Opening a stopped session starts it again.

The tab's title is the box and the conversation, behind a symbol for what that
thread is doing: `⟳` running a turn, `⚠` waiting for a permission decision,
`?` waiting for an answer, `○` idle. Several boxes in several tabs is the
normal way to use this, and the symbol is the part a narrow tab still shows.

**Watch it think.** A turn shows the agent's reasoning as a collapsed
*Reasoning* line above what it does, streaming while it goes. The sliders in
the thread's header hold everything the agent offers — its mode, its model,
its effort level, and whatever else the adapter advertises. All of it is per
conversation.

**Watch work that reports back later.** A command left running in the
background, a subagent, a monitor — none of them answers into the turn that
started it. When one has something to say it wakes the agent, and the thread
shows that as a row of its own rather than as a message from you: what
happened, and what the task said. A monitor's event is there to read; a
finished task's answer is folded under its summary and opens on a tap.

**Work in two threads at once.** A session can hold several conversations on
one workspace, listed under its card, each with its own link. **Fork** branches
the one you are in, and the button offers to open it in a new tab — so you can
ask the fork about what the original is doing without stopping it or losing
your place. It opens on everything that was said up to the branch, and goes
its own way from there. A fork starts in `plan` mode, because it shares the original's
checkout and two agents editing the same files at once is a mess neither can
see; flip it to `auto` under the header's sliders when that is what you want.

**Attach a file.** The `+` under the composer takes anything — drop it on the
thread or paste it, on a phone as much as on a desktop. Whatever it is, it is
uploaded into that session's workspace under `.boxes/attachments/`, and the
prompt tells the agent the path, the type and the size, so it opens a
screenshot, a PDF or a CSV with the tools it already has. Nothing is carried
in the message itself, so an attachment costs context only when the agent
reaches for it. Images still show in the thread, served back from the
workspace, and anything else reads as a chip you can tap — a PDF opens in a
tab. The files stay there afterwards, and a `.gitignore` keeps them out of
any repository you are working in.

**Run a shell command with `!`.** A composer line starting with `!` runs as
`bash -lc` in the session container and never reaches the model — no tokens
spent, no chance of it being read as an instruction:

```
!npm test
!git diff --stat
```

Output is printed as it arrives, as a code block ending with the exit code.
Commands are capped at 120 seconds and 256 KiB of output.

**Review the code.** **Review** on a session card, or the magnifier in a
thread's header, opens the session's workspace as a review: browse the files,
read one highlighted, and tap a line to leave a comment. Git statuses colour the
tree, changed lines are marked in the gutter, and tapping a marker shows the
diff hunk — including the lines that were deleted, which the file itself cannot
show. **Compare against** a branch, tag or commit to review a whole branch's
work rather than only what is uncommitted.

Comments are written to a `REVIEW.md` at the root of what you are reviewing, in
the workspace. That is the point of having this here rather than beside it:
**Hand to agent** opens the thread with "Read REVIEW.md and address the comments
in it." waiting in the composer — staged, not sent. The agent can edit and
delete the file too, and a comment whose code has since moved follows it, or is
marked as no longer matching.

The format is the desktop [`review`](https://github.com/splitbrain/review)
tool's, byte for byte, so a review started in one can be continued in the other.

Reviewing needs no running container — the files are a directory on the
orchestrator's data volume — so the natural moment, once the agent is done and
the box has idled out, costs nothing. A session created before Boxes stored
workspaces this way says so and asks you to start it once, which migrates it.

**Configure the agent.** The sliders in the session list header open **Agent
configuration**: an `AGENTS.md`, skills and slash commands, managed here rather
than pasted into every box.

They live in *sets*. The **Global** set goes into every box and cannot be
deleted. Any other set is optional: a box names at most one when it is created,
and the two are merged —

| | How the two sets combine |
|---|---|
| `AGENTS.md` | Concatenated, global first, separated by a blank line |
| Skills | Union by name; the named set's replaces the global one of the same name |
| Slash commands | Same |

— and the set's editor shows the result, so an override is never silent.

**The session image is a third layer, underneath both.** A skill the image
ships — `playwright-cli`, for the browser, is the only one today — is installed
into a box only when no set in its merged configuration claims that name. So
the same rule runs all the way down: the more specific configuration wins, with
the image least specific of all. Define a `playwright-cli` skill in a set and
the box gets yours; delete it again and the image's comes back at the next
start. The one thing the editor cannot show is that bottom layer, because it
lives in the image rather than the database — so if a skill you did not write
turns up in a box, this is where it came from.

Inside the box, the merged set is installed into the agent's own configuration:
the `AGENTS.md` as its user-level memory, so it applies wherever in the box the
agent is working; a skill as `skills/<name>/SKILL.md`, which needs YAML front
matter naming and describing it or it is not loaded at all; a command as
`commands/<name>.md`, invoked as `/<name>` in the composer.

**An edit reaches a box the next time that box starts.** Nothing is pushed into
a running one. Stop and start it, or create a new one.

**Answer permission requests.** When the agent asks to do something requiring
consent, the request goes to a browser watching the thread that asked. With
nobody on that thread it is queued, you are notified, and it is delivered to
the next browser to open it. Nothing is ever auto-approved.

**Manage the session.** The ⓘ corner of a card opens its details and controls:
start, stop, delete, the container and network names, and the WebSocket URL and
bearer token for attaching your own ACP client. Deleting removes the storage
too, so the agent's work and the thread history go with it.

Idle sessions — no turn on any thread, no waiting request, no attached browser
— are stopped after `IDLE_STOP_MINUTES`. They are never deleted. Work left
running in the background counts as not idle: a command still going or a
monitor still watching holds the stop off, for up to
`BACKGROUND_TASK_MAX_MINUTES` from the call that started it. So backgrounding
a long build and closing the tab is safe, and a box whose task ended without
saying so is stopped late rather than never.

## Notifications

A box that wants something tells you whenever **nobody is watching that
thread**: a permission request has been queued, or a turn has finished. A
turn finishing in front of you is not announced — that is the screen you are
already looking at.

**Web Push** is the one channel, and it reaches a browser with no tab open,
which is the case the feature exists for: lock your phone mid-turn and the
answer arrives on the lock screen. Tap *Notify me* on the session list to
subscribe this browser. Nothing to configure — the deployment generates its
own VAPID keypair into `/data/vapid-keys.json` on first use, and the tap is
the whole setup.

Two things it needs, both outside Boxes:

- **HTTPS.** The Push API does not exist on a page served over plain HTTP,
  `http://localhost` excepted. So push works on the loopback default and
  behind a TLS [reverse proxy](#behind-a-reverse-proxy), and not at all on a
  bare `http://192.168.x.x:3000` — the toggle says so rather than failing
  quietly. Set `PUSH_SUBJECT` to your own `mailto:` or `https:` URL so a push
  service with a problem has somebody to contact.
- **Add to Home Screen, on iOS.** Safari gives a page the Push API only once
  it has been installed. Share → Add to Home Screen, open it from there, then
  subscribe. Android and desktop browsers need no install.

Unsubscribing is the same toggle. A subscription the push service reports as
finished — permission revoked, browser uninstalled, Safari expiring it on its
own schedule — is dropped on the next attempt without anybody doing anything.

## Behind a reverse proxy

Boxes has no authentication and holds the Docker socket, so as shipped it binds
to `127.0.0.1`. Anything beyond a single-user machine needs a reverse proxy in
front — Caddy, nginx, Traefik, whatever you already run. Proxy to
`127.0.0.1:3000`, or join the `boxes_default` network and use
`orchestrator:3000` if the proxy is itself a container. Only widen `BIND_ADDR`
once something else is doing the authenticating.

Two rules:

1. **Authenticate `/` and `/api`, and terminate TLS there.** Every route is
   otherwise open, including the one that creates containers.
2. **Do not put HTTP authentication in front of `/ws`.** Browsers cannot attach
   Basic credentials to a WebSocket upgrade, so guarding it breaks every thread
   view. It does not need guarding: the gateway authenticates the upgrade
   itself against `WS_AUTH_TOKEN`.

Also forward `Upgrade` and `Connection` on `/ws`, and give it a long read
timeout — a turn can hold the socket open for minutes with nothing on it.

## What a session can reach

Two settings shape it, and both default to something safe.

**The allowlist.** `EGRESS_ALLOWED_HOSTS` is a comma or whitespace separated
list of exact hostnames and one-label wildcards:

```
EGRESS_ALLOWED_HOSTS=github.com,*.github.com,*.githubusercontent.com,api.anthropic.com,registry.npmjs.org
```

`*.example.com` matches `a.example.com`, but neither `example.com` nor
`a.b.example.com`. An address literal matches only as a literal. Leave it unset
and behaviour is what it has always been: any public host, private ranges still
denied. The hosts of a credential you configured are always reachable, so a
narrow list can never sever inference or GitHub.

**Token translation.** It is always on, and it applies to whichever credentials
you configured:

- Set `PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN`, and `api.anthropic.com`
  becomes a translated host.
- Set `PROFILE_DEFAULT_GH_TOKEN`, and the GitHub hosts do.
- Leave one unset and its host stays an ordinary tunnel, which is what keeps
  the "log in inside a session with `claude setup-token`" flow working.

For a translated host the session holds a placeholder of the same shape as the
real token, and:

```
docker exec session-<id> env | grep -c sk-ant-oat01-...   # 0
```

The proxy terminates TLS for that host under a CA generated once for your
deployment, swaps the placeholder for the real credential, and refuses any
*other* credential outright — so "api.anthropic.com is allowlisted" no longer
implies "any Anthropic account is reachable". Everything else stays an opaque
tunnel the proxy cannot read.

The real credentials live in the orchestrator's environment and in the proxy's
memory, and nowhere else. The proxy has no config file, no database and no CA
on disk: it boots empty and is handed its policy over an authenticated channel
on the compose network, which no session can route to. Restart it and the
orchestrator's reconciler pushes again within a minute.

The CA certificate reaches each session as `BOXES_PROXY_CA`, written by the
entrypoint to `~/.boxes/proxy-ca.crt`, with `NODE_EXTRA_CA_CERTS`,
`SSL_CERT_FILE`, `GIT_SSL_CAINFO` and `CURL_CA_BUNDLE` pointing at it.

### When a new tool fails TLS

A tool that honours none of those variables fails TLS against *translated
hosts only*, which is a confusing shape — everything else keeps working. The
fix is to point that tool at the same file:

| Tool | Variable | Notes |
|---|---|---|
| node, npm, anything on Node | `NODE_EXTRA_CA_CERTS` | Already set |
| curl | `CURL_CA_BUNDLE` | Already set |
| git | `GIT_SSL_CAINFO` | Already set |
| gh, and most Go tools | `SSL_CERT_FILE` | Already set |
| Python `requests` | `REQUESTS_CA_BUNDLE` | Add it, pointing at `$BOXES_PROXY_CA`'s file |
| Python `httpx`, `aiohttp` | `SSL_CERT_FILE` | Already set |
| Deno | `DENO_CERT` | Add it |
| Rust `reqwest` (rustls) | `SSL_CERT_FILE` | Already set |

Rotating the CA is deleting `egress-secrets.json` from the data volume and
restarting; sessions created before that keep the old certificate and must be
recreated.

## When an agent needs a tool the image lacks

`apt-get install` cannot work inside a session, and not by accident: the root
filesystem is mounted read-only, the agent is not root, and every capability is
dropped, so all three of the things that install needs are missing. Handing any
of them back would hand them to every session, for the sake of the one that
wanted a package.

There are two ways in, and which one you want depends on whether the tool is
this session's business or the deployment's. Before either, check whether the
toolchain is already in the image.

### Language toolchains

The image carries Node, Python, Go, Rust and PHP, so a session can work in any
of them without installing anything:

| | Version | From | Also |
|---|---|---|---|
| Node | 22 | NodeSource | npm; `NPM_CONFIG_PREFIX` is `~/.local` |
| Python | 3.14 | Ubuntu 26.04 | `python3-venv`, `pipx` |
| Go | 1.26 | Ubuntu 26.04 | `GOPATH` is `~/go`, cache `~/.cache/go-build` |
| Rust | 1.93 | Ubuntu 26.04 | `cargo`, `rustfmt`, `cargo-clippy`, `rust-src` |
| PHP | 8.5 | Ubuntu 26.04 | Composer 2.9, and the mbstring, xml, curl, zip, intl, sqlite3, gd and bcmath extensions |

`build-essential`, `cmake`, `pkg-config` and `libssl-dev` are there too, so a
crate or an extension with a native dependency builds. `uv` is installed as
well, which is worth knowing under a read-only `/usr`: `uv tool install` and
`uv python install` both write to the home volume, so a session can fetch a
Python it does not have without any privilege at all.

### Everything else in the image

The tools an agent reaches for that are not a language — reading the PDF a
ticket linked to, unpacking whatever a download turned out to be, converting a
document, poking at a database file. A read-only `/usr` means a tool that is
not here is one the agent has to build or do without mid-task, so the list
leans generous:

| | |
|---|---|
| PDF | `pdftotext`, `pdftoppm`, `pdfinfo` and the rest of poppler; `qpdf`; `mutool`; `gs`; `ocrmypdf` with `tesseract` (English) |
| Documents | `pandoc` |
| Images, diagrams | `magick` (ImageMagick 7), `dot` and the rest of graphviz |
| Archives | `unzip`, `zip`, `xz`, `zstd`, `7z`, `bzip2` |
| Files, text | `file`, `tree`, `patch`, `fd`, `rg`, `jq`, `yq`, `shellcheck`, `less` |
| Data | `sqlite3` |
| Network, VCS | `curl`, `wget`, `git`, `git-lfs`, `gh`, `dig`, `nc` |

Two notes that will otherwise cost someone an hour. `fd` is a symlink the
image adds, because Debian and Ubuntu install fd-find as `fdfind` to avoid a
name collision. And ImageMagick's shipped policy refuses PDF and PostScript
input — that is its Ghostscript hardening, left alone here — so rasterise a
PDF with `pdftoppm` or `mutool draw`, not `magick`.

Between the toolchains and these, the image is a few gigabytes; most of the
toolchain half is Rust and most of the tool half is pandoc. Worth knowing
before a first pull on a slow link, and the reason a deployment that wants a
leaner image is better off stripping what it does not need in a derived one
than with this image as shipped.

### Headless browser

`@playwright/cli` and a Chromium build are in the image, so a session can drive
a real browser: inspect a page, click and type in it, screenshot it, scrape it,
or check the dev server it just started.

**A CLI and a skill rather than an MCP server**, which is what Microsoft
themselves recommend for coding agents, and the two share an implementation —
so this gives up nothing on interaction. `playwright-cli snapshot` renders the
page as an accessibility tree with a `[ref=eN]` handle on every element, and
`click`, `type`, `select`, `hover` and the rest take those refs, so the agent
never guesses a CSS selector:

```yaml
- heading "Sign in" [level=1] [ref=e2]
- textbox "Email" [ref=e4]
- button "Continue" [ref=e5]
```

```sh
playwright-cli type e4 user@example.com
playwright-cli click e5
```

The browser lives in a daemon between invocations, so those are three separate
commands acting on one page, and each snapshot is written to a **file** with
only the path printed — which is the point of the CLI over MCP: the tree does
not land in the model's context unless the agent chooses to read it. Named
sessions (`-s=name`), tabs, network inspection, console, cookies, storage,
tracing, video and `run-code` for arbitrary Playwright snippets are all there;
`playwright-cli --help` lists them.

**Its skill comes from the package**, and the entrypoint runs
`playwright-cli install --skills --global` on every start. That writes
`~/.claude/skills/playwright-cli/` — a SKILL.md plus nine reference files
maintained by the Playwright team — rather than into the workspace, which is a
git checkout and none of the image's business. Re-running each start means the
copy in the home volume follows the image instead of being frozen at whatever
that volume was initialised with.

It runs *after* the box's own agent configuration is installed, and defers to
it: a `playwright-cli` skill in one of the deployment's sets is the one the box
gets, and the image's copy is left out. See
[Configure the agent](#use) — the image is the bottom layer of that merge.

**Three settings the CLI cannot work out for itself**, shipped as
`/usr/local/share/boxes/playwright-cli.config.json` and copied by the entrypoint
to `~/.playwright/cli.config.json`, the CLI's documented global config, with the
egress proxy added — that part is only known at runtime. A project's own
`.playwright/cli.config.json` still overrides everything.

- **`browserName: chromium`.** The CLI defaults to the `chrome` channel and
  looks for real Google Chrome at `/opt/google/chrome/chrome`. Without this the
  browser does not open at all.
- **`chromiumSandbox: false`.** Chromium's own sandbox needs a user namespace,
  and Docker's seccomp profile denies one to a container without
  `CAP_SYS_ADMIN` — which this container deliberately does not have. Left on,
  the browser dies at startup with `Chromium sandboxing failed`. Note this is
  *not* the Playwright library's default, where it is already false. The
  container is the sandbox instead: non-root, no capabilities, read-only
  rootfs, no route out but the proxy.
- **`--disable-dev-shm-usage`.** `/dev/shm` is Docker's default 64 MB, which
  Chromium exhausts on a substantial page and reports as a closed target. This
  moves that traffic to `/tmp`, already a 512 MB tmpfs.

The proxy entry carries `NO_PROXY` as its bypass list, so a dev server started
in the session is reachable while everything external still goes through the
egress proxy.

**TLS.** Chromium keeps its own trust store and reads none of the CA variables
the rest of the image is pointed at, so the entrypoint imports the deployment
CA into `~/.pki/nssdb` with `certutil`. Without it the hosts the proxy
intercepts fail TLS in the browser and nowhere else.

Two smaller things. `PLAYWRIGHT_BROWSERS_PATH` is `/opt/playwright`, on the
image and so read-only at runtime. A project pinning its own Playwright has
two ways out of that. Either download the build its version wants, once, into
the home volume:

```sh
export PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright
npx playwright install chromium
```

Or use the browser that is already here, at **`/usr/local/bin/chromium`** — a
stable link to whatever revision the image installed, which is what a test
suite can hardcode:

```js
chromium.launch({ executablePath: '/usr/local/bin/chromium' });
```

That needs no download and no egress, at the price of a Chromium a couple of
Chrome majors from the one the library pins, which Playwright tolerates until
it does not. Naming it with `executablePath` is what skips the revision check;
`channel: 'chromium'` would go looking under `PLAYWRIGHT_BROWSERS_PATH` again.
Either way, pass `--disable-dev-shm-usage`: `/dev/shm` here is Docker's
default 64 MB, which Chromium exhausts on any substantial page and reports as
a closed target. The browser CLI's own config already carries it.

And the CLI writes snapshots and screenshots to `.playwright-cli/` in the
working directory, which in a session is the workspace — convenient, since the
review surface then shows them, but worth a `.gitignore` entry in a repo the
agent works on regularly. Set `outputDir` in the config to move it.

Ask the agent to read a screenshot back and it is shown in the thread, tap to
zoom it full-screen: a `Read` of an image file returns the image itself, and
the chat renders one wherever it arrives — in a tool's result, or in what the
agent says. So "screenshot the dev server and show me" is a thing to ask for
from a phone.

**Firefox and WebKit are one download away.** Their *binaries* are not in the
image — that would roughly double the browser layer for something most
sessions never open — but their system libraries are, which is the half a
session cannot install for itself:

```sh
export PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright
npx playwright install firefox webkit
```

That is the same route as the Chromium one above and it now ends in a browser
that starts. Without the libraries in the image it did not: `apt-get` needs a
root and a writable `/usr` that no session has, so the download reported
success and the launch died on `libgtk-3.so.0` — or, for WebKit, on any of
forty-odd gstreamer and flite objects — which reads as a broken image rather
than as a missing package. The image build proves the route by walking it: it
downloads both, launches each and deletes them again, so a version bump that
breaks this stops the build rather than reaching a session.

Libraries rather than binaries is also the half that keeps. A binary in the
image would be pinned to the revision *this* image's Playwright wants, and a
project pinning its own resolves a different one and downloads it regardless —
the same reason `/usr/local/bin/chromium` exists. Library names carry no such
revision.

There is still no display, so `--headed` cannot work in any of the three.
`playwright-cli install-browser chromium --only-shell` in a derived image
drops the full browser and keeps just the headless shell if image size matters
more than the option of a headed run later. A deployment that only ever drives
Chromium drops the Firefox and WebKit libraries by deleting that block from
its own copy of the Dockerfile — a derived image cannot take them back out,
since an `apt-get purge` in a later layer removes the files without
recovering the bytes.

### The agent installs it itself

`/home/agent` is a persistent volume, so anything the agent puts there survives
restarts and image updates. The image points the user-level package managers at
`/home/agent/.local` and puts `/home/agent/.local/bin` on `PATH`, so an agent
can equip itself with no privilege at all:

```sh
npm install -g <pkg>            # prefix is ~/.local, not /usr/local
pipx install <pkg>              # PEP 668 clean; binaries land in ~/.local/bin
python3 -m venv ~/.local/venvs/<name>
```

`build-essential`, `python3` and `git` are already in the image, so packages
that compile on install do compile. `~/.local/bin` is ahead of the system path
for both a plain `docker exec` and a login shell.

A `.deb` whose *contents* are all you need takes no root either —
unpacking a `.deb` into the home volume is an ordinary file write:

```sh
apt-get download ripgrep                    # apt honours the proxy variables
dpkg -x ripgrep_*.deb ~/.local              # binaries, libs, no maintainer scripts
```

The limits are worth knowing before you rely on it: `apt-get download` fetches
the one package and not its dependencies (`apt-get install --print-uris -qq
<pkg>` lists those URLs), maintainer scripts never run, and a package that
expects to live under `/usr` may need `LD_LIBRARY_PATH=~/.local/usr/lib`. For a
CLI binary it is usually enough; for anything with a postinst it is not.

### The deployment bakes it in

For a package the sessions on this deployment should simply have — a language
runtime, a headless browser and its libraries, a database client — build an
image on top of the published one and point `SESSION_IMAGE` at it. Root at
build time, no root at runtime, and none of the container hardening changes:

```dockerfile
FROM ghcr.io/splitbrain/boxes/session:latest

# Root here, and only here.
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      postgresql-client \
 && rm -rf /var/lib/apt/lists/*

# Back to the agent, on the uid the deployment runs sessions as.
USER 1020
```

Two rules a derived image has to keep:

- **End on the agent user, not root.** The orchestrator runs the container as
  `SESSION_UID` regardless, so a stray `USER root` does not get root — but it
  does make the image's own uid wrong for the next rule.
- **Do not change the uid.** A session's home is a named volume Docker
  initialises from the image, owned by the uid the *image* was built on, and
  nothing outside the container can chown it afterwards. Build with the same
  `AGENT_UID`/`AGENT_GID` as `SESSION_UID`/`SESSION_GID`. The orchestrator
  reads the image's user back at boot and warns when they have drifted.

Set `SESSION_IMAGE_PULL_MINUTES=0` for an image built on the host, since there
is no registry to pull it from.

### What is deliberately not offered

Neither Docker-in-Docker nor a mounted Docker socket. A session with the host's
socket would have root-equivalent control of the host *and* of this deployment:
it could read every other session's workspace and `egress-secrets.json` — the
CA key and the placeholder map — which is precisely what token translation
exists to prevent. `--privileged` for a nested daemon is host root by another
route, and would apply to every session rather than the one that asked. A
session that genuinely needs to run containers wants either an opt-in
`sysbox-runc` runtime on the host, or a facility where the orchestrator creates
the container on the session's behalf from the same hardened template. Neither
exists today.

## Security model

Isolation rests on two Docker primitives, with nothing touching the host
firewall:

- **Session networks are `internal`.** No NAT, no default route: no L3 path to
  your LAN, the internet, or another session.
- **The egress proxy is the only way out.** It checks the allowlist, resolves
  the target, rejects the request if *any* resolved address is private, then
  connects to that specific vetted address without re-resolving — which is what
  closes DNS rebinding. Every connection it makes goes through that one check,
  including the ones it makes on behalf of a translated host. If the proxy is
  down, sessions have no egress at all.
- **Credentials never enter the sandbox.** See
  [What a session can reach](#what-a-session-can-reach).

Session containers additionally run as a non-root user with `ReadonlyRootfs`,
`CapDrop: ALL`, `no-new-privileges`, a tmpfs `/tmp`, and memory, CPU and pids
limits.

Known residual risks, accepted deliberately:

- Host services bound to `0.0.0.0` stay reachable from inside a session at the
  host's per-bridge IP; Docker's internal-network isolation filters forwarded
  traffic only. Anything sensitive on the host must have its own auth.
- The orchestrator holds the Docker socket, which is root-equivalent. It is
  mitigated by a fixed container template that user input never reaches and by
  never shell-executing user strings — but the auth you put in front of `/api`
  is what keeps it yours.
- `GET /api/sessions` returns `WS_AUTH_TOKEN`, behind that same auth.
- A compromised proxy sees the credentials it injects. That is true of any
  injecting proxy; what this one adds is that it leaves nothing at rest.
- A credential you do *not* configure is not translated. A session that logs
  itself in with `claude setup-token` holds its own token, and prompt injection
  can leak that one.
- Sibling sessions share a deployment's placeholders, so they map to the same
  real credentials. Per-session placeholders arrive with per-session
  credentials.
- Protocol behaviour is pinned to `claude-agent-acp` 0.70.0. Re-check
  capabilities and WebSocket framing on upgrade.

## Development

One toolchain across the repository: every package builds with Vite, tests with
Vitest, and type-checks before its Docker bundle, so an image cannot be built
from code that fails `tsc`.

```sh
cd orchestrator && npm run check && npm test
cd proxy        && npm run check && npm test
cd dashboard    && npm run check && npm test && npm run build
```

`npm run dev` in `dashboard/` serves the SPA with `/api`, `/healthz` and `/ws`
proxied to an orchestrator on port 3000. The dashboard's tests run in two
projects: `unit` for the framework-free stores, and `e2e`, which builds the
production bundle and drives it in Chromium against stub backends.
`/playground` renders every message part kind over a canned store, and the
browser suite asserts that page.

`scripts/live-test.sh` covers what only real inference can prove — a turn
surviving the browser leaving, thread replay on reattach, a permission request
held with nobody watching — and needs
`PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN`.

### Frontend conventions

Tailwind utilities and shadcn/assistant-ui components only: no inline `style=`,
no CSS-in-JS, and design tokens defined once in `src/globals.css` — including
the `@theme inline` bridge, without which Tailwind silently drops every token
utility. `.aui-md-bleed` is a hand-written rule rather than utilities because
it needs container-query units and a negative margin computed from them: it
lets a table or a code block in chat output escape the 44rem reading column
out to the width of the thread and scroll horizontally beyond that. The rule
under it withholds `content-visibility` from the messages that hold such a
block, since paint containment would clip one back into the column.

Components under `src/components/assistant-ui/` and `src/components/ui/` are
installed by their official CLIs and committed. Our edits carry a comment
saying so. Upgrade by re-running the CLI and reading the diff:

```sh
cd dashboard
npx assistant-ui add thread --overwrite     # or: npx shadcn add <name> --overwrite
npm run check && npm test
```

## Layout

| Path | What |
|---|---|
| `orchestrator/` | Node 22 + TypeScript: REST API, SQLite, Docker lifecycle, ACP gateway, idle reaper |
| `dashboard/` | React SPA — session list and chat — built into the orchestrator image and served at `/` |
| `proxy/` | The egress proxy: allowlist, address vetting and token translation — the security boundary |
| `session-image/` | The per-session container image |
| `shared/types.ts` | REST shapes imported by both orchestrator and dashboard |
| `scripts/smoke-test.sh` | Security smoke test, no credentials needed |
| `scripts/live-test.sh` | The checks that need a real Claude token |
| `ARCHITECTURE.md` | How the system is put together |
