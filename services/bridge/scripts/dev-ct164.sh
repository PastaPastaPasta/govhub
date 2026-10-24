#!/usr/bin/env bash
# Development only: run a bridge command against the temporary mainnet Core on R730 CT 164 through an SSH tunnel.
# The tunnel lives exactly as long as this script; it is torn down on exit (also on Ctrl-C / timeout).
#
#   scripts/dev-ct164.sh backfill
#   BRIDGE_RUN_SECONDS=540 scripts/dev-ct164.sh run          # run for a bounded time, then stop cleanly
#
# Secrets are read from files outside the repo:
#   ~/.local/share/govhub-dev/mainnet.rpcpw      Core RPC password (0600)
#   ~/.local/share/govhub-dev/bridge-key.json    bridge identity key file (0600), only needed with PUBLISH=1
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dev="${GOVHUB_DEV_DIR:-$HOME/.local/share/govhub-dev}"
host="${CT164_HOST:-root@192.168.5.227}"
rpc_port="${DEV_RPC_PORT:-19998}"
zmq_port="${DEV_ZMQ_PORT:-29998}"

ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
  -L "${rpc_port}:127.0.0.1:9998" -L "${zmq_port}:127.0.0.1:29998" "$host" &
tunnel=$!
bridge_pid=""
cleanup() {
  [ -n "$bridge_pid" ] && kill "$bridge_pid" 2>/dev/null || true
  kill "$tunnel" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM
for _ in $(seq 1 50); do
  nc -z 127.0.0.1 "$rpc_port" 2>/dev/null && break
  sleep 0.2
done

export CORE_NETWORK="${CORE_NETWORK:-mainnet}"
export PLATFORM_NETWORK="${PLATFORM_NETWORK:-testnet}"
export CORE_RPC_URL="http://127.0.0.1:${rpc_port}"
export CORE_RPC_USER="${CORE_RPC_USER:-quorumproofs}"
export CORE_RPC_PASSWORD_FILE="${CORE_RPC_PASSWORD_FILE:-$dev/mainnet.rpcpw}"
export CORE_ZMQ_URL="tcp://127.0.0.1:${zmq_port}"
export GOV_CONTRACT_ID="${GOV_CONTRACT_ID:-3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ}"
export BRIDGE_IDENTITY_KEY_FILE="${BRIDGE_IDENTITY_KEY_FILE:-$dev/bridge-key.json}"
export DB_PATH="${DB_PATH:-$dev/bridge-mainnet.sqlite}"
export HTTP_PORT="${HTTP_PORT:-8787}"
export PUBLISH="${PUBLISH:-0}"

cd "$here"
if [ "${1:-}" = "run" ] && [ -n "${BRIDGE_RUN_SECONDS:-}" ]; then
  node bin/bridge.mjs run &
  bridge_pid=$!
  for _ in $(seq 1 "$BRIDGE_RUN_SECONDS"); do
    kill -0 "$bridge_pid" 2>/dev/null || break
    sleep 1
  done
  kill -TERM "$bridge_pid" 2>/dev/null || true
  wait "$bridge_pid" 2>/dev/null || true
  bridge_pid=""
else
  node bin/bridge.mjs "$@"
fi
