# Custom box images

Boxes publishes two box images:

| Image | Contents |
| --- | --- |
| `ghcr.io/splitbrain/boxes/box-base` | Everything a box needs to work with the orchestrator: the agent account, Node, Claude Code and Codex with their ACP adapters, `git`, `gh`, `glab`, `devtunnel`, `tmux`, `rg`, `jq`, `less`, the file service and the setup. |
| `ghcr.io/splitbrain/boxes/box` | The base image with Go, Rust, PHP, Python, Nix, Playwright with Chromium, and tools for documents, archives and databases. This is the default of `BOX_IMAGE`. |

A custom image starts from `box-base` and adds the tools that the projects need. To use it, set
[`BOX_IMAGE`](environment.md) to its reference. The orchestrator pulls it like the default image.

## Example

```dockerfile
FROM ghcr.io/splitbrain/boxes/box-base:latest

USER root
ENV HOME=/root \
    TMPDIR=/tmp

RUN apt-get update && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*

COPY skills/ /usr/local/share/boxes/skills/
COPY setup.d/ /usr/local/lib/boxes/setup.d/

USER 1020
ENV HOME=/home/agent \
    TMPDIR=/home/agent/.cache/tmp
```

## Installs

The base image ends as the agent, with `HOME` and `TMPDIR` in the home of the agent. Run the installs as root with
`HOME` and `TMPDIR` outside the home, as in the example. At the end, set `USER`, `HOME` and `TMPDIR` back.

`/home/agent` in the image is only a mount point and must stay empty. To put a file into each new home, put it into
`/usr/local/share/boxes/home`. `boxes-setup` copies these files into a new home once.

## The account and the mount points

Keep the account `agent` (uid and gid 1020, home `/home/agent`), and end the image with `USER 1020`.

The orchestrator mounts `/workspace`, `/home/agent` and `/nix`, and a tmpfs at `/tmp`. These directories must stay in
the image.

## Commands

Do not replace or remove these files of the base image:

| File | Purpose |
| --- | --- |
| `/usr/local/bin/entrypoint.sh` | Holds the container open, under `tini` as PID 1. Keep the `ENTRYPOINT` of the base. |
| `/usr/local/bin/boxes-files` | The [file service](files.md). |
| `/usr/local/bin/boxes-setup` | The setup of the home after each start of a box. |
| `/usr/local/share/boxes/home` | The files of a new home. Add files here, but keep the files of the base. |

## Skills

The file service installs every directory in `/usr/local/share/boxes/skills` into the home as a skill, in addition to
the selected [agent sets](agent-sets.md). Each directory holds a `SKILL.md`. The base image has no skills. Add a skill
for each tool of the image that the agent must know about. See [skills](skills.md) for the precedence.

## Setup steps

`boxes-setup` runs after each start of a box, as the agent, before the box is ready. After its own steps, it runs each
executable file in `/usr/local/lib/boxes/setup.d/` in name order. Use a number prefix to set the order, for example
`10-nix`.

- A step must write only in the home.
- A non-zero exit code is an error of the box. The box gets the status `error` with the output of the setup. Use it only
  when the box cannot work.
- A line with `WARNING:` on stderr goes to the log of the orchestrator. Use it when one tool cannot work.
- The setup and all steps together have a limit of 60 seconds.

When a step runs, the certificate of the egress proxy CA is at `~/.boxes/proxy-ca.crt` (only when the deployment has
one). `/etc/ssl/certs` links to a copy of the system trust store `/etc/ssl/certs-system` with that CA added. The
environment has the proxy variables (`HTTPS_PROXY`, `NO_PROXY`).

## Environment variables

The orchestrator and the harnesses rely on these values of the base image. Do not change them:

`HOME`, `TMPDIR`, `LANG`, `TERM`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `CODEX_PATH`, `NPM_CONFIG_PREFIX`.

Add directories to `PATH` with `ENV PATH=<dir>:$PATH`. Do not set `PATH` to a fixed value, and do not reset it in a
profile script: the harnesses run commands in login shells.

## The image label

The base image has the label `boxes.image=box`, and a custom image gets it from the base. With `BOX_IMAGE_PRUNE` on, the
orchestrator removes the untagged copies of images with this label after a pull.
