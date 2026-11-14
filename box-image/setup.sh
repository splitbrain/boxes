#!/usr/bin/env bash
# Setup of the home of a box. The orchestrator runs it as the agent after each
# start of the box, before the box is ready.
#
# A step that breaks the box fails it, and the orchestrator marks the box as
# an error with this output. A step that breaks one tool only warns. The
# setup runs every step, so the output names every failure.
set -uo pipefail

# Writes the arguments as one line with the prefix [setup] to stderr, which the
# orchestrator reads.
log() { printf '[setup] %s\n' "$*" >&2; }

failed=0

# Logs the arguments as an error and records a failure, which the exit status
# of the script reports at the end.
fail() {
  log "ERROR: $*"
  failed=1
}

# --- the home seed ----------------------------------------------------------
# A new home gets the files of the image's seed directory, once. The marker
# keeps a file that the agent deleted from coming back. The copy overwrites
# nothing and keeps the mode of the home itself, so a home that has files
# keeps them.
seed=/usr/local/share/boxes/home
marker=/home/agent/.boxes/seeded
if [ ! -e "$marker" ]; then
  if cp -R --update=none "$seed/." /home/agent/ \
     && mkdir -p /home/agent/.boxes \
     && touch "$marker"; then
    log "seeded the home from $seed"
  else
    fail "could not seed the home from $seed; the shell and the harnesses would miss their files"
  fi
fi

# --- scratch space ----------------------------------------------------------
# TMPDIR lies on the persistent home, so the setup empties it at every start.
# The seed does not hold TMPDIR, so the setup creates it. Only the contents
# go, so a wrong TMPDIR cannot delete a directory that matters.
if [ -n "${TMPDIR:-}" ]; then
  if mkdir -p "$TMPDIR"; then
    find "$TMPDIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null
  else
    log "WARNING: could not create $TMPDIR; tools reading TMPDIR will fail"
  fi
fi

# --- the trust store -----------------------------------------------------------
# /etc/ssl/certs links to ~/.boxes/certs. The setup points that link at a new
# copy of the system certificates with the deployment CA, which the
# orchestrator writes to ~/.boxes/proxy-ca.crt. A new name for each copy lets
# one rename switch the link. ca-bundle.crt links to the bundle file, because
# the CA env vars and nix.conf of the full image name it.

# Adds the deployment CA to the bundle file and the hash links of a copy of
# the trust store, so clients that read either one trust it.
#
# $1 is the directory of the copy. Returns non-zero when a step fails.
add_proxy_ca() {
  local hash
  hash=$(openssl x509 -noout -subject_hash -in "$proxy_ca") \
    && cp "$proxy_ca" "$1/boxes-proxy-ca.pem" \
    && cat "$proxy_ca" >> "$1/ca-certificates.crt" \
    && ln -s boxes-proxy-ca.pem "$1/$hash.0"
}

proxy_ca=/home/agent/.boxes/proxy-ca.crt
certs=/home/agent/.boxes/certs
copy=
if mkdir -p /home/agent/.boxes \
   && copy=$(mktemp -d "$certs.XXXXXX") \
   && chmod 0755 "$copy" \
   && cp -a /etc/ssl/certs-system/. "$copy/" \
   && { [ ! -f "$proxy_ca" ] || add_proxy_ca "$copy"; } \
   && ln -sfn certs/ca-certificates.crt "$certs.new" \
   && mv -T "$certs.new" /home/agent/.boxes/ca-bundle.crt \
   && ln -sfn "$(basename "$copy")" "$certs.new" \
   && mv -T "$certs.new" "$certs"; then
  find /home/agent/.boxes -maxdepth 1 -name 'certs.*' ! -name "$(basename "$copy")" -exec rm -rf {} +
  log "wrote the trust store to $copy"
else
  [ -z "$copy" ] || rm -rf "$copy"
  rm -f "$certs.new"
  fail "could not write the trust store to $certs; TLS would fail for nix, git, curl and other tools"
fi

# --- directories an agent needs to find already there ------------------------
# npm install -g needs its prefix to exist, and Codex fails on a missing
# CODEX_HOME. .NET programs such as devtunnel put their data into the working
# directory when ~/.local/share is missing. The seed holds none of these
# directories.
if ! mkdir -p /home/agent/.local/bin; then
  fail "could not create /home/agent/.local/bin; installing tools would fail"
fi
if ! mkdir -p /home/agent/.local/share; then
  fail "could not create /home/agent/.local/share; devtunnel would write into the working directory"
fi
if ! mkdir -p "${CODEX_HOME:-/home/agent/.codex}"; then
  fail "could not create ${CODEX_HOME:-/home/agent/.codex}; Codex would not start"
fi

# --- github auth ------------------------------------------------------------
if [ -n "${GH_TOKEN:-}" ]; then
  if gh auth setup-git 2>/dev/null; then
    log "configured git credential helper via gh"
  else
    log "WARNING: gh auth setup-git failed; https pushes may prompt"
  fi
fi

# --- gitlab auth ------------------------------------------------------------
# glab clones over ssh by default, and the box network has no route for ssh.
if glab config set --global git_protocol https >/dev/null 2>&1; then
  log "set the git protocol of glab to https"
else
  log "WARNING: could not set the git protocol of glab; glab clones may use ssh and fail"
fi

# glab reads GITLAB_TOKEN and GITLAB_HOST from the environment. git uses
# glab's credential helper for that one host.
if [ -n "${GITLAB_TOKEN:-}" ] && [ -n "${GITLAB_HOST:-}" ]; then
  if git config --global "credential.https://${GITLAB_HOST}.helper" '!glab auth git-credential'; then
    log "configured git credential helper for $GITLAB_HOST via glab"
  else
    log "WARNING: could not configure the glab credential helper; https pushes to $GITLAB_HOST may prompt"
  fi
fi

# --- the steps of the image ----------------------------------------------------
# An image built from this one adds its steps as executable files. Each runs
# in name order, under the same rules as this script: a non-zero exit code
# is an error of the box, and a WARNING: line is a warning.
for step in /usr/local/lib/boxes/setup.d/*; do
  if [ ! -f "$step" ] || [ ! -x "$step" ]; then
    continue
  fi
  if ! "$step"; then
    fail "the setup step $(basename "$step") failed"
  fi
done

exit "$failed"
