# Nuestracolmena
> Antes se llamaba MyHive. El cambio fue solo de nombre visible: repo, carpetas, comando `sirp.sh myhive`, contenedores, base de datos, variables `MYHIVE_*`, `custom-myhive`, prefijo de API key `mh_`, logins `@myhive.local` y etiqueta `myhive` de MISP siguen igual.

SIRP self-hosted inspirado funcionalmente en TheHive. Implementación propia (React + Ant Design 5 / NestJS + Prisma + PostgreSQL), creada a partir del análisis de TheHive 4 (AGPL, referencia de dominio/API) y del comportamiento observable de TheHive 6 (comercial, solo UX/documentación pública).

No reutiliza código, marca ni assets propietarios de TheHive 6.

## Estado actual

Implementado:

- Autenticación JWT, API keys, cambio de contraseña, multi-organización y cambio de contexto.
- Organizaciones, usuarios, perfiles/permisos, auditoría.
- Casos: lista, creación, detalle, edición, cierre, reapertura, merge, flag, borrado, comentarios, timeline, reporte y shares entre organizaciones.
- Tareas: lista global, detalle, estados, logs Markdown y action-required básico.
- Observables: creación masiva, flags IOC/sighted, edición (incl. tags), borrado y deduplicación que conserva IOC/sighted/tags/reportes.
- TTPs/ATT&CK: catálogo MITRE, alta/edición/borrado de procedimientos.
- Alertas: creación, lista, preview, marcar leída, importar a caso, merge a caso.
- Dashboards con widgets y gráficas.
- Knowledge base (páginas CRUD + Markdown).
- Búsqueda global de casos, alertas, observables y tareas.
- Administración: organizaciones, usuarios, perfiles, estados, custom fields, tags, plantillas, ATT&CK, licencia/estado, auditoría, automatización y **Cortex & MISP**.
- **Cortex** (real): analizadores sobre observables de casos y alertas (taxonomías en la tabla, reporte completo, importar artefactos), responders sobre casos/tareas/observables/alertas con historial de acciones.
- **MISP** (real): importar eventos como alertas (manual o con feeders periódicos, deduplicado por evento), exportar casos como eventos MISP (re-exportar solo añade atributos nuevos) y buscar observables en MISP.
- **Ingesta de correo**: importación manual de `.eml` y buzones IMAP sondeados periódicamente que convierten correos (incluidos reenvíos de phishing con el mensaje original adjunto) en alertas con observables y adjuntos analizables por Cortex.
- Adjuntos por caso (subida/descarga con almacenamiento local) y **observables de fichero** con hashes md5/sha1/sha256, ZIP protegido y análisis en Cortex.
- **Notificaciones reales**: webhook con formato TheHive (trigger de n8n), Slack, Mattermost, Teams, Discord y email SMTP, con reintentos e historial de entregas.
- **Functions** estilo TheHive 5 (`function handle(input, context)`) en `node:vm`, con plantillas Wazuh/Suricata y ejecución asíncrona.
- **SLA**: reglas de acuse/resolución con avisos, cumplimiento y `acknowledgedAt`.
- **Correlación** de casos/alertas por observables compartidos.
- **MITRE ATT&CK** completo: catálogo importable, buscador, matriz y TTPs enriquecidos.
- **API compatible con TheHive 5** (alertas, casos, tareas, logs, observables, comentarios, páginas, Query API, Cortex) y **con TheHive 4** (`/api/alert`, `/api/case/_search`, `artifacts`, Basic auth + `X-Organisation`).
- API REST v1 + Swagger, Query API compatible (subset).

Pendiente/futuro: TheHive Flow/orquestración visual, portal de usuarios externos, clustering/HA y object storage S3.

## Requisitos

- Node.js 22+
- Docker + Docker Compose
- npm 10+

## Arranque

```bash
cd ~/myhive
docker compose up -d postgres
npm install
cp .env.example apps/api/.env   # ajustar si hace falta
cp .env.example apps/web/.env   # VITE_API_URL=http://localhost:4100/api/v1
npm run db:sync -w @myhive/api
npm run db:seed -w @myhive/api
npm run dev
```

### Local

- Web: http://localhost:5173
- API: http://localhost:4100/api/v1
- Swagger: http://localhost:4100/api/docs

### Red local (LAN)

- Nuestracolmena: http://192.0.2.10:8088 (pública: https://nuestracolmena.example.com)
- Nuestracolmena API: http://192.0.2.10:4100/api/v1
- Nuestracolmena Swagger: http://192.0.2.10:4100/api/docs
- TheHive (referencia): https://192.0.2.10:9443 (certificado self-signed, aceptar aviso)

En este servidor todo corre en Docker con `restart: unless-stopped`, así que vuelve solo tras reiniciar:

- API: contenedor `myhive-api` (`deploy/local-api.compose.yml`, ejecuta `apps/api/dist` del repo).
  Tras cambiar el backend: `npm run build -w @myhive/api && docker restart myhive-api`. Logs: `docker logs -f myhive-api`.
- Web: contenedor `myhive-web` (nginx sirve `apps/web/dist` con `deploy/myhive-nginx.conf`, proxy de `/api`).
  Tras cambiar la web: `npm run build -w @myhive/web`.
- PostgreSQL: contenedor `myhive-postgres` (puerto 5433).

`npm run dev -w @myhive/web` (Vite en :5173) queda solo para desarrollo con recarga en caliente.

## Cortex y MISP

El stack de integraciones vive en `deploy/integrations/` (ver su README). Puertos en la LAN:

| Servicio | URL |
|---|---|
| Cortex 4.2 | http://192.0.2.10:9001 |
| MISP 2.5 | http://192.0.2.10:8090 |

Los servidores se registran en **Administración → Cortex & MISP** (URL + API key). Desde ahí también se crean los feeders MISP → alertas.

Flujo en la UI:

- **Caso → Observables**: icono de matraz = analizar con Cortex; clic en el valor = drawer con reportes, artefactos y "Buscar en MISP". La columna *Análisis (Cortex)* se actualiza sola mientras hay análisis en curso.
- **Caso → cabecera**: `MISP` exporta el caso como evento; `Responders` lanza responders y muestra el historial.
- **Alertas**: `Importar de MISP` trae eventos recientes; en el detalle de una alerta se pueden analizar sus observables y lanzar responders.

## Ingesta de correo (phishing)

Nuestracolmena puede convertir en alertas el correo de un buzón SOC (por ejemplo `phishing@tu-dominio`) de dos formas, usando el mismo parser:

- **Importación manual**: botón `Importar .eml` en *Alertas* (arrastrar y soltar, varios ficheros).
- **Buzón IMAP**: *Administración → Automatización → Buzones de correo (IMAP)*. Cada ejecución lee los mensajes no leídos, crea alertas deduplicadas por `Message-ID`, los marca como leídos (o los mueve a otra carpeta) y guarda el resultado en el propio buzón. El sondeo se controla con `intervalMinutes` y `EMAIL_SCHEDULER`.

El parser detecta reenvíos de phishing: si el correo recibido lleva el mensaje sospechoso como adjunto `message/rfc822`, la alerta se crea sobre el mensaje interno (`Reportado: <asunto>`) y añade al remitente original como observable `mail` con el mensaje *Reportado por*. La descripción incluye cabeceras, resultado SPF/DKIM/DMARC, cadena de `Received` y cuerpo de texto. Los enlaces, dominios, IPs públicas, remitentes, asuntos y adjuntos se añaden como observables (sin marcarlos IOC); el mensaje original se guarda como `.eml` con el tag `original-email`.

## Pruebas

Todas las suites viven en `scripts/*-test.mjs` y se ejecutan contra una API en marcha:

```bash
MYHIVE_URL=http://127.0.0.1:4100 bash scripts/run-all-tests.sh
```

| Suite | Qué comprueba |
|---|---|
| `smoke-test.mjs` | End-to-end de API + Cortex + MISP (crea y borra sus datos) |
| `thehive5-compat-test.mjs` | Peticiones del nodo TheHive 5 de n8n y Query API |
| `thehive4-compat-test.mjs` | API TheHive 4 / thehive4py (`/api/alert`, `_search`, artifacts, Basic auth) |
| `functions-test.mjs` | Functions en `node:vm`, plantilla Wazuh, DryRun y límites |
| `notifications-test.mjs` | Motor de eventos, webhooks formato TheHive y reintentos |
| `sla-test.mjs` | Reglas SLA, acuse/resolución y avisos |
| `correlation-test.mjs` | Casos/alertas relacionados y avistamientos |
| `mitre-test.mjs` | Importación y búsqueda del catálogo ATT&CK |
| `file-observables-test.mjs` | Observables `file`, hashes, ZIP y Cortex |
| `email-test.mjs` | Ingesta manual de `.eml`, reenvío reportado y feeder IMAP contra GreenMail |

Fuera de esa lista: `bash scripts/upgrade-test.sh` (actualización de esquema con base temporal) y `node deploy/wazuh/test-custom-myhive.mjs` (transporte Wazuh → Nuestracolmena).

Variables opcionales: `MYHIVE_URL`, `MYHIVE_LOGIN`, `MYHIVE_PASSWORD`. Las pruebas de ingesta IMAP arrancan un contenedor GreenMail local y se omiten si Docker no está disponible. El smoke y las pruebas MISP pueden dejar un evento `[Nuestracolmena #N] principal` en MISP (Nuestracolmena no borra eventos de MISP); usa `SMOKE_MISP_WRITE=1` solo si quieres exportar.

## Credenciales de demo

| Usuario | Contraseña | Perfil |
|---|---|---|
| `admin@myhive.local` | `admin123` | admin (todos los permisos) |
| `analyst@myhive.local` | `analyst123` | analyst |
| `readonly@myhive.local` | `readonly123` | read-only |

Organización demo: `SOC` (también `Partner`).

Estas cuentas las crea `npm run db:seed` solo en una base nueva (volver a correr el seed no cambia contraseñas existentes). **Cámbialas antes de exponer la instancia.** La pantalla de login solo las muestra si la web se compila con `VITE_DEMO_LOGIN=true`.

## Estructura

```
apps/
  api/        NestJS + Prisma + PostgreSQL
  web/        React + Vite + Ant Design 5
packages/
  shared/     (reservado)
docs/analysis/  análisis de TheHive 3/4 (AGPL) y blueprint del clon
```

## Scripts

```bash
npm run build          # build API + web
npm run dev            # API + web
npm run db:sync -w @myhive/api
npm run db:seed -w @myhive/api
npm run lint           # typecheck API + web
```

## Variables de entorno (API)

```env
DATABASE_URL="postgresql://myhive:myhive@localhost:5433/myhive?schema=public"
JWT_SECRET="change-me"            # obligatorio: la API no arranca sin él; usa un valor aleatorio largo
JWT_EXPIRES_IN="12h"
PORT=4100
CORS_ORIGIN="http://localhost:5173"
UPLOAD_DIR="/ruta/a/myhive/apps/api/uploads"
```

## Licencia

Código propio: MIT (pendiente de confirmar). El dossier de análisis referencia TheHive 4/3 bajo AGPL-3.0; si se reutiliza código AGPL, el derivado debe cumplir AGPL.

## Licencia

Copyright (C) 2026 Adolfo García Vázquez.

Nuestracolmena es software libre: puedes redistribuirlo y modificarlo bajo los términos de la [GNU Affero General Public License](LICENSE), versión 3 o (a tu elección) cualquier versión posterior (`AGPL-3.0-or-later`). Si ofreces una versión modificada como servicio en red, debes poner su código fuente a disposición de quienes la usen. Se distribuye **sin ninguna garantía**; ver `LICENSE`.

### Avisos de terceros

- **TheHive** es una marca de StrangeBee. Nuestracolmena es un proyecto independiente, no afiliado ni respaldado por StrangeBee ni por TheHive Project; el nombre se usa solo para indicar compatibilidad de API. Este repositorio no contiene código, documentación, capturas ni assets de TheHive 5/6.
- **MITRE ATT&CK®** es una marca registrada de The MITRE Corporation. El catálogo ATT&CK se descarga en tiempo de ejecución desde `mitre/cti` y el seed incluye algunos identificadores y nombres de técnicas. © The MITRE Corporation. Este trabajo se reproduce y distribuye con permiso de The MITRE Corporation, conforme a los [Términos de uso de ATT&CK](https://attack.mitre.org/resources/legal-and-branding/terms-of-use/).
- Las dependencias de npm conservan sus propias licencias (MIT, ISC, Apache-2.0, BSD y similares); ver `package-lock.json`. Grafana, Cortex, MISP y Wazuh se usan como servicios externos y no se redistribuyen aquí.

