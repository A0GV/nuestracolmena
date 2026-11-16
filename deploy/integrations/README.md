# Cortex + MISP para Nuestracolmena

Stack Docker con **Cortex 4.2** (analizadores/responders) y **MISP 2.5** (threat intel) para Nuestracolmena.

- Cortex reutiliza el Elasticsearch del stack de TheHive (`~/thehive-docker/prod1-thehive`, red `prod1-thehive_thehive-network`). Ese contenedor `elasticsearch` debe estar arrancado.
- Los analizadores de Cortex se ejecutan como contenedores Docker (Cortex usa el socket del host). La primera ejecución de cada analizador descarga su imagen.

## Primera instalación

```bash
cd deploy/integrations
# .env con los secretos (ver variables abajo); se genera una vez y NO se versiona
./setup.sh
```

`setup.sh` genera `cortex/config/secret.conf` + `index.conf`, arranca el stack, inicializa Cortex con `cortex-bootstrap.mjs` (superadmin, organización `MyHive`, usuario `myhive` con API key, analizadores gratuitos y el responder de prueba `DevTools_Echo_Responder`) y escribe `connectors.env` con las URLs/keys que hay que registrar en Nuestracolmena (Administración → Cortex & MISP).

`cortex-bootstrap.mjs` es idempotente: se puede volver a lanzar (`set -a; . ./.env; set +a; node cortex-bootstrap.mjs`).

## Variables de `.env`

| Variable | Uso |
|---|---|
| `ES_PASSWORD` | contraseña `elastic` del Elasticsearch de TheHive |
| `CORTEX_SECRET`, `CORTEX_ADMIN_PASSWORD` | secreto Play y contraseña del superadmin `admin` de Cortex |
| `CORTEX_JOB_DIR` | ruta absoluta de `cortex/cortex-jobs` (Cortex la pasa a los contenedores de analizadores) |
| `CORTEX_DAEMON_USER` | `uid:gid` del usuario del host y del grupo `docker` (ver nota) |
| `MISP_*`, `MYSQL_*`, `REDIS_PASSWORD` | credenciales de MISP, MariaDB y Valkey |

> **Nota sobre el socket de Docker.** El entrypoint de Cortex ejecuta `chown cortex:cortex /var/run/docker.sock` sobre el socket **del host**. Con `daemon_user=${CORTEX_DAEMON_USER}` (p. ej. `1000:988`) el socket queda como `usuario:docker` y sigue accesible para el grupo `docker`. Si alguna vez `docker` responde *permission denied*: `sudo chown root:docker /var/run/docker.sock`.

## Operación

```bash
docker compose ps
docker compose logs -f cortex
docker compose restart misp-core
```

- Cortex UI: http://192.0.2.10:9001 (usuario `admin`, contraseña en `.env`)
- MISP UI: http://192.0.2.10:8090 (`admin@myhive.local`, contraseña en `.env`)

Analizadores habilitados sin API key: Abuse_Finder, DShield_lookup, TorProject, StopForumSpam, GoogleDNS_resolve, Mnemonic_pDNS_Public, Robtex (IP/forward/reverse), CyberCrime-Tracker, UnshortenLink, FileInfo, EmlParser. Para VirusTotal, AbuseIPDB, Shodan, etc. habilítalos en la UI de Cortex (organización `MyHive`) con tu API key: aparecen automáticamente en Nuestracolmena.
