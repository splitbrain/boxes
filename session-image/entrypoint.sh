#!/usr/bin/env bash
# Runs as agent on container start. Prepares the git and gh identity, then
# holds the container open with sleep. The gateway spawns the ACP adapter
# separately, as a long-lived exec.
set -uo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# --- egress proxy CA --------------------------------------------------------
# The proxy terminates TLS for the hosts whose credentials it translates, so
# this container has to trust the deployment's CA for those hosts to work. The
# certificate arrives as a PEM in the environment rather than a mount, and the
# variables that point node, gh, git and curl at the file are already set by
# the orchestrator; all that is left is putting it where they look.
if [ -n "${BOXES_PROXY_CA:-}" ]; then
  mkdir -p /home/agent/.boxes
  if printf '%s\n' "$BOXES_PROXY_CA" > /home/agent/.boxes/proxy-ca.crt; then
    chmod 0644 /home/agent/.boxes/proxy-ca.crt
    log "wrote the egress proxy CA to /home/agent/.boxes/proxy-ca.crt"
  else
    log "WARNING: could not write the egress proxy CA; TLS to translated hosts will fail"
  fi
fi

# --- the agent's own tool directory -----------------------------------------
# npm's prefix has to exist before `npm install -g` will use it, and a home
# filled from an image that predates this directory does not have it: a home is
# copied out of the image when its session is created and never refreshed.
if ! mkdir -p /home/agent/.local/bin; then
  log "WARNING: could not create /home/agent/.local/bin; installing tools will fail"
fi

# --- agent configuration ----------------------------------------------------
# The orchestrator materializes this box's merged AGENTS.md, skills and slash
# commands into a read-only bind at /boxes/agent, laid out exactly as they have
# to appear under ~/.claude. Only the copy happens here. The orchestrator does
# have a path to ~/.claude now that a home is a directory of its own, but a
# box's home is the box's to write: doing it out here would race with the agent
# that is living in it.
#
# The manifest is what makes the install reversible: it names every path put
# there, a copy of it is left behind in ~/.claude/.boxes-managed, and the next
# start removes exactly those before installing again. So a skill deleted in
# the dashboard disappears from the box, while anything the agent itself put in
# ~/.claude is never touched.
AGENT_SRC=/boxes/agent
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-/home/agent/.claude}"
MANAGED="$CLAUDE_DIR/.boxes-managed"

# A manifest line has to be one relative path under CLAUDE_DIR and nothing
# else. The file is written by the orchestrator, but it decides what gets
# deleted, so it is checked rather than trusted.
safe_rel() {
  case "$1" in
    ''|/*|*..*|*'
'*) return 1 ;;
  esac
  return 0
}

install_agent_config() {
  mkdir -p "$CLAUDE_DIR" || { log "WARNING: could not create $CLAUDE_DIR"; return; }

  if [ -f "$MANAGED" ]; then
    while IFS= read -r rel; do
      safe_rel "$rel" || continue
      rm -rf -- "$CLAUDE_DIR/$rel"
    done < "$MANAGED"
    rm -f "$MANAGED"
  fi

  if [ ! -f "$AGENT_SRC/manifest" ]; then
    log "no agent configuration is mounted"
    return
  fi

  installed=0
  while IFS= read -r rel; do
    safe_rel "$rel" || continue
    [ -e "$AGENT_SRC/$rel" ] || continue
    mkdir -p "$CLAUDE_DIR/$(dirname -- "$rel")"
    # cp -R onto an existing directory would nest inside it rather than
    # replace it, so the destination goes first. A managed name wins over
    # anything already sitting under it.
    rm -rf -- "$CLAUDE_DIR/$rel"
    if cp -R -- "$AGENT_SRC/$rel" "$CLAUDE_DIR/$rel"; then
      printf '%s\n' "$rel" >> "$MANAGED"
      installed=$((installed + 1))
    else
      log "WARNING: could not install $rel"
    fi
  done < "$AGENT_SRC/manifest"
  log "installed $installed agent configuration entries into $CLAUDE_DIR"
}

install_agent_config

# --- chromium's trust store -------------------------------------------------
# Chromium reads none of the CA variables the rest of the image is pointed at;
# it keeps its own NSS database under ~/.pki/nssdb. Without the deployment CA
# in there, the hosts the proxy intercepts -- and only those -- fail TLS inside
# the browser while working in every other tool, which is a confusing shape to
# debug from a page that will not load.
#
# Removed before it is added, so a restart replaces the entry rather than
# failing on one that is already there.
if [ -n "${BOXES_PROXY_CA:-}" ] && command -v certutil >/dev/null 2>&1; then
  nssdb=/home/agent/.pki/nssdb
  if mkdir -p "$nssdb"; then
    [ -f "$nssdb/cert9.db" ] || certutil -N -d "sql:$nssdb" --empty-password >/dev/null 2>&1
    certutil -D -n boxes-egress-proxy -d "sql:$nssdb" >/dev/null 2>&1
    if certutil -A -n boxes-egress-proxy -t C,, -i /home/agent/.boxes/proxy-ca.crt \
         -d "sql:$nssdb" 2>/dev/null; then
      log "trusted the egress proxy CA in the browser's certificate store"
    else
      log "WARNING: could not add the egress proxy CA to $nssdb; intercepted hosts will fail TLS in the browser"
    fi
  fi
fi

# --- the browser CLI ---------------------------------------------------------
# Two things the CLI cannot work out for itself.
#
# Its global config, at ~/.playwright/cli.config.json, carries which browser to
# use and the launch options a session container needs; the image ships that
# much, and the only piece missing at build time is the egress proxy, which is
# added here. Written on every start rather than once, so a corrected base
# config reaches a session whose home already exists. A project's own
# .playwright/cli.config.json still overrides all of it.
cli_base=/usr/local/share/boxes/playwright-cli.config.json
cli_config=/home/agent/.playwright/cli.config.json
if [ -r "$cli_base" ] && mkdir -p /home/agent/.playwright; then
  proxy="${HTTPS_PROXY:-${HTTP_PROXY:-}}"
  if [ -n "$proxy" ]; then
    jq --arg server "$proxy" --arg bypass "${NO_PROXY:-}" \
      '.browser.launchOptions.proxy = (if $bypass == "" then { server: $server }
                                       else { server: $server, bypass: $bypass } end)' \
      "$cli_base" > "$cli_config.tmp" \
      && mv "$cli_config.tmp" "$cli_config" \
      && log "wrote the browser CLI config, pointed at the egress proxy"
  else
    cp "$cli_base" "$cli_config" \
      && log "wrote the browser CLI config; no egress proxy is configured"
  fi
fi

# And its skill, which the CLI installs itself. --global puts it in
# ~/.claude/skills rather than in the workspace, which is a git checkout that
# is none of our business. Re-run every start so the copy in the session's home
# follows the image rather than being frozen at whatever the home was filled
# with when the session was created.
#
# Runs after install_agent_config, and defers to it: a skill of this name in
# the box's merged set is the one the box gets. The dashboard showed that
# version as the effective one, so installing the image's copy over the top
# would be exactly the silent override the editor's merged view exists to
# prevent. This is the same direction the merge itself runs -- the more
# specific configuration wins -- with the image as the least specific layer of
# all. The image's copy fills the name in only while nothing has claimed it,
# and install_agent_config replaces it the moment something does.
if [ -f "$AGENT_SRC/manifest" ] \
   && grep -qxF 'skills/playwright-cli' "$AGENT_SRC/manifest"; then
  log "the playwright-cli skill is configured for this box; leaving the image's copy out"
elif command -v playwright-cli >/dev/null 2>&1; then
  if playwright-cli install --skills --global >/dev/null 2>&1; then
    log "installed the image's playwright-cli skill"
  else
    log "WARNING: could not install the playwright-cli skill"
  fi
fi

# --- git identity -----------------------------------------------------------
if [ -n "${GIT_NAME:-}" ]; then
  git config --global user.name "$GIT_NAME"
fi
if [ -n "${GIT_EMAIL:-}" ]; then
  git config --global user.email "$GIT_EMAIL"
fi
git config --global init.defaultBranch main
git config --global advice.detachedHead false
# /workspace is the agent's own volume. Marking it safe avoids git's
# dubious-ownership refusal when uid mapping differs across volume restores.
git config --global --add safe.directory '*'

# --- github auth ------------------------------------------------------------
if [ -n "${GH_TOKEN:-}" ]; then
  if gh auth setup-git 2>/dev/null; then
    log "configured git credential helper via gh"
  else
    log "WARNING: gh auth setup-git failed; https pushes may prompt"
  fi
fi

# --- hold the container -----------------------------------------------------
log "ready; holding container open"
exec sleep infinity
