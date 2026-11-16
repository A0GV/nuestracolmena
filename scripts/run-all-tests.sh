#!/usr/bin/env bash
# Ejecuta todas las suites end-to-end contra una API de MyHive ya arrancada.
#   MYHIVE_URL=http://127.0.0.1:4100 bash scripts/run-all-tests.sh
# No arranca ni para servicios. Devuelve código != 0 si alguna suite falla.
set -uo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
BASE="${MYHIVE_URL:-http://127.0.0.1:4100}"
BASE="${BASE%/}"
ROOT_URL="${BASE%/api/v1}"
V1_URL="${ROOT_URL}/api/v1"

TMP_DIR="$(mktemp -d /tmp/myhive-tests.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

NAMES=()
RESULTS=()
DURATIONS=()
FAILED_LOGS=()

echo "== MyHive test suites =="
echo "API: $ROOT_URL"
echo

for file in "$ROOT"/scripts/*-test.mjs; do
  [ -e "$file" ] || continue
  name="$(basename "$file")"
  if [ "$name" = "smoke-test.mjs" ]; then
    url="$V1_URL"
  else
    url="$ROOT_URL"
  fi

  log="$TMP_DIR/$name.log"
  started=$(date +%s)
  printf '%-32s ' "$name"
  MYHIVE_URL="$url" node "$file" >"$log" 2>&1
  rc=$?
  elapsed=$(( $(date +%s) - started ))

  NAMES+=("$name")
  DURATIONS+=("${elapsed}s")
  if [ "$rc" -eq 0 ]; then
    RESULTS+=("PASS")
    echo "PASS (${elapsed}s)"
  else
    RESULTS+=("FAIL")
    FAILED_LOGS+=("$name")
    echo "FAIL (${elapsed}s, código $rc)"
  fi
done

# Optional browser smoke test. It serves apps/web/dist itself and proxies /api
# to this instance, so it never needs the production web/API on 8088/4100.
UI_FILE="$ROOT/scripts/ui-test.cjs"
if [ -f "$UI_FILE" ]; then
  PW="${PLAYWRIGHT_CORE:-/tmp/job-hunter-qa/node_modules/playwright-core}"
  CHROME="${CHROME_PATH:-$HOME/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome}"
  if [ -e "$PW" ] && [ -x "$CHROME" ]; then
    name="ui-test.cjs"
    log="$TMP_DIR/$name.log"
    started=$(date +%s)
    printf '%-32s ' "$name"
    MYHIVE_API="$ROOT_URL" MYHIVE_URL="$ROOT_URL" node "$UI_FILE" >"$log" 2>&1
    rc=$?
    elapsed=$(( $(date +%s) - started ))
    NAMES+=("$name")
    DURATIONS+=("${elapsed}s")
    if [ "$rc" -eq 0 ]; then
      RESULTS+=("PASS")
      echo "PASS (${elapsed}s)"
    else
      RESULTS+=("FAIL")
      FAILED_LOGS+=("$name")
      echo "FAIL (${elapsed}s, código $rc)"
    fi
  else
    printf '%-32s %s\n' "ui-test.cjs" "SKIP (Playwright/Chrome no disponible)"
  fi
fi

echo
echo "== resumen =="
printf '%-32s %-6s %s\n' "SUITE" "RESULT" "TIEMPO"
printf '%-32s %-6s %s\n' "--------------------------------" "------" "------"
fail=0
for i in "${!NAMES[@]}"; do
  printf '%-32s %-6s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}" "${DURATIONS[$i]}"
  [ "${RESULTS[$i]}" = "PASS" ] || fail=$((fail + 1))
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "== salida de las suites fallidas =="
  for name in "${FAILED_LOGS[@]}"; do
    echo "--- $name"
    sed 's/^/    /' "$TMP_DIR/$name.log"
  done
  echo
  echo "FAIL: $fail suite(s) con errores"
  exit 1
fi

echo
echo "PASS: todas las suites en verde"
