# Análisis del frontend de TheHive 4.1.24

**Alcance:** `reference/thehive4/frontend` (SPA AngularJS, AGPL-3.0, versión `4.1.24-1`). Análisis estático de código; no se modificó el repositorio. Las rutas citadas son relativas a `frontend/`.

**Stack observado:** AngularJS 1.7.8, `angular-ui-router` 0.4.3, Bootstrap 3, AdminLTE 2.3.3, Font Awesome 4.7, C3/D3, `ng-tags-input`, `ui-bootstrap` 2.5, `marked`/`hljs`, `angular-drag-and-drop-lists` (`bower.json:4-57`). Build con Grunt/usemin/ngtemplates (`Gruntfile.js:250-340`, `465-475`); `index.html` usa bloques `build:css/js` (`app/index.html:18-58`, `69-355`).

---

## 1. Arquitectura del frontend y mapa de rutas

### 1.1 Arranque y composición

- `ng-app="thehive"` en `app/index.html:2` y `ui-view` raíz en `app/index.html:65-67`; el estado abstracto `app` carga `views/app.html` (`app/scripts/app.js:86-124`).
- `views/app.html:1` solo instancia `<app-container>`; su plantilla pinta el `<header>` (la directiva `header` sustituye ese elemento por el navbar), el `ui-view` interno y el footer (`app/views/components/app-container.component.html:1-15`, `app/scripts/components/header.component.js:4-8`).
- El sidebar izquierdo está explícitamente comentado (`app/views/components/app-container.component.html:2`): la navegación principal es una **navbar superior**, no el sidebar clásico de AdminLTE. El layout usa `body.skin-blue.layout-top-nav` (`app/index.html:65`).
- `RootCtrl` inicializa el stream por polling, la monitorización de conectores MISP/Cortex cada 60 s, los contadores de tareas/alertas y la caché de custom fields (`app/scripts/controllers/RootCtrl.js:28-110`, `139-143`). `StreamSrv.init()` se lanza al entrar al shell (`:28`).
- Resolves globales del estado `app`: `currentUser` (`/api/v1/user/current`), `appConfig` (`/api/status`), `appLayout` (localStorage), `uiConfig` y `taxonomyCache` (`app/scripts/app.js:96-124`).

### 1.2 Mapa de rutas (URL → vista → controlador → API)

| URL (ui-router) | Vista | Controlador | API / operaciones principales |
|---|---|---|---|
| `/login` | `views/login.html` | `AuthenticationCtrl` | `POST /api/login`, `GET /api/status`, `GET /api/v1/user/current` (`AuthenticationSrv.js:8-55`) |
| `/live` | `views/partials/live.html` | `LiveCtrl` | `POST /api/stream` + `GET /api/stream/:id` (`StreamSrv.js:165-175`; `app.js:74-79`) |
| `/maintenance` | `views/maintenance.html` | `MigrationCtrl` | `POST /api/maintenance/migrate` (`MigrationCtrl.js:37-49`) |
| `/` (abstract) | `views/app.html` | `RootCtrl` | usuario actual, status, UI config, taxonomías (`app.js:86-124`) |
| `/index` | redirección | — | `AuthenticationSrv.getHomePage()` (`app.js:125-130`) |
| `/main/:viewId` | `main/list.html` | `MainPageCtrl` | Query v1 `currentUser/tasks` o `waitingTasks` (`MainPageCtrl.js:18-23`, `55-67`) |
| `/cases` | `case/case.list.html` | `CaseListCtrl` | Query v1 `listCase`, `countCase` (`CaseListCtrl.js:71-89`) |
| `/search?q` | `search/list.html` | `SearchCtrl` | `POST /api/v1/query` vía `PSearchSrv` (`SearchCtrl.js:120-150`) |
| `/settings` | `personal-settings.html` | `SettingsCtrl` | `/api/v1/user/:id`, password, API key, MFA (`SettingsCtrl.js:4-27`) |
| `/administration/platform` | `admin/platform/status.html` | `PlatformStatusCtrl` | `/api/v1/admin/index/*`, `/api/v1/admin/check/*` (`PlatformSrv.js:7-23`) |
| `/administration/profiles` | `admin/profile/list.html` | `ProfileListCtrl` | `/api/profile` (`ProfileSrv.js:72-99`) |
| `/administration/taxonomies` | `admin/taxonomy/list.html` | `TaxonomyListCtrl` | `/api/v1/taxonomy/*` (`TaxonomySrv.js:5-42`) |
| `/administration/attack-patterns` | `admin/attack/list.html` | `AttackPatternListCtrl` | `/api/v1/pattern/*` (`AttackPatternSrv.js:7`) |
| `/administration/organisations` | `admin/organisation/list.html` | `OrgListCtrl` | `/api/organisation` (`OrganisationSrv.js:6-46`) |
| `/administration/organisations/:organisation/details` | `admin/organisation/details.html` | `OrgDetailsCtrl` | org + usuarios + case templates + UI config (`app.js:283-305`) |
| `/administration/analyzer-templates` | `admin/analyzer-templates.html` | `AdminAnalyzerTemplatesCtrl` | `/api/analyzer` + templates (`AdminAnalyzerTemplatesCtrl.js:11-176`) |
| `/administration/custom-fields` | `admin/custom-fields.html` | `AdminCustomFieldsCtrl` | `/api/customField` (`CustomFieldsSrv.js:10-36`) |
| `/administration/observables` | `admin/observables.html` | `AdminObservablesCtrl` | `/api/observable/type` (`ObservableTypeSrv.js:6-36`) |
| `/case/:caseId` (abstract) | `views/app.case.html` | `CaseMainCtrl` | Query v1 `getCase` + stats (`app.js:361-385`) |
| `/case/:caseId/details` | `case/case.details.html` | `CaseDetailsCtrl` | `PATCH /api/case/:id`, adjuntos (`CaseDetailsCtrl.js:8-30`) |
| `/case/:caseId/tasks` | `case/case.tasks.html` | `CaseTasksCtrl` | Query v1 `getCase/tasks` (`CaseTasksCtrl.js:55-82`) |
| `/case/:caseId/tasks/:itemId` | `case/case.tasks.item.html` | `CaseTasksItemCtrl` | Query v1 `getTask/logs` + `PATCH /api/case/.../task/:id` (`CaseTasksItemCtrl.js:41-78`) |
| `/case/:caseId/observables` | `case/case.observables.html` | `CaseObservablesCtrl` | Query v1 + `/api/case/artifact/*` (`CaseObservablesCtrl.js:67-91`) |
| `/case/:caseId/observables/:itemId` | `case/case.observables.item.html` | `CaseObservablesItemCtrl` | `GET /api/case/artifact/:id`, jobs (`CaseObservablesItemCtrl.js:6-84`) |
| `/case/:caseId/procedures` | `case/case.procedures.html` | `CaseProceduresCtrl` | TTPs (`ProcedureSrv`) (`app.js:528-539`) |
| `/case/:caseId/links` | `case/case.links.html` | `CaseLinksCtrl` | enlace de casos (`app.js:408-415`) |
| `/case/:caseId/sharing` | `case/case.sharing.html` | `CaseSharingCtrl` | `/api/case/:id/shares` (`CaseSrv.js:106-123`) |
| `/case/:caseId/alerts` | `case/case.alerts.html` | `CaseAlertsCtrl` | Query v1 `alerts` (`CaseSrv.js:47-61`) |
| `/alert/list` | `alert/list.html` | `AlertListCtrl` | Query v1 `listAlert` + `/api/alert/*` (`AlertingSrv.js:127-212`) |
| `/dashboards` | `dashboard/list.html` | `DashboardsCtrl` | `/api/dashboard` (v0/v1) (`DashboardSrv.js:4`, `171-202`) |
| `/dashboards/:id` | `dashboard/view.html` | `DashboardViewCtrl` | `GET /api/dashboard/:id` + metadata |

### 1.3 Guards, redirecciones y errores

- Cada estado declara `guard` con `permissions` o `isSuperAdmin`; `$stateChangeSuccess` cancela la navegación y vuelve a `app.index` si no se cumple (`app/scripts/app.js:698-726`). Esto es solo UX: la autorización real está en backend.
- `app.index` deriva al home según rol: admin → administración; resto → `app.cases` (`AuthenticationSrv.js:59-83`).
- `$stateChangeError` con 401 redirige a `login` (`app.js:733-739`); `NotificationSrv.error` también manda a login (401) o a mantenimiento (520) (`NotificationSrv.js:15-25`).
- El estado `attack-patterns` tiene el guard **comentado** (`app.js:253-267`), por lo que la visibilidad depende del menú y del backend.
- El interceptor XSRF usa `THEHIVE-XSRF-TOKEN` / `X-THEHIVE-XSRF-TOKEN` y mantiene un contador global `$rootScope.async` para el spinner de la navbar (`app.js:599-626`, `views/components/header.component.html:57-61`).

---

## 2. Inventario de pantallas

| Sección | Pantallas / estados | Componente principal |
|---|---|---|
| Autenticación | Login clásico, MFA, SSO | `views/login.html`, `AuthenticationCtrl` |
| Shell | Navbar global, menú Admin, menú usuario, footer, indicador async | `header.component.html`, `app-container.component.html` |
| Casos | Lista, creación (vacía o desde plantilla), detalle, tabs dinámicos, tareas, tarea, observables, observable, TTPs, casos relacionados, alertas relacionadas, sharing | `case/*`, `CaseTabsSrv` |
| Alertas | Lista, preview, importación a caso, merge a caso, similitud | `alert/list.html`, `event.dialog.html` |
| Trabajo personal | My tasks, Waiting tasks | `main/list.html` |
| Búsqueda global | Scope por entidad + filtros + resultados | `search/list.html`, `SearchCtrl` |
| Dashboards | Lista, creación/edición, vista, modo edición drag&drop, export/import | `dashboard/*` |
| Administración | Organizaciones, usuarios, perfiles, custom fields, tipos de observable, analyzer templates, taxonomías, ATT&CK, plataforma | `partials/admin/*` |
| Ajustes / About | Perfil propio, password, API key, MFA; About | `personal-settings.html`, `about.html` |
| Auxiliares | Live feed, mantenimiento/migración, AFK | `live.html`, `maintenance.html`, `afk-modal.html` |

---

## 3. Análisis por pantalla

Convenciones transversales: listas con `datalist-header` (spinner de conteo, “X of Y”), `psearch` (paginación superior/inferior), `page-sizer` (10/15/30/100), estados vacíos `.empty-message` (“No records”), errores vía `NotificationSrv`, permisos con `if-permission`/`allowed`. `FilteringSrv` persiste filtros, orden y tamaño de página en `localStorage` por sección (`FilteringSrv.js:16-45`, `125-127`).

### 3.1 Login — `/login`

- **Propósito:** autenticación local, MFA opcional y SSO.
- **Layout:** caja centrada `.login-box`, logo, formulario, versión; alerta de esquema de BD si `schemaStatus` falla (`views/login.html:1-8`, `10-58`).
- **Campos:** login, password, código MFA condicional (`params.requireMfa`), botón “Sign In”, enlace SSO (`login.html:18-46`).
- **Acciones:** `AuthenticationSrv.login` normaliza usuario a minúsculas; 402 activa MFA, 520 avisa, otros errores notifican (`AuthenticationCtrl.js:29-48`).
- **Permisos/errores:** sin guard; errores de schema visibles; SSO depende de `appConfig.config.authType.indexOf("oauth2")` (`AuthenticationCtrl.js:20-22`).

### 3.2 Shell / navbar

- **Propósito:** navegación y contexto global.
- **Layout:** navbar fija; marca, “New Case”, My tasks, Waiting tasks, Alerts con badges en vivo, Dashboards, Search; a la derecha buscador por CaseId, menú Admin (solo superadmin), acceso a Organización, menú de usuario (Settings/About/Logout) y switch de organización si hay >1 (`header.component.html:9-167`).
- **Contadores:** `myCurrentTasksCount`, `waitingTasksCount`, `unreadAlertCount` vía `StreamQuerySrv` (`RootCtrl.js:57-110`).
- **Permisos:** “New Case” exige `manageCase`; ítems Admin con `if-permission` múltiple; usuario normal ve Organización con `manageUser,manageCaseTemplate` (`header.component.html:20`, `82-134`, `135-140`).
- **Estados:** navbar oculta en `/live` (`hideStatusBar`), spinner async, sin estados vacíos.

### 3.3 Casos — lista `/cases`

- **Propósito:** bandeja principal de investigaciones.
- **Layout:** `box` con header, toolbar multilínea, panel de stats plegable, panel de filtros plegable, chips de filtros activos, tabla y flow lateral opcional (`case.list.html:1-38`).
- **Columnas:** barra TLP clicable, checkbox, Status + duración, `# Number - Title` + tags + custom fields + cierre/merge, sharing, severidad, Details (Tasks/Observables/TTPs con progreso), Assignee, fechas S/C/U, acciones Cortex (`case.list.html:41-140`, `150-309`).
- **Filtros/acciones:** filtros por campo+tipo (`filters.html:3-35`), quick filters (open/closed, míos, mi organización, compartidos), sort, bulk edit/flag/reopen/close/delete, page size, stats, custom fields (`list/toolbar.html:1-105`).
- **Estado:** vacío “No records”; `datalist-header` muestra fetching/counting; error de carga notificado. La selección respeta permisos por caso y `manageCase` (`CaseListCtrl.js:127-136`).
- **Datos:** `PaginatedQuerySrv` con stream en vivo (`CaseListCtrl.js:71-89`); conteo global `countCase` (`CaseListCtrl.js:50-67`).

### 3.4 Casos — creación (modal)

- **Propósito:** crear caso vacío o desde Case Template.
- **Layout:** modal grande, header azul, secciones “Case details” y “Case tasks”, footer con campos obligatorios (`case.creation.html:1-155`).
- **Campos:** título (con prefijo de plantilla si aplica), fecha/hora, severidad L/M/H/C, TLP, PAP, tags con autocompletado y biblioteca, descripción obligatoria, tareas (lista o desde plantilla) (`case.creation.html:8-153`).
- **Acciones:** añadir/quitar tareas, crear caso, cancelar. La plantilla rellena descripción, TLP, PAP, severidad, tags y tareas; el caso vacío crea tareas `Waiting` (`CaseCreationCtrl.js:23-89`).
- **Permisos:** entrada desde navbar `manageCase`; bloque de tareas `manageTask` (`case.creation.html:114-115`).

### 3.5 Caso — shell y tabs

- **Propósito:** contenedor persistente del caso y navegación por subsecciones.
- **Layout:** cabecera de caso (`case.panelinfo.html`) + `uib-tabset`; tabs base Details/Tasks/Observables/TTPs y tabs efímeros (tarea, observable, links, alerts, sharing) que se añaden/eliminan en caliente (`app.case.html:8-52`; `CaseTabsSrv.js:6-105`).
- **Panel de caso:** número/título, icono owner/compartido, creador, fecha de creación, cierre con resolución/impacto, duración, enlaces a casos/alertas relacionados, acciones compartir/responders/MISP/remove/merge/flag/close/reopen (`case.panelinfo.html:1-155`).
- **Permisos:** `canEdit` derivado de `caze.extraData.permissions` (`CaseMainCtrl.js:32-35`); acciones de caso requieren `manageCase` y a menudo `allowed="{{userPermissions}}"`.

### 3.6 Caso — Details

- **Propósito:** información básica y descripción editable inline.
- **Layout:** dos columnas (8/4) + custom fields + descripción + summary + responder jobs + adjuntos (`case.details.html:1-146`).
- **Campos:** título, severidad, TLP, PAP, assignee, fecha, tags, close date (si cerrado), custom fields, descripción Markdown, summary (`case.details.html:6-118`).
- **Acciones:** cada campo usa directivas `updatable-*`; adjuntos abren la tarea de origen o se descargan vía `/api/datastore/...` (`case.details.html:126-146`).
- **Permisos/estados:** `canEdit` alterna edición vs lectura; sin adjuntos/acciones simplemente no se pinta el bloque. Error de actualización notificado.

### 3.7 Caso — Tasks

- **Propósito:** planificación y seguimiento de tareas del caso.
- **Layout:** toolbar (bulk, Add Task, quick filters, page sizer, filtros, vista lista/agrupada), panel de filtros, header de lista, tabla plana o agrupada por `group` (`case.tasks.html:1-260`).
- **Columnas:** checkbox, flags de estado/flag/asignación, grupo editable, título + indicador “Action Required” + duración/“Started”, sharing, fecha, assignee, acciones (delete/start/close/reopen/responders) (`case.tasks.html:63-188`).
- **Formulario inline:** grupo (typeahead) y título; añadir tarea desde `state.isNewTask` (`case.tasks.html:24-44`; `CaseTasksCtrl.js:255-268`).
- **Filtros/acciones:** filtros por campo, quick filters (mías, InProgress, Waiting, Completed, flagged), bulk flag/start/close/reopen/delete, vista agrupada persistida (`tasks/toolbar.html:1-100`).
- **Estado:** “No task found for this case.”; loading/counting por `datalist-header`; permisos `manageTask` + `allowed`.

### 3.8 Caso — Task detail

- **Propósito:** detalle, descripción, logs, adjuntos, sharing y responders de una tarea.
- **Layout:** alerta “Action Required”, cabecera de acciones, dos columnas de metadatos, descripción, editor de logs, timeline y adjuntos (`case.tasks.item.html:1-280`).
- **Campos/acciones:** título, grupo, assignee, start/close date, duración, estado, descripción Markdown; flag, start/close/reopen, “Require Action”, responders, sharing, add log (`:15-226`).
- **Permisos/estados:** `manageTask` para editar, `manageShare` para compartir, `manageAction` para responders; “Not started yet” y “Not specified” como estados vacíos (`:128-171`).

### 3.9 Caso — Observables

- **Propósito:** gestión de IOCs/artefactos del caso.
- **Layout:** toolbar (bulk, Add observable(s), Export, page sizer, filtros, stats), panel de filtros, stats, tabla y panel de exportación CSV/texto (`case.observables.html:1-80`; `list/observables.html:1-150`).
- **Columnas:** checkbox, Flags (TLP/IOC/sighted/seen/similarity), Type, Value/Filename + tags + mini-reportes, sharing, fechas, acciones Cortex (`list/observables.html:22-150`).
- **Formulario de alta:** tipo (dropdown), archivo o valor multi-línea (uno por línea o multilínea), TLP, IOC, sighted, ignore similarity, tags, descripción (`creation/form.html:2-120`). Error de parseo con opción de copiar (`observable.creation.html:5-7`).
- **Acciones:** add, bulk edit, run analyzers, delete, export, responders; `manageObservable`, `manageAnalyse`, `manageAction` (`list/observables.html:1-70`).
- **Estado:** “No records.”; spinner de conteo; `switchTEList` desactiva paginación/checkbox en modo texto.

### 3.10 Caso — Observable detail

- **Propósito:** ficha del observable, análisis, jobs, sharing y similitud.
- **Layout:** cabecera con tipo/valor o adjunto, descarga ZIP protegida, mini-reportes, resumen, responders, analyzers, sharing (`case.observables.item.html:1-46`).
- **Campos:** TLP, hashes, tamaño, fecha, IOC, sighted, ignore similarity, tags, descripción; enlace a casos similares (`details/summary.html:1-180`).
- **Estados/permisos:** “Not Specified”, “This observable has not been seen in any other case”; edición según `canEdit`; acciones Cortex según `manageAction`.

### 3.11 Caso — TTPs / Procedures

- **Propósito:** registro de tácticas, técnicas y procedimientos ATT&CK.
- **Layout:** toolbar (Add TTP, sort, page sizer, filtros), panel de filtros, lista expandible por TTP con color de táctica (`case.procedures.html:1-160`).
- **Campos:** táctica (select), técnica (buscador + radios), fecha de ocurrencia, descripción de procedimiento; en detalle: creador, fechas, occurDate editable, descripción (`procedures/add-procedure.modal.html:1-120`; `case.procedures.html:100-150`).
- **Acciones/permisos:** add/delete/update con `manageProcedure`; filtros por `tactic`/`patternId`/`occurDate`; estado vacío “No records”.

### 3.12 Caso — Links, Alerts y Sharing

- **Links (`/links`):** casos relacionados con chips por estado/resolución, orden por título/fecha/nº de observables, lista de observables enlazados con “Show more” (`case.links.html:1-110`).
- **Alerts (`/alerts`):** alertas relacionadas con chips por tipo/source, tabla (referencia, tipo, título, source, severidad, atributos, fecha), enlace MISP y preview en modal (`case.alerts.html:1-120`; `CaseAlertsCtrl.js:1-103`).
- **Sharing (`/sharing`):** lista de organizaciones y perfiles, “Add share” condicionado a que queden organizaciones, edición inline de perfil y borrado (`case.sharing.html:1-34`; `SharingListCmp`). Modal con organizaciones, perfil, reglas de tasks/observables (`case.share.modal.html:1-80`). Permiso `manageShare`.

### 3.13 Alertas — lista `/alert/list`

- **Propósito:** triaje de eventos/alertas antes de convertirlos en casos.
- **Layout:** `box` con búsqueda, toolbar bulk, stats, filtros, chips y tabla expandible (`alert/list.html:1-150`).
- **Columnas:** checkbox, severidad, Read/Unread, título, # Case (o “None”), tipo, source, reference, observables, fechas O/C/U, acciones (`alert/list.html:36-150`).
- **Filtros:** por campo, quick filters (read/unread, imported, followed/ignored), sort, page size, stats, custom fields (`alert/list/toolbar.html:1-120`).
- **Acciones bulk:** follow/unfollow, mark read/unread, delete, crear caso desde selección o merge en caso; individualmente preview, responders, marcar leído, follow (`AlertListCtrl.js:126-212`, `222-260`, `303-430`).
- **Estados/permisos:** “No records”, conteo global `alertCountAll`, `manageAlert` para acciones; el flujo por defecto filtra `imported=false` (`AlertListCtrl.js:26-40`).

### 3.14 Alertas — preview, import y merge

- **Propósito:** revisar el evento y decidir importarlo a un caso nuevo o fusionarlo con uno existente.
- **Layout:** modal `size=max`, cabecera “Alert Preview” con badge New/Imported, metadatos, tags, descripción Markdown, custom fields, tabs Observables/Similar cases, footer de acciones (`event.dialog.html:1-190`).
- **Importación:** selector “Import alert as” con plantillas; opción “-- Empty case --” salvo que la configuración hideEmptyCaseButton lo impida; `POST /api/alert/:id/createCase` (`event.dialog.html:170-186`; `AlertEventCtrl.js:76-92`).
- **Merge:** busca caso por título/número (typeahead), avisa si el caso ya fue mergeado y fusiona con `POST /api/alert/:id/merge/:caseId` (`case.merge.html:1-65`; `CaseMergeModalCtrl.js:20-95`; `AlertingSrv.js:164-176`).
- **Otros estados:** similar cases con filtros locales/paginación cliente y acción de merge por fila; “No records” cuando no hay similitudes (`components/alert/similar-case-list.component.html`). Errores de import/merge notificados y modal cerrado/navegación al caso creado.

### 3.15 My tasks y Waiting tasks — `/main/mytasks`, `/main/waitingtasks`

- **Propósito:** bandeja personal de tareas y bolsa de tareas sin asignar/en espera.
- **Layout:** mismo `main/list.html`; título dinámico, toolbar, filtros, tabla y flow lateral (`main/list.html:1-43`).
- **My tasks:** columnas flags, severidad del caso, grupo, tarea + caso enlazado + “Action Required”, fecha; filtro base `status in [Waiting, InProgress]` y operaciones `currentUser/tasks` (`MainPageCtrl.js:11-23`; `index-mytasks.html:1-60`).
- **Waiting tasks:** columnas flags, severidad, grupo, tarea, acción “Take”; operaciones `waitingTasks`; “Take” actualiza a `InProgress` y abre la entidad (`MainPageCtrl.js:55-67`, `107-121`; `index-waitingtasks.html:1-55`).
- **Estados:** “No records”; sin bulk; permisos implícitos por pertenencia/asignación.

### 3.16 Búsqueda global — `/search`

- **Propósito:** búsqueda transversal por entidad.
- **Layout:** scope de entidades (Cases, Tasks, Task Logs, Observables, Alerts, Jobs), constructor de filtros, resultados heterogéneos y paginación (`search/list.html:1-115`).
- **Filtros:** campo+tipo con `filter-editor`; tipos texto, número, tags, usuario, enumeración, booleano, fecha; operadores any/all/none/empty y rangos de fecha (`dashboard/filter-editor.js:1-90`; `dashboard/filter-editor.html:1-180`).
- **Resultados:** `search-item` con icono, contenido específico por `_type`, breadcrumb de entidad; alertas/observables pueden abrir preview (`search/list.html:96-110`; `SearchCtrl.js:6-16`).
- **Estado/permisos:** “No result found”; configuración persistida con `GlobalSearchSrv`; sin filtros no ejecuta query (`SearchCtrl.js:120-158`). Sin guard específico; cualquier usuario autenticado.

### 3.17 Dashboards — lista y vista

- **Lista:** tabla con status, título/descripción, propietario, fechas y acciones View/Edit/Copy/Export/Delete; toolbar “Create new Dashboard” e “Import Dashboard”; filtros y page sizer (`dashboard/list.html:1-125`; `dashboard/list/toolbar.html:1-20`).
- **Creación/edición:** modal con título, descripción y visibilidad Private/Shared; la visibilidad solo la cambia el creador (`create.dialog.html:1-45`).
- **Vista:** selector de periodo (all, 3 meses, 30/7 días, custom), auto-refresh 1/5/10/15 min, export, modo edición con drag&drop de contenedores y widgets (`dashboard/view.html:1-115`).
- **Widgets:** bar, donut, line, multiline, counter, text; cada uno con editor de filtros y series (`views/directives/dashboard/*`). Toolbox y guardado desde barra lateral flotante (`dashboard/view.html:65-88`).
- **Estados/errores:** lista vacía “No records”; dashboard vacío permite añadir widgets; error 400 en carga resetea el contexto de filtros (`DashboardsCtrl.js:83-113`). Sin guard específico más allá de autenticación.

### 3.18 Administración — Organizaciones y usuarios

- **Lista de organizaciones:** nombre, descripción, organizaciones enlazadas, creador, fechas; acciones Configure/Edit/Link (`admin/organisation/list.html:1-80`). Permiso `manageOrganisation` (`app.js:268-282`).
- **Detalle de organización:** cabecera con nombre/descripción/links y tabs Users, Case Templates, Custom Tags, UI Configuration (`admin/organisation/details.html:1-140`).
- **Usuarios:** tabla con estado Active/Locked, login, nombre, perfil (popover de permisos), password, API key (crear/renovar/revocar/revelar), MFA reset, fechas y acciones (`components/org/user.list.html:1-160`).
- **Formularios:** alta/edición de usuario en modal (`admin/organisation/user.modal.html`); password/MFA condicionados por `canSetPass`/`canChangeMfa` (`OrgDetailsCtrl.js:11-12`). Permisos `manageUser`.
- **Estados:** “No users defined.”, filtros activos/locked, page sizer, notificaciones de error.

### 3.19 Administración — Perfiles

- **Propósito:** definir perfiles y permisos de organización/administración.
- **Layout:** tabla Nombre / Permisos (labels) / acciones; toolbar de creación (`admin/profile/list.html:1-60`).
- **Formulario:** tipo (Administration/Organisation), nombre, permisos multi-select con etiquetas; nombre bloqueado al editar (`profile.modal.html:1-55`).
- **Acciones/permisos:** editar/eliminar; `canDelete` evita perfiles protegidos; ruta requiere `manageProfile` (`ProfileListCtrl.js:18-95`). Estado vacío “No permissions”.

### 3.20 Administración — Custom fields

- **Propósito:** metadatos personalizados de casos.
- **Layout:** tabla Tipo / Nombre / Referencia interna / Descripción / Mandatory / Opciones / Acciones; botón “Add custom field” (`admin/custom-fields.html:1-60`).
- **Formulario:** nombre, referencia única (patrón), descripción, tipo, posibles valores (string/integer/float), “Is mandatory” (`custom-field-dialog.html:1-100`).
- **Permisos/estados:** `manageCustomField`; vacío “No custom fields defined yet”; borrado con confirmación.

### 3.21 Administración — Tipos de observable

- **Propósito:** catálogo de `dataType` disponibles al crear observables.
- **Layout:** formulario de alta y tabla `dataType` / acción (`admin/observables.html:1-45`).
- **Acciones/permisos:** añadir/eliminar tipos, `manageObservableTemplate`; sin estados vacíos explícitos (tabla vacía). El cambio impacta el dropdown de creación de observables.

### 3.22 Administración — Analyzer templates

- **Propósito:** gestionar plantillas de reporte de analyzers Cortex.
- **Layout:** aviso de descarga de plantillas oficiales, tabla Nombre / Long template, botones View/Delete/Default, “Import templates” (`admin/analyzer-templates.html:1-55`).
- **Permisos/estados:** `manageAnalyzerTemplate`; resolve exige Cortex habilitado (`app.js:306-332`); vacío “No analyzer templates found.”; import vía modal y ZIP (`AdminAnalyzerTemplatesCtrl.js:109-180`).

### 3.23 Administración — Taxonomías

- **Propósito:** catálogos de etiquetas (MITRE, etc.).
- **Layout:** tabla con indicador enabled, namespace, descripción, versión, nº tags y acciones enable/disable, ver, borrar; toolbar de importación (`admin/taxonomy/list.html:1-80`).
- **Estados/permisos:** “loading taxonomies...”, “No taxnomies found.” [sic], error notificado; `manageTaxonomy` (`app.js:238-252`).

### 3.24 Administración — ATT&CK patterns

- **Propósito:** consulta/importación de patrones ATT&CK usados por TTPs.
- **Layout:** tabla ID, Name, Sub-Technique of, Tactics, Description, acciones external link / show (`admin/attack/list.html:1-100`).
- **Estados/permisos:** “loading patterns...”, “No ATT&CK patterns found.”, import modal; guard comentado, pero el ítem de menú usa `managePattern` (`header.component.html:118-123`; `app.js:253-267`).

### 3.25 Administración — Platform status

- **Propósito:** salud de la plataforma e índices.
- **Layout:** botón “Export status report”, schema status, data index status con reindex/rebuild, database integrity check con “Trigger” (`admin/platform/status.html:1-120`).
- **Acciones/permisos:** `managePlatform`; exporta informe; reindex/rebuild/check con confirmación (`PlatformStatusCtrl.js:16-115`). Estados “Loading index status...” y “Loading data health stats...”.

### 3.26 Ajustes de usuario — `/settings`

- **Propósito:** perfil propio, contraseña, API key y MFA.
- **Layout:** columna centrada, cuatro `box`: información básica, password, API key, MFA (`personal-settings.html:1-250`).
- **Campos/acciones:** nombre completo, avatar (máx. 500 KB, recomendado 100×100), perfil/permisos; cambio de password con confirmación; API key Renew/Reveal/Copy; MFA con QR + secreto + código (`personal-settings.html:11-245`).
- **Permisos/estados:** capacidades del backend (`changePassword`, `authByKey`, `mfa`) controlan la visibilidad (`SettingsCtrl.js:25-27`); errores de formulario inline y notificaciones; avatar vacío y “You don't have any API key.” como estados.

### 3.27 About

- **Propósito:** versiones de módulos y estado de conectores.
- **Layout:** modal con logo, tabla módulo/versión, conectores MISP/Cortex habilitados con servidor, versión y estado, licencia AGPL (`about.html:1-36`).
- **Errores:** `VersionSrv.get()` fallido se notifica; se abre desde el menú de usuario (`RootCtrl.js:253-260`).

### 3.28 Live feed y mantenimiento

- **Live:** ventana/panel con logo, badge LIVE y `<flow>`; abre en ventana emergente desde “Open in new window” (`live.html:1-15`; `AppLayoutSrv.js:52-55`).
- **Mantenimiento:** aviso “TheHive needs to update its database”, migración con barras de progreso por tabla vía stream, y formulario de creación de administrador inicial si no hay usuarios (`maintenance.html:1-75`; `MigrationCtrl.js:9-70`).

---

## 4. Componentes UI reutilizables y patrones de interacción

- **Edición inline:** familia `updatable*` (`updatable-simple-text`, `updatable-text`, `updatable-date`, `updatable-user`, `updatable-select`, `updatable-tag(s)`, `updatable-colour`, `updatable-boolean`) con estados waiting/success/failure (`scripts/directives/updatable*.js`; `styles/updatable.css`). Se usa en detalles de caso/tarea/observable y en administración.
- **Etiquetas y marcadores:** `tlp` (WHITE/GREEN/AMBER/RED), `severity` (L/M/H/C), `tag-item`/`tag-list`, `tag-colour`, `task-progress`, `case-duration`, `alert-duration`, `entity-link`, `user`, `user-info` (`scripts/directives/*`).
- **Listas:** `datalist-header` (título + conteo + spinner), `psearch` (paginación), `page-sizer`, `filters-preview` (chips de filtros), `filter-editor` (editor por tipo), `stats-item` (mini-charts clicables) (`components/common`, `components/list`, `components/search`).
- **Entidades compartidas:** `observable-flags`, `task-flags`, `custom-field-labels`, `custom-field-input`, `sharing-list`, `task-sharing-list`, `responder-actions`, `mini-report-list` (`scripts/components/*`).
- **Patrones de interacción:** bulk selection con menú contextual; quick filters; click en cualquier celda semántica añade filtro (status, tags, TLP, severidad, fechas); “Add a filter” + “Search”; tablas con orden por columna; modales de confirmación (`ModalUtilsSrv.confirm`); toasts (`NotificationSrv`); actualización en vivo por stream que refresca listas y contadores.
- **Persistencia local:** `localStorage` prefijado `th4` (`app.js:628-634`): contexto de filtros por sección y layout (`showFlow`, columnas de custom fields, agrupación de tareas) (`FilteringSrv.js:16-45`; `AppLayoutSrv.js:7-35`).
- **Formularios:** Angular forms + `ngMessages`; asterisco rojo para obligatorios, `help-block` para errores, botones deshabilitados con `$invalid`; modales con header `bg-primary` y footer Cancel/Save.
- **Accesibilidad/UX observada:** tooltips en iconos, `sr-only` en el toggle de navbar, foco automático en algunos campos, pero iconos sin `aria-label` en la mayoría de acciones y tablas sin `scope` explícito (deuda técnica).

---

## 5. Design system observado

- **Base visual:** Bootstrap 3 + AdminLTE 2.3.3 (skin azul) y Font Awesome 4.7; `body` con `skin-blue layout-top-nav` (`app/index.html:65`). La tipografía declarada por AdminLTE es `Source Sans Pro` (`styles/vendors/AdminLTE.css:24`) y se carga Roboto como recurso adicional (`app/index.html:25`), aunque el uso efectivo es mixto.
- **Colores:** fondo de app `#ecf0f5` (`styles/main.css:1`; `styles/vendors/AdminLTE.css:99`); primario `#3c8dbc`, hover/oscuro `#367fa9` (`AdminLTE-skin-blue.css:6`, `32`); navbar `bg-navy`; texto principal `#333` (`main.css:91-93`).
- **TLP:** WHITE `#5BC0CE`, GREEN `#5CB85C`, AMBER `#F0AD4E`, RED `#D9534F`; clases `bg-tlp-*`, `text-tlp-*`, `border-left-tlp-*` (`styles/main.css:412-471`). El componente `tlp` usa `label-info/success/warning/danger` (`views/directives/tlp.html`).
- **Severidad:** L=`label-info`, M=`label-warning`, H=`label-danger`, C=`label-critical` (`views/directives/severity.html`); TLP/PAP comparten el mismo widget con `namespace` (`tlp.js:4-18`).
- **Tipografía/escala:** títulos de `box` ~18 px, metadatos 12-13 px, labels de tabla 12 px; mucho texto secundario en `text-muted` (`styles/main.css:562-631`; `styles/case.css:73-80`).
- **Espaciado:** utilidades tipo `mt-xs`, `mv-s`, `vpad10`, `hpad5`, `p-0`, `flexwrap` procedentes de `css-spaces` (`app/index.html:26`); contenedor principal con `padding-top: 80px` para compensar la navbar fija (`main.css:60-62`).
- **Estructura visual:** navbar fija superior; `container-fluid`; cajas AdminLTE (`box`, `box-header`, `box-body`, `box-tools`); tablas `table-striped table-hover`; formularios `form-horizontal`; modales con cabecera azul; footer con versión y logos de conectores (`app-container.component.html:17-39`).
- **Iconografía:** Font Awesome (`fa fa-*`) y Glyphicons (`glyphicon glyphicon-*`) conviven; iconos semánticos: carpeta=caso, tareas, pushpin=observable, knight=TTP, users=sharing, cog=responders/Cortex, flag, star=IOC, eye=sighted/seen, link=relaciones.
- **Estados visuales:** `.empty-message` fondo gris, texto 18 px; `.loading-message` equivalente; spinners `fa-circle-o-notch fa-spin`/`fa-spinner fa-pulse` (`main.css:72-86`); `tr-warning` para flags; `text-disabled` para acciones inactivas.
- **Densidad:** tablas muy densas, acciones como iconos, una sola columna principal y panel de flujo lateral de 3 columnas; en desktop convive la lista con el live stream (`app.case.html:59-79`; `case.list.html:315-350`).

---

## 6. Flujos clave paso a paso

1. **Arranque y autenticación.** `app` resuelve usuario actual (`/api/v1/user/current`), configuración (`/api/status`), layout y taxonomías; si no hay usuario, `RootCtrl` redirige a `login` y `AuthenticationCtrl` hace `POST /api/login`; con 402 muestra MFA y reintenta; con éxito `app.index` deriva al home según permisos (`app.js:96-130`; `AuthenticationCtrl.js:29-48`; `AuthenticationSrv.js:59-83`).
2. **Crear caso.** “New Case” abre selector de plantilla si hay templates; “Empty Case” o plantilla abre el modal de creación; se completan título, fecha, severidad, TLP/PAP, tags, descripción y tareas; se hace `POST /api/case` y se navega a `app.case.details` (`RootCtrl.js:203-250`; `CaseCreationCtrl.js:58-89`).
3. **Ciclo de vida de tarea.** En el caso, “Add Task” crea una tarea `Waiting` con grupo; “Start” la pasa a `InProgress`; al cerrar pasa a `Completed`; se registran logs y adjuntos; el estado se refleja en la lista del caso y en My tasks/Waiting tasks por stream (`CaseTasksCtrl.js:255-330`; `CaseTasksItemCtrl.js:96-160`).
4. **Observables y análisis.** “Add observable(s)” permite alta masiva o archivo; se guardan con TLP/IOC/sighted; desde la lista se ejecutan analyzers o responders (Cortex) y se consultan jobs/reportes; la similitud enlaza con otros casos (`CaseObservablesCtrl.js:217-330`; `CaseObservablesItemCtrl.js:60-180`).
5. **Cierre/merge/export de caso.** “Close” pide resolución e impacto y actualiza el caso; “Merge” busca el caso destino por título/número y fusiona; “Export (MISP)” usa el conector MISP; “Remove” borra con confirmación; “Sharing” añade/elimina organizaciones y perfiles (`CaseMainCtrl.js:163-330`; `CaseMergeModalCtrl.js`; `CaseSharingCtrl.js:40-122`).
6. **Triaje de alertas.** La lista filtra por defecto no importadas; preview (`GET /api/v1/alert/:id`); importar crea caso con plantilla (`POST /api/alert/:id/createCase`) o merge (`POST /api/alert/:id/merge/:caseId`); también se puede marcar leído, seguir, borrar y ejecutar responders; el contador de no leídas se actualiza por stream (`AlertEventCtrl.js:76-145`; `AlertListCtrl.js:126-212`).
7. **Búsqueda.** Se elige entidad, se añaden filtros tipados y se ejecuta `PSearchSrv`; el resultado se pagina y cada tipo se renderiza con su plantilla; la configuración de búsqueda se restaura de localStorage (`SearchCtrl.js:109-158`).
8. **Dashboard.** Se crea con visibilidad Private/Shared; el editor permite arrastrar widgets a filas/columnas, definir filtros y series, elegir periodo y auto-refresh, guardar y exportar el JSON (`DashboardsCtrl.js:122-230`; `DashboardViewCtrl.js:78-171`).
9. **Administración.** Un superadmin gestiona organizaciones, usuarios (password, API key, MFA), perfiles/permisos, custom fields, tipos de observable, plantillas de analyzer, taxonomías y ATT&CK; los cambios se reflejan en formularios y filtros de toda la app (`admin/*`).
10. **Colaboración en vivo.** `StreamSrv` mantiene un stream por sesión; `PaginatedQuerySrv` añade listeners por `objectType` y refresca listas con guardas para evitar updates irrelevantes; `StreamQuerySrv` actualiza contadores de tareas/alertas; el panel Flow muestra la actividad del caso/global (`PaginatedQuerySrv.js:47-58`; `StreamSrv.js:1-120`).

---

## 7. Priorización: MVP vs paridad completa

### 7.1 MVP (núcleo imprescindible)

- **Auth:** login local, sesión, logout, manejo de 401/520, rol superadmin vs usuario de organización (`AuthenticationSrv`, `NotificationSrv`).
- **Shell:** navbar, menús por permiso, contadores básicos, footer de versión.
- **Casos:** lista con filtros/orden/paginación, creación vacía o por plantilla, detalle editable, tareas (CRUD + estados + logs básicos), observables (alta/listado/edición y flags), cierre/reapertura, sharing básico.
- **Alertas:** lista con filtros, preview, import a caso nuevo y merge a caso existente.
- **Trabajo personal:** My tasks y Waiting tasks con “Take”.
- **Búsqueda:** por entidad con filtros tipados y resultados.
- **Administración mínima:** organizaciones/usuarios, perfiles, custom fields, tipos de observable.
- **Ajustes:** perfil, password y About.
- **Estados:** vacío/cargando/error consistentes, permisos por acción y confirmaciones destructivas.

### 7.2 Paridad completa (segunda ola)

- **Casos avanzados:** TTPs/ATT&CK, links entre casos, alertas relacionadas, merge de casos, export MISP, adjuntos, custom fields por columna, plantillas completas y bulk avanzado (flag/close/reopen/delete).
- **Observables avanzados:** análisis Cortex, responders, jobs, reportes, similitud, export CSV/texto, ZIP protegido, ignoreSimilarity/sighted/IOC.
- **Alertas avanzadas:** similar cases con filtros locales, merge masivo, follow/ignore, mark read/unread masivo, responders, filtros por imported.
- **Dashboards:** constructor drag&drop, widgets bar/donut/line/multiline/counter/text, periodos, auto-refresh, export/import, duplicado, visibilidad.
- **Admin completo:** analyzer templates, taxonomías, ATT&CK, platform status (índices, checks, reindex/rebuild), UI config por organización, custom tags, case templates, API keys y MFA por usuario.
- **Tiempo real:** live feed, side panel Flow, actualización por stream y refresco de contadores; AFK/session extension.
- **Detalles de UX:** SSO, avatar, MFA de usuario, notificaciones de conectores MISP/Cortex, mantenimiento/migración, switch de organización, persistencia de layout/filtros.

### 7.3 Deuda y riesgos observados

- **AngularJS 1.7 + ui-router 0.4** y Bower: alto coste de mantenimiento/seguridad; migrar a framework moderno implica reescribir rutas, directivas y servicios.
- **Permisos duplicados en cliente y servidor:** el frontend solo oculta; cualquier reimplementación debe mantener autorización real en API y revalidar `extraData.permissions`.
- **Inconsistencias:** guard comentado en ATT&CK (`app.js:253-267`), typo “No taxnomies found.” (`admin/taxonomy/list.html`), mezcla Font Awesome/Glyphicons, `header` como directiva que sustituye un `<header>` vacío.
- **Rendimiento:** muchas listas renderizan tablas completas y escuchan streams; conviene paginación server-side, virtualización y cancelación de listeners al salir.
- **Accesibilidad:** iconos sin etiquetas, foco y contraste mejorables; formularios con `help-block` pero sin `aria-describedby` sistemático.

---

## 8. Conclusión

El frontend de TheHive 4.1.24 es una SPA AngularJS clásica, muy orientada a tablas densas y edición inline, con un shell de navbar superior, un motor de filtros tipados reutilizable y actualización en tiempo real por stream. Su valor diferencial está en la riqueza funcional del triaje (casos/tareas/observables/alertas/similitud) y en la administración multi-organización. Para un MVP conviene reproducir primero el eje casos-tareas-observables-alertas-búsqueda con permisos y estados consistentes; el resto (dashboards, ATT&CK, taxonomías, Cortex/MISP, platform status) puede abordarse después sin comprometer el modelo de datos ni la navegación.
