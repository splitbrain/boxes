#!/usr/bin/env bash
# Security smoke test.
#
# Run on the Docker host after `docker compose up -d`. Creates throwaway
# sessions via the API, asserts the isolation properties from inside one of
# their containers, then cleans up.
#
#   API_BASE=http://localhost:3000 ./scripts/smoke-test.sh
#
# Every probe passes `curl -f`, so a 403 from the egress proxy leaves a
# non-zero exit status.
#
# The token-translation and allowlist sections below assert only what the
# deployment configured. Run it with credentials and an allowlist to
# exercise all of it:
#
#   PROFILE_DEFAULT_GH_TOKEN=ghp_...
#   PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
#   EGRESS_ALLOWED_HOSTS='github.com,*.github.com,*.githubusercontent.com,api.anthropic.com,registry.npmjs.org'
set -uo pipefail

API_BASE="${API_BASE:-http://localhost:3000}"
CURL_AUTH=()
if [ -n "${API_USER:-}" ]; then CURL_AUTH=(-u "${API_USER}:${API_PASS:-}"); fi

pass=0; fail=0; noted=0

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
grey()  { printf '\033[90m%s\033[0m\n' "$*"; }

# One call to the API, carrying whatever authenticates it. Same helper
# live-test.sh uses, so the two scripts read the same.
api() { curl -sS "${CURL_AUTH[@]}" "$@"; }

# Asserts a command run inside the session container FAILS.
must_fail() {
  local desc="$1"; shift
  if docker exec -u agent "$CONTAINER" "$@" >/dev/null 2>&1; then
    red   "FAIL (succeeded but must not): $desc"; fail=$((fail+1))
  else
    green "ok   (correctly denied):       $desc"; pass=$((pass+1))
  fi
}

# Asserts a command run inside the session container SUCCEEDS.
must_pass() {
  local desc="$1"; shift
  if docker exec -u agent "$CONTAINER" "$@" >/dev/null 2>&1; then
    green "ok   (allowed as intended):    $desc"; pass=$((pass+1))
  else
    red   "FAIL (denied but must work):  $desc"; fail=$((fail+1))
  fi
}

# Asserts a documented and accepted property: logs the outcome, never fails.
note() {
  local desc="$1"; shift
  if docker exec -u agent "$CONTAINER" "$@" >/dev/null 2>&1; then
    grey "note (reachable, accepted):    $desc"
  else
    grey "note (not reachable):          $desc"
  fi
  noted=$((noted+1))
}

# Asserts that a string appears nowhere in a session's environment or volumes.
# The needle is the real credential, so it is never printed.
absent_from_session() {
  local desc="$1" needle="$2"
  if [ -z "$needle" ]; then return; fi
  local found=0
  docker exec "$CONTAINER" env 2>/dev/null | grep -qF -- "$needle" && found=1
  docker exec "$CONTAINER" sh -c \
    'cat /proc/*/environ 2>/dev/null | tr "\0" "\n"' 2>/dev/null \
    | grep -qF -- "$needle" && found=1
  docker exec "$CONTAINER" sh -c \
    'grep -rlF -- "$0" /workspace /home/agent 2>/dev/null | head -1' "$needle" \
    2>/dev/null | grep -q . && found=1
  if [ "$found" -eq 1 ]; then
    red   "FAIL (real credential present): $desc"; fail=$((fail+1))
  else
    green "ok   (no real credential):      $desc"; pass=$((pass+1))
  fi
}

# Runs a command in the session and asserts its output matches a pattern.
must_output() {
  local desc="$1" pattern="$2"; shift 2
  local out
  out=$(docker exec -u agent "$CONTAINER" "$@" 2>&1)
  if printf '%s' "$out" | grep -Eq "$pattern"; then
    green "ok   (as intended):             $desc"; pass=$((pass+1))
  else
    red   "FAIL (unexpected output):     $desc"; fail=$((fail+1))
    grey  "     wanted /$pattern/, got: $(printf '%s' "$out" | head -c 200 | tr '\n' ' ')"
  fi
}

cleanup() {
  if [ -n "${SESSION_ID:-}" ]; then
    grey "cleaning up session $SESSION_ID"
    api -X DELETE "$API_BASE/api/sessions/$SESSION_ID" >/dev/null || true
  fi
  if [ -n "${SIBLING_ID:-}" ]; then
    api -X DELETE "$API_BASE/api/sessions/$SIBLING_ID" >/dev/null || true
  fi
}
trap cleanup EXIT

echo "== creating throwaway sessions =="
SESSION_ID=$(api -X POST "$API_BASE/api/sessions" \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke-test"}' | jq -r '.id')
[ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "null" ] || { red "could not create session"; exit 1; }

SIBLING_ID=$(api -X POST "$API_BASE/api/sessions" \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke-test-sibling"}' | jq -r '.id')

CONTAINER="session-$SESSION_ID"
SIBLING_CONTAINER="session-$SIBLING_ID"
SIBLING_IP=$(docker inspect -f \
  '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$SIBLING_CONTAINER" 2>/dev/null)
grey "session=$SESSION_ID sibling=$SIBLING_ID sibling_ip=${SIBLING_IP:-unknown}"

echo
echo "== MUST FAIL: direct (proxy-bypassing) egress =="
# The session network is internal: no NAT, no default route.
must_fail "curl --noproxy '*' https://api.github.com" \
  curl --noproxy '*' -fsS -m 3 https://api.github.com
must_fail "nc -w3 1.1.1.1 443" \
  nc -w3 -z 1.1.1.1 443

echo
echo "== MUST FAIL: private space via the proxy (resolved-IP vetting) =="
must_fail "curl http://192.168.1.1" \
  curl -fsS -m 3 http://192.168.1.1
must_fail "curl http://10.0.0.1" \
  curl -fsS -m 3 http://10.0.0.1
must_fail "curl http://169.254.169.254 (cloud metadata)" \
  curl -fsS -m 3 http://169.254.169.254/latest/meta-data/
# DNS-rebind shape: a public hostname whose A record is private.
must_fail "curl http://localtest.me (hostname -> private IP)" \
  curl -fsS -m 3 http://localtest.me
must_fail "curl http://[::ffff:192.168.1.1] (v4-mapped bypass)" \
  curl -fsS -m 3 'http://[::ffff:192.168.1.1]'

echo
echo "== MUST FAIL: cross-session reachability =="
if [ -n "${SIBLING_IP:-}" ]; then
  must_fail "nc -w3 <sibling> 22 (distinct internal networks)" \
    nc -w3 -z "$SIBLING_IP" 22
  must_fail "curl http://<sibling>:8080 via proxy" \
    curl -fsS -m 3 "http://$SIBLING_IP:8080"
else
  grey "skipped: sibling IP unavailable"
fi

echo
echo "== MUST FAIL: host and container escapes =="
must_fail "ls /var/run/docker.sock" \
  ls /var/run/docker.sock
must_fail "touch /usr/local/bin/x (read-only rootfs)" \
  touch /usr/local/bin/x

echo
echo "== MUST SUCCEED: intended egress and writes (via injected proxy env) =="
must_pass "curl https://api.github.com" \
  curl -fsS -m 15 https://api.github.com
must_pass "write to /workspace" \
  sh -c 'echo ok > /workspace/.smoke && rm /workspace/.smoke'
must_pass "write to /home/agent" \
  sh -c 'echo ok > /home/agent/.smoke && rm /home/agent/.smoke'
must_pass "write to /tmp (tmpfs)" \
  sh -c 'echo ok > /tmp/.smoke && rm /tmp/.smoke'

if [ -n "${SMOKE_BOT_FORK:-}" ]; then
  must_pass "git ls-remote \$SMOKE_BOT_FORK" \
    git ls-remote "$SMOKE_BOT_FORK"
fi
if [ "${SMOKE_CLAUDE:-0}" = "1" ]; then
  # Costs a real inference call, so opt-in.
  must_pass "claude -p 'reply ok' (subscription auth)" \
    claude -p 'reply ok'
fi

if [ -n "${SMOKE_UPSTREAM_REPO:-}" ]; then
  echo
  echo "== MUST FAIL: pushing to an upstream default branch =="
  # The bot is read-only on upstreams and works on forks, so a push straight at
  # the upstream must be refused. The clone lands in the tmpfs, leaving the
  # agent's workspace untouched, and is scored on its own, because only a
  # successful clone can test the push.
  if docker exec -u agent "$CONTAINER" sh -c \
       'rm -rf /tmp/upstream && git clone --depth 1 "$0" /tmp/upstream' \
       "$SMOKE_UPSTREAM_REPO" >/dev/null 2>&1; then
    must_fail "git push origin HEAD to \$SMOKE_UPSTREAM_REPO" \
      sh -c 'cd /tmp/upstream &&
             git commit --allow-empty -m "smoke test" >/dev/null &&
             git push origin HEAD'
  else
    red "FAIL: could not clone \$SMOKE_UPSTREAM_REPO to test the push guard"
    fail=$((fail+1))
  fi
fi

echo
echo "== pids limit containment =="
# PidsLimit must contain a fork bomb without affecting the host or the sibling
# session. Bounded, so the test itself cannot hang.
docker exec -u agent "$CONTAINER" sh -c \
  ':(){ :|:& };: & sleep 5; kill %1 2>/dev/null' >/dev/null 2>&1
if docker exec -u agent "$SIBLING_CONTAINER" true >/dev/null 2>&1; then
  green "ok   (sibling unaffected):      fork bomb contained by pids-limit"; pass=$((pass+1))
else
  red   "FAIL: sibling session affected by fork bomb"; fail=$((fail+1))
fi

echo
echo "== workspace storage: a directory on the data volume, bound in =="
# A session's workspace is a directory under the orchestrator's own /data,
# bind-mounted at /workspace. The agent must own it, one session must not see
# another's, and the parent must not be readable by a stray container.
must_pass "the agent can write to its bound workspace" \
  sh -c 'echo ok > /workspace/.smoke-ws && rm /workspace/.smoke-ws'

WS_SOURCE=$(docker inspect -f \
  '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Type}} {{.Source}}{{end}}{{end}}' \
  "$CONTAINER" 2>/dev/null)
case "$WS_SOURCE" in
  "bind "*/workspaces/"$SESSION_ID")
    green "ok   /workspace is a bind of the session's own directory"; pass=$((pass+1)) ;;
  *)
    red   "FAIL: /workspace is not a bind of workspaces/\$SESSION_ID: ${WS_SOURCE:-none}"
    fail=$((fail+1)) ;;
esac

# The orchestrator must see the very file the agent wrote, with no exec: that
# is what makes reviewing a stopped session possible at all.
docker exec -u agent "$CONTAINER" sh -c 'echo from-the-agent > /workspace/.smoke-seen' \
  >/dev/null 2>&1
if docker exec boxes-orchestrator \
     sh -c 'cat "/data/workspaces/'"$SESSION_ID"'/.smoke-seen"' 2>/dev/null \
     | grep -q from-the-agent; then
  green "ok   the orchestrator reads the agent's file directly"; pass=$((pass+1))
else
  red   "FAIL: the orchestrator cannot read the agent's workspace file"; fail=$((fail+1))
fi
docker exec -u agent "$CONTAINER" rm -f /workspace/.smoke-seen >/dev/null 2>&1

# 0700 on the parent, so mounting the data volume elsewhere shows nothing.
WS_MODE=$(docker exec boxes-orchestrator stat -c '%a' /data/workspaces 2>/dev/null)
if [ "$WS_MODE" = "700" ]; then
  green "ok   workspaces/ on the data volume is 0700"; pass=$((pass+1))
else
  red   "FAIL: workspaces/ is ${WS_MODE:-unknown}, must be 700"; fail=$((fail+1))
fi

# One session's workspace is not mounted into another, and the sibling's
# directory is not reachable from inside this one.
if [ -n "${SIBLING_ID:-}" ]; then
  docker exec -u agent "$SIBLING_CONTAINER" \
    sh -c 'echo sibling > /workspace/.smoke-sibling' >/dev/null 2>&1
  must_fail "the sibling's workspace file is not visible" \
    sh -c 'test -f /workspace/.smoke-sibling'
  must_fail "the data volume is not reachable from a session" \
    sh -c 'ls /data'
  docker exec -u agent "$SIBLING_CONTAINER" rm -f /workspace/.smoke-sibling \
    >/dev/null 2>&1
fi

echo
echo "== documented-but-accepted residual surface =="
# Docker's internal-network isolation filters forwarded traffic only, so the
# host stays addressable at its per-bridge IP. The owner accepted this, so it
# is logged rather than failed.
HOST_BRIDGE_IP=$(docker network inspect "sn-$SESSION_ID" \
  -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null)
if [ -n "$HOST_BRIDGE_IP" ]; then
  note "host per-bridge IP $HOST_BRIDGE_IP:22" nc -w3 -z "$HOST_BRIDGE_IP" 22
fi

echo
echo "== token translation: the session holds placeholders, not credentials =="
# What the deployment configured, read back from the orchestrator's own env.
REAL_GH=$(docker exec boxes-orchestrator printenv PROFILE_DEFAULT_GH_TOKEN 2>/dev/null || true)
REAL_CLAUDE=$(docker exec boxes-orchestrator printenv PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN 2>/dev/null || true)

if [ -z "$REAL_GH" ] && [ -z "$REAL_CLAUDE" ]; then
  grey "skipped: this deployment configures no credential, so it translates none"
else
  absent_from_session "GH_TOKEN is nowhere in the session" "$REAL_GH"
  absent_from_session "CLAUDE_CODE_OAUTH_TOKEN is nowhere in the session" "$REAL_CLAUDE"

  if [ -n "$REAL_GH" ]; then
    # The placeholder must authenticate as the bot: proof the proxy swapped it.
    must_output "curl api.github.com/user with the placeholder is the bot" '"login"' \
      sh -c 'curl -fsS -m 15 -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user'
    # An invented token must be refused by the proxy, not forwarded to GitHub.
    must_output "an invented GitHub token is refused by the proxy" 'egress denied' \
      sh -c 'curl -sS -m 15 -H "Authorization: Bearer ghp_notTheDeploymentsToken" https://api.github.com/user'
  fi
  if [ -n "$REAL_CLAUDE" ]; then
    must_output "an invented Anthropic token is refused by the proxy" 'egress denied' \
      sh -c 'curl -sS -m 15 -H "Authorization: Bearer sk-ant-oat01-notTheDeploymentsToken" https://api.anthropic.com/v1/messages'
  fi

  # Interception is bounded: the deployment CA appears for a translated host
  # and nowhere else.
  must_output "an injection host presents the deployment CA" 'Boxes egress proxy CA' \
    sh -c 'curl -sS -m 15 -v https://api.github.com/ 2>&1 | grep -i "issuer:"'
  must_output "a passthrough host presents its own certificate chain" 'issuer:' \
    sh -c 'curl -sS -m 15 -v https://registry.npmjs.org/ 2>&1 | grep -i "issuer:" | grep -v "Boxes egress proxy CA"'
fi

echo
echo "== egress allowlist =="
ALLOWLIST=$(docker exec boxes-orchestrator printenv EGRESS_ALLOWED_HOSTS 2>/dev/null || true)
if [ -z "$ALLOWLIST" ]; then
  # Unset is the documented default: any public host, private ranges still denied.
  must_pass "allowlist unset: https://example.com is reachable" \
    curl -fsS -m 15 https://example.com
  grey "note (allowlist off):          set EGRESS_ALLOWED_HOSTS to exercise the deny probes"
  noted=$((noted+1))
else
  grey "allowlist: $ALLOWLIST"
  must_fail "an unlisted host is denied" \
    curl -fsS -m 15 https://example.com
  must_fail "an unlisted address literal is denied" \
    curl -fsS -m 15 https://1.1.1.1
  must_pass "a listed host is still reachable" \
    curl -fsS -m 15 https://registry.npmjs.org/
  # A narrow allowlist must never sever the credential hosts.
  must_pass "a credential host is implied by the allowlist" \
    curl -fsS -m 15 https://api.github.com
fi

echo
echo "== egress policy is live in the proxy =="
if api "$API_BASE/healthz" | jq -e '.egress.inSync == true' >/dev/null; then
  green "ok   proxy is running the policy the orchestrator composed"; pass=$((pass+1))
elif api "$API_BASE/healthz" | jq -e '.egress == null' >/dev/null; then
  grey "note (no policy pushed yet):   /healthz reports no egress state"
  noted=$((noted+1))
else
  red   "FAIL: the proxy is not running the composed policy"; fail=$((fail+1))
  api "$API_BASE/healthz" | jq -c '.egress' | sed 's/^/     /'
fi

echo
echo "== proxy attachment =="
if api "$API_BASE/api/sessions/$SESSION_ID" | jq -e '.proxyAttached' >/dev/null; then
  green "ok   proxy attached to session network"; pass=$((pass+1))
else
  red   "FAIL: egress proxy is not attached to the session network"; fail=$((fail+1))
fi

echo
echo "=================================="
echo "passed: $pass   failed: $fail   noted: $noted"
[ "$fail" -eq 0 ] || exit 1
green "smoke test green"
