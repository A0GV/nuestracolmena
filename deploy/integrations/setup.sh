#!/usr/bin/env bash
# First-time setup of Cortex + MISP for MyHive.
#   1. Renders Cortex secret/index configs from .env
#   2. Starts the stack
#   3. Bootstraps Cortex (superadmin, MyHive org, API user/key, free analyzers)
#   4. Writes connectors.env with the URLs/keys MyHive must use
set -euo pipefail
cd "$(dirname "$0")"

[[ -f .env ]] || { echo "Missing .env (see README in this folder)" >&2; exit 1; }
set -a; source .env; set +a

cat > cortex/config/secret.conf <<EOF
play.http.secret.key="${CORTEX_SECRET}"
EOF
cat > cortex/config/index.conf <<EOF
search {
  index = cortex
  user = "elastic"
  password = "${ES_PASSWORD}"
}
EOF

docker compose up -d

echo "==> Waiting for Cortex on :9001"
for i in $(seq 1 90); do
  curl -sf http://127.0.0.1:9001/api/status >/dev/null && break
  sleep 5
done
curl -sf http://127.0.0.1:9001/api/status >/dev/null || { echo "Cortex did not start" >&2; exit 1; }

node ./cortex-bootstrap.mjs

echo "==> Waiting for MISP on :8090 (first boot can take several minutes)"
for i in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: ${MISP_ADMIN_KEY}" -H 'Accept: application/json' http://127.0.0.1:8090/servers/getVersion || true)
  [[ "$code" == "200" ]] && break
  sleep 5
done
echo "MISP getVersion HTTP ${code}"

{
  echo "CORTEX_URL=http://192.0.2.10:9001"
  echo "CORTEX_API_KEY=$(cat cortex/.myhive-key)"
  echo "MISP_URL=${MISP_BASE_URL}"
  echo "MISP_API_KEY=${MISP_ADMIN_KEY}"
} > connectors.env
chmod 600 connectors.env
echo "OK. Connector settings written to $(pwd)/connectors.env"
