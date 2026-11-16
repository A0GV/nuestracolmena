#!/usr/bin/env bash
# Instala/actualiza Grafana de Nuestracolmena en el servidor de casa. Idempotente.
set -euo pipefail
cd "$(dirname "$0")"

PG=${POSTGRES_CONTAINER:-myhive-postgres}

[ -f .env ] || cp .env.example .env
chmod 600 .env
for var in GRAFANA_ADMIN_PASSWORD MYHIVE_GRAFANA_DB_PASSWORD; do
  if ! grep -qE "^${var}=.+" .env; then
    value=$(openssl rand -hex 16)
    if grep -qE "^${var}=" .env; then sed -i "s|^${var}=.*|${var}=${value}|" .env
    else echo "${var}=${value}" >> .env; fi
    echo "Generada ${var} (en deploy/grafana/.env)"
  fi
done
set -a; . ./.env; set +a

echo "Creando/actualizando el rol de solo lectura en ${PG}..."
docker exec -i "$PG" psql -q -v ON_ERROR_STOP=1 -U myhive -d "${MYHIVE_GRAFANA_DB_NAME:-myhive}" \
  -v grafana_password="$MYHIVE_GRAFANA_DB_PASSWORD" < grafana-readonly.sql

docker compose up -d

port=${GRAFANA_PORT:-3030}
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${port}/grafana/api/health" >/dev/null 2>&1; then
    echo "Grafana lista: ${PUBLIC_URL:-https://nuestracolmena.example.com}/grafana/ (local: http://127.0.0.1:${port}/grafana/)"
    echo "Usuario: admin · contraseña: GRAFANA_ADMIN_PASSWORD en deploy/grafana/.env"
    echo "Si es la primera vez, recarga nginx: docker exec myhive-web nginx -s reload"
    exit 0
  fi
  sleep 2
done
echo "Grafana no respondió en 60 s: docker logs myhive-grafana" >&2
exit 1
