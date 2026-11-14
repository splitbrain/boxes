# Boxes

A box is an isolated Docker container. It encapsulates a workspace, a home directory, a Nix store, and a private
network. The [glossary](glossary.md) defines these terms.

## Creating a box

Select **New** on the box list. The form asks for:

- a name (100 characters or fewer),
- an optional agent set, merged over the global set (see [agent sets](agent-sets.md)),
- the [egress profile](egress-profiles.md), with the default profile preselected,
- the agent and settings of the first [thread](threads.md).

The orchestrator then creates the box's private network, its directories in the data volume, and the container, and
starts it.

The container runs as the unprivileged `agent` account. Its root filesystem is read-only. The orchestrator puts a
credential placeholder for each stored credential into the environment; the [egress proxy](egress.md) replaces a
placeholder with the real secret on the wire. No real credential enters a box. The environment is fixed when the
container is created, so a credential stored later reaches the box at its next start.

The first thread is created in the same request. Creating a box does not require a working credential: the thread is a
database row until a browser opens it.

## The box list

The box list is the dashboard home page. It polls every five seconds while visible. Each box shows as a card with:

- the box name and id,
- status badges (see [box status](status.md)),
- disk use, when measured,
- one row per thread,
- buttons for **New thread**, **[Review](review.md)**, **[Terminal](terminal.md)**, and, when orphaned background work
  is detected, **Stop everything**.

The info icon on a card opens the box's details page.

## Box details

The details page shows the box's identity and runtime state: the facts of the runtime (on Docker the container id, the
network name with its subnet, and the image id), agent set, last activity, disk use, and the ACP session id of the most
recently active thread. It shows the egress profile of the box, which the user can change there, and the
[refused hosts](egress-profiles.md#refused-hosts). It lists the dev tunnels the box hosts and the processes the
orchestrator last read in the box.
For a running box whose network isolation is not complete, it shows a warning.

The page has three controls:

- **Start** — starts a stopped box's container and re-attaches the egress proxy.
- **Stop** — stops the container and drops the ACP connection. The workspace, home, and Nix store stay.
- **Delete** — removes the container, the network, the workspace, the home directory, the Nix store, and the agent set
  directory. The database keeps the box row as a tombstone. This cannot be undone.

A box has no page of its own other than the details page.

## Starting and stopping

A box starts when:

- a user selects **Start** on the details page,
- a browser opens a thread of a stopped box,
- a terminal opens on a stopped box,
- the review, an attachment or a download needs the files of a stopped box. The orchestrator reaches the files only
  through the [file service](files.md) in the box.

Before the container starts, the orchestrator repairs what drifted while the box was stopped, for example a container
that Docker lost. A repair that would replace the container is deferred while the container runs, so a turn is never
interrupted.

A box stops when:

- a user selects **Stop** on the details page,
- the idle reaper finds no turn, no waiting approval, no attached browser, no open terminal, no background task, and no
  activity for `IDLE_STOP_MINUTES` (default 30 minutes).

A stopped box keeps its workspace, home, and Nix store. Opening a thread starts it again.

## The box image

Every box is created from the image `BOX_IMAGE` names (default `ghcr.io/splitbrain/boxes/box:latest`). This full image
has the tools for many projects. It is built from the base image `ghcr.io/splitbrain/boxes/box-base`. A
[custom image](custom-images.md) also starts from the base image. The orchestrator pulls the image when it is missing,
and again every `BOX_IMAGE_PULL_MINUTES` (default 60). A stopped box picks up the new image at its next start; the
orchestrator does not replace a running box. Superseded image copies are removed when `BOX_IMAGE_PRUNE` is on.

## Resource limits

Each box container has the limits the [deployment configures](environment.md): `BOX_MEM_LIMIT` (default 4 GiB),
`BOX_CPUS` (default 2), and `BOX_PIDS_LIMIT` (default 512). The limits cover every process in the box, including all
adapters and their agents.

## Box layout

| Path | Source | Access |
| --- | --- | --- |
| `/workspace` | the box's workspace directory | read and write |
| `/home/agent` | the box's home directory | read and write |
| `/nix` | the box's Nix store directory | read and write |
| `/tmp` | memory | read and write, empty at each start |

The three persistent directories stay when a box stops and survive a box image change. They are removed only when the
box is deleted. See [storage](storage.md).

## Networking

Each box has its own internal Docker network with no route to the outside. The egress proxy is attached to it and is the
only way out. Tools in the box use `HTTP_PROXY` and `HTTPS_PROXY` to reach it. See [egress proxy](egress.md).

A process in a box can share a web app through a dev tunnel, using the `share-app` skill. The tunnels a box hosts are
listed on its details page. See [skills](skills.md).

## Technical internals

### The container

`orchestrator/src/docker.ts` builds the container from a fixed template that user input never reaches: read-only root
filesystem, all capabilities dropped, `no-new-privileges`, a tmpfs at `/tmp`, and the configured memory, CPU and pid
limits. The container runs as the numeric `BOX_UID:BOX_GID`, so the configured account decides who the agent is; the
image's own build-time uid does not have to agree. The container gets no Docker init: the image entrypoint starts tini
as PID 1, because the kernel discards default-disposition signals for PID 1 and nothing would reap orphaned processes.
The container is named `box-<id>`, the network `bn-<id>`, and every object the orchestrator creates for a box carries
the label `boxes.box=<id>`.

### Creation and repair

`BoxManager.create` in `orchestrator/src/boxes.ts` inserts the database row before it creates any Docker object, so the
orphan sweep can always tell a stray object from one that is being created. Every directory exists before the container
that binds it. A failed step removes everything it created and marks the row `error`.

Every start goes through a repair pass, `BoxManager.prepareContainer`, which `bringUp` runs before it starts the
container. A missing workspace or home directory marks the box `error` rather than being
recreated — a fresh home would erase the agent's transcripts without a warning. Then `ensure` of the runtime
(`orchestrator/src/runtime/docker.ts`) repairs the box. A container the daemon reports missing is recreated together
with its network. A container whose image id no longer matches the box image, or whose environment differs from the
environment the box gets now, is replaced, but never while it runs, so a turn is never interrupted.

### The setup

After each container start, `BoxManager.bringUp` sets up the box in three steps. The adapters, the terminal and the
file operations wait for it. When a step fails, the box gets the status `error` with the output of the step.

1. The orchestrator writes its own files into the home through the [file service](files.md): the CA of the
   [egress proxy](egress.md) to `~/.boxes/proxy-ca.crt`, and the git configuration with the
   [identity](credentials.md#git-identity) to `~/.config/git/config`.
2. It runs `boxes-setup`, a shell script of the base image at `/usr/local/bin/boxes-setup` (source
   `box-image/setup.sh`), with a limit of 60 seconds. The script first seeds a new home with the files of
   `/usr/local/share/boxes/home`, once: the marker `~/.boxes/seeded` records the seed, and the copy overwrites no file.
   Then it prepares the home for the tools of the base image: it empties `TMPDIR`, writes the trust store of the box,
   and sets the credential helpers of `gh` and `glab`. Then it runs
   the [setup steps](custom-images.md#setup-steps) of the image in `/usr/local/lib/boxes/setup.d/`. The steps of the
   full image (source `box-image/setup.d/`) check `/nix`, add the CA to the trust store of Chromium, and link the
   browsers.
3. It installs the [agent set](agent-sets.md) and the [built-in skills](skills.md).

The column `ready_at` records a complete setup, and each container start clears it, so a restart of the orchestrator
does not set up a running box again.

### The operation queue

Every mutating operation on a box takes the box's slot in a per-box promise chain, so two of them never run at the same
time; reads never queue. Stop and delete mark the box as pre-empted first: work in progress stops at its next step, so
the stop does not wait for the start it undoes. The reaper never waits — it skips a busy box and tries again at the next
tick.

### Boot and sweep

At boot the orchestrator reconciles its rows with Docker by the `boxes.box` label: it adopts live containers, marks
missing ones as stopped, marks an interrupted create as an error, and repairs the isolation of every running box. The periodic sweep uses the same label in the opposite direction: it removes every labelled container,
network and box directory that has no live row, containers before networks. One guard: when the strays outnumber the
known boxes by a wide margin, the sweep refuses, because that pattern usually means a wrongly mounted data volume rather
than real garbage. The sweep removes login containers by age.

### The subnet pool

Each box's network gets one `/24` out of `BOX_SUBNET_POOL`: the first one that no box network uses. A full pool fails
the create.

### Image refresh

The orchestrator re-pulls `BOX_IMAGE` on the configured interval and compares image ids, not tags, because a `latest`
tag moves. With `BOX_IMAGE_PRUNE` on, it removes the superseded image and any untagged image that still carries the
`boxes.image=box` label. Removal is never forced: the daemon refuses while a container was created from the image, and a
later sweep retries after the box has moved to the new image.
