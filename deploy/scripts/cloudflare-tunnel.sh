#!/usr/bin/env bash
# Create (or update) a remotely-managed Cloudflare Tunnel for this stack, point DNS at it, and write the
# tunnel token to the secrets directory for the `cloudflared` service (compose profile `tunnel`).
#
# Idempotent: an existing tunnel with the same name is reused, its ingress is replaced with the routes
# given here, and existing CNAMEs are updated. Nothing secret is printed.
#
# Usage:
#   CF_API_TOKEN=... deploy/scripts/cloudflare-tunnel.sh --account ACCOUNT_ID --zone example.org \
#     [--name govhub] [--route gov-bridge.example.org=http://bridge:8787] [--route HOST=SERVICE ...] \
#     [--token-out FILE]
#
#   --route       hostname=service, repeatable. Default: gov-bridge.<zone>=http://bridge:8787. Services
#                 are compose service names, because cloudflared runs on the compose network.
#                 Future services: gov-relay.<zone>=http://relay:<port>, gov-accounts.<zone>=http://accounts:<port>.
#   --token-out   where the tunnel token goes (default: $SECRETS_DIR/cloudflare_tunnel_token, i.e. the file
#                 the compose secret reads). Written with umask 077.
#
# The API token (CF_API_TOKEN, or a file named by CF_API_TOKEN_FILE) needs:
#   Account > Cloudflare Tunnel > Edit     (create the tunnel, set its ingress, read its token)
#   Zone    > DNS > Edit                   (the CNAMEs), on the zone
# Needs curl and jq.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACCOUNT=""
ZONE=""
NAME=govhub
ROUTES=()
TOKEN_OUT=""

die() { echo "error: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --account) ACCOUNT="${2:?}"; shift 2 ;;
    --zone) ZONE="${2:?}"; shift 2 ;;
    --name) NAME="${2:?}"; shift 2 ;;
    --route) ROUTES+=("${2:?}"); shift 2 ;;
    --token-out) TOKEN_OUT="${2:?}"; shift 2 ;;
    -h | --help) awk 'NR > 1 && !/^#/ { exit } NR > 1' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

command -v curl > /dev/null || die "curl is required"
command -v jq > /dev/null || die "jq is required"
[ -n "$ACCOUNT" ] || die "--account is required"
[ -n "$ZONE" ] || die "--zone is required"
if [ -z "${CF_API_TOKEN:-}" ] && [ -n "${CF_API_TOKEN_FILE:-}" ]; then CF_API_TOKEN="$(tr -d '\r\n' < "$CF_API_TOKEN_FILE")"; fi
[ -n "${CF_API_TOKEN:-}" ] || die "set CF_API_TOKEN (or CF_API_TOKEN_FILE)"
[ "${#ROUTES[@]}" -gt 0 ] || ROUTES=("gov-bridge.$ZONE=http://bridge:8787")
if [ -z "$TOKEN_OUT" ]; then
  secrets="${SECRETS_DIR:-}"
  if [ -z "$secrets" ] && [ -f "$DEPLOY_DIR/.env" ]; then secrets="$(sed -n 's/^SECRETS_DIR=//p' "$DEPLOY_DIR/.env" | tail -1)"; fi
  secrets="${secrets:-./secrets}"
  case "$secrets" in /*) ;; *) secrets="$DEPLOY_DIR/$secrets" ;; esac
  TOKEN_OUT="$secrets/cloudflare_tunnel_token"
fi

API=https://api.cloudflare.com/client/v4
# cf METHOD PATH [JSON]: prints .result; on failure prints Cloudflare's errors and exits.
cf() {
  local method="$1" path="$2" body="${3:-}" out
  # The token goes in through a file descriptor (printf is a builtin), so it never shows up in `ps`.
  out="$(curl -sS -X "$method" -H @<(printf 'Authorization: Bearer %s\n' "$CF_API_TOKEN") \
    -H 'Content-Type: application/json' ${body:+--data "$body"} "$API$path")" || die "$method $path: request failed"
  if [ "$(jq -r '.success' <<< "$out")" != true ]; then
    echo "error: $method $path: $(jq -c '.errors' <<< "$out")" >&2
    case "$path" in
      */cfd_tunnel*) echo "hint: the API token needs Account > Cloudflare Tunnel > Edit on account $ACCOUNT" >&2 ;;
      */dns_records*) echo "hint: the API token needs Zone > DNS > Edit on $ZONE" >&2 ;;
    esac
    exit 1
  fi
  jq -c '.result' <<< "$out"
}

zone_id="$(cf GET "/zones?name=$ZONE" | jq -r '.[0].id // empty')"
[ -n "$zone_id" ] || die "zone $ZONE not visible to this token"

tunnel_id="$(cf GET "/accounts/$ACCOUNT/cfd_tunnel?name=$NAME&is_deleted=false" | jq -r '.[0].id // empty')"
if [ -n "$tunnel_id" ]; then
  echo "tunnel: reusing $NAME ($tunnel_id)"
else
  tunnel_id="$(cf POST "/accounts/$ACCOUNT/cfd_tunnel" "$(jq -nc --arg n "$NAME" '{name: $n, config_src: "cloudflare"}')" | jq -r '.id')"
  echo "tunnel: created $NAME ($tunnel_id)"
fi

# Ingress: one rule per route, then the mandatory catch-all.
ingress="$(printf '%s\n' "${ROUTES[@]}" | jq -Rnc '[inputs | select(length > 0) | capture("^(?<hostname>[^=]+)=(?<service>.+)$")] + [{service: "http_status:404"}]')"
[ "$(jq length <<< "$ingress")" -eq $((${#ROUTES[@]} + 1)) ] || die "every --route must be hostname=service"
cf PUT "/accounts/$ACCOUNT/cfd_tunnel/$tunnel_id/configurations" "$(jq -nc --argjson i "$ingress" '{config: {ingress: $i}}')" > /dev/null
echo "ingress: $(jq -c '[.[] | (.hostname // "*") + " -> " + .service]' <<< "$ingress")"

target="$tunnel_id.cfargotunnel.com"
for route in "${ROUTES[@]}"; do
  host="${route%%=*}"
  rec="$(jq -nc --arg n "$host" --arg c "$target" '{type: "CNAME", name: $n, content: $c, proxied: true, ttl: 1, comment: "govhub cloudflared tunnel"}')"
  existing="$(cf GET "/zones/$zone_id/dns_records?name=$host" | jq -c '.[0] // empty')"
  if [ -z "$existing" ]; then
    cf POST "/zones/$zone_id/dns_records" "$rec" > /dev/null
    echo "dns: created $host CNAME $target (proxied)"
  elif [ "$(jq -r .type <<< "$existing")" = CNAME ]; then
    cf PUT "/zones/$zone_id/dns_records/$(jq -r .id <<< "$existing")" "$rec" > /dev/null
    echo "dns: updated $host CNAME $target (proxied)"
  else
    die "$host already has a $(jq -r .type <<< "$existing") record; remove it first"
  fi
done

# Token for `cloudflared tunnel run`. Written, never printed.
token="$(cf GET "/accounts/$ACCOUNT/cfd_tunnel/$tunnel_id/token" | jq -r '.')"
[ -n "$token" ] && [ "$token" != null ] || die "empty tunnel token"
mkdir -p "$(dirname "$TOKEN_OUT")"
(umask 077 && printf '%s\n' "$token" > "$TOKEN_OUT")
unset token
# Same rule as init.sh: the containers run as uid 1000.
if [ "$(uname -s)" = Linux ] && [ "$(id -u)" -eq 0 ]; then chown 1000:1000 "$TOKEN_OUT"; fi
echo "token: written to $TOKEN_OUT"
echo "next: COMPOSE_PROFILES=tunnel in .env, then docker compose up -d"
