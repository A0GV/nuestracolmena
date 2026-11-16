# Juntar Nuestracolmena con un Cortex y un MISP que ya existen

Guía para el agente (Claude/Codex) que hace `git pull` de este repo en una máquina que **ya tiene Cortex y MISP** (por ejemplo la VM2 de CyberSOC con MISP/TheHive). Objetivo: que Nuestracolmena use esos servidores, sin levantar otros.

## Resumen en una línea

Nuestracolmena habla con Cortex y MISP solo por su API REST (URL + API key). "Juntarlo" = **registrar los servidores existentes como conectores**. No hace falta tocar Cortex ni MISP, salvo crear un usuario/API key si no lo hay.

## Qué NO hacer

- **No ejecutes `deploy/integrations/setup.sh`** ni `docker compose` en `deploy/integrations/`. Ese stack crea un Cortex y un MISP *nuevos* (puertos 9001 y 8090) y depende de la red Docker `prod1-thehive_thehive-network` del servidor `el servidor de casa`. Es solo para una máquina sin Cortex/MISP.
- No ejecutes responders reales para probar (pueden bloquear IPs, aislar hosts, etc.). El smoke test solo usa `DevTools_Echo_Responder`.
- No copies API keys a archivos versionados ni al hub de agentes.

## Pasos

### 0. Inventario (antes de tocar nada)

Averigua y anota con evidencia (comando + salida):

| Dato | Cómo verificarlo |
|---|---|
| URL de Cortex accesible desde donde corre la API de Nuestracolmena | `curl -sk <CORTEX_URL>/api/status` → JSON con `versions.Cortex` |
| URL base de MISP (la de `BASE_URL`) | `curl -sk -H "Authorization: <KEY>" -H 'Accept: application/json' <MISP_URL>/servers/getVersion` |
| ¿Certificados autofirmados? | si `curl` sin `-k` falla → usar `*_VERIFY_TLS=false` |
| Organización de Cortex que usará Nuestracolmena | UI de Cortex → Organizations |

Compatibilidad comprobada: Cortex 4.2 y MISP 2.5.51. Los endpoints que usa Nuestracolmena (`/api/analyzer`, `/api/job/:id/report`, `/api/responder/type/:t`, `/events/restSearch`, `/events/add`, `/attributes/restSearch`) existen también en Cortex 3.x y MISP 2.4.

### 1. Credenciales

- **Cortex**: un usuario de la organización que vaya a usar Nuestracolmena con roles `read` + `analyze` y su API key (UI de Cortex → Users → *Create API key*). Si TheHive ya usa Cortex, se puede usar la misma organización (los analizadores habilitados en ella aparecen solos en Nuestracolmena), pero mejor un usuario propio `myhive`.
  - Los analizadores/responders que Nuestracolmena ofrece son exactamente los **habilitados en esa organización**. Para probar responders sin efectos, habilita `DevTools_Echo_Responder`.
- **MISP**: API key de un usuario con rol *User* o superior (Global Actions → My Profile → Auth keys). Para exportar casos necesita poder crear eventos.

### 2. Levantar Nuestracolmena (si aún no corre en esa máquina)

```bash
git pull
npm install
docker compose up -d postgres            # o usa un PostgreSQL existente y ajusta DATABASE_URL
cp .env.example apps/api/.env            # DATABASE_URL, JWT_SECRET, PORT, CORS_ORIGIN
echo 'VITE_API_URL="/api/v1"' > apps/web/.env
npm run db:sync -w @myhive/api           # pasos previos + db push (no destructivo)
npm run db:seed -w @myhive/api           # SOLO en una base nueva: crea admin/analyst/readonly y la org SOC
npm run build
npm run start -w @myhive/api             # API en :4100 ; sirve apps/web/dist con nginx (deploy/myhive-nginx.conf) o usa `npm run dev`
```

Si Nuestracolmena **ya corría** en esa máquina con una versión anterior: `git pull && npm install && npm run db:sync -w @myhive/api && npm run build` y reinicia la API. `db:sync` ejecuta pasos previos idempotentes y `prisma db push --skip-generate` (sin `--accept-data-loss`); no borra datos. Prueba la ruta de actualización con `bash scripts/upgrade-test.sh`.

### 3. Registrar los servidores existentes

Por UI: **Administración → Cortex & MISP → Añadir servidor** (URL, API key y "Verificar certificado TLS").

O por script (idempotente, prueba la conexión y opcionalmente crea el feeder de MISP):

```bash
MYHIVE_URL=http://127.0.0.1:4100/api/v1 MYHIVE_LOGIN=admin@myhive.local MYHIVE_PASSWORD='...' \
CORTEX_URL='https://<cortex>:9001' CORTEX_API_KEY='...' CORTEX_VERIFY_TLS=false \
MISP_URL='https://<misp>' MISP_API_KEY='...' MISP_VERIFY_TLS=false MISP_FEEDER_MINUTES=15 \
node scripts/register-connectors.mjs
```

Debe imprimir `cortex: OK v… · org … · N analyzers` y `misp: OK v…`.

### 4. Verificar

```bash
node scripts/smoke-test.mjs                      # no crea eventos en MISP
SMOKE_MISP_WRITE=1 node scripts/smoke-test.mjs   # también exporta un caso de prueba a MISP (solo si se permite)
```

En la UI: un caso con un observable IP → icono de matraz → elegir analizadores → la columna *Análisis (Cortex)* se llena sola. En **Alertas → Importar de MISP** deben aparecer eventos recientes como alertas `type=misp`.

## Cómo funciona por dentro (para adaptar)

| Pieza | Dónde |
|---|---|
| Conectores (modelo `Endpoint` con `type` = `cortex`/`misp`, `config` = `{url, apiKey, verifyTls, distribution}`) | `apps/api/src/integrations/connectors.service.ts` |
| Cortex: analizadores, responders, sondeo de jobs | `apps/api/src/integrations/cortex.service.ts` |
| MISP: eventos → alertas, caso → evento, búsqueda de observables, mapeo de tipos | `apps/api/src/integrations/misp.service.ts` |
| Scheduler (Cortex cada 5 s, feeders MISP cada 60 s; `INTEGRATIONS_SCHEDULER=false` lo apaga) | `apps/api/src/integrations/integrations.scheduler.ts` |
| Rutas REST (`/connectors`, `/cortex/*`, `/observables/:id/analyze`, `/misp/*`, `/cases/:id/misp-export`) | `apps/api/src/integrations/integrations.controller.ts` |
| UI (modal de análisis, drawer de inteligencia, responders, export/import MISP) | `apps/web/src/lib/integrations.tsx`, `apps/web/src/pages/IntegrationsPanel.tsx` |

Decisiones a conocer:

- Las alertas importadas de MISP usan `type=misp`, `source=<nombre del conector>`, `sourceRef=<uuid del evento>`; la restricción única `(organisationId, type, source, sourceRef)` las deduplica. Re-sincronizar actualiza la alerta y añade solo atributos nuevos.
- La importación filtra por `timestamp` (última modificación), no por `last` (que solo devuelve eventos *publicados*), y excluye eventos con tag `myhive` (los que exporta Nuestracolmena) para no crear bucles.
- La exportación crea el evento con `distribution` del conector (por defecto 0 = solo tu organización) y tags `tlp:*`, tags del caso y `myhive`. El id del evento se guarda en `Case.exports`.
- Si TheHive de esa máquina también importa de MISP, Nuestracolmena tendrá sus propias alertas de los mismos eventos: es esperado (son plataformas separadas).

## Al terminar

Actualiza la sección **Nuestracolmena** de `STATE.md` en el hub de agentes (`A0GV/agents-hub`) con: máquina, versiones de Cortex/MISP encontradas, qué se registró y qué pasó en el smoke test (distinguiendo C / API / UI).
