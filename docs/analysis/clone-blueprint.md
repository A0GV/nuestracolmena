# Blueprint del clon — “Nuestracolmena” (SIRP tipo TheHive)

**Base funcional:** dominio/API de TheHive 4.1.24 (AGPL) + UX/UX observable de TheHive 6.0.0 (comercial).
**Regla legal:** no copiar código, textos, imágenes, logos ni assets de TheHive 6. Se reimplementa desde cero. Las ideas, flujos y contratos públicos pueden usarse; si se reutiliza código AGPL de TheHive 4, el derivado debe cumplir AGPL.

Este documento es la guía de implementación. Los detalles de referencia están en:

- `backend-thehive4.md` — dominio, endpoints, permisos y reglas de TheHive 4.
- `frontend-thehive4.md` — pantallas, componentes y flujos de TheHive 4.
- Documentación pública de la API de TheHive 5/6 (StrangeBee) — contratos de la API y Query API. No se incluye en este repositorio.
- `thehive3-vs-4.md` — qué tomar de cada versión.

---

## 1. Objetivo y alcance

Construir un SIRP self-hosted, multi-organización, con paridad funcional razonable con TheHive:

**Incluido en el alcance:**

- Casos, alertas, tareas, task logs, observables, TTPs, tags, custom fields, comentarios, adjuntos.
- Organizaciones, usuarios, perfiles/permisos, shares, auditoría.
- Dashboards, plantillas de caso, páginas/knowledge base, reportes de caso.
- Búsqueda y filtros tipo Query API.
- Administración de plataforma y de organización.
- API REST v1 + API keys.
- UI React/Ant Design con la misma estructura visual (top bar oscura, rail de iconos, listas densas, detalle con panel + tabs + comentarios).

**Fuera del alcance inicial (fases posteriores):**

- TheHive Flow / orquestación visual.
- Cortex/MISP reales (se dejan interfaces y stubs).
- Email intake, LLM providers, portal de usuarios externos.
- Clustering, HA y multi-región.

---

## 2. Stack recomendado

### Frontend

- React 19 + TypeScript + Vite.
- Ant Design 5 (mismos tokens visuales).
- React Router 7.
- TanStack Query para estado de servidor; Zustand para estado UI.
- React Hook Form + Zod.
- i18next (es/en; estructura preparada para más).
- TipTap o editor markdown para descripciones, logs, comentarios y páginas.
- Recharts o ECharts para widgets de dashboard.

### Backend

- NestJS 11 + TypeScript.
- Prisma ORM + PostgreSQL 16.
- Redis 7 + BullMQ para jobs (notificaciones, exportaciones, analyzers simulados).
- MinIO/S3 para adjuntos (interfaz `StorageProvider`).
- OpenSearch opcional para búsqueda avanzada; PostgreSQL `tsvector`/trigram como base.
- Argon2id para contraseñas; API keys hasheadas.
- OpenAPI generado desde NestJS (`@nestjs/swagger`).

### Infra

- pnpm + Turborepo (monorepo).
- Docker Compose para desarrollo: web, api, postgres, redis, minio.
- Caddy/Nginx para TLS.
- GitHub Actions para lint, test, build y migraciones.

### Estructura del monorepo

```
myhive/
├── apps/
│   ├── web/                 # React + Vite + AntD
│   └── api/                 # NestJS
├── packages/
│   ├── shared/              # tipos, zod schemas, permisos, constantes
│   ├── ui/                  # componentes compartidos (opcional)
│   └── config/              # eslint, tsconfig, tailwind? (no)
├── docs/analysis/
├── docker-compose.yml
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

---

## 3. Modelo de datos (PostgreSQL)

Convenciones: UUID v7 como PK, `created_at/updated_at`, `created_by/updated_by`, `deleted_at` para borrado lógico, `organisation_id` en toda entidad de negocio. Números de caso por organización con secuencia.

### Identidad y tenancy

- `users`: id, login (email único), name, email, password_hash, type (normal/service/external), locked, mfa_enabled, mfa_secret, default_organisation_id, created_at, updated_at.
- `api_keys`: id, user_id, name, key_hash, prefix, last_used_at, expires_at, revoked_at.
- `sessions`: id, user_id, token_hash, organisation_id, ip, user_agent, expires_at, created_at.
- `organisations`: id, name (único), description, task_rule (manual/autoShare), observable_rule, locked, avatar_key, created_by, created_at.
- `organisation_users`: organisation_id, user_id, profile_id, is_default, created_at. PK compuesta.
- `organisation_links`: org_id, linked_org_id.
- `profiles`: id, name, type (admin/organisation/external), permissions JSONB (array de strings), is_system.
- `shares`: id, organisation_id (owner), shared_with_org_id, object_type, object_id, profile_id, created_by, created_at.

### Casos

- `cases`: id, organisation_id, number (secuencia por org), title, description, summary, severity (1-4), tlp (0-3), pap (0-3), status_id, stage (New/InProgress/Closed), assignee_id, start_date, end_date, due_date, flag, access_kind (organisation/restricted/external), access_org_ids UUID[], created_by, created_at, updated_at, closed_at, merged_into_case_id, custom_fields JSONB, extra JSONB.
- `case_statuses`: id, organisation_id, value, stage, order, colour, hidden, requires_impact.
- `case_tasks`: id, organisation_id, case_id, title, group, description, status (Waiting/InProgress/Completed/Cancel), flag, mandatory, start_date, end_date, due_date, order, assignee_id, created_by, created_at, updated_at.
- `task_logs`: id, organisation_id, task_id, message, date, include_in_timeline, created_by, created_at, updated_at.
- `observables`: id, organisation_id, case_id (nullable), alert_id (nullable), data_type, data (text), data_hash (para dedupe), message, tlp, pap, ioc, sighted, sighted_at, ignore_similarity, tags text[], start_date, created_by, created_at, updated_at.
- `observable_reports`: id, observable_id, analyzer, report JSONB, created_at.
- `procedures`: id, organisation_id, case_id, alert_id, pattern_id, tactic, occur_date, description, created_by, created_at, updated_at.
- `patterns`: id, pattern_id (T1566), name, description, tactics text[], platforms text[], catalog (MITRE), is_custom.
- `custom_events`: id, organisation_id, case_id, date, title, description, colour, created_by.
- `comments`: id, organisation_id, object_type, object_id, message, created_by, created_at, updated_at.

### Alertas

- `alerts`: id, organisation_id, type, source, source_ref, external_link, title, description, summary, severity, tlp, pap, status_id, stage (New/InProgress/Imported/Closed), assignee_id, date, flag, follow, read, case_id (nullable), custom_fields JSONB, created_by, created_at, updated_at. Índice único (organisation_id, type, source, source_ref).
- `alert_statuses`: id, organisation_id, value, stage, order, colour, hidden.
- `alert_observables`: alert_id, observable_id.
- `alert_procedures`: alert_id, procedure_id.

### Plantillas, conocimiento y dashboards

- `case_templates`: id, organisation_id, name, display_name, title_prefix, description, severity, tlp, pap, tags text[], custom_fields JSONB, task_rule, observable_rule.
- `case_template_tasks`: id, template_id, title, group, description, order, due_days, mandatory.
- `pages`: id, organisation_id, title, content, category, created_by, created_at, updated_at.
- `page_templates`: id, organisation_id, name, content, category.
- `case_reports`: id, organisation_id, case_id, template_id, content, rendered_at, created_by.
- `case_report_templates`: id, organisation_id, name, content, widgets JSONB.
- `dashboards`: id, organisation_id, name, description, visibility, created_by.
- `dashboard_widgets`: id, dashboard_id, type, title, config JSONB, position, size.

### Colaboración y archivos

- `attachments`: id, organisation_id, object_type, object_id, filename, content_type, size, storage_key, sha256, created_by, created_at.
- `tags`: id, organisation_id, name, colour, count.
- `custom_field_defs`: id, organisation_id, name, reference, type (string/text/number/date/boolean/select), options JSONB, mandatory, order.
- `audit_logs`: id, organisation_id, actor_id, action, object_type, object_id, details JSONB, ip, created_at.

### Automatización y SLA (fase posterior)

- `functions`, `function_runs`, `sla_rules`, `notifications`, `endpoints`, `alert_feeders`, `jobs`.
- `jobs`: id, organisation_id, type, status, payload JSONB, result JSONB, created_by, created_at, started_at, finished_at.

### Relaciones clave

- Organización 1-N usuarios (via organisation_users), casos, alertas, observables, plantillas.
- Caso 1-N tareas, observables, procedimientos, comentarios, adjuntos, eventos.
- Alerta N-M observables y procedimientos; 0/1 caso.
- Caso N-M organizaciones vía shares; acceso restringido vía access_org_ids.
- Perfil N-M usuarios por organización.
- Custom fields: definición por org + valores JSONB por caso/alerta.

---

## 4. API REST

Prefijo `/api/v1`. Autenticación por `Authorization: Bearer <jwt|api_key>` o cookie de sesión. Contexto de organización por `X-Organisation: <org>` (default del usuario si se omite).

### Respuestas y errores

- Listados: `200`, header `X-Total`, body `{ data, total }` o array (elegir una convención y documentarla).
- Error: `{ type, message, details? }` con códigos 400/401/403/404/409/422/429/500.
- Fechas en ISO 8601 UTC en la API; el frontend formatea.
- IDs: UUID en el clon (no `~1234`), pero aceptar `number` de caso en rutas de caso.

### Endpoints núcleo

Auth:

- `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`
- `GET /users/me`, `PATCH /users/me`, `POST /users/me/password`, `POST /users/me/mfa`
- `GET/POST/DELETE /users/me/api-keys`

Organizaciones/usuarios:

- `GET/POST /organisations`, `GET/PATCH /organisations/:id`
- `GET/POST/PATCH/DELETE /organisations/:id/users`
- `PUT /users/:id/organisations`
- `GET/POST/PATCH/DELETE /profiles`
- `GET/POST/DELETE /organisation-links`

Casos:

- `GET /cases` (filtros, sort, page)
- `POST /cases`, `GET /cases/:idOrNumber`, `PATCH /cases/:id`, `DELETE /cases/:id`
- `PATCH /cases/_bulk`, `POST /cases/_merge`
- `POST /cases/:id/tasks`, `GET /cases/:id/tasks`
- `POST /cases/:id/observables`, `GET /cases/:id/observables`
- `POST /cases/:id/procedures`, `GET /cases/:id/procedures`
- `POST /cases/:id/comments`, `GET /cases/:id/timeline`
- `POST /cases/:id/close`, `POST /cases/:id/reopen`, `POST /cases/:id/merge`
- `POST /cases/:id/shares`, `DELETE /cases/:id/shares/:shareId`
- `POST /cases/:id/export`, `POST /cases/import`

Tareas/logs:

- `GET/PATCH/DELETE /tasks/:id`, `PATCH /tasks/_bulk`
- `POST /tasks/:id/logs`, `PATCH/DELETE /logs/:id`
- `PUT /tasks/:id/action-required/:orgId`, `PUT /tasks/:id/action-done/:orgId`
- `GET/POST/DELETE /tasks/:id/shares`

Observables:

- `GET/PATCH/DELETE /observables/:id`, `PATCH /observables/_bulk`
- `POST /observables/:id/reports` (analyzer simulado)
- `GET/POST/DELETE /observables/:id/shares`
- `POST /observables/_merge`

Alertas:

- `GET/POST /alerts`, `GET/PATCH/DELETE /alerts/:id`
- `POST /alerts/:id/case`, `POST /alerts/:id/merge/:caseId`
- `POST /alerts/:id/observables`, `POST /alerts/:id/procedures`
- `PATCH /alerts/_bulk`, `POST /alerts/:id/read`, `POST /alerts/:id/follow`

Administración:

- `GET/POST/PATCH/DELETE /case-statuses`, `/alert-statuses`, `/observable-types`, `/custom-fields`, `/tags`, `/patterns`, `/taxonomies`, `/case-templates`, `/page-templates`, `/case-report-templates`, `/sla-rules`, `/functions`, `/notifications`, `/endpoints`, `/license`, `/branding`, `/audit`.

Query:

- `POST /query` con pipeline compatible conceptualmente:
  `{ query: [{_name:"listCase"}, {_name:"filter", _eq:{...}}, {_name:"sort",...}, {_name:"page", from, to, extraData:["total"]}] }`.
  Implementar un subset: `list/get` por entidad, `filter` (`_and/_or/_not/_eq/_ne/_lt/_gt/_lte/_gte/_between/_in/_has/_like/_startsWith/_endsWith`), `sort`, `page`.
- `GET /export`, `GET /export/_fields`.

### Permisos

Array de strings por perfil, p. ej.:

```
manageCase/create, manageCase/update, manageCase/delete, manageCase/merge,
manageCase/reopen, manageCase/changeOwnership, manageCaseAccess/restrict,
manageTask, manageObservable, manageProcedure, manageAlert/create,
manageAlert/update, manageAlert/delete, manageAlert/import, manageAlert/reopen,
manageShare, manageAnalyse, manageAction, manageComment, manageCustomEvent,
manageDashboard, manageKnowledgeBase, managePage, managePageTemplate,
manageCaseTemplate, manageCaseReport, manageCaseReportTemplate, manageSla,
manageTag, manageUser, manageConfig, manageOrganisation, manageProfile,
manageCustomField, manageObservableTemplate, managePattern, manageTaxonomy,
managePlatform, manageFunction/create, manageFunction/invoke, accessTheHiveFS
```

Reglas:

- Toda operación verifica permiso + pertenencia a la organización + visibilidad del objeto (owner, share, access kind).
- El perfil `admin` es de plataforma; `org-admin` administra su org; `analyst` opera casos; `read-only` solo lectura; `external-*` acceso limitado por Portal (fase posterior).
- Auditoría obligatoria en create/update/delete/close/share/login.

---

## 5. Frontend

### Layout

- `AppShell`: top bar (48 px, `#1b1b34`) + rail de iconos (~56 px) + contenido.
- Top bar: logo, breadcrumb, buscador global, botón “Crear caso”, idioma, ayuda, avatar, live feed.
- Banner de licencia/estado (solo si aplica; el clon no tendrá trial).
- Rail: Casos, Alertas, Tareas, Knowledge Base, Dashboards, Búsqueda, Administración (según permisos).

### Páginas y componentes

- **Casos**: `CaseListPage` (tabla densa, filtros, quick filters, bulk, exportación), `CaseCreateDrawer`, `CaseDetailPage` con:
  - `CaseSummaryPanel` (ID, creador, fechas, severidad, TLP/PAP, estado, assignee, time metrics, colaboradores).
  - Tabs: General, Tareas, Observables, TTPs, Adjuntos, Automatizaciones, Timeline, Report, Páginas, Historial, Comentarios.
  - `CommentsPanel` a la derecha.
  - `CaseActionsMenu` (close, reopen, merge, flag, share, export, delete).
- **Tareas**: `TasksTab`, `TaskRow`, `TaskDrawer` (metadatos, descripción, logs, shares, action required), `TaskLogEditor`.
- **Observables**: `ObservablesTab`, `ObservableDrawer` (resumen, flags, reports, shares, dedupe), `ObservableBulkActions`.
- **TTPs**: `ProceduresTab`, `AddProcedureDrawer` (táctica, técnica, occur date, descripción).
- **Alertas**: `AlertListPage`, `AlertPreviewDrawer`, `ImportToCaseDrawer`, `MergeAlertDrawer`.
- **Dashboards**: `DashboardListPage`, `DashboardViewPage`, `WidgetRenderer` (stats cases/alerts/observables/TTPs).
- **Knowledge Base**: lista de páginas, editor markdown, plantillas.
- **Administración**: organizaciones, usuarios, perfiles, custom fields, tipos de observable, estados, plantillas, taxonomías, ATT&CK, license/estado, branding, auth, SMTP, endpoints, conectores.
- **Ajustes**: perfil, contraseña, MFA, API keys, tema, organización por defecto.

### Estado y datos

- TanStack Query con claves `['cases', orgId, filters]`, `['case', id]`, etc.
- Invalidación por mutaciones; optimistic updates en flags/estado.
- `useOrganisation()` lee `X-Organisation` y refresca queries al cambiar.
- Permisos: `usePermissions()` + componente `<Can permission="...">`.

### Design tokens

- Fuente: Nunito Sans (o Source Sans Pro como fallback).
- Header `#1b1b34`; primario `#54c1c2`; fondos `#f5f7fa`; texto `#262626`; borde `#e5e7eb`.
- Radios 4–8 px; tablas 13 px; badges pill; sombras suaves.
- Modo claro inicial; modo oscuro fase posterior (TheHive 6 tiene selector de tema).

---

## 6. Seguridad

- Aislamiento por organización en todas las queries (nunca confiar en el cliente).
- Contraseñas Argon2id; API keys `mh_...` hasheadas con SHA-256 y prefijo visible.
- Rate limiting en login y API.
- Validación Zod en el backend; nunca ejecutar markdown/HTML sin sanitizar.
- Subida de archivos: límite de tamaño, MIME real, hash SHA-256, almacenamiento fuera del webroot, descarga autenticada.
- Auditoría de acciones sensibles.
- CSP, HSTS, cookies `HttpOnly/Secure/SameSite=Lax`.
- Secretos en variables de entorno; nunca en el repo.
- Licencia AGPL: si se copia código de TheHive 4, el proyecto derivado debe publicarse bajo AGPL y conservar avisos. Si se reimplementa desde cero, se puede elegir otra licencia (recomendado MIT/Apache-2.0 para el código propio, revisando marcas).

---

## 7. Fases de implementación

### Fase 0 — Scaffold (1–2 días)

- Monorepo pnpm/turbo, lint, prettier, tsconfig, Docker Compose.
- `apps/api` NestJS + Prisma + PostgreSQL + Swagger.
- `apps/web` React + Vite + AntD + router + layout shell.
- Autenticación básica y `/health`.
- Criterio: login, shell, DB migrada, CI verde.

### Fase 1 — Identidad y tenancy (3–5 días)

- Users, sessions, API keys, organisations, organisation_users, profiles/permisos, shares base.
- Login/logout/refresh, `me`, cambio de organización, admin de usuarios/perfiles.
- Criterio: multi-org, permisos efectivos, auditoría de login.

### Fase 2 — Casos, tareas, observables (1–2 semanas)

- CRUD de casos, numeración, estados, severidad/TLP/PAP, tags, custom fields.
- Tareas, logs, action required.
- Observables, dedupe, flags, reports simulados.
- TTPs y comentarios.
- UI: lista, creación, detalle, tabs.
- Criterio: flujo completo de caso con tareas/observables/TTPs/comentarios y permisos.

### Fase 3 — Alertas y plantillas (1 semana)

- Alertas, estados, importar a caso, merge, follow/read, observables/TTPs.
- Case templates, aplicación a casos.
- Criterio: alerta → caso con observables/TTPs precargados.

### Fase 4 — Dashboards, knowledge base y reportes (1 semana)

- Dashboards y widgets; páginas y plantillas; reportes de caso.
- Criterio: dashboard con métricas reales y páginas CRUD.

### Fase 5 — Administración completa (1 semana)

- Custom fields, tipos de observable, estados, taxonomías, ATT&CK, SLA, branding, auth/SMTP/LDAP, endpoints, auditoría.
- Criterio: paridad de administración con la referencia.

### Fase 6 — Integraciones y automatización (posterior)

- Cortex/MISP, email intake, notificaciones, functions, jobs, Flow.
- Export/import, API keys de servicio, webhooks.

---

## 8. Criterios de aceptación del MVP

- Un usuario puede iniciar sesión, cambiar de organización y ver solo lo permitido.
- Crear caso con título, descripción, severidad, TLP/PAP, tags, plantilla y tareas.
- Añadir tareas, logs con markdown, observables con IOC/sighted, TTPs y comentarios.
- Cerrar/reabrir/mergear casos y registrar resolución/impacto.
- Crear alerta, importarla a caso y mergearla.
- Listar/filtrar/ordenar/paginar casos, alertas, tareas y observables.
- Administrar usuarios, perfiles, custom fields y estados.
- Dashboard con métricas básicas.
- API documentada en Swagger; tests de integración de permisos y aislamiento por org.

---

## 9. Riesgos y decisiones abiertas

- **Alcance:** paridad total con TheHive 6 es enorme; el MVP debe priorizar casos/tareas/observables/alertas.
- **Búsqueda:** PostgreSQL basta al inicio; OpenSearch si se necesita búsqueda avanzada.
- **Adjuntos:** MinIO local en dev; S3 en prod.
- **Licencia:** decidir licencia del clon antes de reutilizar cualquier código AGPL.
- **Branding:** crear identidad propia (“Nuestracolmena” u otra), no reutilizar logo/marca de StrangeBee.
- **Automatización:** Functions/Flow se dejan para fase 6; no bloquear el MVP.
