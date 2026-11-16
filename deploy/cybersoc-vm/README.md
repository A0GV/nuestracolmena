# Nuestracolmena en la VM de CyberSOC (reemplazo de TheHive)
> Antes se llamaba MyHive. El cambio fue solo de nombre visible: repo, carpetas, comando `sirp.sh myhive`, contenedores, base de datos, variables `MYHIVE_*`, `custom-myhive`, prefijo de API key `mh_`, logins `@myhive.local` y etiqueta `myhive` de MISP siguen igual.

VM Kali `kali-linux-2026.2-virtualbox-amd64 1` (MISP + Cortex + TheHive). Nuestracolmena corre en Docker junto a esos servicios y usa el mismo Cortex y MISP.

| Servicio | URL | Notas |
|---|---|---|
| Nuestracolmena web | `https://192.0.2.4:9443` (también `192.0.2.104:9443`) | nginx con TLS (copia del certificado de TheHive en `certs/`); `/api/` → API. Es el puerto que usaba TheHive: n8n le escribe sin cambiar la URL |
| Nuestracolmena API | `http://192.0.2.4:4100/api/v1` | Para n8n / Wazuh. Swagger en `/api/docs` |
| TheHive (respaldo) | `https://192.0.2.4:9443` | Detenido; comparte el puerto 9443 con Nuestracolmena, así que solo uno puede estar encendido |
| Cortex | `https://192.0.2.4:9444` | Compartido |
| MISP | `https://192.0.2.4:8443` | Compartido; usuario dedicado `myhive@admin.test` |

## Cambiar entre Nuestracolmena y TheHive

```bash
~/myhive/deploy/cybersoc-vm/sirp.sh myhive    # detiene TheHive, enciende Nuestracolmena
~/myhive/deploy/cybersoc-vm/sirp.sh thehive   # detiene Nuestracolmena, enciende TheHive (~2 min hasta healthy)
~/myhive/deploy/cybersoc-vm/sirp.sh status    # dice quién ocupa el 9443 (ya no hay modo both)
```

Solo hace `docker stop`/`start`: no borra contenedores, volúmenes ni datos de ninguno. El modo elegido se mantiene tras reiniciar la VM (`restart: unless-stopped`). Cortex y MISP no se tocan.

## Instalación (ya hecha)

```bash
cd ~/myhive/deploy/cybersoc-vm
cp .env.example .env     # POSTGRES_PASSWORD y JWT_SECRET aleatorios; revisa PUBLIC_URL
mkdir -p certs && cp ~/soc/strangebee/prod1-thehive/nginx/certs/server.* certs/   # certificado TLS del 9443
docker compose up -d --build
docker compose exec -T api npm run db:seed </dev/null    # solo con base nueva
```

Variables nuevas en `.env` (ver `.env.example`): `PUBLIC_URL` (enlaces en notificaciones, por defecto `https://192.0.2.4:9443`), `MITRE_ATTACK_URL` (opcional), `MAX_UPLOAD_MB` (por defecto 100), `INTEGRATIONS_SCHEDULER`, `SLA_SCHEDULER` y `EMAIL_SCHEDULER` (`false` los desactiva). Los secretos (`POSTGRES_PASSWORD`, `JWT_SECRET`, API keys) van solo en `.env` / `connectors.env`, nunca en git.

## Actualizar

```bash
cd ~/myhive/deploy/cybersoc-vm
git pull
docker compose up -d --build
```

El contenedor de la API ejecuta **`node prisma/db-sync.mjs`** antes de arrancar. `db-sync`:

1. ejecuta pasos previos idempotentes (por ejemplo, renombra `Function` duplicadas antes de crear el índice único `(organisationId, name)`);
2. ejecuta `prisma db push --skip-generate` **sin `--accept-data-loss`**. Si Prisma pidiera aceptar pérdida de datos, el contenedor no arranca y el log explica qué paso previo falta.

Comprueba el arranque y el esquema:

```bash
docker compose logs -f api          # debe verse "[db-sync] Esquema sincronizado correctamente"
curl -skf https://192.0.2.4:9443/api/v1/health
```

La base de datos no se borra. Para probar la actualización sin tocar producción:

```bash
bash scripts/upgrade-test.sh        # usa solo la base temporal myhive_upgrade_test y la elimina
```

Después de actualizar, una sola vez:

1. **MITRE ATT&CK**: Administración → ATT&CK → importar catálogo (o esperar al job; `MITRE_ATTACK_URL` opcional).
2. **Wazuh**: crear la función `wazuh-alert` desde la plantilla y la API key (ver [Wazuh](#wazuh)).
3. **n8n**: registrar el endpoint webhook de Nuestracolmena y la notificación `AnyEvent` (ver [n8n](#n8n)).

Secretos locales (no versionados, permisos 600): `.env` y `connectors.env` (`MISP_API_KEY`, `CORTEX_API_KEY`, `MYHIVE_N8N_KEY`).

Registrar o actualizar Cortex/MISP:

```bash
set -a; . ./connectors.env; set +a
docker compose exec -T -e MYHIVE_TOKEN="$MYHIVE_N8N_KEY" \
  -e CORTEX_URL=https://192.0.2.4:9444 -e CORTEX_API_KEY="$CORTEX_API_KEY" -e CORTEX_VERIFY_TLS=false \
  -e MISP_URL=https://192.0.2.4:8443 -e MISP_API_KEY="$MISP_API_KEY" -e MISP_VERIFY_TLS=false -e MISP_FEEDER_MINUTES=15 \
  api node /app/scripts/register-connectors.mjs </dev/null
docker compose exec -T api node /app/scripts/smoke-test.mjs </dev/null
```

## Buzón de reportes de phishing (IMAP)

Nuestracolmena puede leer directamente el buzón donde los usuarios reenvían correos sospechosos (por ejemplo `phishing@tu-dominio`) y crear alertas automáticamente:

1. Crea o reutiliza una cuenta IMAP dedicada para ese buzón (mejor solo lectura/lectura-escritura en esa carpeta, no una cuenta personal).
2. Entra en **Administración → Automatización → Buzones de correo (IMAP)** y pulsa **Nuevo buzón**.
3. Rellena servidor (`mail.tu-dominio`), puerto (`993` con TLS), usuario, contraseña, carpeta (`INBOX`), intervalo y, si quieres, una carpeta destino para los correos ya procesados (`moveTo`). Ajusta TLP/severidad/tags.
4. **Probar conexión** valida usuario y carpeta sin importar nada; **Ejecutar ahora** procesa los no leídos en ese momento.

El scheduler sondea cada minuto los buzones cuyo intervalo haya vencido (`EMAIL_SCHEDULER=false` lo desactiva). Solo usa mensajes no leídos; los procesados se marcan como leídos o se mueven a `moveTo`. La deduplicación es por `Message-ID`, así que reejecutar no duplica alertas. Los reenvíos con el mensaje original adjunto (`message/rfc822`) se analizan sobre el mensaje interno.

Alternativa manual: en *Alertas*, botón **Importar .eml** para subir ficheros exportados desde el cliente de correo o desde el gateway.

## n8n

Nuestracolmena acepta las rutas de TheHive 5 (`POST /api/v1/alert`, `GET|PATCH|DELETE /api/v1/alert/:id`, `POST /api/v1/alert/:id/case`, `POST /api/v1/alert/:id/observable`, `POST /api/v1/case`, `GET /api/v1/case/:id`, `GET /api/v1/user/current`) con `Authorization: Bearer <API key mh_…>` y devuelve `_id`.

- **Credencial "TheHive 5"** de n8n: URL `http://192.0.2.4:4100` y una API key de Nuestracolmena (`mh_…`). Sirve para el nodo TheHive 5 y para nodos HTTP Request.
- **Nodo TheHive 5 Trigger**: Nuestracolmena empuja eventos a un webhook de n8n. En Nuestracolmena: Administración → Automatización → **Endpoints** → crear uno de tipo webhook con formato `thehive` apuntando a la URL del webhook de n8n; luego crear una **Notificación** `AnyEvent` que use ese endpoint. El cuerpo sigue el formato del trigger de TheHive (`operation`, `objectType`, `objectId`, `details`).
- Si prefieres no usar el trigger, un nodo HTTP Request puede hacer `POST http://192.0.2.4:4100/api/v1/alert` con cuerpo TheHive 5: `{type, source, sourceRef, title, description, severity, tlp, pap, tags, observables:[{dataType, data}]}`. `type`/`source`/`sourceRef` son únicos por alerta (duplicado → 409).
- Las rutas de compatibilidad están probadas por curl y por `scripts/thehive4-compat-test.mjs` / `scripts/thehive5-compat-test.mjs`; el nodo real de n8n no se ha probado en esta VM.

## Usuarios de integración (API keys)

Las API keys **pertenecen a un usuario** y heredan los permisos de su perfil en la organización activa. Para Wazuh y n8n el usuario de integración necesita como mínimo el perfil **`analyst`**, que incluye `manageAlert/create` (crear/importar alertas) y `manageFunction/invoke` (invocar `POST /api/v1/function/:name`). Un perfil `read-only` no puede invocar funciones. Evita usar una cuenta `admin` para integraciones si no necesitas configuración.

Los **`org-admin`** gestionan usuarios (alta, perfil de organización, bloqueo, contraseña, API keys y baja) solo dentro de su propia organización; no pueden asignar el perfil `admin` ni tocar usuarios de otras organizaciones. La gestión global de usuarios y organizaciones sigue reservada a `admin`.

## Wazuh

La integración vive en [`deploy/wazuh/`](../wazuh/) y sustituye a `custom-w2thive`:

- `custom-myhive` (wrapper) + `custom-myhive.py`: leen el JSON de Wazuh y lo envían por `POST` a la función `wazuh-alert` de Nuestracolmena con `Authorization: Bearer`.
- `ossec.conf.snippet`: bloque `<integration>` para `/var/ossec/etc/ossec.conf`.
- `sample-alert.json` y `test-custom-myhive.mjs` para probar sin Wazuh.

Pasos completos (instalación, permisos, API key, prueba): [`deploy/wazuh/README.md`](../wazuh/README.md).

## Cortex en esta VM

Antes del 2026-11-03 Cortex solo tenía la organización de administración `cortex` (usuario `admin`, superadmin), sin analizadores: ni TheHive ni Nuestracolmena podían analizar. Se configuró por la API:

- Organización **SOC** con usuarios `myhive` y `thehive` (`read`, `analyze`; sus claves están en `connectors.env` como `CORTEX_MYHIVE_KEY` y `CORTEX_THEHIVE_KEY`) y `socadmin` (`orgadmin`, sin contraseña: se la pone el superadmin desde la UI).
- Analizadores sin clave externa: TorProject, DShield_lookup, Abuse_Finder, Crt_sh_Transparency_Logs, GoogleDNS_resolve, MaxMind_GeoIP, FileInfo, EmlParser; responder DevTools_Echo_Responder.
- Para que TheHive también analice: en TheHive → Platform management → Connectors → Cortex, URL `https://192.0.2.4:9444` y la clave `CORTEX_THEHIVE_KEY`.

Dos problemas que impedían ejecutar cualquier job:

1. `~/soc/strangebee/prod1-cortex/cortex/cortex-jobs` era `root:root 755` y Cortex corre como uid 1001 → el job fallaba al instante con la ruta del job como error. Se cambió a `1001:983`, `770`.
2. Cortex no termina de descargar las imágenes de los analizadores (`ghcr.io/thehive-project/<analizador>:<versión>`): el job se queda `InProgress` o falla con *Could not pull image*. Descárgalas antes en el host:

```bash
for i in torproject:1 dshield_lookup:1 abuse_finder:3 crt_sh_transparency_logs:1 googledns_resolve:1 \
         maxmind_geoip:4 fileinfo:8 emlparser:2 devtools_echo_responder:1; do
  docker pull -q ghcr.io/thehive-project/$i
done
```

Las imágenes quedan en la VM, así que los analizadores funcionan también sin internet en el laboratorio (salvo los que consultan servicios externos, como TorProject o DShield).

## Grafana (gráficas)

Paneles de alertas, casos, observables, Cortex, MITRE, tareas y SLA leyendo la base de Nuestracolmena
con un rol de solo lectura. Detalles en `deploy/grafana/README.md`.

```bash
cd ~/myhive/deploy/cybersoc-vm
# 1. Contraseñas en .env (una vez)
grep -q '^COMPOSE_PROFILES=' .env || echo 'COMPOSE_PROFILES=grafana' >> .env
for v in GRAFANA_ADMIN_PASSWORD MYHIVE_GRAFANA_DB_PASSWORD; do
  grep -qE "^$v=.+" .env || { sed -i "/^$v=/d" .env; echo "$v=$(openssl rand -hex 16)" >> .env; }
done
# 2. Rol de solo lectura (idempotente; repetir si cambias la contraseña)
docker exec -i myhive-postgres psql -q -v ON_ERROR_STOP=1 -U myhive -d myhive \
  -v grafana_password="$(grep ^MYHIVE_GRAFANA_DB_PASSWORD= .env | cut -d= -f2)" < ../grafana/grafana-readonly.sql
# 3. Arrancar y recargar la web
docker compose up -d grafana web
```

URL: `https://192.0.2.4:9443/grafana/` (usuario `admin`, contraseña `GRAFANA_ADMIN_PASSWORD` del `.env`).
También se abre desde el botón «Gráficas» del menú lateral de Nuestracolmena.
Comprobar las consultas: `python3 ../grafana/check-dashboards.py https://192.0.2.4:9443/grafana` (puede necesitar
`GRAFANA_ADMIN_PASSWORD=... ` delante; usa el certificado de TheHive, así que mejor desde la VM con
`http://` al contenedor: `docker exec myhive-grafana wget -qO- http://localhost:3000/grafana/api/health`).

## Gotcha del socket de Docker

El entrypoint de Cortex hace `chown` de `/var/run/docker.sock` del host en cada arranque. En `~/soc/strangebee/prod1-cortex/docker-compose.override.yml` se fijó `daemon_user: '1001:983'` (983 = grupo `docker` del host) para que el usuario `kali` siga pudiendo usar Docker. Si vuelve a salir *permission denied*: `sudo chown root:docker /var/run/docker.sock`.
