#!/usr/bin/env bash
# Prepare a govhub deployment directory: check prerequisites, create the secrets directory with
# restrictive permissions, generate the dashd RPC password, and write .env from .env.example.
#
# Safe to run again: it never overwrites an existing secret or .env. It does re-apply permissions.
#
# Usage: deploy/scripts/init.sh [--network mainnet|testnet|regtest] [--secrets-dir DIR] [--check]
#   --network      sets COMPOSE_FILE in a newly created .env (default mainnet)
#   --secrets-dir  where secrets live (default: ./secrets next to docker-compose.yml, or $SECRETS_DIR)
#   --check        only check prerequisites; create nothing
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK=mainnet
SECRETS_DIR="${SECRETS_DIR:-$DEPLOY_DIR/secrets}"
CHECK_ONLY=0

die() { echo "error: $*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }
say() { echo "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --network) [ $# -ge 2 ] || die "--network needs a value"; NETWORK="$2"; shift 2 ;;
    --secrets-dir) [ $# -ge 2 ] || die "--secrets-dir needs a value"; SECRETS_DIR="$2"; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    -h | --help) awk 'NR > 1 && !/^#/ { exit } NR > 1' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# Per-network project name, subnet, host port and bridge image tag, so a mainnet and a testnet stack can live
# on one host without sharing volumes, networks, ports or the locally built bridge image (with one tag, building
# in the testnet checkout would retag the image the mainnet stack recreates its bridge from).
case "$NETWORK" in
  mainnet) COMPOSE_FILES="docker-compose.yml"; PROJECT=govhub; SUBNET=172.29.73.0/24; HOST_PORT=8787; IMAGE_TAG=local ;;
  testnet) COMPOSE_FILES="docker-compose.yml:docker-compose.testnet.yml"; PROJECT=govhub-testnet; SUBNET=172.29.74.0/24; HOST_PORT=8788; IMAGE_TAG=testnet ;;
  regtest) COMPOSE_FILES="docker-compose.yml:docker-compose.regtest.yml"; PROJECT=govhub-regtest; SUBNET=172.29.75.0/24; HOST_PORT=8789; IMAGE_TAG=regtest ;;
  *) die "--network must be mainnet, testnet or regtest" ;;
esac

# ---- prerequisites ---------------------------------------------------------------------------
command -v docker > /dev/null 2>&1 || die "docker is not installed or not on PATH"
docker info > /dev/null 2>&1 || die "cannot talk to the docker daemon (is it running, and are you in the docker group?)"
compose_version="$(docker compose version --short 2> /dev/null || true)"
[ -n "$compose_version" ] || die "the 'docker compose' plugin (v2) is required"
compose_version="${compose_version#v}"
IFS=. read -r cv_major cv_minor _ <<< "$compose_version"
if [ "${cv_major:-0}" -lt 2 ] || { [ "${cv_major:-0}" -eq 2 ] && [ "${cv_minor:-0}" -lt 24 ]; }; then
  die "docker compose >= 2.24 is required (found $compose_version)"
fi
say "ok: docker compose $compose_version"

# Disk is the one requirement people miss. Warn, do not block: sizes are in README.md.
avail_kb="$(df -Pk "$DEPLOY_DIR" 2> /dev/null | awk 'NR==2 {print $4}')"
if [ -n "${avail_kb:-}" ]; then
  avail_gb=$((avail_kb / 1024 / 1024))
  say "ok: ${avail_gb} GiB free where this directory lives (docker volumes may be on another disk)"
  if [ "$NETWORK" = mainnet ] && [ "$avail_gb" -lt 120 ]; then
    warn "mainnet needs roughly 120 GiB or more (see README, Hardware); check where /var/lib/docker lives"
  fi
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  say "prerequisites ok (--check: nothing created)"
  exit 0
fi

# ---- secrets ---------------------------------------------------------------------------------
# The directory is 0700, so other host users cannot reach it. Files are bind-mounted into the
# containers, where dashd and the bridge run as uid 1000. A file mode of 0600 is only readable
# there if the host owner is also uid 1000 (the usual first Linux user, and always fine with
# Docker Desktop). As root (a typical LXC or VM deployment) the files are chowned to uid 1000 and
# stay 0600. Otherwise the files get 0644, which stays private because of the 0700 directory.
secret_mode=600
secret_owner=""
if [ "$(uname -s)" = Linux ] && [ "$(id -u)" -eq 0 ]; then
  secret_owner=1000:1000
elif [ "$(uname -s)" = Linux ] && [ "$(id -u)" -ne 1000 ]; then
  secret_mode=644
  warn "host uid is $(id -u), not 1000: secret files get mode 0644 inside the 0700 directory so the containers can read them"
fi

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
# Absolute, because compose resolves a relative SECRETS_DIR against deploy/, not the caller's cwd.
SECRETS_DIR="$(cd "$SECRETS_DIR" && pwd)"

rpc_pw_file="$SECRETS_DIR/core_rpc_password"
if [ -s "$rpc_pw_file" ]; then
  say "kept: $rpc_pw_file"
else
  # Hex only: dash.conf is a flat key=value file, so the password must not need quoting.
  if command -v openssl > /dev/null 2>&1; then
    pw="$(openssl rand -hex 32)"
  else
    pw="$(LC_ALL=C od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  fi
  [ "${#pw}" -eq 64 ] || die "could not generate a random password"
  (umask 077 && printf '%s\n' "$pw" > "$rpc_pw_file")
  say "created: $rpc_pw_file"
fi

identity_file="$SECRETS_DIR/bridge_identity.json"
if [ -e "$identity_file" ]; then
  say "kept: $identity_file"
else
  (umask 077 && : > "$identity_file")
  say "created: $identity_file (EMPTY placeholder; fill it before setting PUBLISH=1, see README)"
fi

tunnel_file="$SECRETS_DIR/cloudflare_tunnel_token"
if [ -e "$tunnel_file" ]; then
  say "kept: $tunnel_file"
else
  (umask 077 && : > "$tunnel_file")
  say "created: $tunnel_file (EMPTY placeholder; only the \`tunnel\` profile uses it, see README)"
fi

hmac_file="$SECRETS_DIR/issuer_hmac_secret"
if [ -s "$hmac_file" ]; then
  say "kept: $hmac_file"
else
  if command -v openssl > /dev/null 2>&1; then
    hm="$(openssl rand -hex 32)"
  else
    hm="$(LC_ALL=C od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  fi
  [ "${#hm}" -eq 64 ] || die "could not generate the issuer challenge secret"
  (umask 077 && printf '%s\n' "$hm" > "$hmac_file")
  say "created: $hmac_file (issuer challenges; only the \`issuer\` profile uses it)"
fi

report_file="$SECRETS_DIR/issuer_report_key.json"
if [ -e "$report_file" ]; then
  say "kept: $report_file"
else
  (umask 077 && : > "$report_file")
  say "created: $report_file (EMPTY placeholder; the issuer needs its HIGH key here before it starts, see services/issuer/README.md)"
fi

issuer_keys="$SECRETS_DIR/issuer-keys"
mkdir -p "$issuer_keys"
chmod 700 "$issuer_keys"

chmod "$secret_mode" "$rpc_pw_file" "$identity_file" "$tunnel_file" "$hmac_file" "$report_file"
[ -z "$secret_owner" ] || chown "$secret_owner" "$rpc_pw_file" "$identity_file" "$tunnel_file" "$hmac_file" "$report_file"
[ -z "$secret_owner" ] || chown -R "$secret_owner" "$issuer_keys"

# ---- .env ------------------------------------------------------------------------------------
env_file="$DEPLOY_DIR/.env"
if [ -e "$env_file" ]; then
  say "kept: $env_file (not modified; set COMPOSE_FILE yourself for $NETWORK)"
  kept_tag="$(sed -n 's/^BRIDGE_TAG=//p' "$env_file" | tail -n 1)"
  if [ "${kept_tag:-local}" != "$IMAGE_TAG" ]; then
    warn "$env_file has BRIDGE_TAG=${kept_tag:-<unset, so local>}, not $IMAGE_TAG: another stack on this host with the same tag shares (and rebuilds) one bridge image"
  fi
else
  tmp="$(mktemp "$DEPLOY_DIR/.env.XXXXXX")"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      COMPOSE_FILE=*) printf 'COMPOSE_FILE=%s\n' "$COMPOSE_FILES" ;;
      COMPOSE_PROJECT_NAME=*) printf 'COMPOSE_PROJECT_NAME=%s\n' "$PROJECT" ;;
      GOVHUB_SUBNET=*) printf 'GOVHUB_SUBNET=%s\n' "$SUBNET" ;;
      BRIDGE_PORT=*) printf 'BRIDGE_PORT=%s\n' "$HOST_PORT" ;;
      BRIDGE_TAG=*) printf 'BRIDGE_TAG=%s\n' "$IMAGE_TAG" ;;
      SECRETS_DIR=*) printf 'SECRETS_DIR=%s\n' "$SECRETS_DIR" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$DEPLOY_DIR/.env.example" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$env_file"
  say "created: $env_file (network: $NETWORK)"
fi

cat << EOF

Next steps (from $DEPLOY_DIR):
  1. Review .env. PUBLISH=0 archives and serves without touching Platform.
  2. docker compose up -d --build
  3. docker compose logs -f dashd        # initial sync takes hours to a day or more on mainnet
  4. curl http://127.0.0.1:${HOST_PORT}/v1/status
Publishing to Platform needs a funded identity and your own gov contract: README.md.
EOF
