#!/usr/bin/env bash
# Prueba de ruta de actualización: crea una base temporal myhive_upgrade_test en
# el mismo PostgreSQL que apps/api/.env, aplica el esquema de b35c77f (el que
# está desplegado en la VM), inserta datos representativos, ejecuta db-sync y
# comprueba que la actualización no pierde datos ni pide --accept-data-loss.
#
# Uso: bash scripts/upgrade-test.sh
# Nunca toca la base "myhive". La base temporal se borra siempre (trap).
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
ENV_FILE="$ROOT/apps/api/.env"
OLD_COMMIT="${OLD_COMMIT:-b35c77f}"
DB_NAME="myhive_upgrade_test"

if [ -z "${DATABASE_URL:-}" ]; then
  if [ ! -f "$ENV_FILE" ]; then
    echo "FAIL no existe $ENV_FILE y DATABASE_URL no está definida" >&2
    exit 1
  fi
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
fi
if [ -z "$DATABASE_URL" ]; then
  echo "FAIL no se pudo leer DATABASE_URL" >&2
  exit 1
fi

# Deriva las URLs del mismo servidor: psql (sin ?schema=public) y Prisma.
URLS="$(node - "$DATABASE_URL" "$DB_NAME" <<'NODE'
const { URL } = require('node:url');
const base = new URL(process.argv[2]);
const name = process.argv[3];
const admin = new URL(base);
admin.pathname = '/postgres';
admin.search = '';
const test = new URL(base);
test.pathname = `/${name}`;
test.search = '';
console.log(admin.toString());
console.log(test.toString());
NODE
)"
ADMIN_URL="$(printf '%s\n' "$URLS" | sed -n '1p')"
TEST_URL="$(printf '%s\n' "$URLS" | sed -n '2p')"

OLD_SCHEMA="$(mktemp /tmp/myhive-old-schema.XXXXXX.prisma)"
SYNC_LOG="$(mktemp /tmp/myhive-db-sync.XXXXXX.log)"

cleanup() {
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" >/dev/null 2>&1 || true
  rm -f "$OLD_SCHEMA" "$SYNC_LOG"
}
trap cleanup EXIT INT TERM

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1${2:+ — $2}"; }
q()   { psql "$TEST_URL" -tAc "$1" | tr -d '[:space:]'; }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "esperado '$2', obtenido '$3'"; fi; }
truth() { if [ "$2" = "1" ]; then ok "$1"; else bad "$1" "obtenido '$2'"; fi; }

column_exists() {
  q "SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '$1' AND column_name = '$2'"
}
table_exists() {
  q "SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = '$1'"
}

echo "== MyHive upgrade test =="
echo "servidor: ${ADMIN_URL%%/postgres*}"
echo "base temporal: $DB_NAME"
echo "esquema origen: $OLD_COMMIT"

git -C "$ROOT" show "$OLD_COMMIT:apps/api/prisma/schema.prisma" > "$OLD_SCHEMA"

psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" >/dev/null
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB_NAME\"" >/dev/null
echo "PASS base temporal creada"

echo "-- aplicando esquema $OLD_COMMIT"
if (cd "$ROOT/apps/api" && DATABASE_URL="$TEST_URL" npx prisma db push --skip-generate --schema "$OLD_SCHEMA" >/dev/null 2>&1); then
  ok "esquema $OLD_COMMIT aplicado"
else
  bad "esquema $OLD_COMMIT aplicado"
  echo "No se puede continuar sin la base antigua" >&2
  exit 1
fi

ORG=11111111-1111-4111-8111-111111111111
USER_ID=22222222-2222-4222-8222-222222222222
CASE_ID=33333333-3333-4333-8333-333333333333
ALERT_ID=44444444-4444-4444-8444-444444444444
OBS_ID=55555555-5555-4555-8555-555555555555
FN1=66666666-6666-4666-8666-666666666666
FN2=77777777-7777-4777-8777-777777777777
NOTIF_ID=88888888-8888-4888-8888-888888888888

echo "-- insertando datos representativos"
psql "$TEST_URL" -v ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO "Organisation" (id, name, "updatedAt") VALUES ('$ORG', 'Upgrade Org', now());
INSERT INTO "User" (id, login, name, "updatedAt", "defaultOrganisationId")
  VALUES ('$USER_ID', 'upgrade@test.local', 'Upgrade User', now(), '$ORG');
INSERT INTO "Case" (id, "organisationId", number, title, "updatedAt")
  VALUES ('$CASE_ID', '$ORG', 1, 'Caso previo a la actualización', now());
INSERT INTO "Alert" (id, "organisationId", type, source, "sourceRef", title, "updatedAt")
  VALUES ('$ALERT_ID', '$ORG', 'wazuh', 'wazuh', 'upgrade-1', 'Alerta previa', now());
INSERT INTO "Observable" (id, "organisationId", "alertId", "dataType", data, "updatedAt")
  VALUES ('$OBS_ID', '$ORG', '$ALERT_ID', 'ip', '203.0.113.9', now());
INSERT INTO "Function" (id, "organisationId", name, "createdAt")
  VALUES ('$FN1', '$ORG', 'duplicate-fn', now() - interval '2 days');
INSERT INTO "Function" (id, "organisationId", name, "createdAt")
  VALUES ('$FN2', '$ORG', 'duplicate-fn', now() - interval '1 day');
INSERT INTO "Notification" (id, "organisationId", name) VALUES ('$NOTIF_ID', '$ORG', 'Notificación previa');
SQL
ok "datos insertados (org, usuario, caso, alerta, observable, 2 functions, notificación)"

echo "-- ejecutando db-sync (1ª vez)"
set +e
DATABASE_URL="$TEST_URL" node "$ROOT/apps/api/prisma/db-sync.mjs" >"$SYNC_LOG" 2>&1
SYNC_RC=$?
set -e
if [ "$SYNC_RC" -eq 0 ]; then
  ok "db-sync termina con código 0"
else
  bad "db-sync termina con código 0" "código $SYNC_RC"
  sed 's/^/    /' "$SYNC_LOG"
fi

eq "organización conservada" "1" "$(q "SELECT count(*) FROM \"Organisation\" WHERE id = '$ORG'")"
eq "usuario conservado" "1" "$(q "SELECT count(*) FROM \"User\" WHERE id = '$USER_ID'")"
eq "caso conservado" "1" "$(q "SELECT count(*) FROM \"Case\" WHERE id = '$CASE_ID'")"
eq "alerta conservada" "1" "$(q "SELECT count(*) FROM \"Alert\" WHERE id = '$ALERT_ID'")"
eq "observable conservado" "1" "$(q "SELECT count(*) FROM \"Observable\" WHERE id = '$OBS_ID'")"
eq "notificación conservada" "1" "$(q "SELECT count(*) FROM \"Notification\" WHERE id = '$NOTIF_ID'")"

eq "función más antigua conserva el nombre" "duplicate-fn" "$(q "SELECT name FROM \"Function\" WHERE id = '$FN1'")"
eq "función duplicada renombrada" "duplicate-fn-2" "$(q "SELECT name FROM \"Function\" WHERE id = '$FN2'")"
eq "total de functions intacto" "2" "$(q "SELECT count(*) FROM \"Function\" WHERE \"organisationId\" = '$ORG'")"
eq "índice único Function creado" "1" "$(q "SELECT count(*) FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'Function' AND indexname = 'Function_organisationId_name_key'")"

truth "columna Function.kind existe" "$(column_exists Function kind)"
truth "tabla SlaEvent existe" "$(table_exists SlaEvent)"
truth "tabla Tactic existe" "$(table_exists Tactic)"
truth "columna Page.caseId existe" "$(column_exists Page caseId)"
truth "columna Observable.attachmentId existe" "$(column_exists Observable attachmentId)"

echo "-- ejecutando db-sync (2ª vez, debe ser no-op)"
set +e
DATABASE_URL="$TEST_URL" node "$ROOT/apps/api/prisma/db-sync.mjs" >"$SYNC_LOG" 2>&1
SYNC_RC2=$?
set -e
if [ "$SYNC_RC2" -eq 0 ]; then
  ok "segunda ejecución termina con código 0"
else
  bad "segunda ejecución termina con código 0" "código $SYNC_RC2"
  sed 's/^/    /' "$SYNC_LOG"
fi
eq "segunda ejecución no renombra de nuevo" "duplicate-fn-2" "$(q "SELECT name FROM \"Function\" WHERE id = '$FN2'")"

echo
echo "== resumen: $PASS PASS · $FAIL FAIL =="
if [ "$FAIL" -ne 0 ]; then
  echo "FAIL upgrade-test"
  exit 1
fi
echo "PASS upgrade-test"
