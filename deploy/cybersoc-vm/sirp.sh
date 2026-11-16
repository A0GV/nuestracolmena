#!/usr/bin/env bash
# Switch the CyberSOC VM between MyHive and TheHive (Cortex and MISP stay up: both use them).
#   sirp.sh myhive | thehive | status   (no "both": they share port 9443)
set -euo pipefail

MYHIVE_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# TheHive stack (StrangeBee prod1 profile), in start order.
THEHIVE_CONTAINERS=(${THEHIVE_CONTAINERS:-soc-hive-cassandra soc-hive-elasticsearch soc-thehive soc-hive-nginx})

myhive_up() {
  (cd "$MYHIVE_DIR" && docker compose up -d)
  for _ in $(seq 1 30); do
    curl -skf -o /dev/null -m 3 "https://127.0.0.1:${MYHIVE_WEB_PORT:-9443}/api/v1/health" && break
    sleep 2
  done
}
myhive_down() { (cd "$MYHIVE_DIR" && docker compose stop); }
thehive_up()  { docker start "${THEHIVE_CONTAINERS[@]}" >/dev/null; }
thehive_down() {
  local rev=()
  for ((i=${#THEHIVE_CONTAINERS[@]}-1; i>=0; i--)); do rev+=("${THEHIVE_CONTAINERS[i]}"); done
  # Cassandra/TheHive need more than Docker's default 10 s to shut down cleanly.
  docker stop -t 60 "${rev[@]}" >/dev/null
}

status() {
  docker ps -a --format '{{.Names}}\t{{.Status}}' \
    | grep -E '^(myhive-|soc-thehive|soc-hive-|soc-cortex|misp)' | sort || true
  echo
  # Both use port 9443: tell them apart by which container is running.
  local who=nadie
  docker ps --format '{{.Names}}' | grep -qx myhive-web && who=Nuestracolmena
  docker ps --format '{{.Names}}' | grep -qx soc-hive-nginx && who=TheHive
  printf 'https://192.0.2.4:9443 -> %s  ' "$who"
  curl -sk -o /dev/null -m 5 -w '%{http_code}\n' https://192.0.2.4:9443/ || true
  free -m | awk 'NR==2 {print "RAM usada " $3 " / " $2 " MB"}'
}

case "${1:-status}" in
  myhive)  thehive_down; myhive_up ;;
  thehive) myhive_down; thehive_up ;;
  both)    echo "both: ya no es posible, Nuestracolmena y TheHive usan el puerto 9443" >&2; exit 2 ;;
  status)  ;;
  *) echo "uso: $0 myhive|thehive|status" >&2; exit 2 ;;
esac
status
