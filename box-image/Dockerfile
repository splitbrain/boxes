# Boxes box images: one long-lived container per box. PID 1 only holds the
# container open. The gateway starts the ACP adapter with an exec, so a
# browser that disconnects does not restart the adapter.
#
# Two images from this file, selected with --target:
#
#   base   what a box needs to work with the orchestrator. A custom image is
#          built from it.
#   full   the base with the tools for projects: languages, nix, browsers,
#          and tools for documents, archives and databases. The default of
#          BOX_IMAGE.
#
# Each image has three stages: *-image installs everything, *-test checks it,
# and the target ships the image once the test has passed.
#
# boxes-setup seeds a new home once from /usr/local/share/boxes/home and does
# not refresh it. /home/agent in the image is an empty mount point. Thus a
# tool that must follow the image is installed outside the home.
#
# The build context is the repository root, because the file service is
# built from files/ and shared/.

# Build arguments the test stages check the images against. A stage sees one
# only after it names it again with a bare ARG.
ARG NODE_MAJOR=26
ARG NIX_VERSION=2.34.8
ARG CODEX_VERSION=0.156.1
ARG OPENCODE_VERSION=1.19.3

# The agent's own account, and the defaults of the orchestrator's BOX_UID and
# BOX_GID. 1020 keeps clear of the ubuntu user at 1000, which is often a
# person on the host.
ARG AGENT_UID=1020
ARG AGENT_GID=1020

# The file service, type-checked and bundled like the orchestrator and the
# proxy. The build mirrors the repository layout, so imports from files/src
# into shared/ resolve as they do in a checkout.
FROM node:${NODE_MAJOR}-alpine AS files-build
WORKDIR /build
COPY files/package.json files/package-lock.json* ./files/
WORKDIR /build/files
RUN npm ci
# After npm ci, so a change in shared/ keeps the installed dependencies.
COPY shared/ /build/shared/
COPY files/tsconfig.json files/vite.config.ts ./
COPY files/src ./src
RUN npm run check && npm run build

# ---------------------------------------------------------------------------
# The base image
# ---------------------------------------------------------------------------

FROM ubuntu:26.04 AS base-image

# Marks copies of this image and of every image built from it, so the
# orchestrator can find and remove an untagged copy after a pull replaced it.
LABEL boxes.image=box

# curl needs a trust store to add the repositories below. tini is PID 1.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      tini \
 && rm -rf /var/lib/apt/lists/*

# Node from NodeSource, because Ubuntu's own stays at the release's version.
# The key is ASCII-armoured, so signed-by takes it without gnupg. nodistro is
# NodeSource's suite for every distribution.
ARG NODE_MAJOR
RUN install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      -o /etc/apt/keyrings/nodesource.asc \
 && chmod go+r /etc/apt/keyrings/nodesource.asc \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# The orchestrator reads the process table of the box with ps to find what a
# thread left running, and to stop it by pid.
#
# The dashboard's terminal attaches to tmux, so a shell and its scrollback
# outlive a closed tab.
#
# rg for searches, jq for the setup steps, and less as git's pager.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ripgrep \
      jq \
      less \
      procps \
      tmux \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI from the official apt repository, for the fork and pull request
# flow. Ubuntu's own gh stays at the release's version.
RUN install -d -m 0755 /usr/share/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# GitLab CLI, for the same flow on GitLab. It has no apt repository, so the
# version and the checksum of each .deb are pinned here. The package depends
# only on git, so dpkg installs it directly.
ARG GLAB_VERSION=1.119.0
ARG GLAB_SHA256_AMD64=95a9ca105518dec7f70ee403d98501402a5fda154c406f4f4cd6696928d3a098
ARG GLAB_SHA256_ARM64=70987a8bab6970d0d042d73d0f06b9d56ecb9abb88c7137c742f1c11b19350e0
RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      amd64) sha="$GLAB_SHA256_AMD64" ;; \
      arm64) sha="$GLAB_SHA256_ARM64" ;; \
      *) echo "no glab package pinned for $arch" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${arch}.deb" \
      -o /tmp/glab.deb \
 && echo "$sha  /tmp/glab.deb" | sha256sum -c - \
 && dpkg -i /tmp/glab.deb \
 && rm -f /tmp/glab.deb

# The Microsoft Dev Tunnels CLI, which the share-app skill hosts a tunnel
# with. It is one self-contained binary with no package, so the version and
# the checksum of each build are pinned here. The version check runs it as
# root, and the step removes the files it unpacks into root's home.
#
# The CLI is a .NET program, and .NET aborts at start without ICU.
ARG DEVTUNNEL_VERSION=1.0.2094+24665e6583
ARG DEVTUNNEL_SHA256_AMD64=2aa6c41aaf7840427e84b7e1e99be5b826a9966fc027ddf61dc0f69b68db060b
ARG DEVTUNNEL_SHA256_ARM64=efac378f9ffb40914935fbd2361543088b50cd62248372df06c243e6f7c49cc8
RUN apt-get update && apt-get install -y --no-install-recommends libicu78 \
 && rm -rf /var/lib/apt/lists/* \
 && case "$(dpkg --print-architecture)" in \
      amd64) build=linux-x64; sha="$DEVTUNNEL_SHA256_AMD64" ;; \
      arm64) build=linux-arm64; sha="$DEVTUNNEL_SHA256_ARM64" ;; \
      *) echo "no devtunnel build pinned for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://tunnelsassetsprod.blob.core.windows.net/cli/$(echo "$DEVTUNNEL_VERSION" | sed 's/+/%2B/')/${build}-devtunnel" \
      -o /usr/local/bin/devtunnel \
 && echo "$sha  /usr/local/bin/devtunnel" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/devtunnel \
 && devtunnel --version | grep -qF "${DEVTUNNEL_VERSION}" \
 && rm -rf /root/.net /root/.local/share/DevTunnels

# The agent and the adapter, each pinned to a major line. Below 1.0, the caret
# pins the minor instead. Do not switch to @zed-industries/claude-code-acp,
# which is stale.
#
# --prefix keeps the image's globals in /usr/local. Without it, npm derives the
# prefix from the node binary in /usr/bin. The identity check below relies on
# /usr/local.
RUN npm install -g --prefix /usr/local \
      @anthropic-ai/claude-code@^2 \
      @agentclientprotocol/claude-agent-acp@^0.92.0 \
 && npm cache clean --force

# The Codex CLI and its ACP adapter, both pinned exactly.
#
# @openai/codex is a small launcher, and its platform binary arrives as an
# optional dependency of several hundred megabytes. The adapter nests its own
# @openai/codex. --omit=optional leaves that nested copy without a binary, and
# CODEX_PATH points the adapter at the global one. A person's codex and the
# adapter's codex are then the same build. The identity check below proves it.
ARG CODEX_VERSION
RUN npm install -g --prefix /usr/local @openai/codex@${CODEX_VERSION} \
 && npm install -g --prefix /usr/local --omit=optional \
      @agentclientprotocol/codex-acp@1.13.0 \
 && npm cache clean --force
ENV CODEX_PATH=/usr/local/bin/codex

# Codex's system configuration.
COPY box-image/codex-config.toml /etc/codex/config.toml

# opencode, pinned exactly. It is its own ACP adapter.
#
# The postinstall script of opencode-ai selects the platform binary by the CPU
# of the build host. The install skips the script. The start script selects
# the binary by the CPU of the host that runs the box.
#
# opencode installs @opencode-ai/plugin in its own version into
# ~/.config/opencode at its start, when the folder has no node_modules. The
# home seed holds that install, so a new box does not download it.
ARG OPENCODE_VERSION
RUN npm install -g --prefix /usr/local --ignore-scripts opencode-ai@${OPENCODE_VERSION} \
 && npm install --prefix /usr/local/share/boxes/home/.config/opencode --ignore-scripts --save-exact \
      @opencode-ai/plugin@${OPENCODE_VERSION} \
 && npm cache clean --force
COPY box-image/opencode.sh /usr/local/bin/opencode
RUN chmod 0755 /usr/local/bin/opencode

# Skills for the tools of the image, which the file service installs into the
# home with each agent set. The full image and a custom image add theirs here.
RUN mkdir -p /usr/local/share/boxes/skills

# The file service. The orchestrator starts it in the box and reaches all the
# files of the box through it. The bundle has no npm dependencies. node
# resolves the link to the bundle, so the .mjs name makes it an ES module.
COPY --from=files-build /build/files/dist/main.mjs /usr/local/lib/boxes-files/main.mjs
RUN chmod 0755 /usr/local/lib/boxes-files/main.mjs \
 && ln -s /usr/local/lib/boxes-files/main.mjs /usr/local/bin/boxes-files

# The agent's own account, with the uid and gid from the top of this file.
ARG AGENT_UID
ARG AGENT_GID
RUN groupadd -g "${AGENT_GID}" agent \
 && useradd -u "${AGENT_UID}" -g "${AGENT_GID}" -M -d /home/agent -s /bin/bash agent

# HOME is set outright, because the caches of many tools derive from it.
# C.UTF-8 is built into glibc and keeps non-ASCII paths intact.
# CLAUDE_CONFIG_DIR and CODEX_HOME make the adapter and a shell in the box use
# the same directory.
ENV HOME=/home/agent \
    LANG=C.UTF-8 \
    CLAUDE_CONFIG_DIR=/home/agent/.claude \
    CODEX_HOME=/home/agent/.codex \
    TERM=dumb \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# The agent installs its own tools into the persistent home, because the
# root filesystem is read-only and the agent is not root.
#
# Set after the global installs above, which belong on the image.
ENV NPM_CONFIG_PREFIX=/home/agent/.local \
    PATH=/home/agent/.local/bin:$PATH

COPY box-image/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# The setup of the home. The orchestrator runs it as the agent after each
# start of the box, before the box is ready.
COPY box-image/setup.sh /usr/local/bin/boxes-setup
RUN chmod 0755 /usr/local/bin/boxes-setup

# The setup steps of the full image or a custom image. boxes-setup runs each
# executable file here after its own steps.
RUN mkdir -p /usr/local/lib/boxes/setup.d

# The root filesystem is read-only at runtime, so every mount point must
# exist in the image. /workspace, /home/agent and /nix are writable binds, and
# /tmp is a tmpfs. The home stays empty, because the mount hides it in a box.
RUN mkdir -p /workspace /nix /home/agent \
 && chown agent:agent /workspace /nix /home/agent

# The files of a new home. boxes-setup copies them into a home that has no
# seed marker, and overwrites nothing. They belong to root and are readable
# by every uid, so the copy works for any BOX_UID.
#
# The empty .gitconfig makes git config --global write there, and not into
# ~/.config/git/config, which the orchestrator writes at each start.
#
# The Claude Code user settings disable commit and pull request attribution.
COPY box-image/claude-settings.json /usr/local/share/boxes/home/.claude/settings.json
RUN cp -R /etc/skel/. /usr/local/share/boxes/home/ \
 && touch /usr/local/share/boxes/home/.gitconfig \
 && chmod -R a+rX,go-w /usr/local/share/boxes/home

# Numeric, so the uid is readable from the image itself.
USER ${AGENT_UID}
WORKDIR /workspace

# Temporary files go to disk rather than to the 512 MB /tmp tmpfs, which
# counts against the box's memory limit. Set at the end of the stage, so no
# install step writes into the home.
ENV TMPDIR=/home/agent/.cache/tmp

# Checks the base image. Nothing here reaches a shipped image, so the
# checks need no cleanup.
FROM base-image AS base-test
ARG AGENT_UID
ARG AGENT_GID
ARG CODEX_VERSION
ARG OPENCODE_VERSION
ARG NODE_MAJOR

# Checks the user, the writable directories, the npm prefix and the tool
# locations. Each of these failures is silent otherwise. For example, an ARG
# out of scope leaves USER empty, which means root.
#
# codex --version runs the platform binary, so it fails if --omit=optional
# left none. The match against CODEX_VERSION catches a followed range.
# opencode --version runs the binary that the start script selects, so it
# fails when that binary is missing. On amd64, the baseline binary must also
# run, because the start script selects it on a CPU without AVX2. opencode
# writes into the home, so its check comes after the seed checks.
#
# The file service ends with exit code 0 when its input closes, so the run
# with an empty input proves that node loads the bundle through the link.
#
# The setup runs first, as it does in a box, without a proxy CA and without
# steps. It seeds the empty home, so the checks after it see the home of a
# new box. A second setup does not copy a file of the seed again.
#
# A login shell keeps every directory of the image's PATH.
RUN test "$(id -u)" = "${AGENT_UID}" \
 && test "$(id -g)" = "${AGENT_GID}" \
 && test "$(id -un)" = "agent" \
 && test -w /workspace && test -w /home/agent && test -w /nix \
 && test -z "$(ls -A /home/agent)" \
 && test "$(command -v boxes-setup)" = "/usr/local/bin/boxes-setup" \
 && boxes-setup \
 && test -f /home/agent/.boxes/seeded \
 && test -f /home/agent/.profile \
 && test -f /home/agent/.claude/settings.json \
 && test -f /home/agent/.gitconfig && test ! -s /home/agent/.gitconfig \
 && test -z "$(find /home/agent ! -user agent -print -quit)" \
 && rm /home/agent/.bashrc && boxes-setup && test ! -e /home/agent/.bashrc \
 && test -w /home/agent/.local/bin \
 && test "$(npm config get prefix)" = "/home/agent/.local" \
 && test "$(command -v claude-agent-acp)" = "/usr/local/bin/claude-agent-acp" \
 && test "$(command -v codex-acp)" = "/usr/local/bin/codex-acp" \
 && test "$(command -v codex)" = "/usr/local/bin/codex" \
 && codex --version | grep -qF "${CODEX_VERSION}" \
 && test "$(command -v opencode)" = "/usr/local/bin/opencode" \
 && opencode --version | grep -qxF "${OPENCODE_VERSION}" \
 && { test "$(dpkg --print-architecture)" != amd64 \
      || /usr/local/lib/node_modules/opencode-ai/node_modules/opencode-linux-x64-baseline/bin/opencode \
           --version | grep -qxF "${OPENCODE_VERSION}"; } \
 && test -f /home/agent/.config/opencode/node_modules/@opencode-ai/plugin/package.json \
 && test "$(command -v boxes-files)" = "/usr/local/bin/boxes-files" \
 && boxes-files </dev/null \
 && test -d /usr/local/share/boxes/skills \
 && ps -eo pid,ppid,args >/dev/null \
 && bash -lc 'set -eu; IFS=:; for d in $0; do \
      case ":$PATH:" in *":$d:"*) ;; *) echo "a login shell lost $d" >&2; exit 1 ;; esac; \
    done' "$PATH"

# Node has the requested major and comes from NodeSource. The vendor check
# catches apt preferring Ubuntu's nodejs.
RUN test "$(node -p 'process.versions.node.split(".")[0]')" = "${NODE_MAJOR}" \
 && test "$(command -v node)" = "/usr/bin/node" \
 && dpkg-query -W -f='${Version}' nodejs | grep -q nodesource \
 && npm --version >/dev/null

# Every tool resolves by the name the agent uses. timeout comes from Ubuntu's
# coreutils, and the orchestrator relies on it.
RUN set -eu; \
    for t in git rg jq less ps tmux curl gh glab devtunnel claude timeout; do \
      command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 1; }; \
    done

RUN touch /tmp/checks-passed

# The shipped base image. Copying the marker makes this stage depend on the
# test stage, so a failed check fails the build.
FROM base-image AS base
COPY --from=base-test /tmp/checks-passed /etc/boxes/checks-passed-base
# tini as PID 1, because the kernel discards default-disposition signals for
# PID 1: the entrypoint's sleep would never see SIGTERM, and every stop would
# wait out the grace period. tini also reaps the processes orphaned in the
# box, which would otherwise stay zombies and count against the pids limit.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]

# ---------------------------------------------------------------------------
# The full image
# ---------------------------------------------------------------------------

# Nix as one statically linked binary from the official binary cache. /nix is
# a per-box bind, so the binary lives in /usr/local/bin and follows the image.
#
# nix copy checks the cache's signature for the pinned store path. A bump
# changes both paths and NIX_VERSION above. The stage runs on the build
# platform, because copying a store path executes nothing.
FROM --platform=$BUILDPLATFORM nixos/nix:2.35.2 AS nix-static
ARG TARGETARCH
ARG NIX_STATIC_AMD64=/nix/store/vx0h5sdb0r7qgsm9fp653f0fi2wn5v7k-nix-static-x86_64-unknown-linux-musl-2.34.8
ARG NIX_STATIC_ARM64=/nix/store/x7ym2j54zsnws310rv7lg3sqbvhcfani-nix-static-aarch64-unknown-linux-musl-2.34.8
RUN case "$TARGETARCH" in \
      amd64) path="$NIX_STATIC_AMD64" ;; \
      arm64) path="$NIX_STATIC_ARM64" ;; \
      *) echo "no static nix pinned for $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && nix --extra-experimental-features nix-command copy --from https://cache.nixos.org "$path" \
 && cp -a "$path/bin" /out

# From the shipped base, so the full image has everything a custom image has.
FROM base AS full-image

# The base ends as the agent, with HOME and TMPDIR in the agent's home. The
# installs here run as root with both outside the home, because the home of
# the image must stay empty.
USER root
ENV HOME=/root \
    TMPDIR=/tmp

# Build tools, Python, and tools to debug the network.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      python3 \
      python3-venv \
      pipx \
      netcat-openbsd \
      bind9-dnsutils \
 && rm -rf /var/lib/apt/lists/*

# Go, Rust and PHP from the distribution, which carries their security
# updates. pkg-config and libssl-dev are what common native crates and
# extensions look for.
RUN apt-get update && apt-get install -y --no-install-recommends \
      golang-go \
      rustc \
      cargo \
      rustfmt \
      rust-clippy \
      rust-src \
      php-cli \
      php-mbstring \
      php-xml \
      php-curl \
      php-zip \
      php-intl \
      php-sqlite3 \
      php-gd \
      php-bcmath \
      composer \
      pkg-config \
      libssl-dev \
 && rm -rf /var/lib/apt/lists/*

# Tools for documents, archives and databases. /usr is read-only at runtime,
# so the agent cannot add them later.
#
# fd-find installs its binary as fdfind, and 7zip is the package that
# replaced p7zip-full.
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils \
      qpdf \
      mupdf-tools \
      ghostscript \
      pandoc \
      tesseract-ocr \
      tesseract-ocr-eng \
      ocrmypdf \
      imagemagick \
      graphviz \
      unzip \
      zip \
      xz-utils \
      zstd \
      7zip \
      bzip2 \
      file \
      tree \
      patch \
      wget \
      git-lfs \
      sqlite3 \
      fd-find \
      shellcheck \
      yq \
      cmake \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# uv, which the archive does not carry. PIPX_HOME and PIPX_BIN_DIR point at
# /usr/local for this one command, so uv lives on the image and not in the
# home.
RUN PIPX_HOME=/usr/local/pipx PIPX_BIN_DIR=/usr/local/bin pipx install uv \
 && rm -rf /root/.cache

# Nix from the first stage, and its system configuration. With it, the agent
# installs tools and services into the box's own /nix without privileges.
COPY --from=nix-static /out/ /usr/local/bin/
COPY box-image/nix.conf /etc/nix/nix.conf

# @playwright/cli and Chromium. The CLI is 0.1.x, so the caret pins the minor.
#
# Playwright's Chromium, because Ubuntu's chromium package is a snap wrapper
# and snapd does not run here. --with-deps installs the libraries and fonts
# the browser needs.
#
# The browsers live on the image at BOXES_IMAGE_BROWSERS, and
# PLAYWRIGHT_BROWSERS_PATH points there only during the build. libnss3-tools
# provides certutil, with which the setup adds the deployment CA to
# Chromium's store.
#
# /usr/local/bin/chromium is a stable path to the image's Chromium, for a
# project whose own Playwright wants another revision. /usr/local/bin/playwright
# is the Playwright CLI nested under @playwright/cli, so the agent can
# download Firefox and WebKit without npx.
ARG PLAYWRIGHT_CLI_VERSION=^0.1.19
ENV BOXES_IMAGE_BROWSERS=/opt/playwright
ENV PLAYWRIGHT_BROWSERS_PATH=${BOXES_IMAGE_BROWSERS}
RUN npm install -g --prefix /usr/local @playwright/cli@${PLAYWRIGHT_CLI_VERSION} \
 && npm cache clean --force \
 && playwright-cli install-browser chromium --with-deps \
 && ln -s "$(find "${PLAYWRIGHT_BROWSERS_PATH}" -maxdepth 3 -type f -name chrome \
      -path '*/chromium-*' -print -quit)" /usr/local/bin/chromium \
 && chromium --version \
 && ln -s /usr/local/lib/node_modules/@playwright/cli/node_modules/.bin/playwright \
      /usr/local/bin/playwright \
 && playwright --version \
 && apt-get update && apt-get install -y --no-install-recommends libnss3-tools \
 && rm -rf /var/lib/apt/lists/*

# The system libraries of Firefox and WebKit, without the browsers. The agent
# can download a browser, but it cannot install libraries, because it is not
# root.
#
# install-deps is a command of the playwright-core that @playwright/cli nests,
# so the path names it directly. The dry run fails if any package is still
# missing, which an apt error in the install output would hide.
RUN pw=/usr/local/lib/node_modules/@playwright/cli/node_modules/.bin/playwright \
 && "$pw" install-deps firefox webkit \
 && "$pw" install-deps --dry-run firefox webkit \
 && rm -rf /var/lib/apt/lists/*

# At runtime, Playwright uses a writable directory in the home, into which
# the setup links the image's builds at every start.
ENV PLAYWRIGHT_BROWSERS_PATH=/home/agent/.cache/ms-playwright

# The CLI's base configuration. The setup adds the egress proxy at
# runtime.
COPY box-image/playwright-cli.config.json /usr/local/share/boxes/playwright-cli.config.json

# The skill of the browser CLI, with this image's browser notes appended,
# beside the other image skills. The CLI installs its skill only into a home,
# so the step uses a scratch home and removes it.
COPY box-image/playwright-skill-notes.md /tmp/playwright-skill-notes.md
RUN HOME=/tmp/skill-home NO_UPDATE_NOTIFIER=1 playwright-cli install --skills --global \
 && mv /tmp/skill-home/.claude/skills/playwright-cli /usr/local/share/boxes/skills/playwright-cli \
 && cat /tmp/playwright-skill-notes.md >> /usr/local/share/boxes/skills/playwright-cli/SKILL.md \
 && rm -rf /tmp/skill-home /tmp/playwright-skill-notes.md

# The skills of the image's tools, beside the playwright-cli skill.
COPY box-image/skills/ /usr/local/share/boxes/skills/

# The setup steps of the image's tools.
COPY box-image/setup.d/ /usr/local/lib/boxes/setup.d/
RUN chmod 0755 /usr/local/lib/boxes/setup.d/*

# The agent installs Python tools with pipx into the persistent home.
ENV PIPX_HOME=/home/agent/.local/pipx \
    PIPX_BIN_DIR=/home/agent/.local/bin

# Where nix profile add links what the agent installs, and where Go, Cargo
# and Composer install binaries. nix.conf selects the XDG layout of nix.
ENV PATH=/home/agent/.local/state/nix/profile/bin:/home/agent/go/bin:/home/agent/.cargo/bin:/home/agent/.config/composer/vendor/bin:$PATH

# Back to the account, HOME and TMPDIR of the base.
ARG AGENT_UID
USER ${AGENT_UID}
ENV HOME=/home/agent \
    TMPDIR=/home/agent/.cache/tmp

# Checks the full image.
FROM full-image AS full-test
ARG AGENT_UID
ARG NIX_VERSION

# Checks the user, that no install wrote into the home, nix, the setup with
# the steps of the full image, and the skills. The setup runs as it does in a
# box, without a proxy CA, and the skill of the browser CLI must hold this
# image's notes. The setup also creates the TMPDIR that the Go and Rust
# builds below need.
#
# A login shell keeps every directory of the image's PATH.
RUN test "$(id -u)" = "${AGENT_UID}" \
 && test "$(id -un)" = "agent" \
 && test "$HOME" = "/home/agent" \
 && test -z "$(ls -A /home/agent)" \
 && test "$(command -v nix)" = "/usr/local/bin/nix" \
 && nix --version | grep -qF "${NIX_VERSION}" \
 && boxes-setup \
 && test -f /home/agent/.playwright/cli.config.json \
 && test -f /usr/local/share/boxes/skills/nix/SKILL.md \
 && grep -qF '## Browsers in this container' /usr/local/share/boxes/skills/playwright-cli/SKILL.md \
 && bash -lc 'set -eu; IFS=:; for d in $0; do \
      case ":$PATH:" in *":$d:"*) ;; *) echo "a login shell lost $d" >&2; exit 1 ;; esac; \
    done' "$PATH"

# Every added tool resolves by the name the agent uses. This catches a package
# renamed to a virtual one that installs nothing useful.
RUN set -eu; \
    for t in pdftotext pdftoppm pdfinfo qpdf mutool gs pandoc tesseract ocrmypdf \
             magick dot unzip zip xz zstd 7z file tree patch wget git-lfs \
             sqlite3 fd fdfind shellcheck yq cmake uv uvx dig nc python3 make \
             go cargo php composer playwright-cli playwright chromium certutil; do \
      command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 1; }; \
    done

# Chromium opens a page and snapshots it with refs, as the agent. This catches
# a missing library, an unreadable browsers directory, a config that looks for
# Google Chrome, and a Chromium sandbox left on.
#
# A loopback python server serves the page, because the CLI blocks file: URLs.
# The config goes into the working directory's .playwright/, because only open
# takes --config. The browsers path points at the image's builds, because
# only the setup links them into the home.
RUN set -eu; \
    export PLAYWRIGHT_BROWSERS_PATH="$BOXES_IMAGE_BROWSERS"; \
    cd /tmp; \
    printf '<!doctype html><title>t</title><button>Continue</button>\n' > index.html; \
    python3 -m http.server 18901 --bind 127.0.0.1 >/dev/null 2>&1 & \
    server=$!; \
    trap 'kill $server 2>/dev/null || true' EXIT; \
    mkdir -p /tmp/.playwright; \
    cp /usr/local/share/boxes/playwright-cli.config.json \
      /tmp/.playwright/cli.config.json; \
    for _ in $(seq 1 50); do \
      curl -fsS -o /dev/null http://127.0.0.1:18901/ && break; sleep 0.2; \
    done; \
    playwright-cli open http://127.0.0.1:18901/; \
    playwright-cli snapshot >/dev/null; \
    grep -qE 'button "Continue" \[ref=e[0-9]+\]' .playwright-cli/*.yml; \
    playwright-cli close

# Firefox and WebKit launch, downloaded as the agent into the home, as in a
# box. install-deps reports installed packages, not a browser that
# starts. Playwright maps this Ubuntu release to an older release's Firefox
# build, so Firefox is the likeliest to fail.
#
# playwright-core is required by path, as for install-deps.
RUN set -eu; \
    deps=/usr/local/lib/node_modules/@playwright/cli/node_modules; \
    "$deps/.bin/playwright" install firefox webkit; \
    node -e ' \
      const pw = require(process.argv[1]); \
      (async () => { \
        for (const name of ["firefox", "webkit"]) { \
          const browser = await pw[name].launch(); \
          const page = await browser.newPage(); \
          await page.setContent("<title>t</title><button>Continue</button>"); \
          const text = await page.textContent("button"); \
          if (text !== "Continue") throw new Error(name + " rendered " + text); \
          await browser.close(); \
          console.log(name + " ok"); \
        } \
      })().catch((e) => { console.error(e); process.exit(1); }); \
    ' "$deps/playwright-core"

# Chromium resolves through a symlink of the kind the setup writes. This
# relies on Playwright not resolving the real path of its browsers directory,
# which is undocumented.
RUN set -eu; \
    seed=/tmp/browsers-seed; \
    mkdir -p "$seed"; \
    for d in "$BOXES_IMAGE_BROWSERS"/*/; do \
      ln -s "${d%/}" "$seed/$(basename "$d")"; \
    done; \
    PLAYWRIGHT_BROWSERS_PATH="$seed" node -e ' \
      const pw = require(process.argv[1]); \
      (async () => { \
        const browser = await pw.chromium.launch({ chromiumSandbox: false }); \
        const page = await browser.newPage(); \
        await page.setContent("<title>t</title><button>Continue</button>"); \
        const text = await page.textContent("button"); \
        if (text !== "Continue") throw new Error("rendered " + text); \
        await browser.close(); \
        if (!pw.chromium.executablePath().startsWith(process.env.PLAYWRIGHT_BROWSERS_PATH)) { \
          throw new Error("resolved outside the linked path: " + pw.chromium.executablePath()); \
        } \
        console.log("chromium resolves through a link"); \
      })().catch((e) => { console.error(e); process.exit(1); }); \
    ' /usr/local/lib/node_modules/@playwright/cli/node_modules/playwright-core

# Go, Rust and PHP each build something as the agent, which proves their
# caches go under /home/agent.
RUN set -eu; \
    cd /tmp; \
    printf 'package main\nimport "fmt"\nfunc main() { fmt.Println("ok") }\n' > hello.go; \
    test "$(go run hello.go)" = "ok"; \
    test "$(go env GOPATH)" = "/home/agent/go"; \
    test "$(go env GOCACHE)" = "/home/agent/.cache/go-build"; \
    cargo new --quiet --bin --vcs none /tmp/hello-rs; \
    cd /tmp/hello-rs && cargo build --quiet --offline && ./target/debug/hello-rs >/dev/null; \
    command -v rustfmt >/dev/null && command -v cargo-clippy >/dev/null; \
    test "$(php -r 'echo "ok";')" = "ok"; \
    composer --version >/dev/null

RUN touch /tmp/checks-passed

# The shipped full image.
FROM full-image AS full
COPY --from=full-test /tmp/checks-passed /etc/boxes/checks-passed-full
