#!/usr/bin/env bash
# Development only, run ONCE: governance re-sync of the CT 164 dashd while the bridge listens on ZMQ, so every current
# signed vote is re-accepted by Core and published on rawgovernancevote (RPC never returns vote signatures).
# Procedure (README "Backfill"): start listener -> stop dashd -> back up and move governance.dat aside -> start dashd.
#
#   RESYNC_CONFIRM=yes scripts/dev-ct164-resync.sh
set -euo pipefail
[ "${RESYNC_CONFIRM:-}" = "yes" ] || { echo "set RESYNC_CONFIRM=yes" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
host="${CT164_HOST:-root@192.168.5.227}"
total="${BRIDGE_RUN_SECONDS:-560}"
port="${HTTP_PORT:-8787}"

BRIDGE_RUN_SECONDS="$total" "$here/dev-ct164.sh" run &
runner=$!
trap 'kill $runner 2>/dev/null || true; wait 2>/dev/null || true' EXIT INT TERM

# wait for the listener: /v1/status answers and ZMQ has delivered at least one message or 40 s passed
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${port}/v1/status" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${port}/v1/status" | head -c 600; echo

ts="$(date -u +%Y%m%dT%H%M%SZ)"
ssh -o BatchMode=yes "$host" "TS=$ts bash -s" <<'REMOTE'
set -euo pipefail
d=/var/lib/dashcore/mainnet
cd "$d"
# Raise the ZMQ publisher high-water marks (default 1000 per socket) so the burst of re-synced votes is not dropped.
if ! grep -q '^zmqpubrawgovernancevotehwm=' dash.conf; then
  cp -p dash.conf "dash.conf.bak-govhub-hwm-$TS"
  printf '%s\n' '# govhub bridge: ZMQ high-water marks for governance re-sync bursts' \
    'zmqpubhashblockhwm=100000' 'zmqpubhashchainlockhwm=100000' \
    'zmqpubrawgovernanceobjecthwm=100000' 'zmqpubrawgovernancevotehwm=100000' >> dash.conf
fi
echo "stopping dashd-mainnet at $(date -u +%T)"
systemctl stop dashd-mainnet
cp -p governance.dat "governance.dat.bak-govhub-resync-$TS"
mv governance.dat "governance.dat.moved-aside-$TS"
sha256sum "governance.dat.bak-govhub-resync-$TS"
systemctl start dashd-mainnet
echo "started dashd-mainnet at $(date -u +%T)"
REMOTE

wait "$runner" || true
