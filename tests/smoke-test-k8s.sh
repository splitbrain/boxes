#!/usr/bin/env bash
# Security smoke test, the Kubernetes-specific half.
#
# This does NOT replace tests/smoke-test.sh. Credential translation, TLS
# interception, the egress allowlist and /healthz are exercised entirely over
# the orchestrator's HTTP API and are backend-independent — run the original
# script against this deployment too, with API_BASE pointed at it:
#
#   API_BASE=http://boxes-orchestrator.boxes-sessions.svc.cluster.local:3000 \
#     ./tests/smoke-test.sh
#
# (or through a port-forward, from outside the cluster). What is here instead
# is everything that only exists, or only differs, because a box is a pod
# rather than a Docker container: whether NetworkPolicy is enforced at all,
# the pod's own security context, PVC persistence across a stop/start, and the
# egress proxy's control-channel isolation.
#
# Run with a kubectl context already pointed at the right cluster:
#
#   API_BASE=http://localhost:3000 ./tests/smoke-test-k8s.sh
#
# (API_BASE typically reaches the orchestrator through a
# `kubectl port-forward svc/boxes-orchestrator 3000:3000` left running in
# another terminal.)
set -uo pipefail

API_BASE="${API_BASE:-http://localhost:3000}"
NAMESPACE="${K8S_NAMESPACE:-boxes-sessions}"
CURL_AUTH=()
if [ -n "${API_USER:-}" ]; then CURL_AUTH=(-u "${API_USER}:${API_PASS:-}"); fi

pass=0; fail=0

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
grey()  { printf '\033[90m%s\033[0m\n' "$*"; }

api() { curl -sS "${CURL_AUTH[@]}" "$@"; }

kexec() { kubectl exec -n "$NAMESPACE" "$@"; }

cleanup() {
  if [ -n "${BOX_ID:-}" ]; then
    grey "cleaning up box $BOX_ID"
    api -X DELETE "$API_BASE/api/boxes/$BOX_ID" >/dev/null || true
  fi
  if [ -n "${SIBLING_ID:-}" ]; then
    api -X DELETE "$API_BASE/api/boxes/$SIBLING_ID" >/dev/null || true
  fi
}
trap cleanup EXIT

echo "== creating throwaway boxes =="
BOX_ID=$(api -X POST "$API_BASE/api/boxes" \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke-test-k8s"}' | jq -r '.id')
[ -n "$BOX_ID" ] && [ "$BOX_ID" != "null" ] || { red "could not create box"; exit 1; }

SIBLING_ID=$(api -X POST "$API_BASE/api/boxes" \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke-test-k8s-sibling"}' | jq -r '.id')
[ -n "$SIBLING_ID" ] && [ "$SIBLING_ID" != "null" ] || { red "could not create sibling box"; exit 1; }

POD="boxes-box-$BOX_ID"
SIBLING_POD="boxes-box-$SIBLING_ID"
grey "box=$BOX_ID pod=$POD sibling=$SIBLING_ID sibling_pod=$SIBLING_POD"

# Both pods have to actually be up before anything below is a fair test of
# the network between them, rather than of how fast they schedule.
wait_running() {
  local pod="$1"
  for _ in $(seq 1 30); do
    [ "$(kubectl get pod -n "$NAMESPACE" "$pod" -o jsonpath='{.status.phase}' 2>/dev/null)" = "Running" ] && return 0
    sleep 2
  done
  return 1
}
wait_running "$POD" || { red "FAIL: $POD never reached Running"; exit 1; }
wait_running "$SIBLING_POD" || { red "FAIL: $SIBLING_POD never reached Running"; exit 1; }

echo
echo "== THE CRITICAL CHECK: is NetworkPolicy enforced at all? =="
# Every box gets a NetworkPolicy (orchestrator/src/kubernetes.ts), but a
# NetworkPolicy object is inert on a CNI that does not enforce it — Flannel's
# default configuration in kind, minikube and stock k3s, among others. This
# is not a note: if this reaches the sibling, box isolation on this
# cluster does not exist no matter how many policies are applied, and saying
# so quietly would be worse than not testing it at all.
#
# A real listener has to be running on the sibling first: connecting to a
# port nothing listens on fails whether or not NetworkPolicy is enforced (an
# instant refusal either way), which would make this check pass on a cluster
# where isolation does not work at all. The listener is what turns "cannot
# connect" into evidence.
SIBLING_IP=$(kubectl get pod -n "$NAMESPACE" "$SIBLING_POD" -o jsonpath='{.status.podIP}' 2>/dev/null)
if [ -z "$SIBLING_IP" ]; then
  red "FAIL: could not read the sibling pod's IP; cannot run the isolation check at all"
  fail=$((fail+1))
else
  kexec "$SIBLING_POD" -- sh -c 'nohup nc -l 8123 >/dev/null 2>&1 &' >/dev/null 2>&1
  sleep 1
  if kexec "$POD" -- nc -w3 -z "$SIBLING_IP" 8123 >/dev/null 2>&1; then
    red   "FAIL: box pod reached its sibling's open port ($SIBLING_IP:8123) — NetworkPolicy is NOT enforced on this cluster"
    red   "      Box isolation is not real here. Install a NetworkPolicy-enforcing CNI"
    red   "      (Calico, Cilium) — Flannel's default configuration does not enforce it."
    fail=$((fail+1))
  else
    green "ok   box pod cannot reach its sibling's open port — NetworkPolicy is enforced"; pass=$((pass+1))
  fi
fi

echo
echo "== pod security context =="
SEC_JSON=$(kubectl get pod -n "$NAMESPACE" "$POD" -o json)
check_field() {
  local desc="$1" jq_expr="$2" wanted="$3"
  local got
  got=$(printf '%s' "$SEC_JSON" | jq -r "$jq_expr")
  if [ "$got" = "$wanted" ]; then
    green "ok   $desc"; pass=$((pass+1))
  else
    red   "FAIL: $desc (wanted $wanted, got $got)"; fail=$((fail+1))
  fi
}
check_field "readOnlyRootFilesystem" '.spec.containers[0].securityContext.readOnlyRootFilesystem' 'true'
check_field "runAsNonRoot" '.spec.containers[0].securityContext.runAsNonRoot' 'true'
check_field "allowPrivilegeEscalation is false" '.spec.containers[0].securityContext.allowPrivilegeEscalation' 'false'
if printf '%s' "$SEC_JSON" | jq -e '.spec.containers[0].securityContext.capabilities.drop | index("ALL")' >/dev/null; then
  green "ok   all capabilities dropped"; pass=$((pass+1))
else
  red   "FAIL: capabilities.drop does not include ALL"; fail=$((fail+1))
fi

echo
echo "== PVC persistence across stop/start (delete-and-recreate, not pause) =="
# Kubernetes has no pause: stop() deletes the pod, start() creates a fresh one
# against the same PVCs. This is the whole bet that nothing is lost by it.
kexec "$POD" -- sh -c 'echo from-before-the-stop > /workspace/.smoke-k8s' >/dev/null 2>&1
# The Nix store is a PVC of its own, and nix needs it writable by the agent.
if kexec "$POD" -- sh -c 'echo from-before-the-stop > /nix/.smoke-k8s' >/dev/null 2>&1; then
  green "ok   the agent can write to its Nix store"; pass=$((pass+1))
else
  red   "FAIL: /nix is not writable by the agent — nix will not work in this box"; fail=$((fail+1))
fi
api -X POST "$API_BASE/api/boxes/$BOX_ID/stop" >/dev/null
for _ in $(seq 1 15); do
  kubectl get pod -n "$NAMESPACE" "$POD" >/dev/null 2>&1 || break
  sleep 2
done
if kubectl get pod -n "$NAMESPACE" "$POD" >/dev/null 2>&1; then
  red "FAIL: pod still exists after stop; cannot test the recreate"; fail=$((fail+1))
else
  green "ok   stop deleted the pod"; pass=$((pass+1))
  api -X POST "$API_BASE/api/boxes/$BOX_ID/start" >/dev/null
  wait_running "$POD" || { red "FAIL: pod did not come back after start"; fail=$((fail+1)); }
  if kexec "$POD" -- cat /workspace/.smoke-k8s 2>/dev/null | grep -q from-before-the-stop; then
    green "ok   the file written before stop is still on the recreated pod's PVC"; pass=$((pass+1))
  else
    red   "FAIL: the file did not survive stop/start — the PVC was not reattached"; fail=$((fail+1))
  fi
  if kexec "$POD" -- cat /nix/.smoke-k8s 2>/dev/null | grep -q from-before-the-stop; then
    green "ok   the Nix store survived stop/start"; pass=$((pass+1))
  else
    red   "FAIL: the Nix store did not survive stop/start"; fail=$((fail+1))
  fi
  kexec "$POD" -- rm -f /workspace/.smoke-k8s /nix/.smoke-k8s >/dev/null 2>&1
fi

echo
echo "== egress proxy control-channel isolation =="
# proxy/src/control.ts accepts whichever caller's bearer token reaches
# POST /policy first as the one it trusts from then on (see
# k8s/egress-proxy.yaml). A box pod reaching the control port at all would
# let it race the orchestrator for that trust, so this must fail exactly the
# way the data port must succeed.
if kexec "$POD" -- nc -w3 -z "boxes-egress-proxy.$NAMESPACE.svc.cluster.local" 3129 >/dev/null 2>&1; then
  red   "FAIL: a box pod reached the egress proxy's control port (3129) — it could hijack the control channel"
  fail=$((fail+1))
else
  green "ok   a box pod cannot reach the egress proxy's control port"; pass=$((pass+1))
fi
if kexec "$POD" -- sh -c 'nc -w3 -z boxes-egress-proxy.'"$NAMESPACE"'.svc.cluster.local 3128' >/dev/null 2>&1; then
  green "ok   a box pod can reach the egress proxy's data port"; pass=$((pass+1))
else
  red   "FAIL: a box pod cannot reach the egress proxy's data port — boxes would have no egress at all"
  fail=$((fail+1))
fi

echo
echo "=================================="
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ] || exit 1
green "kubernetes smoke test green"
