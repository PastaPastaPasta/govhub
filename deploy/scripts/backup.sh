#!/usr/bin/env bash
# Online backup of the bridge's SQLite archive (README section 6) into DIR, keeping KEEP_DAYS days.
# Safe while the bridge runs (SQLite online-backup API inside the bridge container). Exits non-zero on
# any failure, so cron can report it.
#
# Usage: deploy/scripts/backup.sh [DIR=./backups] [KEEP_DAYS=30]
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${1:-$DEPLOY_DIR/backups}"
KEEP_DAYS="${2:-30}"
name="bridge-$(date +%F).sqlite"

cd "$DEPLOY_DIR"
mkdir -p "$DIR"
chmod 700 "$DIR"
trap 'docker compose exec -T bridge rm -f "/data/$name" > /dev/null 2>&1 || true' EXIT
out="$(docker compose exec -T bridge node bin/bridge.mjs backup "/data/$name" 2>&1)" || { echo "$out" >&2; exit 1; }
out="$(docker compose cp "bridge:/data/$name" "$DIR/$name" 2>&1)" || { echo "$out" >&2; exit 1; }
if command -v sqlite3 > /dev/null; then
  [ "$(sqlite3 "$DIR/$name" 'PRAGMA integrity_check' 2>&1)" = ok ] || { echo "integrity check failed: $DIR/$name" >&2; exit 1; }
fi
find "$DIR" -name 'bridge-*.sqlite' -mtime +"$KEEP_DAYS" -delete
echo "backup ok: $DIR/$name ($(wc -c < "$DIR/$name") bytes)"
