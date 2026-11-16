# Nuestracolmena — instrucciones para agentes

SIRP propio (estilo TheHive) del proyecto CyberSOC de Adolfo: API NestJS + Prisma + PostgreSQL en `apps/api`, web React + Ant Design en `apps/web`.

- **Si te piden "juntarlo con el MISP/Cortex que ya tengo"**: sigue `docs/INTEGRAR-CORTEX-MISP-EXISTENTES.md`. Resumen: registrar los servidores existentes como conectores (`scripts/register-connectors.mjs` o Administración → Cortex & MISP). **No** ejecutes `deploy/integrations/setup.sh` en una máquina que ya tiene Cortex/MISP.
- Tras cambiar el esquema Prisma: `npm run db:sync -w @myhive/api` (pasos previos idempotentes + `prisma db push --skip-generate`, nunca `--accept-data-loss`). Si añades un `@@unique`/`@unique` sobre una tabla existente, añade el paso previo de deduplicación en `apps/api/prisma/db-sync.mjs`. Tras cambiar la API: `npm run build -w @myhive/api` y reiniciarla. Tras cambiar la web: `npm run build -w @myhive/web`.
- Verificación: `MYHIVE_URL=http://127.0.0.1:4100 bash scripts/run-all-tests.sh` (todas las suites `scripts/*-test.mjs`; el smoke admite `SMOKE_MISP_WRITE=1`). Ruta de actualización de base: `bash scripts/upgrade-test.sh` (base temporal `myhive_upgrade_test`, se borra sola). Integración Wazuh: `node deploy/wazuh/test-custom-myhive.mjs`.
- Typecheck: `npm run lint`.
- Prioridad del usuario: que todo **funcione** (features, integraciones, bugs de comportamiento) por encima del endurecimiento de seguridad.
- Distingue en tus reportes: configurado · responde la API · visto en la UI · confirmado físicamente.
- Estado compartido entre agentes: repo `A0GV/agents-hub` (`STATE.md`, sección Nuestracolmena).
