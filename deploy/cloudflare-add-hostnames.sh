#!/usr/bin/env bash
# Adds MyHive and TheHive public hostnames to the existing Cloudflare Tunnel.
#
# Requirements:
#   export CF_API_TOKEN=...   # token with: Account > Cloudflare Tunnel: Edit, Zone > DNS: Edit
#   ./deploy/cloudflare-add-hostnames.sh
#
# Optional overrides:
#   ACCOUNT_ID, TUNNEL_ID, ZONE_NAME, MYHIVE_ORIGIN, THEHIVE_ORIGIN

set -euo pipefail

API="https://api.cloudflare.com/client/v4"
ACCOUNT_ID="${ACCOUNT_ID:?export ACCOUNT_ID (Cloudflare account id)}"
TUNNEL_ID="${TUNNEL_ID:?export TUNNEL_ID (Cloudflare tunnel id)}"
ZONE_NAME="${ZONE_NAME:-example.com}"
MYHIVE_HOST="${MYHIVE_HOST:-myhive.example.com}"
THEHIVE_HOST="${THEHIVE_HOST:-thehive.example.com}"
MYHIVE_ORIGIN="${MYHIVE_ORIGIN:-http://192.0.2.10:8088}"
THEHIVE_ORIGIN="${THEHIVE_ORIGIN:-https://192.0.2.10:9443}"

if [[ -z "${CF_API_TOKEN:-}" ]]; then
  echo "ERROR: export CF_API_TOKEN with Account Tunnel:Edit and Zone DNS:Edit permissions." >&2
  exit 1
fi

auth=(-H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json")

echo "==> Reading tunnel configuration"
cfg=$(curl -sf "${auth[@]}" "${API}/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations")
echo "$cfg" | jq -e '.success == true' >/dev/null

new_cfg=$(echo "$cfg" | jq \
  --arg mh "$MYHIVE_HOST" --arg mho "$MYHIVE_ORIGIN" \
  --arg th "$THEHIVE_HOST" --arg tho "$THEHIVE_ORIGIN" '
  .result.config.ingress as $ing
  | ($ing | map(select(.hostname == $mh)) | length) as $has_mh
  | ($ing | map(select(.hostname == $th)) | length) as $has_th
  | (if $has_mh == 0 then $ing[0:-1] + [{"hostname":$mh,"service":$mho}] + [$ing[-1]] else $ing end) as $a
  | (if $has_th == 0 then $a[0:-1] + [{"hostname":$th,"service":$tho,"originRequest":{"noTLSVerify":true}}] + [$a[-1]] else $a end) as $b
  | {config: {ingress: $b, "warp-routing": (.result.config["warp-routing"] // {"enabled": false})}}
')

echo "==> Updating tunnel ingress"
curl -sf "${auth[@]}" -X PUT "${API}/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations" \
  -d "$(echo "$new_cfg" | jq -c .)" | jq -e '.success == true' >/dev/null

echo "==> Resolving zone ${ZONE_NAME}"
zone_id=$(curl -sf "${auth[@]}" "${API}/zones?name=${ZONE_NAME}" | jq -r '.result[0].id // empty')
if [[ -z "$zone_id" ]]; then
  echo "ERROR: zone ${ZONE_NAME} not found with this token." >&2
  exit 1
fi

add_dns() {
  local name="$1"
  local target="$2"
  local existing
  existing=$(curl -sf "${auth[@]}" "${API}/zones/${zone_id}/dns_records?name=${name}" | jq -r '.result | length')
  if [[ "$existing" != "0" ]]; then
    echo "    DNS ${name} already exists; leaving it unchanged."
    return
  fi
  curl -sf "${auth[@]}" -X POST "${API}/zones/${zone_id}/dns_records" \
    -d "$(jq -nc --arg n "$name" --arg c "$target" '{type:"CNAME",name:$n,content:$c,proxied:true,ttl:1}')" \
    | jq -e '.success == true' >/dev/null
  echo "    DNS ${name} -> ${target} created."
}

target="${TUNNEL_ID}.cfargotunnel.com"
echo "==> Ensuring DNS records"
add_dns "$MYHIVE_HOST" "$target"
add_dns "$THEHIVE_HOST" "$target"

echo
echo "OK. Open:"
echo "  https://${MYHIVE_HOST}"
echo "  https://${THEHIVE_HOST}  (self-signed origin; tunnel uses noTLSVerify)"
