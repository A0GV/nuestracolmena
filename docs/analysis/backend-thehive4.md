# Dossier técnico del backend de TheHive 4.1.24

**Fuente analizada:** `~/reference/thehive4` (sin modificaciones).
**Versión:** `4.1.24-1` (`build.sbt:5`).
**Licencia:** AGPL-3.0 (`LICENSE:1`, `README.md:107`).
**Objetivo:** especificación funcional para una reimplementación limpia (dominio, API, permisos), no reutilización de código.

> Nota de alcance: el submódulo `ScalliGraph/` está vacío en este checkout. Por eso el parser exacto de la Query API y la ruta `/api/vN/query` no se pueden leer aquí; se documentan a partir del ejecutor de consultas de TheHive (`controllers/v1/TheHiveQueryExecutor.scala`), de los controladores `QueryableCtrl` y del cliente Angular (`frontend/app/scripts/services/common/QuerySrv.js`). Todo lo demás se cita directamente del código presente.

---

## 1. Resumen de arquitectura

TheHive 4 es una aplicación **Scala + Play Framework** con inyección de dependencias Guice, actores Akka y persistencia en grafo. La cadena de una petición es:

```
HTTP -> TheHiveRouter (SIRD) -> Controller v0/v1 -> Service -> ScalliGraph Traversal -> JanusGraph -> Cassandra + índice (Lucene/Elasticsearch)
                                                       -> AuditSrv -> EventSrv/Akka Streams -> NotificationActor
                                                       -> AttachmentSrv -> StorageSrv (localfs/S3/HDFS/database)
```

Evidencias:

- Router raíz y prefijos: `thehive/app/org/thp/thehive/TheHiveRouter.scala:23-26`. `/api/v1/` va a `v1.Router`, `/api/v0/` a `v0.Router`, `/api/` usa v0 por compatibilidad, `/fs` expone WebDAV y el resto sirve el frontend.
- Módulo de composición: `thehive/app/org/thp/thehive/TheHiveModule.scala:34-107` registra autenticación, base de datos, almacenamiento, routers, ejecutores de consulta, actores de auditoría/notificación y chequeos de integridad.
- Persistencia: `db.provider: janusgraph` (`thehive/conf/reference.conf:1-3`), con backend de índice Lucene por defecto (`:4-7`) y almacenamiento de grafo local (`:8-10`). La configuración de ejemplo permite Cassandra (`storage.backend: cql`) y Elasticsearch (`index.search.backend: elasticsearch`) en `conf/application.sample.conf:10-30`.
- Almacenamiento de adjuntos: `storage.provider: localfs` y directorio (`thehive/conf/reference.conf:17-20`), con implementaciones alternativas seleccionables en `TheHiveModule.scala:70-75`.
- Capas: los controladores no acceden al grafo directamente salvo para transacciones; delegan en servicios (`CaseSrv`, `AlertSrv`, etc.). Los DTO de entrada/salida viven en `dto/src/main/scala/org/thp/thehive/dto/{v0,v1}`.
- Modelo de datos: entidades y aristas se declaran con anotaciones `@BuildVertexEntity` / `@BuildEdgeEntity` en `thehive/app/org/thp/thehive/models/*.scala`; el esquema se autodescubre por reflexión (`TheHiveSchemaDefinition.scala`, `modelList`).
- API dual: **v1** es la API nueva, deliberadamente incompleta, con rutas REST explícitas; **v0** es la API histórica completa, basada en `_search`/`_stats` y usada por el frontend. No hay fichero `routes` de Play: las rutas se declaran en Scala con SIRD (`Router.scala` de cada versión).

---

## 2. Modelo de dominio

### 2.1 Convenciones comunes

Todas las entidades heredan metadatos de ScalliGraph: `_id`, `_label`, `_createdBy`, `_createdAt`, `_updatedBy`, `_updatedAt`. Los DTO v1 los exponen como `_id`, `_type`, `_createdBy`, `_createdAt`, etc. (`dto/.../v1/Case.scala:29-50`). Las relaciones se modelan como vértices-arista en el grafo, no como claves foráneas.

Tipos de valor habituales:

- `tlp` y `pap`: entero 0-3; por defecto 2 (`controllers/v1/Conversion.scala:76-80`, `:112-118`).
- `severity`: entero 1-4; por defecto 2 (`Conversion.scala:75-79`, `:111-116`).
- `tags`: `Seq[String]` denormalizada en la entidad y sincronizada con aristas `*Tag`.

### 2.2 Case

Definición: `thehive/app/org/thp/thehive/models/Case.scala:101-121`.

| Campo | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `title` | String | sí | índice fulltext |
| `description` | String | sí | fulltext-only |
| `severity` | Int | sí | 1-4 |
| `startDate` | Date | sí | |
| `endDate` | Option[Date] | no | se fija al cerrar |
| `flag` | Boolean | sí | |
| `tlp` | Int | sí | 0-3 |
| `pap` | Int | sí | 0-3 |
| `status` | `CaseStatus` | sí | `Open`, `Resolved`, `Duplicated` (`Case.scala:10-14`) |
| `summary` | Option[String] | no | fulltext-only |
| `tags` | Seq[String] | sí | lista denormalizada |
| `impactStatus` | Option[String] | no | `NoImpact`, `WithImpact`, `NotApplicable` (`Case.scala:39-48`) |
| `resolutionStatus` | Option[String] | no | `Indeterminate`, `FalsePositive`, `TruePositive`, `Other`, `Duplicated` (`Case.scala:20-29`) |
| `assignee` | Option[String] | no | login; rellenado por servicio |
| `number` | Int | sí | único, generado por actor |
| `organisationIds` | Set[EntityId] | sí | organizaciones con visibilidad |
| `caseTemplate` | Option[String] | no | nombre de plantilla origen |
| `owningOrganisation` | EntityId | sí | organización propietaria |

Relaciones (aristas declaradas en `Case.scala:31-83`):

- `CaseTag` (N-M con Tag), `CaseUser` (asignado), `CaseCaseTemplate` (plantilla), `CaseCustomField` (N-M con valores tipados), `CaseImpactStatus`, `CaseResolutionStatus`, `MergedFrom` (caso→caso), `CaseProcedure` (N-M con Procedure/TTP).
- `ShareCase` conecta el caso con `Share` (visibilidad multi-organización).
- `AlertCase` conecta alertas importadas.

Permiso: `manageCase` (`Permissions.scala:11`). La visibilidad se filtra por `organisationIds` y sharing (`CaseSrv.scala:512-527`).

### 2.3 Alert

Definición: `models/Alert.scala:57-75`.

| Campo | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `type` | String | sí | p. ej. `misp`, `siem` |
| `source` | String | sí | origen |
| `sourceRef` | String | sí | referencia en el origen |
| `externalLink` | Option[String] | no | enlace externo |
| `title` | String | sí | fulltext |
| `description` | String | sí | fulltext-only |
| `severity` | Int | sí | |
| `date` | Date | sí | fecha del evento |
| `lastSyncDate` | Date | sí | última sincronización |
| `tlp` / `pap` | Int | sí | |
| `read` | Boolean | sí | leída/ignorada |
| `follow` | Boolean | sí | seguimiento |
| `tags` | Seq[String] | sí | |
| `organisationId` | EntityId | sí | una única organización |
| `caseId` | EntityId | sí (vacío si no importada) | optimización de índice |

Índice único por `(type, source, sourceRef, organisationId)` (`Alert.scala:41`), aunque el esquema 4.1.15 elimina ese índice físico y la unicidad se valida en servicio (`AlertSrv.scala:78-80`, `TheHiveSchemaDefinition.scala` release 4.1.15).

Relaciones: `AlertCustomField`, `AlertObservable`, `AlertOrganisation`, `AlertCase`, `AlertCaseTemplate`, `AlertTag` (`Alert.scala:8-38`).

Estado funcional derivado (no persistido): `New` (no leída, sin caso), `Updated` (no leída, con caso), `Ignored` (leída, sin caso), `Imported` (leída, con caso) (`controllers/v0/AlertCtrl.scala:377-391`).

Permiso: `manageAlert`.

### 2.4 Task

Definición: `models/Task.scala:33-47`.

| Campo | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `title` | String | sí | fulltext |
| `group` | String | sí | por defecto `default` |
| `description` | Option[String] | no | fulltext-only |
| `status` | `TaskStatus` | sí | `Waiting`, `InProgress`, `Completed`, `Cancel` (`Task.scala:9-13`) |
| `flag` | Boolean | sí | |
| `startDate` / `endDate` | Option[Date] | no | automáticos según estado |
| `order` | Int | sí | orden en el caso |
| `dueDate` | Option[Date] | no | |
| `assignee` | Option[String] | no | login |
| `relatedId` | EntityId | sí | caso o plantilla |
| `organisationIds` | Set[EntityId] | sí | |

Relaciones: `TaskUser`, `TaskLog`, `ShareTask(actionRequired: Boolean)`, `CaseTemplateTask` (`Task.scala:15-20`, `Share.scala:18`).

Permiso: `manageTask`.

### 2.5 Log (TaskLog)

Definición: `models/Log.scala:14-21`.

| Campo | Tipo | Obligatorio |
|---|---|---|
| `message` | String | sí |
| `date` | Date | sí |
| `taskId` | EntityId | sí (rellenado por servicio) |
| `organisationIds` | Set[EntityId] | sí |

Relaciones: `TaskLog` (Task→Log), `LogAttachment` (Log→Attachment). Permiso: `manageTask` (`LogSrv.scala`, `LogCtrl.scala:58-82`).

### 2.6 Observable / Artifact

Definición: `models/Observable.scala:35-48`.

| Campo | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `message` | Option[String] | no | fulltext-only |
| `tlp` | Int | sí | |
| `ioc` | Boolean | sí | indicador de compromiso |
| `sighted` | Boolean | sí | visto |
| `ignoreSimilarity` | Option[Boolean] | no | excluye de similitud |
| `dataType` | String | sí | debe existir en `ObservableType` |
| `tags` | Seq[String] | sí | |
| `data` | Option[String] | no | valor; puede hasificarse |
| `attachmentId` | Option[String] | no | para tipos `isAttachment` |
| `relatedId` | EntityId | sí | caso o alerta |
| `organisationIds` | Set[EntityId] | sí | |

Tipos iniciales (`models/ObservableType.scala:9-25`): `url`, `other`, `user-agent`, `regexp`, `mail-subject`, `registry`, `mail`, `autonomous-system`, `domain`, `ip`, `uri_path`, `filename`, `hash`, `file` (attachment), `fqdn`, `hostname`. Se pueden crear más vía admin.

Relaciones: `ObservableData`, `ObservableAttachment`, `ObservableKeyValue`, `ObservableTag`, `ObservableReportTag`, `ShareObservable`, `AlertObservable`, `ObservableJob`/`ReportObservable` (Cortex).

Permisos: `manageObservable`; para artefactos de alerta `manageAlert`; para análisis Cortex `manageAnalyse`.

### 2.7 TTP: Pattern + Procedure

**Pattern** (técnica MITRE ATT&CK): `models/Pattern.scala:8-26`.

Campos: `patternId` (external_id), `name`, `description`, `tactics: Set[String]`, `url`, `patternType`, `capecId`, `capecUrl`, `revoked`, `dataSources`, `defenseBypassed`, `detection`, `permissionsRequired`, `platforms`, `remoteSupport`, `systemRequirements`, `revision`. Relación `PatternPattern` para sub-técnicas.

**Procedure**: `models/Procedure.scala:8-14`. Campos `description`, `occurDate`, `tactic`; relaciones `ProcedurePattern` (a Pattern) y `CaseProcedure` (a Case).

Permisos: `managePattern` (solo admin) y `manageProcedure` (organización) (`Permissions.scala:19-20`).

### 2.8 Tag y Taxonomía

**Tag**: `models/Tag.scala:10-16`.

| Campo | Tipo | Obligatorio |
|---|---|---|
| `namespace` | String | sí |
| `predicate` | String | sí |
| `value` | Option[String] | no |
| `description` | Option[String] | no |
| `colour` | String | sí |

- Unicidad lógica por `(namespace, predicate, value)`; el índice físico se elimina en 4.1.15, la unicidad se garantiza en servicio.
- Formato textual: `namespace:predicate="value"`; si el namespace empieza por `_` se omite (`Tag.toString`).
- Tags libres: namespace `_freetags_<organisationId>` (`TagSrv.scala:33-34`, `:66-77`).
- `TaxonomyTag` conecta taxonomías MISP con tags (`models/Taxonomy.scala`).

Permiso: `manageTag` (organización).

**Taxonomy** (`models/Taxonomy.scala:8-12`): `namespace`, `description`, `version`; N-M con Tag y con Organisation (`OrganisationTaxonomy`). Importación desde JSON MISP (`TaxonomyCtrl.scala:57-130`).

### 2.9 CustomField y valores tipados

**CustomField**: `models/CustomField.scala:223-230`.

| Campo | Tipo | Obligatorio |
|---|---|---|
| `name` | String | sí, único |
| `displayName` | String | sí |
| `description` | String | sí |
| `type` | `CustomFieldType` | sí (`string`, `integer`, `float`, `boolean`, `date`) |
| `mandatory` | Boolean | sí |
| `options` | Seq[JsValue] | sí (lista de valores sugeridos) |

Los valores no son texto libre: cada asociación `CaseCustomField`, `AlertCustomField`, `CaseTemplateCustomField`, etc. es una arista con columnas `order`, `stringValue`, `booleanValue`, `integerValue`, `floatValue`, `dateValue` (`Case.scala:58-73`, `CustomField.scala:13-27`). El servicio valida el tipo al escribir (`CustomField.scala:80-220`) y reordena los valores (`CaseSrv.scala:113-121`).

`mandatory` se persiste y el frontend lo usa al cerrar casos, pero **el backend no lo exige en la creación/actualización**: solo aparece en modelos, conversión y controladores de administración (búsqueda de `mandatory`). Un clon debe decidir si lo aplica (recomendado si se busca paridad funcional real).

Permiso: `manageCustomField` (solo admin).

### 2.10 CaseTemplate

Definición: `models/CaseTemplate.scala:41-52`.

Campos: `name` (único por organización), `displayName`, `titlePrefix`, `description`, `tags`, `severity`, `flag`, `tlp`, `pap`, `summary`. Relaciones: `CaseTemplateOrganisation`, `CaseTemplateTask`, `CaseTemplateTag`, `CaseTemplateCustomField`.

Al crear un caso desde plantilla: se aplica prefijo al título, se heredan severidad/flag/tlp/pap/summary y tags, se crean las tareas de plantilla y se combinan los custom fields (los del caso tienen prioridad por nombre) (`Conversion.scala:124-140`, `CaseSrv.scala:79-111`, `:113-121`).

Permiso: `manageCaseTemplate`.

### 2.11 Dashboard

Definición: `models/Dashboard.scala:10-14`.

Campos: `title`, `description`, `definition: JsObject` (layout/consultas del frontend). Relaciones: `DashboardUser` (propietario), `OrganisationDashboard(writable: Boolean)` (compartido con organización).

Estados de API: `Private` (solo propietario) o `Shared` (con organización); el frontend admite además `Deleted` como acción (`controllers/v0/DashboardCtrl.scala:72-104`). No tiene permiso propio: se controla por propiedad (`user.current`) o por `writable` en la organización (`DashboardSrv.scala:76-105`).

### 2.12 Organisation

Definición: `models/Organisation.scala:10-11`. Campos `name` (único), `description`.

La organización `admin` es especial e inmutable (`OrganisationSrv.scala:99`, `Organisation.scala:13-14`). Relaciones: `RoleOrganisation` (usuarios/perfiles), `OrganisationShare` (shares de casos), `OrganisationOrganisation` (enlaces visibles entre organizaciones), `OrganisationTaxonomy`, `OrganisationPage`, `OrganisationDashboard`, `AlertOrganisation`, `CaseTemplateOrganisation`.

Permiso: `manageOrganisation` (solo admin). Los enlaces entre organizaciones determinan qué organizaciones son visibles para compartir (`OrganisationOps.visibleOrganisationsFrom/To`).

### 2.13 User, Role y Profile

**User**: `models/User.scala:18-33`.

| Campo | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `login` | String | sí | único; email (se añade dominio por defecto) |
| `name` | String | sí | |
| `apikey` | Option[String] | no | API key |
| `locked` | Boolean | sí | |
| `password` | Option[String] | no | hash SecureHash |
| `totpSecret` | Option[String] | no | MFA |
| `failedAttempts` | Option[Int] | no | bloqueo por intentos |
| `lastFailed` | Option[Date] | no | |

Usuario inicial `admin@thehive.local` / contraseña `secret` (`User.scala:35-46`) y usuario `system@thehive.local` (`:48-58`).

**Role**: vértice vacío que une User + Organisation + Profile (`models/Role.scala:7-9`, `UserRole`, `RoleOrganisation`, `RoleProfile`). Un usuario puede pertenecer a varias organizaciones con perfiles distintos.

**Profile**: `models/Role.scala:12-17`. Campos `name` (único), `permissions: Set[Permission]`.
Perfiles iniciales (`Role.scala:19-36`):

- `admin`: todos los permisos de scope admin.
- `org-admin`: todos los permisos de scope organización.
- `analyst`: `manageCase`, `manageObservable`, `manageAlert`, `manageTask`, `manageAction`, `manageShare`, `manageAnalyse`, `managePage`, `accessTheHiveFS`, `manageProcedure`.
- `read-only`: sin permisos.

`admin` y `org-admin` no son editables ni borrables (`Role.scala:14-16`, `ProfileSrv.scala:46-63`). Permiso de gestión: `manageProfile` (solo admin).

### 2.14 Share (núcleo del multi-tenancy)

Definición: `models/Share.scala:8-22`.

- `Share(owner: Boolean)`: un share pertenece a una organización y da visibilidad a un caso con un perfil.
- Aristas: `OrganisationShare` (Organisation→Share), `ShareProfile` (Share→Profile), `ShareCase` (Share→Case), `ShareTask` (Share→Task, con `actionRequired`), `ShareObservable` (Share→Observable).
- Invariante: como máximo un share por caso y organización (`ShareSrv.scala:49-56`).
- El share `owner=true` identifica a la organización propietaria; solo esa organización puede borrar el caso (`CaseSrv.scala:231-249`).
- Al compartir un caso se puede compartir en bloque sus tareas y observables (`ShareCtrl.scala:56-87`, `ShareSrv.scala:134-219`).
- Al retirar un share se quitan las visibilidades de tareas/observables y, si ya no tienen más shares, se eliminan (`ShareSrv.scala:88-112`).

Permiso: `manageShare`.

### 2.15 AuditLog

Definición: `models/Audit.scala:23-31`.

| Campo | Tipo | Notas |
|---|---|---|
| `requestId` | String | id de la petición HTTP |
| `action` | String | `create`, `update`, `delete`, `merge` (`Audit.scala:39-42`) |
| `mainAction` | Boolean | acción principal de la transacción |
| `objectId` | Option[String] | |
| `objectType` | Option[String] | |
| `details` | Option[String] | JSON serializado |

Relaciones: `AuditUser` (autor), `Audited` (objeto auditado), `AuditContext` (contexto de visibilidad: caso, alerta, organización, etc.). `AuditSrv` agrupa auditorías dentro de una transacción, guarda una `mainAction` y publica el evento al stream al hacer commit (`AuditSrv.scala:80-143`). La visibilidad del audit se resuelve según el contexto (`AuditOps.visible`, `AuditSrv.scala:360-430`).

No existe un permiso específico de lectura de auditoría; se filtra por visibilidad del contexto.

### 2.16 Attachment

Definición: `models/Attachment.scala:9-11`.

Campos: `name`, `size`, `contentType`, `hashes: Seq[Hash]`, `attachmentId`. El `attachmentId` es el primer hash configurado (`SHA-256` por defecto), por lo que el almacenamiento es content-addressed y deduplicado (`AttachmentSrv.scala:29-46`). Hashes configurables: `[SHA-256, SHA-1, MD5]` (`reference.conf:44`).

Se usa en observables de tipo attachment, logs, avatares de usuario y descargas ZIP protegidas.

### 2.17 Job y Action (Cortex)

**Job**: `cortex/connector/.../models/Job.scala:28-40`.

Campos: `workerId`, `workerName`, `workerDefinition`, `status` (`InProgress`, `Success`, `Failure`, `Waiting`, `Deleted`), `startDate`, `endDate`, `report: Option[JsObject]`, `cortexId`, `cortexJobId`, `operations: Seq[JsObject]`. Relaciones `ObservableJob` y `ReportObservable` (observables generados por el análisis).

**Action**: `cortex/connector/.../models/Action.scala:10-22`; mismos campos de worker/estado/report y `parameters`, más `ActionContext` al objeto sobre el que se ejecuta (Case, Task, Observable, Log o Alert).

Permisos: `manageAnalyse` para jobs y `manageAction` para responders. Endpoints en `/api/v0/job`, `/api/v0/action` (`cortex/.../Router.scala:18-27`).

### 2.18 Otras entidades

- **Page**: `title`, `content`, `slug`, `order`, `category`; N-M con Organisation. Permiso `managePage` (`models/Page.scala`).
- **ObservableType**: `name` único, `isAttachment`. Permiso `manageObservableTemplate` (admin).
- **Config**: configuración global/organización/usuario persistida; permiso `manageConfig` (global solo desde org admin) (`ConfigCtrl.scala`).
- **KeyValue** y **ReportTag**: metadatos y resultados de reportes de analizadores asociados a observables (`models/KeyValue.scala`, `ReportTag.scala`).
- **ImpactStatus / ResolutionStatus**: catálogos iniciales, editables vía integridad/administración.
- **Data**: valor completo de un observable grande; `data` indexado puede ser `sha256/...` y `fullData` guarda el original (`Observable.scala:74-108`).

---

## 3. Inventario de endpoints REST

Prefijos reales (`TheHiveRouter.scala:23-26`): `/api/v1/...`, `/api/v0/...`, y `/api/...` (alias de v0). En las tablas se omite el prefijo.

### 3.1 API v1 (Router en `controllers/v1/Router.scala`)

#### Sistema y autenticación

| Método | Ruta | Propósito | Request/Response | Permiso |
|---|---|---|---|---|
| GET | `/status` | Estado, versiones, auth, cluster, esquema | JSON | autenticado (`Router.scala:43`, `StatusCtrl.scala`) |
| GET/POST | `/logout` | Cerrar sesión | 200 nueva sesión | autenticado (`Router.scala:59-60`) |
| POST | `/login` | Login | `{user,password,organisation?,code?}` → usuario + sesión | público (`Router.scala:61`, `AuthenticationCtrl.scala:35-58`) |
| POST | `/auth/totp/set` | Generar/confirmar secreto TOTP | `{code?}` → `{secret,uri}` o 204 | autenticado |
| POST | `/auth/totp/unset[/user]` | Desactivar TOTP | 204 | propio usuario o `manageUser` |
| GET | `/admin/check/stats` | Estado de chequeos de integridad | JSON | `managePlatform` |
| GET/POST | `/admin/check/:name/trigger`, `/global/trigger`, `/dedup/trigger` | Disparar chequeo | 202/JSON | `managePlatform` |
| POST | `/admin/check/cancel` | Cancelar chequeo | 200 | `managePlatform` |
| GET | `/admin/index/status` | Estado de índices | JSON | `managePlatform` |
| POST | `/admin/index/:name/reindex|rebuild` | Reindexar/rebuild | 200 | `managePlatform` |
| GET | `/admin/log/set/:package/:level` | Cambiar nivel de log | 200 | `managePlatform` |
| POST | `/admin/schema/repair|info/:schema` | Reparar/inspeccionar esquema | 200 | `managePlatform` |
| GET | `/monitor/disk` | Uso de disco | JSON | `managePlatform` |

Los endpoints `/admin/*` se declaran en `Router.scala:46-56` y `MonitoringCtrl.scala:32`.

#### Casos

| Método | Ruta | Propósito | Request/Response | Permiso |
|---|---|---|---|---|
| POST | `/case` | Crear caso | `{case:{...},caseTemplate?,tasks?[,...]}` → 201 caso | ser miembro de la org con `manageCase` (`CaseCtrl.scala:104-129`) |
| GET | `/case/:idOrNumber` | Obtener caso | 200 caso | visible (`CaseCtrl.scala:131-140`) |
| PATCH | `/case/:idOrNumber` | Actualizar campos | body `{...}` → 204 | `manageCase` en el caso (`:142-153`) |
| POST | `/case/_merge/:ids` | Fusionar casos (coma-separados) | → 201 caso fusionado | visible + reglas de merge (`:181-198`) |
| DELETE | `/case/:idOrNumber` | Borrar caso | 204 | `manageCase` + org propietaria (`:155-166`) |
| DELETE | `/case/customField/:cfId` | Quitar custom field del caso | 204 | `manageCase` (`:168-179`) |

Rutas en `Router.scala:66-71`.

#### Observables

| Método | Ruta | Propósito | Request/Response | Permiso |
|---|---|---|---|---|
| POST | `/case/:caseId/observable` | Crear observable en caso (soporta ZIP) | `{observable:{...},isZip?,zipPassword?}` → 201/207 | `manageObservable` en el caso (`ObservableCtrl.scala:126-167`) |
| POST | `/alert/:alertId/artifact` | Crear observable en alerta | `{artifact:{...}}` → 201/207 | `manageAlert` (`:209-250`) |
| GET | `/observable/:id` | Obtener observable | 200 | visible (`:296-308`) |
| PATCH | `/observable/:id` | Actualizar | 204 | `manageObservable` (`:310-320`) |
| PATCH | `/observable/_bulk` | Actualización masiva | `{input:{...},ids:[...]}` → 204 | `manageObservable` (`:370-386`) |
| DELETE | `/observable/:id` | Borrar | 204 | `manageObservable`/propietario (`:388-400`) |
| POST | `/observable/:id/shares` | Compartir observable | `{organisations:[...]}` → 204 | `manageShare` (`ShareCtrl.scala:250-263`) |
| PUT | `/observable/type/update/:from/:to` | Cambiar tipo masivamente | 204 | `managePlatform` (`ObservableCtrl.scala:336-356`) |

Rutas en `Router.scala:76-84`.

#### Tareas y logs

| Método | Ruta | Propósito | Request/Response | Permiso |
|---|---|---|---|---|
| GET | `/task` | Listar tareas visibles | 200 array | visible (`TaskCtrl.scala:112-121`) |
| POST | `/task` | Crear tarea | `{task:{...},caseId}` → 201 | `manageTask` en el caso (`:95-106`) |
| GET | `/task/:id` | Obtener tarea | 200 | visible (`:113-121`) |
| PATCH | `/task/:id` | Actualizar | 204 | `manageTask` (`:128-143`) |
| PATCH | `/task/_bulk` | Actualización masiva | `{input,ids}` → 204 | `manageTask` (`:145-164`) |
| GET | `/task/:id/actionRequired` | Mapa organización→bool | 200 | visible (`:166-171`) |
| PUT | `/task/:id/actionRequired/:orgaId` | Marcar acción requerida | 204 | visible (`:173-182`) |
| PUT | `/task/:id/actionDone/:orgaId` | Desmarcar | 204 | visible |
| POST | `/task/:id/log` | Crear log | `{log:{message,startDate?,attachment?}}` → 201 | `manageTask` (`LogCtrl.scala:53-65`) |
| PATCH | `/log/:id` | Actualizar log | 204 | `manageTask` (`:67-80`) |
| DELETE | `/log/:id` | Borrar log | 204 | `manageTask` (`:82-86`) |

Rutas en `Router.scala:122-135`.

#### Alertas

| Método | Ruta | Propósito | Request/Response | Permiso |
|---|---|---|---|---|
| POST | `/alert` | Crear alerta | `{alert:{...},caseTemplate?}` → 201 | `manageAlert` (`AlertCtrl.scala:100-117`) |
| GET | `/alert/:idOrName` | Obtener | 200 | visible (`:119-130`) |
| PATCH | `/alert/:idOrName` | Actualizar | 204 | `manageAlert` (`:132-145`) |
| POST | `/alert/:id/read|unread` | Marcar leída/no leída | 204 | `manageAlert` (`:147-166`) |
| POST | `/alert/:id/follow|unfollow` | Seguir/dejar de seguir | 204 | `manageAlert` (`:192-214`) |
| POST | `/alert/:id/case` | Crear caso desde alerta | `{caseTemplate?}` → 201 caso | `manageAlert` (`:169-190`) |
| POST | `/alert/fixCaseLink` | Reparar vínculo alerta→caso | `{alertName,caseNumber,organisation}` → 204 | `managePlatform` (`:218-234`) |

Rutas en `Router.scala:140-148`. La actualización masiva y el borrado de alertas solo existen en v0.

#### Plantillas, custom fields, taxonomías, TTP

| Método | Ruta | Propósito | Permiso |
|---|---|---|---|
| GET | `/caseTemplate` | Listar plantillas | visible |
| POST | `/caseTemplate` | Crear plantilla | `manageCaseTemplate` efectivo por org |
| GET/PATCH | `/caseTemplate/:idOrName` | Obtener/actualizar | visible / `manageCaseTemplate` |
| GET | `/customField` | Listar custom fields | autenticado |
| POST | `/customField` | Crear custom field | autenticado (el servicio no valida permiso explícito; ver nota) |
| POST | `/taxonomy` | Importar taxonomía | `manageTaxonomy` |
| POST | `/taxonomy/import-zip` | Importar ZIP de taxonomías | `manageTaxonomy` |
| GET | `/taxonomy/:id` | Obtener | visible |
| PUT | `/taxonomy/:id/activate|deactivate` | Activar/desactivar | `manageTaxonomy` |
| DELETE | `/taxonomy/:id` | Borrar | `manageTaxonomy` |
| POST | `/pattern/import/attack` | Importar MITRE ATT&CK | `managePattern` |
| GET | `/pattern/:id` | Obtener técnica | autenticado |
| GET | `/pattern/case/:caseId` | TTP de un caso | autenticado |
| DELETE | `/pattern/:id` | Borrar técnica | `managePattern` |
| POST | `/procedure` | Crear procedimiento | `manageProcedure` |
| GET/PATCH/DELETE | `/procedure/:id` | Obtener/actualizar/borrar | lectura / `manageProcedure` |

Rutas en `Router.scala:86-90`, `:153-158`, `:166-174`. Controladores: `CaseTemplateCtrl.scala`, `CustomFieldCtrl.scala`, `TaxonomyCtrl.scala`, `PatternCtrl.scala`, `ProcedureCtrl.scala`.

Nota: `POST /customField` en v1 usa `authTransaction` sin `authPermitted` (`CustomFieldCtrl.scala:49-58`). En v0 sí exige `manageCustomField` (`controllers/v0/CustomFieldCtrl.scala:31`). Es una inconsistencia que un clon no debería reproducir si se busca coherencia.

#### Usuarios, organizaciones, perfiles

| Método | Ruta | Propósito | Permiso |
|---|---|---|---|
| POST | `/user` | Crear usuario o añadirlo a org | `manageUser` en la org (`UserCtrl.scala:109-135`) |
| GET | `/user/current` | Usuario actual + cabeceras `X-Organisation`, `X-Permissions` | autenticado (`:96-108`) |
| GET | `/user/:id` | Obtener | visible (`:190-200`) |
| PATCH | `/user/:id` | Actualizar nombre/perfil/avatar/lock | propio o `manageUser` (`:202-286`) |
| DELETE | `/user/:id` | Bloquear | `manageUser` (`:137-145`) |
| DELETE | `/user/:id/force?organisation=` | Borrar de una org o global | `manageUser` (`:147-157`) |
| POST | `/user/:id/password/set` | Fijar contraseña | `manageUser` o admin (`:288-310`) |
| POST | `/user/:id/password/change` | Cambiar propia contraseña | autenticado (`:312-325`) |
| GET/DELETE/POST | `/user/:id/key`, `/key/renew` | Ver/eliminar/renovar API key | `manageUser` o propio (`:327-365`) |
| GET | `/user/:id/avatar/*` | Descargar avatar | visible (`:367-...`) |
| POST | `/user/:id/reset` | Resetear intentos fallidos | `manageUser` (`UserCtrl.scala:144-154`) |
| POST | `/organisation` | Crear organización | `manageOrganisation` |
| GET/PATCH | `/organisation/:id` | Obtener/actualizar | visible / `manageOrganisation` |
| POST | `/profile` | Crear perfil | `manageProfile` |
| GET/PATCH/DELETE | `/profile/:id` | Obtener/actualizar/borrar | lectura / `manageProfile` |

Rutas en `Router.scala:92-108`, `:176-179`. Controladores `UserCtrl.scala`, `OrganisationCtrl.scala`, `ProfileCtrl.scala`.

#### Shares

| Método | Ruta | Propósito | Permiso |
|---|---|---|---|
| POST | `/case/:caseId/shares` | Compartir caso (lista de `{organisationName,profile,tasks,observables}`) | `manageShare` (`ShareCtrl.scala:56-87`) |
| GET | `/case/:caseId/shares` | Listar shares del caso (excepto el propio) | visible |
| DELETE | `/case/:caseId/shares` | Quitar shares por organizaciones | `manageShare`, no propia, no owner |
| POST | `/case/task/:taskId/shares` | Compartir tarea | `manageShare` |
| DELETE | `/task/:taskId/shares` | Quitar shares de tarea | visible/`manageShare` |
| POST | `/observable/:id/shares` | Compartir observable | `manageShare` |
| DELETE | `/observable/:id/shares` | Quitar shares de observable | visible |
| GET | `/case/:caseId/task/:taskId/shares` | Listar shares de tarea | `manageShare` |
| GET | `/case/:caseId/observable/:id/shares` | Listar shares de observable | `manageShare` |
| DELETE | `/case/shares` | Quitar varios shares por ids | `manageShare` |
| DELETE | `/case/share/:shareId` | Quitar un share | `manageShare`, no propio, no owner |
| PATCH | `/case/share/:shareId` | Cambiar perfil del share | `manageShare` |

Rutas en `Router.scala:110-120`.

#### Auditoría, describe y tipos de observable

| Método | Ruta | Propósito | Permiso |
|---|---|---|---|
| GET | `/audit` | Últimos 10 audits visibles (flow) | autenticado (`AuditCtrl.scala:66-76`) |
| GET | `/describe/_all` | Descriptor de todos los modelos/campos | autenticado |
| GET | `/describe/:model` | Descriptor de un modelo | autenticado |
| GET | `/observable/type/:idOrName` | Obtener tipo | autenticado |
| POST | `/observable/type` | Crear tipo | `manageObservableTemplate` |
| DELETE | `/observable/type/:idOrName` | Borrar tipo (si no se usa) | `manageObservableTemplate` |

Rutas en `Router.scala:160`, `:185-190`.

### 3.2 API v0 relevante (Router en `controllers/v0/Router.scala`)

v0 es la API que consume el frontend y contiene lo que v1 no expone:

- **Búsqueda/stats** por recurso: `GET /case`, `POST /case/_search`, `POST /case/_stats`; equivalentes para `alert`, `task` (`/case/task`), `log` (`/case/task/log`), `observable` (`/case/artifact` y `/alert/artifact`), `caseTemplate` (`/case/template`), `customField`, `dashboard`, `observable/type`, `organisation`, `page`, `profile`, `tag`, `user`, `audit`, `_stats` global (`Router.scala:52-233`).
- **Alertas**: borrado, borrado masivo, merge con caso, merge masivo, markAsRead/Unread, follow/unfollow, createCase (`Router.scala:52-66`).
- **Casos**: bulk update, merge (ruta antigua), delete/force delete, `links` (casos vinculados por observables similares) (`:122-132`).
- **Adjuntos**: `GET /datastore/:id?name=` y `GET /datastorezip/:id?name=` (`:69-70`).
- **Configuración**: global, por organización y por usuario (`:134-142`).
- **Dashboards**: CRUD completo (`:153-159`).
- **Tags**: búsqueda y get (`:215-218`).
- **Organizaciones**: enlaces (`link`, `bulkLink`, `listLinks`, `unlink`) (`:178-187`).
- **Permisos**: `GET /permission` (`:196`).
- **Stream/notificaciones**: `POST /stream`, `GET /stream/status`, `GET /stream/:id` (`:211-213`).
- **Pages** y **Listas** (`/list/...`) (`:164-194`).

### 3.3 Conectores

**Cortex** (`cortex/connector/.../Router.scala:18-50`), montado bajo `/api/v0` cuando el módulo está activo:

- `GET /job/:id`, `POST /job/_search`, `POST /job/_stats`, `POST /job`.
- `POST /action`, `POST /action/_search`, `POST /action/_stats`, `GET /action`, `GET /action/:entityType/:entityId`.
- Plantillas de analizador/reporte: `/analyzer/template`, `/report/template` (CRUD, import, search, content).
- `GET /analyzer`, `GET /analyzer/:id`, `GET /analyzer/type/:dataType`.
- `GET /responder/:entityType/:entityId`, `POST /responder/_search`.

**MISP** (`misp/connector/.../Router.scala:14-18`):

- `GET /api/v0/_syncAlerts`: sincronización (permiso `manageOrganisation`).
- `POST /api/v0/export/:caseId/:mispName`: exportar caso (permiso `manageShare`).

---

## 4. Autenticación y autorización

### 4.1 Proveedores de autenticación

El módulo registra los proveedores (`TheHiveModule.scala:38-46`): Active Directory, LDAP, contraseña local, API key local, Basic, cabecera HTTP, PKI, sesión y OAuth2. La configuración por defecto activa `session`, `basic`, `local` y `key` (`reference.conf:24-31`). `AuthSrv` se envuelve con TOTP (`TheHiveModule.scala:36`).

### 4.2 Login

`POST /api/v1/login` acepta `{user, password, organisation?, code?}` y devuelve el usuario con sus organizaciones/perfiles; crea sesión (`AuthenticationCtrl.scala:35-58`). Si el usuario está bloqueado, devuelve 403. La organización se puede indicar en el body, en el parámetro de organización de la petición o en la cookie `X-Organisation` (`reference.conf:32`; `AuthenticationCtrl.scala:41-43`).

### 4.3 API Key

- Se genera con 24 bytes aleatorios en Base64 (`LocalKeyAuthSrv.scala:25-29`).
- Se almacena en `User.apikey` y se busca por igualdad (`LocalKeyAuthSrv.scala:33-39`, `UserSrv.scala:186`).
- Operaciones: `getKey`, `removeKey`, `renewKey` (`LocalKeyAuthSrv.scala:42-72`), expuestas en `/user/:id/key*`.
- El usuario debe estar desbloqueado para obtener contexto (`UserSrv.scala:236`).

### 4.4 Contraseña local

- Hash con `SecureHash` (`LocalPasswordAuthSrv.scala:21-22`); compatibilidad con hashes legacy SHA-256 con semilla (`:32-40`).
- Intentos fallidos: incrementa `failedAttempts` y `lastFailed`; si se alcanza `maxAttempts`, se bloquea hasta `resetAfter` (`LocalPasswordAuthSrv.scala:45-86`). Configurable en el bloque `local` (`maxAttempts`, `resetAfter`).
- `setPassword` y `changePassword`; auditoría con valor oculto (`UserCtrl.scala:288-325`).

### 4.5 MFA/TOTP

TOTP HMAC-SHA1, ventana de ±1 periodo de 30 s, 6 dígitos (`TOTPAuthSrv.scala:42-55`). Si el usuario tiene `totpSecret`, el login exige `code` válido; si no lo envía, error `MultiFactorCodeRequired` (`:57-77`). Alta en dos pasos: `POST /auth/totp/set` devuelve secreto/URI y guarda temporalmente en sesión; con `code` confirma (`AuthenticationCtrl.scala:62-87`).

### 4.6 Contexto de autorización

La autenticación produce un `AuthContext` con `userId`, `organisation`, `requestId` y `permissions`. La construcción está en `UserSrv.getAuthContext` (`UserSrv.scala:231-251`):

1. Resuelve la organización solicitada; si no se indica, usa la primera organización del usuario por fecha de creación del rol; si no hay, `admin`.
2. Verifica que el usuario no esté bloqueado.
3. Obtiene el perfil del usuario **en esa organización**; si no existe, usa el perfil en la organización `admin`.
4. Calcula el scope: `admin` si la organización es `admin`, si no `organisation`.
5. `permissions = Permissions.forScope(scope) & profile.permissions`.

Consecuencia: un usuario con perfil `admin` en la organización `admin` obtiene todos los permisos; fuera de `admin` solo los permisos de scope organización, aunque su perfil contenga permisos admin. Los permisos restringidos se calculan en `Permissions.restrictedPermissions` (`Permissions.scala:56-61`).

### 4.7 Perfiles y permisos

Catálogo completo en `Permissions.scala:6-27`. Scopes:

- **Organización**: `accessTheHiveFS`, `manageAction`, `manageAlert`, `manageAnalyse`, `manageCase`, `manageCaseTemplate`, `manageConfig`, `manageObservable`, `managePage`, `manageProcedure`, `manageShare`, `manageTag`, `manageTask`, `manageUser`.
- **Admin**: `manageAnalyzerTemplate`, `manageCustomField`, `manageObservableTemplate`, `manageOrganisation`, `managePattern`, `manageProfile`, `manageTaxonomy`, `managePlatform`.
- Mixtos: `manageConfig` (org+admin), `manageUser` (org+admin).

Los perfiles iniciales están en `Role.scala:19-36`; `admin` y `org-admin` son inmutables.

### 4.8 Organizaciones y visibilidad

- Un usuario pertenece a organizaciones mediante `UserRole → Role → RoleOrganisation` (`UserSrv.scala:188`).
- Los datos de caso/alerta/tarea/observable llevan `organisationIds`/`organisationId` y se filtran por la organización actual (`CaseOps.visible`, `AlertOps.visible`, `TaskOps.visible`, `ObservableOps.visible`).
- Un caso puede ser visible para varias organizaciones mediante `ShareCase`; cada share tiene un perfil que determina los permisos de esa organización sobre el caso (`CaseOps.can`).
- Los enlaces `OrganisationOrganisation` limitan qué organizaciones pueden compartir entre sí (`OrganisationOps.visibleOrganisationsFrom/To`).
- La organización `admin` no se puede modificar ni enlazar (`OrganisationSrv.scala:99`, `:117`).

### 4.9 Reglas de sharing y propiedad

- Crear un caso crea automáticamente un share `owner=true` con la organización creadora y perfil `org-admin` (`CaseSrv.scala:96`).
- No puede haber dos shares del mismo caso para la misma organización (`ShareSrv.scala:54`).
- Solo la organización propietaria puede borrar el caso (`CaseSrv.scala:231-249`).
- No se puede retirar el share propio ni el share owner (`ShareCtrl.scala:160-170`).
- Al compartir un caso se puede optar por compartir todas/ninguna tarea y observable (`ShareCtrl.scala:78-84`).
- Al quitar un share de caso se quitan los shares de tareas/observables de esa organización y se eliminan los que queden huérfanos (`ShareSrv.scala:88-112`).
- Las tareas/observables tienen su propio `ShareTask`/`ShareObservable`, pero cuelgan del share del caso; no se puede compartir una tarea/observable de un caso no compartido (`ShareSrv.addTaskShares/addObservableShares`).
- `ShareTask.actionRequired` permite marcar que una organización debe actuar sobre una tarea; se consulta por tarea/organización (`TaskSrv.scala:140-160`).
- Los dashboards son privados del usuario o compartidos con la organización; solo el propietario o un usuario con `writable` puede modificarlos (`DashboardSrv.scala:76-105`).

### 4.10 Visibilidad de usuarios

`UserOps.visible`: si el usuario tiene `manageOrganisation`, ve todos; si no, ve usuarios de organizaciones visibles para su organización y el usuario `system` (`UserSrv.scala:176-180`). Para asignar, se exige que el usuario destino pertenezca a una organización donde el actor tenga el permiso correspondiente (`UserSrv.organisations(permission)`).

---

## 5. Query/search DSL

Hay dos estilos de consulta.

### 5.1 Búsqueda legacy v0 (`_search`)

- Endpoint: `POST /api/{recurso}/_search` (o `POST /api/_search` global) con body `{"query": <filtro>}`.
- Parámetros de query string: `range=from-to` (o `all`), `sort=+campo,-campo` (repetible), `nparent`, `nstats`.
- Respuesta: array JSON y cabecera `X-Total` con el total.
- Implementación de referencia: `controllers/v0/QueryCtrl.scala:44-137` (parseo de `range`, `sort`, filtros), y cliente Angular `frontend/app/scripts/services/common/data/SearchSrv.js:7-35`.

Ejemplo:

```json
POST /api/case/_search?range=0-10&sort=-startDate
{"query":{"_and":[{"status":"Open"},{"severity":{"_gte":2}}]}}
```

### 5.2 Query API v1/v0 (`/query`)

El frontend construye un array de operaciones y lo envía a `POST /api/{version}/query` con `{"query":[ ... ]}` (`frontend/app/scripts/services/common/QuerySrv.js:30-37`, `:50-85`). Cada operación tiene `_name`:

1. `listCase` / `listAlert` / `listTask` / ... (consulta inicial del recurso).
2. `filter` con el árbol de predicados.
3. `sort` con `_fields: [{"campo":"asc|desc"}]`.
4. `page` con `from`, `to`, `extraData` (por ejemplo `["total"]`).
5. `count` o `limitedCount` para contar.
6. Consultas extra por recurso: `observables`, `tasks`, `alerts`, `shares`, `linkedCases`, `assignableUsers`, etc.

Los ejecutores están en `controllers/v1/TheHiveQueryExecutor.scala:35-110` y `controllers/v0/TheHiveQueryExecutor.scala:41-155`; cada controlador `QueryableCtrl` declara `initialQuery`, `getQuery`, `pageQuery`, `outputQuery` y `extraQueries` (`QueryableCtrl.scala:6-14`). El límite de conteo es `query.limitedCountThreshold` (1000 por defecto, `reference.conf:15`).

> La ruta `/query` la aporta el router de ScalliGraph (submódulo ausente). Su contrato se deduce del ejecutor y del cliente: body `{"query":[operaciones]}` y respuesta JSON; para count, un número.

### 5.3 Operadores de filtro

Sintaxis observada en el constructor de consultas del frontend (`frontend/app/scripts/services/common/QueryBuilderSrv.js:24-283`) y en los filtros de ScalliGraph:

| Operador | Forma | Semántica |
|---|---|---|
| campo directo | `{"status":"Open"}` | igualdad |
| `_eq` implícito | `{"_field":"severity","_value":2}` | igualdad |
| `_lt`, `_lte`, `_gt`, `_gte` | `{"_gt":{"severity":2}}` | comparación numérica/fecha |
| `_between` | `{"_between":{"_field":"startDate","_from":123,"_to":456}}` | rango inclusivo |
| `_like` | `{"_like":{"_field":"title","_value":"foo*"}}` | texto con comodines `*` |
| `_in` | `{"_in":{"_field":"status","_values":["Open","Resolved"]}}` | pertenencia |
| `_contains` | `{"_contains":"campo"}` | campo presente |
| `_not` | `{"_not":{...}}` | negación |
| `_and`, `_or` | `{"_and":[...]}` | composición lógica |
| `_any` | `{"_any":"*"}` | comodín global |
| `_string` | `{"_string":"title:\"foo\" AND status:Open"}` | consulta textual |
| `_parent` | `{"_parent":{"_type":"case","_id":"..."}}` o `_query` | filtra por padre (tarea/observable/log) |
| `_child` | `{"_child":{"_type":"case_task","_query":{...}}}` | filtra por hijo |

Los filtros `_parent`/`_child` están implementados en `controllers/v0/TheHiveQueryExecutor.scala:113-254`: tipos válidos `case_task`, `case_artifact`, `alert_artifact`, `case_task_log`, `caseTemplate_task`, `caseTemplate`. En v1 no se declaran esos filtros personalizados, por lo que son propios de v0.

### 5.4 Campos consultables

Cada controlador expone sus propiedades públicas (`Properties.scala`). Destacan:

- Caso: `title`, `description`, `severity`, `startDate`, `endDate`, `number`, `tags`, `flag`, `tlp`, `pap`, `status`, `summary`, `assignee`, `impactStatus`, `resolutionStatus`, `customFields.*`, `computed.handlingDuration*`, `viewingOrganisation`, `owningOrganisation`, `patternId` (`Properties.scala:133-260`).
- Alerta: `type`, `source`, `sourceRef`, `title`, `description`, `severity`, `date`, `lastSyncDate`, `tags`, `flag`, `tlp`, `pap`, `read`, `follow`, `imported`, `case`, `importDate`, `computed.handlingDuration*`, `customFields.*` (`:57-131`).
- Tarea: `title`, `description`, `status`, `flag`, `startDate`, `endDate`, `order`, `dueDate`, `group`, `assignee`, `actionRequired` (`:358-404`).
- Observable: `status` (constante `Ok`), `startDate` (= `_createdAt`), `ioc`, `sighted`, `ignoreSimilarity`, `tags`, `message`, `tlp`, `dataType`, `data`, `attachment.*` (`:428-470`).
- Log: `message`, `date`, `attachment.*` (`:406-420`).
- Usuario: `login`, `name`, `locked`, `avatar`, `profile` (`:422-428`).

Los custom fields se filtran como `customFields.<nombre>` con el operador adecuado al tipo; `hasCustomField`/`hasNotCustomField` para presencia (`CaseSrv.scala:560-640`, `Properties.scala:91-130`).

### 5.5 Ordenación y paginación

- Ordenación legacy: `sort=+campo` ascendente, `-campo` descendente (`QueryCtrl.scala:55-69`).
- Ordenación nueva: operación `{"_name":"sort","_fields":[{"campo":"desc"}]}` (`QuerySrv.js:14-28`).
- Paginación legacy: `range=0-10`, `range=all`; por defecto `0-10` (`QueryCtrl.scala:71-96`).
- Paginación nueva: `{"_name":"page","from":0,"to":10,"extraData":["total"]}` (`TheHiveQueryExecutor.scala:19-30`).
- `extraData: ["total"]` devuelve el total; sin él, algunos recursos no calculan el count para ahorrar coste.
- `limitedCountThreshold` limita counts altos a 1000 (`reference.conf:15`).

### 5.6 Agregaciones (`_stats`)

`POST /api/{recurso}/_stats` con body `{"query": {...}, "stats": [ ... ]}` (`QueryCtrl.scala:98-137`). Tipos de agregación (`services/th3/Aggregation.scala:59-150`):

- `field`: agrupa por campo; `_name`, `_field`, `_order`, `_size`, `_select`, `_query`.
- `time`: agrupa por intervalo temporal; `_fields`, `_interval` (p. ej. `7d`, `1M`), `_select`, `_query`.
- `count`: cuenta; `_query`.
- `avg`, `min`, `max`, `sum`: sobre un campo; `_query`.

Las agregaciones se pueden anidar mediante `_select` y filtrar con `_query`. El resultado se fusiona en un objeto JSON (`QueryCtrl.scala:128-136`).

---

## 6. Flujos clave

### 6.1 Crear caso desde cero

1. `POST /case` parsea `InputCase`, `caseTemplate` y `tasks` (`CaseCtrl.scala:104-112`).
2. Resuelve la organización del usuario que tenga `manageCase` en la organización de la petición (`:118-121`); si no, 403.
3. Aplica valores por defecto: `severity=2`, `startDate=now`, `flag=false`, `tlp=2`, `pap=2`, `status=Open`, `number=0`, `assignee=usuario actual` (`Conversion.scala:95-120`).
4. Si hay plantilla: prefijo de título, herencia de campos y tags (`Conversion.scala:124-140`).
5. `CaseSrv.create` (`CaseSrv.scala:79-111`):
   - Obtiene número de caso del actor singleton (`CaseNumber.scala:29-56`).
   - Crea tags que no existan (`TagSrv.getOrCreate`).
   - Crea el vértice `Case` con `organisationIds` y `owningOrganisation`.
   - Asigna usuario (arista `CaseUser`).
   - Crea share owner con perfil `org-admin`.
   - Enlaza plantilla, crea tareas de plantilla + tareas adicionales, crea tags y custom fields (plantilla + petición, con prioridad a la petición).
   - Audita la creación.
6. Devuelve 201 con el caso (`OutputCase` v1).

### 6.2 Crear caso desde alerta

`POST /alert/:id/case` (`AlertCtrl.scala:169-190`):

1. Requiere `manageAlert`; comprueba que la plantilla, si se indica, sea visible.
2. Si el usuario tiene `manageCase`, se asigna el caso a sí mismo; si no, sin asignado.
3. `AlertSrv.createCase` (`AlertSrv.scala:231-265`):
   - Si la alerta ya tiene caso, devuelve ese caso.
   - Construye un `Case` con título `titlePrefix + alert.title`, descripción, severidad, `startDate=now`, `flag=false`, TLP/PAP, `status=Open`, tags de la alerta.
   - Crea el caso con los custom fields de la alerta, sin tareas adicionales.
   - Importa los observables de la alerta al caso.
   - Crea `AlertCase`, actualiza `alert.caseId`, marca la alerta como leída.
   - Audita la creación con detalle `fromAlert`.
4. Devuelve 201 con el caso.

### 6.3 Merge de alerta en caso existente (v0)

`POST /api/alert/:alertId/merge/:caseId` (`controllers/v0/AlertCtrl.scala:186-199`):

1. Requiere `manageAlert` y `manageCase` en el caso destino.
2. `AlertSrv.mergeInCase` (`AlertSrv.scala:275-308`):
   - Falla si la alerta ya está importada (`:277`).
   - Marca leída, importa observables, importa custom fields, añade tags al caso.
   - Crea `AlertCase`, actualiza `alert.caseId`.
   - Añade al final de la descripción del caso: `#### Merged with alert #<sourceRef> <title>` + descripción de la alerta.
   - Audita el merge con detalle `fromAlert`.
3. Existe versión masiva `POST /api/alert/merge/_bulk` con `{caseId, alertIds}` (`v0/AlertCtrl.scala:201-226`).

### 6.4 Merge de casos

`POST /api/v1/case/_merge/:ids` (`CaseCtrl.scala:181-198`, `CaseSrv.scala:388-450`):

1. Requiere al menos 2 casos visibles.
2. `canMerge`: todos los casos deben tener **el mismo par organización/perfil**, y ese par debe ser la organización actual con perfil `org-admin` (`CaseSrv.scala:452-466`). Si no, 400 con mensaje explicativo.
3. Construye un caso nuevo:
   - `title = títulos unidos por " / "`.
   - `description = descripciones unidas por dos saltos de línea`.
   - `severity = max`, `startDate = min`, `endDate = None`, `flag = OR`, `tlp = max`, `pap = max`, `status = Open`, `summary` concatenados, tags únicos.
4. Crea el caso (con usuario actual y organización actual) y comparte con las demás organizaciones que participaban, con sus perfiles.
5. Para cada caso origen: reasigna tareas y observables al nuevo caso y los comparte; reasigna alertas (`alert.caseId`), procedimientos y custom fields.
6. Borra los casos originales y audita el merge con la lista de casos.

### 6.5 Tareas y logs

- Crear tarea: `POST /task` con `caseId`; exige `manageTask` en el caso (`TaskCtrl.scala:95-106`). El asignado debe ser un usuario asignable del caso (`CaseSrv.createTask`, `CaseSrv.scala:200-205`).
- Transiciones (`TaskSrv.updateStatus`, `TaskSrv.scala:99-125`):
  - `Waiting`/`Cancel`: solo cambia estado.
  - `Completed`: fija `endDate` si estaba vacío.
  - `InProgress`: fija `startDate` si estaba vacío y, si no hay asignado, asigna al usuario actual.
- Crear log: `POST /task/:id/log`; si la tarea está `Waiting`, pasa automáticamente a `InProgress` (`LogSrv.scala:23-31`).
- `actionRequired` se guarda en `ShareTask` por organización, no en la tarea (`TaskSrv.scala:140-160`).
- Borrar tarea: si está compartida, solo quita el share de la organización actual; si no, borra logs y tarea (`TaskSrv.scala:68-77`).

### 6.6 Observables

- Crear en caso: `POST /case/:id/observable`; requiere `manageObservable` en el caso (`ObservableCtrl.scala:126-167`).
- Soporta:
  - Valor simple (`data`), con hasificación si es muy largo (`ObservableSrv.scala:87`).
  - Adjunto (`attachment`), con deduplicación por `attachmentId`.
  - ZIP (`isZip`, `zipPassword`): extrae ficheros, protege contra zip bombs comprobando tamaño (`ObservableCtrl.scala:404-434`).
  - Varios valores en una petición; respuesta 201 si todo va bien o 207 Multi-Status con `success`/`failure` (`:153-167`).
- Deduplicación: mismo `organisation`, `relatedId`, `dataType` y `data`/`attachmentId` → `CreateError("Observable already exists")` (`ObservableSrv.scala:60-66`, `:88-94`).
- Tipos attachment vs texto: un tipo attachment exige adjunto; un tipo texto no acepta adjunto (`ObservableSrv.scala:70-75`, `:96-101`).
- Similitud (`ObservableOps.similar`, `ObservableSrv.scala:365-380`): dos observables son similares si comparten el mismo `Data` o `Attachment`; se excluyen los que tienen `ignoreSimilarity=true`. `seen` en la salida indica si existe al menos un similar visible (`:310-333`).
- Borrado (`ObservableSrv.scala:145-190`):
  - Si pertenece a alerta: se elimina y se audita en la alerta.
  - Si el share es owner: se borra para todas las organizaciones y se audita por cada share.
  - Si no es owner: solo se quita el share de la organización actual.

### 6.7 TTP (Pattern/Procedure)

- Importar MITRE: `POST /pattern/import/attack` con fichero JSON; solo acepta `type=attack-pattern` y `external_id` no vacío; las sub-técnicas (`x_mitre_is_subtechnique`) se enlazan al patrón padre por el prefijo antes del punto (`PatternCtrl.scala:92-137`).
- Crear procedimiento: `POST /procedure` con `{description?,occurDate,tactic,caseId,patternId}`; requiere `manageProcedure` (`ProcedureCtrl.scala:47-55`). El servicio crea el vínculo caso→procedimiento y procedimiento→patrón.
- Consulta de TTP de un caso: `GET /pattern/case/:caseId`.

### 6.8 Adjuntos

- Subida: se calculan hashes según `attachment.hash`; `attachmentId` = primer hash; se guarda el binario en `StorageSrv` y se crea el vértice `Attachment` (`AttachmentSrv.scala:29-46`).
- Duplicado: si ya existe el `attachmentId`, se reutiliza tamaño/hashes y solo se crea un nuevo vértice con nombre/contentType (`AttachmentSrv.scala:66-83`).
- Descarga: `GET /api/datastore/:id?name=`; `GET /api/datastorezip/:id?name=` genera ZIP cifrado con contraseña `datastore.attachment.password` (`AttachmentCtrl.scala:35-98`, `reference.conf:45`).
- Borrado: solo elimina el binario si no quedan otros vértices con el mismo `attachmentId` (`AttachmentSrv.scala:95-102`).

### 6.9 Dashboards

- Crear: `POST /api/dashboard`; el propietario es el usuario actual (`DashboardSrv.scala:25-34`).
- `status=Shared` comparte con la organización actual con `writable=true`; `Private` retira el share; `Deleted` borra (`v0/DashboardCtrl.scala:72-104`).
- Listado: unión de dashboards de la organización y del usuario (`v0/DashboardCtrl.scala:113-125`).
- Edición: solo propietario o share de organización con `writable=true` (`DashboardSrv.scala:76-80`).

### 6.10 Plantillas de caso

- Crear: `POST /caseTemplate`; nombre único por organización (`CaseTemplateSrv.scala:58-60`). Crea tareas (asignadas a usuarios de la organización con `manageTask`), tags y custom fields (`:69-85`).
- Aplicar: en `POST /case` con `caseTemplate`; se combinan campos como se describió en 6.1.
- No se permite borrar plantilla en v1 (ruta comentada, `Router.scala:90`); v0 sí tiene DELETE (`v0/Router.scala:88`).

### 6.11 Auditoría, stream y notificaciones

- Cada operación de servicio relevante llama a `auditSrv.<entidad>.create/update/delete/merge`.
- `AuditSrv` mantiene una auditoría pendiente por transacción; al hacer commit guarda la `mainAction`, publica `AuditStreamMessage` en `EventSrv` y envía `AuditNotificationMessage` al `NotificationActor` (`AuditSrv.scala:93-143`).
- El `FlowActor` mantiene en caché los últimos 10 audits por organización/caso y alimenta el flujo en tiempo real (`FlowActor.scala:44-104`).
- `NotificationActor` evalúa triggers por organización y usuario y ejecuta notificadores (`NotificationActor.scala`): `webhook`, `emailer`, `mattermost`, `appendToFile`.
- Triggers disponibles (`TheHiveModule.scala:55-63`): `AlertCreated`, `AnyEvent`, `CaseCreated`, `FilteredEvent`, `JobFinished`, `LogInMyTask`, `TaskAssigned`, `CaseShared`. La configuración es por usuario y por organización; `roleRestriction` permite repartir notificaciones entre nodos del cluster (`NotificationConfig.scala`, `NotificationActor.scala:84-140`).
- `FilteredEvent` permite filtros declarativos sobre el JSON del audit (`And`, `Or`, `Not`, `Lt`, `Gt`, `Lte`, `Gte`, `Is`, `StartsWith`, `EndsWith`, `Between`, `In`, `Contains`, `Like`) (`triggers/FilteredEvent.scala:18-88`).

### 6.12 Cortex (resumen)

- El módulo Cortex se activa añadiendo `play.modules.enabled += connectors.cortex.CortexConnector` y configurando `cortex.servers` (`cortex/connector/src/main/resources/reference.conf`).
- Analizar un observable: `POST /api/v0/job` con `{analyzerId,cortexId,artifactId,parameters?}`; requiere `manageAnalyse` (`JobCtrl.scala:48-80`). El job se asocia al observable y al caso; los observables del reporte se enlazan con `ReportObservable`.
- Ejecutar un responder: `POST /api/v0/action` con `{responderId,cortexId?,objectType,objectId,parameters?,tlp?}`; requiere `manageAction` (`ActionCtrl.scala:61-83`). El objeto puede ser Case, Task, Observable, Log o Alert.
- El reporte del analizador puede incluir operaciones que modifican TheHive: añadir tag a caso/artefacto/alerta, crear tarea, añadir custom field, cerrar tarea, marcar alerta leída, añadir log, añadir artefacto al caso, asignar caso (`models/ActionOperation.scala:10-31`).

### 6.13 MISP (resumen)

- Sincronización: `GET /api/v0/_syncAlerts`; requiere `manageOrganisation` (`MispCtrl.scala:33-39`).
- Conversión evento→alerta (`MispImportSrv.scala:44-80`): `type=misp`, `source=<organización MISP>`, `sourceRef=event.id`, `externalLink`, título `#id info`, severidad derivada de `threatLevel`, TLP desde tags `tlp:*`, PAP 2, tags `src:<org>` + tags del evento.
- Atributos→observables: mapeo configurable categoría/tipo MISP→tipo TheHive y tags (`misp/connector/reference.conf`), con fallback a `other`.
- Exportación: `POST /api/v0/export/:caseId/:mispName`; requiere `manageShare` (`MispCtrl.scala:41-52`).

---

## 7. Reglas de negocio y validaciones que un clon debe respetar

### Casos

1. `number` es único y monótono; se genera con un actor singleton que arranca en `max(number)+1` y recarga periódicamente desde la BD (`CaseNumber.scala:29-56`, `reference.conf:66`).
2. `status` al crear es siempre `Open`, aunque el cliente envíe otro (`Conversion.scala:106-109`).
3. Valores por defecto: severidad 2, TLP 2, PAP 2, flag false, startDate now, asignado al usuario actual (`Conversion.scala:95-120`).
4. Cerrar un caso (`PATCH status=Resolved`) ejecuta un updater especial: las tareas `Waiting` se cancelan, las `InProgress` se completan y se fija `endDate` del caso (`CaseSrv.scala:160-178`).
5. `impactStatus` y `resolutionStatus` son estados opcionales con valores iniciales fijos; se gestionan con aristas dedicadas (`CaseSrv.scala:307-365`).
6. `assignee` debe ser un usuario asignable (con `manageCase` en alguna organización visible del caso) (`CaseSrv.scala:367-385`).
7. Borrar un caso exige ser la organización propietaria; se desvinculan alertas (`caseId` vacío), se descomparte y se borra (`CaseSrv.scala:231-249`).
8. Merge solo entre casos con el mismo par organización/perfil y siendo la organización actual `org-admin` (`CaseSrv.scala:452-466`).

### Alertas

9. Unicidad por `(type, source, sourceRef, organisation)`; duplicado → error de creación (`AlertSrv.scala:78-80`).
10. Una alerta ya importada no se puede volver a fusionar (`AlertSrv.scala:277`).
11. Crear caso desde alerta marca la alerta como leída y le asigna `caseId` (`AlertSrv.scala:247-262`).
12. Los estados `New/Updated/Ignored/Imported` son derivados de `read` + existencia de `caseId`; no se almacenan (`v0/AlertCtrl.scala:377-391`).
13. `lastSyncDate` se actualiza en sincronizaciones MISP; los tags TLP se interpretan para fijar `tlp` (`MispImportSrv.scala:66-78`).

### Tareas y logs

14. El estado `InProgress` fija `startDate` y autoasigna al usuario actual si no hay asignado (`TaskSrv.scala:99-125`).
15. `Completed` fija `endDate`; `Cancel`/`Waiting` no tocan fechas.
16. Crear un log en tarea `Waiting` la pasa a `InProgress` (`LogSrv.scala:23-31`).
17. Borrar tarea compartida solo retira el share de la organización actual; si no está compartida, borra logs y tarea (`TaskSrv.scala:68-77`).
18. `actionRequired` es por organización, no global (`TaskSrv.scala:140-160`).

### Observables

19. No se puede crear un observable duplicado en el mismo contexto (`organisation`, `relatedId`, `dataType`, `data`/`attachmentId`) (`ObservableSrv.scala:60-66`).
20. El `dataType` debe existir; si es de tipo attachment, debe recibir adjunto; si es texto, no debe recibir adjunto (`ObservableSrv.scala:70-75`, `:96-101`).
21. Valores de dato muy largos se indexan como `sha256/<hash>` y el valor completo se guarda en `Data.fullData` (`Observable.scala:77-108`).
22. La similitud se basa en compartir `Data` o `Attachment`; `ignoreSimilarity=true` excluye el observable (`ObservableSrv.scala:359-380`).
23. En importación de alerta a caso, si el observable ya existe se actualizan sus tags en lugar de fallar (`AlertSrv.scala:310-343`).
24. Al borrar un observable compartido sin ser owner, solo se retira la visibilidad de la organización actual (`ObservableSrv.scala:145-190`).

### Adjuntos

25. `attachmentId` = primer hash configurado; el almacenamiento es content-addressed y deduplicado (`AttachmentSrv.scala:29-46`).
26. Solo se borra el binario cuando no quedan vértices que lo referencien (`AttachmentSrv.scala:95-102`).
27. La descarga ZIP usa contraseña configurable y cifrado ZIP estándar (`AttachmentCtrl.scala:52-97`).
28. La extracción de ZIP valida el tamaño declarado para evitar zip bombs (`ObservableCtrl.scala:404-434`).

### Sharing y organizaciones

29. Un caso nace con un share owner a `org-admin` de la organización creadora (`CaseSrv.scala:96`).
30. No se puede duplicar un share caso/organización (`ShareSrv.scala:54`).
31. No se puede quitar el share propio ni el owner (`ShareCtrl.scala:160-170`).
32. Retirar un share de caso limpia shares de tareas/observables y elimina los huérfanos (`ShareSrv.scala:88-112`).
33. Solo la organización propietaria puede borrar el caso (`CaseSrv.scala:231-249`).
34. La organización `admin` es inmutable y no se puede enlazar con otras (`OrganisationSrv.scala:99`, `:117`).
35. Los perfiles `admin` y `org-admin` no son editables ni borrables; un perfil en uso tampoco se puede borrar (`ProfileSrv.scala:46-63`).
36. Los permisos efectivos son la intersección del scope de la organización con los del perfil; fuera de `admin` no se pueden tener permisos admin (`UserSrv.scala:245-251`).

### Usuarios

37. `login` debe ser un email; si no contiene `@`, se le añade `auth.defaultUserDomain`; se normaliza a minúsculas (`UserSrv.scala:36-48`).
38. No se puede bloquear a uno mismo (`UserSrv.scala:123-125`).
39. Solo se puede fijar contraseña de usuarios que pertenezcan a organizaciones del operador, salvo que el operador sea admin (`UserCtrl.scala:290-305`).
40. Al borrar un usuario de una organización se elimina su rol en esa organización; si no tiene más roles, se elimina el usuario (`UserSrv.scala:104-112`).

### Tags, plantillas, custom fields, taxonomías

41. Tags con formato `namespace:predicate="value"`; si no hay namespace se usa `_freetags_<orgId>` (`TagSrv.scala:35-55`, `:66-77`).
42. Borrar un tag lo quita de casos, alertas, observables y plantillas (`TagSrv.scala:112-126`).
43. El namespace `_freetags` está reservado y no se puede importar como taxonomía (`TaxonomyCtrl.scala:120-124`).
44. Nombre de plantilla único por organización (`CaseTemplateSrv.scala:58-60`).
45. Nombre de custom field único global (`CustomFieldSrv.scala:38-40`).
46. El tipo de custom field se valida al escribir y el orden se reindexa (`CaseSrv.scala:113-121`, `CustomField.scala:80-220`).
47. `mandatory` no se exige en el backend; el frontend lo usa en el diálogo de cierre. Si el clon quiere hacerlo cumplir, es una decisión de producto.

### Auditoría

48. Cada transacción genera como máximo una auditoría `mainAction`; las intermedias se van volcando (`AuditSrv.scala:93-143`).
49. El audit incluye siempre contexto de visibilidad; un audit sin contexto visible no se muestra (`AuditSrv.scala:360-430`).
50. Los cambios de contraseña/API key se auditan con `<hidden>` (`UserCtrl.scala:304`, `:343`, `:356`).

---

## 8. Licencia AGPL-3.0: qué implica

- TheHive se distribuye bajo **GNU Affero General Public License v3.0** (`LICENSE:1`, `README.md:107`).
- La AGPL añade a la GPL una obligación específica para software en red: si un usuario interactúa con una versión modificada a través de una red, el operador debe ofrecerle el código fuente correspondiente de esa versión. No basta con liberar solo los cambios si el servicio se ofrece remotamente.
- **Copiar código, adaptarlo o enlazarlo** en un clon distribuido o prestado como servicio normalmente convierte el conjunto en obra derivada y obliga a licenciarlo bajo AGPL, con acceso al código para los usuarios del servicio. Esto incluye copiar ficheros Scala, esquemas, plantillas de consulta o textos sustanciales, no solo binarios.
- **Reutilizar ideas, conceptos, interfaces públicas y hechos del dominio** (por ejemplo, que un caso tenga estados `Open/Resolved/Duplicated`, o que exista un endpoint REST con cierta semántica) es en principio distinto de copiar la expresión concreta. Sin embargo, la línea entre idea y expresión es difusa: estructuras de datos muy detalladas, esquemas de BD originales, comentarios, nombres creativos y organización de módulos pueden estar protegidos en algunas jurisdicciones.
- Estrategia recomendada para un clon propio:
  1. Usar este dossier como especificación funcional, no como fuente de código.
  2. Implementar desde cero con un diseño propio (nombres, capas, estructuras y algoritmos independientes).
  3. No copiar fragmentos, comentarios, cadenas literales ni esquemas de forma mecánica.
  4. Documentar la cadena de autoría (clean-room) y las fuentes de requisitos.
  5. Revisar también las licencias de las dependencias (Play, Akka, JanusGraph, Cassandra, Elasticsearch, Scala) y de los conectores.
- Esta sección es un resumen técnico, **no asesoramiento legal**. Antes de distribuir o prestar el clon conviene una revisión jurídica específica.

---

## Anexo A. Mapa rápido de ficheros

| Área | Ruta |
|---|---|
| Routers | `thehive/app/org/thp/thehive/controllers/{v0,v1}/Router.scala`, `TheHiveRouter.scala` |
| Controladores v1 | `thehive/app/org/thp/thehive/controllers/v1/*.scala` |
| Controladores v0 | `thehive/app/org/thp/thehive/controllers/v0/*.scala` |
| Modelo | `thehive/app/org/thp/thehive/models/*.scala` |
| Servicios | `thehive/app/org/thp/thehive/services/*.scala` |
| Consultas/propiedades | `thehive/app/org/thp/thehive/controllers/v1/Properties.scala`, `TheHiveQueryExecutor.scala`, `v0/QueryCtrl.scala` |
| DTO | `dto/src/main/scala/org/thp/thehive/dto/{v0,v1}/*.scala` |
| Configuración | `thehive/conf/reference.conf`, `conf/application.sample.conf` |
| Esquema/migraciones | `thehive/app/org/thp/thehive/models/TheHiveSchemaDefinition.scala`, `migration/` |
| Cortex | `cortex/connector/src/main/scala/...`, `cortex/client`, `cortex/dto` |
| MISP | `misp/connector/src/main/scala/...`, `misp/client` |
| Frontend (contratos de consulta) | `frontend/app/scripts/services/common/QuerySrv.js`, `QueryBuilderSrv.js`, `data/SearchSrv.js` |
| Licencia | `LICENSE`, `README.md:107` |

## Anexo B. Diferencias v0 vs v1 (resumen operativo)

| Capacidad | v0 | v1 |
|---|---|---|
| Búsqueda `_search`/`_stats` | Sí, por recurso y global | No expuesta en el router |
| Query API `/query` | Sí (ScalliGraph) | Sí (ScalliGraph) |
| CRUD de casos | Sí + bulk + links + force delete | Subconjunto + merge por ids |
| Alertas | CRUD + bulk delete + merge + estados | CRUD + estados + createCase + fixCaseLink |
| Observables | CRUD + bulk + similar | CRUD + bulk + updateAllTypes |
| Tareas/logs | CRUD + búsqueda | CRUD + actionRequired |
| Adjuntos | `/datastore`, `/datastorezip` | Solo a través de avatar; descarga v0 |
| Dashboards | CRUD completo | No expuesto |
| Config | Global/org/user | No expuesto |
| Pages/Listas | CRUD | No expuesto |
| Stream | `POST /stream` | No expuesto |
| Organización links | Sí | No expuesto |
| Permisos | `GET /permission` | No expuesto |
| Cortex/MISP | Sí (módulos) | No (solo v0) |

---

*Fin del dossier.*
