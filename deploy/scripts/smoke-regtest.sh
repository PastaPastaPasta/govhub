#!/usr/bin/env bash
# End-to-end smoke test on an isolated regtest chain. Touches no real network and never writes to
# Platform (the bridge runs with PUBLISH=0).
#
#   1. start dashd + bridge (regtest profile) under a throwaway compose project
#   2. mine blocks, `gobject prepare` a proposal, mine confirmations, `gobject submit`
#   3. wait until the bridge's /v1/status reports the proposal
#   4. tear everything down (containers, volumes, temp secrets), even on failure
#
# Usage: deploy/scripts/smoke-regtest.sh [--keep] [--stub]
#   --keep   leave the stack running afterwards (you must `docker compose -p <project> down -v`)
#   --stub   use the placeholder bridge (docker-compose.bridge-stub.yml) and skip the bridge check.
#            Exercises only the Core side. Automatic when services/bridge/Dockerfile is absent.
#
# Environment:
#   SMOKE_TIMEOUT_S     seconds to wait for the bridge to report the proposal (default 120)
#   DASHD_TAG           dashd image tag (default: the regtest override's)
#   SMOKE_BRIDGE_PORT   host port for the bridge (default: a free port)
#   SMOKE_SUBNET        compose subnet (default: 172.29.<100-199>.0/24, derived from the PID)
#
# What the bridge must provide (see README, "Bridge contract"): honor PUBLISH=0; GET /v1/status
# returns JSON that contains the proposal's governance hash (display hex) OR a numeric field named
# `proposals` >= 1 somewhere in the document.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"

KEEP=0
STUB=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --stub) STUB=1 ;;
    -h | --help) awk 'NR > 1 && !/^#/ { exit } NR > 1' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '[smoke %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# ---- the bridge check (a function so it can be tested on its own) -----------------------------
# status_reports_proposal <json-file> <govhash>
status_reports_proposal() {
  local file="$1" hash="$2"
  grep -qi -- "$hash" "$file" && return 0
  if command -v jq > /dev/null 2>&1; then
    local n
    n="$(jq -r '[.. | objects | .proposals? | numbers] | max // 0' "$file" 2> /dev/null || echo 0)"
    [ "${n:-0}" -ge 1 ] 2> /dev/null && return 0
  fi
  return 1
}

# wait_for_bridge <url> <govhash> <timeout-seconds>
wait_for_bridge() {
  local url="$1" hash="$2" timeout="$3" waited=0 body
  body="$(mktemp)"
  while [ "$waited" -lt "$timeout" ]; do
    if curl -fsS --max-time 5 "$url" -o "$body" 2> /dev/null && status_reports_proposal "$body" "$hash"; then
      log "bridge /v1/status reports the proposal:"
      head -c 600 "$body"; echo
      rm -f "$body"
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  log "timed out after ${timeout}s; last /v1/status body:"
  head -c 1000 "$body" 2> /dev/null || true; echo
  rm -f "$body"
  return 1
}

# Allow tests to source the functions without running the stack.
if [ "${SMOKE_SOURCE_ONLY:-0}" = 1 ]; then
  # shellcheck disable=SC2317  # `exit` is the fallback when the file is executed, not sourced
  return 0 2> /dev/null || exit 0
fi

if [ ! -f "$REPO_ROOT/services/bridge/Dockerfile" ] && [ "$STUB" -eq 0 ]; then
  echo "note: services/bridge/Dockerfile not found, falling back to --stub (Core side only)" >&2
  STUB=1
fi

for tool in docker curl; do
  command -v "$tool" > /dev/null 2>&1 || { echo "missing prerequisite: $tool" >&2; exit 2; }
done

# ---- throwaway project, secrets and port ------------------------------------------------------
PROJECT="govhub-smoke-$$"
SECRETS_TMP="$(mktemp -d)"
trap 'rm -rf "$SECRETS_TMP"' EXIT   # replaced by cleanup() once the stack exists
chmod 700 "$SECRETS_TMP"
openssl_hex() { if command -v openssl > /dev/null 2>&1; then openssl rand -hex 32; else LC_ALL=C od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; fi; }
(umask 077 && openssl_hex > "$SECRETS_TMP/core_rpc_password")
# Regtest never reads the identity, but a Linux host with uid != 1000 needs the files readable.
chmod 644 "$SECRETS_TMP/core_rpc_password" 2> /dev/null || true

free_port() {
  if command -v python3 > /dev/null 2>&1; then
    python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
  else
    echo 18787
  fi
}
BRIDGE_PORT_HOST="${SMOKE_BRIDGE_PORT:-$(free_port)}"

COMPOSE_FILE_VALUE="docker-compose.yml:docker-compose.regtest.yml"
if [ "$STUB" -eq 1 ]; then
  COMPOSE_FILE_VALUE="$COMPOSE_FILE_VALUE:docker-compose.bridge-stub.yml"
fi

# A per-run bridge image tag: building must never re-tag the image a real stack on this host uses.
BRIDGE_IMAGE_TAG="smoke-$$"
# A per-run subnet (172.29.100-199.0/24) so two runs on one host do not collide.
SMOKE_SUBNET_VALUE="${SMOKE_SUBNET:-172.29.$((100 + $$ % 100)).0/24}"

# Everything compose reads comes from here, so a developer's own .env cannot leak in:
# --env-file replaces the default .env. (Exported shell variables would still win over it;
# dc() unsets every variable .env.example knows.)
ENV_FILE="$SECRETS_TMP/smoke.env"
cat > "$ENV_FILE" << EOF
COMPOSE_FILE=$COMPOSE_FILE_VALUE
COMPOSE_PROJECT_NAME=$PROJECT
COMPOSE_PROFILES=
SECRETS_DIR=$SECRETS_TMP
BRIDGE_BIND=127.0.0.1
BRIDGE_PORT=$BRIDGE_PORT_HOST
BRIDGE_TAG=$BRIDGE_IMAGE_TAG
GOVHUB_SUBNET=$SMOKE_SUBNET_VALUE
DASHD_DBCACHE_MB=128
DASHD_HEALTH_START_PERIOD=2m
${DASHD_TAG:+DASHD_TAG=$DASHD_TAG}
EOF

# Variables the compose files read, from .env.example (active and commented-out lines).
UNSET_ARGS=()
while IFS= read -r var; do
  UNSET_ARGS+=(-u "$var")
done < <(grep -hoE '^#? ?[A-Z][A-Z0-9_]+=' "$DEPLOY_DIR/.env.example" | tr -d '# =' | sort -u)

dc() { (cd "$DEPLOY_DIR" && env "${UNSET_ARGS[@]}" docker compose -p "$PROJECT" --env-file "$ENV_FILE" "$@"); }
cli() { dc exec -T dashd dash-cli -conf=/tmp/dash.conf "$@"; }
wcli() { cli -rpcwallet=w "$@"; }

cleanup() {
  local rc=$?
  trap - EXIT
  if [ "$KEEP" -eq 1 ] && [ "$rc" -eq 0 ]; then
    log "--keep: stack left running as project $PROJECT (secrets in $SECRETS_TMP)"
    log "tear down: cd $DEPLOY_DIR && docker compose -p $PROJECT --env-file $ENV_FILE down -v --remove-orphans"
    exit "$rc"
  fi
  if [ "$rc" -ne 0 ]; then
    log "FAILED (exit $rc). Recent logs:"
    dc logs --no-color --tail 40 2>&1 | sed 's/^/    /' || true
  fi
  log "tearing down"
  dc down -v --remove-orphans > /dev/null 2>&1 || true
  # Only the per-run bridge image; dashd/busybox/caddy images are shared and stay.
  docker image rm "govhub-bridge:$BRIDGE_IMAGE_TAG" > /dev/null 2>&1 || true
  rm -rf "$SECRETS_TMP"
  if [ "$rc" -eq 0 ]; then log "PASS"; else log "FAIL"; fi
  exit "$rc"
}
# INT/TERM must exit non-zero: a bare trap on them would see the interrupted command's status.
trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup EXIT

# ---- 1. start the stack -----------------------------------------------------------------------
log "project $PROJECT, compose files: $COMPOSE_FILE_VALUE"
dc config -q
# --wait returns once every service is running/healthy; the bridge waits on dashd's health check.
if [ "$STUB" -eq 1 ]; then
  dc up -d --wait --wait-timeout 300
else
  dc up -d --build --wait --wait-timeout 600
fi
log "stack is up: $(dc ps --format '{{.Service}}={{.Health}}' | tr '\n' ' ')"

# ---- 2. mine, prepare, submit -----------------------------------------------------------------
log "dashd: $(cli getnetworkinfo | grep -m1 '"subversion"' | tr -d ' ,')"
wcli getwalletinfo > /dev/null 2>&1 || cli createwallet w > /dev/null
ADDR="$(wcli getnewaddress)"
PAYEE="$(wcli getnewaddress)"
log "mining 120 blocks to $ADDR (coinbase maturity is 100)"
cli generatetoaddress 120 "$ADDR" > /dev/null
# gobject submit refuses to run until the (peerless) node believes it is synced.
cli mnsync next > /dev/null 2>&1 || true
cli mnsync next > /dev/null 2>&1 || true

NOW="$(date +%s)"
DATA_JSON="$(printf '{"end_epoch":%s,"name":"govhub-smoke","payment_address":"%s","payment_amount":10,"start_epoch":%s,"type":1,"url":"https://example.invalid/govhub-smoke"}' \
  $((NOW + 3 * 365 * 86400)) "$PAYEE" "$NOW")"
DATA_HEX="$(printf '%s' "$DATA_JSON" | od -An -v -tx1 | tr -d ' \n')"

log "gobject check"
wcli gobject check "$DATA_HEX" > /dev/null

log "gobject prepare (burns the 1 DASH proposal fee into an OP_RETURN)"
COLLATERAL="$(wcli gobject prepare 0 1 "$NOW" "$DATA_HEX")"
[ -n "$COLLATERAL" ] || { log "gobject prepare returned nothing"; exit 1; }
log "collateral txid $COLLATERAL; mining 8 confirmations"
cli generatetoaddress 8 "$ADDR" > /dev/null

log "gobject submit"
GOVHASH="$(wcli gobject submit 0 1 "$NOW" "$DATA_HEX" "$COLLATERAL" | tr -d '"[:space:]')"
if ! printf '%s' "$GOVHASH" | grep -Eq '^[0-9a-f]{64}$'; then
  log "unexpected gobject submit output: $GOVHASH"
  exit 1
fi
log "governance hash $GOVHASH"
cli gobject get "$GOVHASH" | grep -q '"DataString"' || { log "Core does not list the object"; exit 1; }

# ---- 3. the bridge ----------------------------------------------------------------------------
if [ "$STUB" -eq 1 ]; then
  log "stub bridge: skipping the bridge check (Core side verified: prepare, confirm, submit, get)"
else
  wait_for_bridge "http://127.0.0.1:$BRIDGE_PORT_HOST/v1/status" "$GOVHASH" "${SMOKE_TIMEOUT_S:-120}"
fi
