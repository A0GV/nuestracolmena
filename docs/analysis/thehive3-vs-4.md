# TheHive 3.5.2 vs 4.1.24 — análisis comparativo y recomendación para un clon moderno

**Fuentes analizadas (sin modificarlas):**

- `~/reference/thehive3` — versión `3.5.2-1` (`version.sbt:1`).
- `~/reference/thehive4` — versión `4.1.24-1` (`build.sbt:5`).

**Licencia de ambas:** AGPL-3.0 (`LICENSE:1` en ambos árboles).

> **Método.** Lectura estática de código, rutas, modelos, frontend y changelogs. No se ha modificado ningún archivo ni se ha copiado código extenso. Las citas `archivo:línea` son aproximadas y las rutas son relativas a `~/reference/` salvo que se indique otra raíz. El submódulo `ScalliGraph/` de 4 está vacío en este checkout (`thehive4/.gitmodules:1-3`), por lo que el detalle interno de esa librería se infiere de sus usos en TheHive.

---

## 0. Resumen ejecutivo

- **TheHive 3.5.2** es la última versión abierta de la rama 3. Es una aplicación **Scala/Play + Elasticsearch documental**, **single-tenant**, con frontend **AngularJS 1.7/Bootstrap 3**, roles gruesos (`read/write/admin/alert`) y una única API sin prefijo de versión. Su gran virtud es la simplicidad operativa y un flujo MISP/caso muy directo; su límite es el modelo documental y la ausencia de multi-tenancy, RBAC fino, TTPs y taxonomías.
- **TheHive 4.1.24** es la última versión abierta de la rama 4. Mantiene el mismo frontend AngularJS, pero cambia el corazón a un **modelo de grafo (JanusGraph/TinkerPop)**, introduce **organizaciones, perfiles/permisos, shares, observables de primera clase, TTPs/ATT&CK, taxonomías, custom fields tipados y API v1 con capa de compatibilidad v0**. Su límite es la complejidad operativa del grafo, la pérdida de algunas funciones de 3 (métricas, report templates, sync MISP completo) y un frontend que ya nació obsoleto.
- **Recomendación:** basar el clon en el **modelo de dominio y la API de 4**, **no** en su almacenamiento JanusGraph. Recuperar de 3 el flujo MISP, el ciclo de vida explícito de alertas, el borrado lógico y la trazabilidad de merges, y la simplicidad de despliegue. De 6 (comercial, solo comportamiento observable/documentación) tomar la UX de SPA moderna, la navegación y el refinamiento de listas/filtros, sin reutilizar código propietario.

---

## 1. Tabla comparativa de stack y arquitectura

| Dimensión | TheHive 3.5.2 | TheHive 4.1.24 | Lectura para el clon |
|---|---|---|---|
| Versión | `3.5.2-1` (`version.sbt:1`) | `4.1.24-1` (`build.sbt:5`) | Ambas son ramas cerradas. |
| Licencia | AGPL-3.0 (`LICENSE:1`) | AGPL-3.0 (`LICENSE:1`) | Copyleft fuerte: reutilizar código obliga a liberar el derivado bajo AGPL. |
| Lenguaje / build | Scala 2.12.16, sbt 1.3.8 (`project/Dependencies.scala:4`; `project/build.properties:1`) | Scala 2.12.13/2.13.1, sbt 1.4.6 (`build.sbt:6-8`; `project/build.properties:1`) | Misma familia; 4 admite cross-build 2.13. |
| Framework web | Play 2.8.16 (`project/plugins.sbt:4`) | Play 2.8.13 (`project/plugins.sbt:1`) | Play + Guice + Akka en ambas. |
| Persistencia principal | Elasticsearch como store documental; README declara 5.x y el compose usa 6.8.8 (`thehive-backend/conf/reference.conf:27-41`; `README.md:55`; `docker/thehive/docker-compose.yml:4`) | JanusGraph 0.5.3 / TinkerPop 3.4.6 (`project/Dependencies.scala:4,19-26`; `thehive/conf/reference.conf:1-13`) | 3 es “documentos + índice”; 4 es “grafo + índice”. |
| Backend de grafo | No aplica | BerkeleyDB por defecto; Cassandra/HBase vía JanusGraph (`conf/application.sample.conf:10-38`) | El grafo añade relaciones fuertes, pero encarece operación y backup. |
| Índice / búsqueda | Elasticsearch (`thehive-backend/conf/reference.conf:27-41`) | Lucene embebido por defecto; Elasticsearch opcional (`thehive/conf/reference.conf:4-7`; `conf/application.sample.conf:24-31`) | El clon moderno puede separar sistema de registro y motor de búsqueda. |
| Adjuntos | Datastore dentro de Elasticsearch (`thehive-backend/conf/reference.conf:43-55`; `controllers/AttachmentCtrl.scala`) | `localfs`, `database`, `hdfs`, `s3` (`thehive/app/org/thp/thehive/TheHiveModule.scala:70-75`) | 4 es mucho más flexible para object storage. |
| Modelo de datos | Documentos + modelos hijo (`Artifact.scala:55`; `Task.scala:38`; `Log.scala:35`) | Vértices y aristas (`Case.scala:32-70`; `Observable.scala:11-48`) | 4 modela relaciones que 3 duplica o embebe. |
| API | `/api` sin versión, “v0” de facto (`thehive-backend/conf/routes:8-127`) | `/api/v1/`, `/api/v0/` y `/api/` como compatibilidad (`thehive/app/org/thp/thehive/TheHiveRouter.scala:23-25`) | La convivencia v0/v1 de 4 es el patrón a replicar. |
| Frontend | AngularJS 1.7.8 + Bootstrap 3 + UI-Router 0.4.3 + Grunt/Bower (`ui/bower.json:6-19`; `ui/package.json`) | Idéntico stack + `qrcode`/`angular-qr`/multiselect (`frontend/bower.json:6-19,55-57`) | AngularJS está EOL; no es buena base técnica. |
| Autenticación | Local, AD, LDAP, OAuth2, PKI, API key (`thehive-backend/conf/reference.conf:57-72`; `services/OAuth2Srv.scala:18-49`) | Session, basic, local, key, AD, LDAP, PKI, OAuth2, header + TOTP (`TheHiveModule.scala:38-47`; `thehive/conf/reference.conf:24-37`) | 4 añade MFA/TOTP. |
| Autorización | Roles `read/write/admin/alert` (`models/Roles.scala:13-18`) | Permisos granulares con scopes + perfiles (`models/Permissions.scala:5-27`; `models/Role.scala:16-37`) | 4 es la base correcta para RBAC. |
| Multi-tenancy | No; single-tenant | Organizaciones, enlaces organización-organización y shares (`models/Organisation.scala:8-24`; `models/Share.scala:8-21`) | 4 es la base correcta para multi-tenant. |
| Cluster | Akka Cluster (`build.sbt:20-22`) | Akka Cluster + singleton de numeración (`build.sbt`; `services/CaseNumber.scala:20-58`) | Ambas escalan horizontalmente, con distinto coste. |
| Conectores | Módulos separados `thehive-misp` y `thehive-cortex` (`build.sbt:27-55`) | Conectores separados `misp/connector` y `cortex/connector` (`build.sbt:270-337`) | Ambos integran Cortex y MISP, con contratos distintos. |
| Despliegue típico | 1 app + Elasticsearch (`docker/thehive/docker-compose.yml:1-20`) | 1 app + JanusGraph (Cassandra/Berkeley) + índice + storage (`conf/application.sample.conf:10-53`) | 3 es más simple; 4 es más potente y más pesado. |
| Mantenimiento | Última release 3.5.2 del 2022-06-22 (`CHANGELOG.md:3`); repo congelado | Última release 4.1.24 del 2022-09-12 (`CHANGELOG.md:3`); repo congelado | 5/6 son comerciales y no están en estos árboles. |

### 1.1 Estructura de carpetas

**3.5.2** — monolito modular:

- `thehive-backend/` — modelos, controladores, servicios y rutas Play (`thehive-backend/app/models`, `controllers`, `services`; `thehive-backend/conf/routes`).
- `thehive-misp/` — conector MISP.
- `thehive-cortex/` — conector Cortex.
- `ui/` — frontend AngularJS.
- `migration/`, `package/`, `docker/`, `conf/`.

Evidencia: `build.sbt:5-60`; `thehive-backend/conf/routes:1-127`.

**4.1.24** — multi-módulo con núcleo extraído:

- `ScalliGraph/` — submódulo del motor de grafo, vacío en este checkout (`thehive4/.gitmodules:1-3`).
- `thehive/` — núcleo: modelos, controladores v0/v1, servicios, router raíz (`thehive/app/org/thp/thehive`).
- `dto/` — DTO de entrada/salida v0 y v1 (`dto/src/main/scala/org/thp/thehive/dto/{v0,v1}`).
- `client/`, `client-common/` — clientes HTTP.
- `cortex/` — `dto`, `client` y `connector`.
- `misp/` — `client` y `connector`.
- `frontend/` — frontend AngularJS.
- `migration/`, `package/`, `conf/`.

Evidencia: `build.sbt:77-82,156-180,259-337`; `thehive/app/org/thp/thehive/TheHiveRouter.scala:23-26`.

### 1.2 Consecuencia arquitectónica

- 3 usa Elasticsearch como **sistema de registro y de búsqueda**: los modelos hijo (`case_artifact`, `case_task`, `case_task_log`) viven dentro del documento del caso o como documentos enlazados por `parentId`. Esto simplifica el despliegue, pero dificulta relaciones N:M, multi-tenancy y compartición fina.
- 4 usa JanusGraph como **sistema de registro relacional** y Lucene/Elasticsearch solo como índice. Esto permite shares, organizaciones, TTPs y consultas de grafo, pero introduce una dependencia operativa pesada y un modelo de consulta propio (`ScalliGraph`).
- Para un clon moderno, la conclusión no es “copiar JanusGraph”, sino **copiar la semántica de dominio de 4** sobre un almacenamiento más estándar (PostgreSQL + OpenSearch + S3, o PostgreSQL con tablas de aristas/JSONB).

---

## 2. Diferencias de modelo de datos y API

### 2.1 Modelo de 3.5.2: documentos con modelos hijo

Entidades principales (`thehive3/thehive-backend/app/models/`):

| Entidad | Implementación | Campos/relaciones clave |
|---|---|---|
| `Case` | documento ES (`Case.scala:36-58`) | `caseId: Long` autogenerado por secuencia (`Case.scala:82-86`), `owner`, `metrics`, `mergeInto`, `mergeFrom`, `customFields` como JSON. |
| `Alert` | documento ES (`Alert.scala:34-78`) | `type/source/sourceRef`, `status` explícito (`New/Updated/Ignored/Imported`), `artifacts` embebidos, `caseTemplate`, `customFields` JSON. |
| `Artifact` | modelo hijo de `Case` (`Artifact.scala:55`) | `data`, `dataType`, `message`, `attachment`, `tlp`, `tags`, `ioc`, `sighted`, `status`, `reports` JSON (`Artifact.scala:44,133`). |
| `Task` | modelo hijo de `Case` (`Task.scala:38`) | `owner`, `status`, `flag`, `order`, `dueDate`, `group`. |
| `Log` | modelo hijo de `Task` (`Log.scala:35`) | `message`, `attachment`, `status`, `owner`. |
| `CaseTemplate` | documento ES (`CaseTemplate.scala:16-41`) | tareas embebidas, `metrics`, `customFields`. |
| `Dashboard` | documento ES (`Dashboard.scala:13-31`) | `title`, `description`, `status` (`Private/Shared/Deleted`), `definition`. |
| `User` | documento ES (`User.scala:16-26`) | `login`, `roles`, `key`, `password`, `preferences`. |

Puntos clave:

- **IDs:** `caseId` es un entero secuencial legible (`Case.scala:37,82-86`); el `_id` de un artifact se calcula con MD5 de `data + dataType + parent` (`Artifact.scala:99-116`); el `_id` de un alert se calcula con MD5 de `type|source|sourceRef` (`Alert.scala:107-115`).
- **Borrado lógico:** `CaseStatus` incluye `Deleted` y el modelo define `removeAttribute` (`Case.scala:21-24,80`); `AlertStatus` incluye `Ignored` (`Alert.scala:29-32`); `ArtifactStatus` incluye `Deleted` (`Artifact.scala:26-29`).
- **Merge:** se crea un caso nuevo con `mergeFrom` y los originales se marcan `Resolved/Duplicated` con `mergeInto` (`services/CaseMergeSrv.scala:275-326`).
- **Tags:** son `Seq[String]` planos en cada entidad (`Case.scala:44`; `Artifact.scala:40`; `Alert.scala:71`).
- **Custom fields:** son JSON embebido, definidos en una lista (`CustomFieldsCtrl.scala:30-40`; `Case.scala:57`).
- **Métricas:** campo `metrics` específico de caso y plantilla (`Case.scala:49`; `CaseTemplate.scala:28`).
- **Sin organizaciones, perfiles, shares, taxonomías, TTPs ni pages:** no hay modelos ni rutas para ello en `thehive-backend/app/models` ni en `conf/routes:1-127`.

### 2.2 Modelo de 4.1.24: grafo con aristas explícitas

Entidades principales (`thehive4/thehive/app/org/thp/thehive/models/`):

| Entidad | Implementación | Campos/relaciones clave |
|---|---|---|
| `Case` | vértice (`Case.scala:101-121`) | `number: Int`, `assignee`, `organisationIds: Set[EntityId]`, `owningOrganisation`, `caseTemplate`; `status` = `Open/Resolved/Duplicated` (`Case.scala:10-14`). |
| `Alert` | vértice (`Alert.scala:57-75`) | `externalLink`, `read`, `follow`, `pap`, `organisationId`, `caseId`; observables por aristas (`Alert.scala:25-38`). |
| `Observable` | vértice (`Observable.scala:35-48`) | `message`, `tlp`, `ioc`, `sighted`, `ignoreSimilarity`, `dataType`, `data`, `attachmentId`, `relatedId`, `organisationIds`; `Data` vértice único por contenido (`Observable.scala:73-83`). |
| `Task` | vértice (`Task.scala:33-47`) | `assignee`, `relatedId`, `organisationIds`; aristas a usuario, log y share. |
| `Log` | vértice (`Log.scala:16-22`) | `taskId`, `organisationIds`; adjuntos por arista. |
| `CaseTemplate` | vértice (`CaseTemplate.scala:35-46`) | `displayName`, `titlePrefix`, `summary`; tareas y custom fields por aristas; organización por arista (`CaseTemplate.scala:8-32`). |
| `Dashboard` | vértice (`Dashboard.scala:10`) | `definition` JSON; shares por organización con `writable` (`Dashboard.scala:12-16`). |
| `User` | vértice (`User.scala:18-27`) | `login`, `apikey`, `locked`, `password`, `totpSecret`, `failedAttempts`; perfil/organización por `Role` (`Role.scala:39-43`). |
| `Organisation` | vértice (`Organisation.scala:10`) | `name`, `description`; enlaces y taxonomías por aristas (`Organisation.scala:17-24`). |
| `Profile` / `Role` | vértices (`Role.scala:7-37`) | permisos por perfil; `admin`, `org-admin`, `analyst`, `read-only`. |
| `Share` | vértice (`Share.scala:9`) | `owner`; aristas a caso, observable, tarea y perfil (`Share.scala:11-21`). |
| `Tag` / `Taxonomy` | vértices (`Tag.scala:11-16`; `Taxonomy.scala:9-13`) | tags con `namespace/predicate/value/colour`; taxonomías con tags (`Taxonomy.scala:15-16`). |
| `CustomField` | vértice (`CustomField.scala:222-230`) | `name`, `displayName`, `description`, `type`, `mandatory`, `options`; valores tipados en aristas (`CustomField.scala:14-27`). |
| `Pattern` / `Procedure` | vértices (`Pattern.scala:9-27`; `Procedure.scala:9-14`) | ATT&CK (`patternId`, tácticas, plataformas, etc.) y procedimientos por caso (`Procedure.scala:16-17`). |
| `Page` | vértice (`Page.scala:9`) | `title`, `content`, `slug`, `order`, `category`; visible por organización (`Page.scala:5-6`). |
| `ReportTag` | vértice (`ReportTag.scala:14`) | resumen de analizadores Cortex (`origin`, `level`, `namespace`, `predicate`, `value`). |

Puntos clave:

- **Multi-tenancy desde el modelo:** cada caso/alerta/observable/tarea/log lleva `organisationIds` o `organisationId`; los shares determinan visibilidad y permisos (`Case.scala:118`; `Alert.scala:73`; `Observable.scala:47`; `Share.scala:9-21`).
- **Observables de primera clase:** un observable es un vértice independiente, enlazado a caso o alerta por `relatedId` y aristas (`Observable.scala:25-47`); los datos se deduplican en `Data` (`Observable.scala:73-83`; `services/ObservableSrv.scala:80-107`).
- **Custom fields tipados:** valores en aristas con `stringValue/booleanValue/integerValue/floatValue/dateValue` (`Case.scala:50-65`; `CustomField.scala:14-27`), no JSON libre.
- **Tags y taxonomías:** tags con namespace/predicado/valor y color; free tags por organización (`Tag.scala:11-16`; `services/TagSrv.scala:39-40,146-155`).
- **TTPs:** `Pattern` + `Procedure` + aristas (`Pattern.scala:29-30`; `Procedure.scala:16-17`).
- **Borrado duro:** `CaseSrv.delete` elimina el vértice y desvincula alertas (`services/CaseSrv.scala:231-250`); no hay `CaseStatus.Deleted`.
- **Merge múltiple:** se crea un caso nuevo, se comparten tareas/observables/procedimientos/custom fields y **se borran los originales** (`services/CaseSrv.scala:388-450`, especialmente `:442`).
- **Alertas:** el estado `New/Updated/Ignored/Imported` ya no se almacena; se deriva de `caseId` + `read` en la capa v0 (`controllers/v0/Conversion.scala:62-70`).
- **IDs de alerta:** en 4 la unicidad es `(type, source, sourceRef, organisationId)` (`Alert.scala:40-41`), mientras que 3 calcula un MD5 global de `type|source|sourceRef` (`Alert.scala:107-115`). Esto evita colisiones entre organizaciones, pero cambia el contrato de IDs.
- **Impacto y resolución como catálogos:** en 4 `ResolutionStatus` e `ImpactStatus` son vértices enlazados al caso (`Case.scala:16-46`), no enums cerrados como en 3 (`Case.scala:26-34`). Esto permite ampliar valores sin migrar el esquema.
- **Sin métricas:** no hay campo `metrics` en `Case` ni `CaseTemplate`; el equivalente son custom fields (`Case.scala:101-121`; `CaseTemplate.scala:35-46`).

### 2.3 Tabla entidad por entidad

| Entidad | 3.5.2 | 4.1.24 | Cambio clave |
|---|---|---|---|
| Caso | Documento; `caseId` Long; `owner`; `metrics`; `mergeInto/mergeFrom` (`Case.scala:36-58`) | Vértice; `number` Int; `assignee`; `organisationIds`; `caseTemplate`; sin `metrics` (`Case.scala:101-121`) | Pasa de documento single-tenant a vértice multi-tenant con lineage por aristas. |
| Alerta | Documento; artefactos embebidos; `status` almacenado (`Alert.scala:34-78`) | Vértice; observables separados; `read/follow/externalLink/pap` (`Alert.scala:57-75`) | Los artefactos de alerta se convierten en observables de primera clase. |
| Observable/Artifact | Modelo hijo `case_artifact`; ID MD5 por contenido+padre (`Artifact.scala:55,99-116`) | Vértice `Observable` + `Data`; ID de entidad; dedup por `Data` (`Observable.scala:35-48,73-83`) | De “artefacto de un caso” a “observable compartible y deduplicado”. |
| Tarea | Modelo hijo `case_task`; `owner` (`Task.scala:23-40`) | Vértice `Task`; `assignee`, `relatedId`, `organisationIds`; shares (`Task.scala:33-47`) | Tareas compartibles entre organizaciones con `actionRequired`. |
| Log | Modelo hijo `case_task_log`; adjunto embebido (`Log.scala:19-40`) | Vértice `Log`; adjunto por arista; `taskId` (`Log.scala:8-22`) | Se normaliza y se hace multi-tenant. |
| Plantilla | Documento global; tareas embebidas; `metrics` (`CaseTemplate.scala:16-41`) | Vértice por organización; tareas/custom fields por aristas; `displayName`, `summary` (`CaseTemplate.scala:8-46`) | De plantilla global a plantilla por organización. |
| Dashboard | Documento; `Private/Shared/Deleted` (`Dashboard.scala:13-31`) | Vértice; shares por organización con `writable` (`Dashboard.scala:10-16`) | De “privado/compartido” a compartición multi-org. |
| Usuario | Documento; roles planos (`User.scala:16-26`; `Roles.scala:13-18`) | Vértice; perfil por organización (`Role.scala:39-43`; `User.scala:18-27`) | De rol global a perfil por organización. |
| Organización | No existe | Vértice + enlaces (`Organisation.scala:8-24`) | Nuevo eje de multi-tenancy. |
| Perfil/permiso | No existe (solo roles) | `Profile` con permisos (`Role.scala:12-37`; `Permissions.scala:5-27`) | RBAC fino. |
| Tag | `Seq[String]` (`Case.scala:44`; `Artifact.scala:40`) | Vértice con namespace/color; free tags por org (`Tag.scala:11-16`; `TagSrv.scala:39-40`) | De string libre a tag tipado y taxonomía. |
| Custom field | JSON + lista (`Case.scala:57`; `CustomFieldsCtrl.scala:30-40`) | Vértice + valores tipados (`CustomField.scala:222-230`) | De JSON libre a esquema tipado. |
| TTP | No existe | `Pattern` + `Procedure` (`Pattern.scala:9-27`; `Procedure.scala:9-17`) | Nuevo módulo ATT&CK. |
| Taxonomía | No existe | `Taxonomy` + `Tag` (`Taxonomy.scala:9-16`) | Nuevo catálogo MISP. |
| Page | No existe | Vértice `Page` (`Page.scala:5-9`) | Nuevo contenido editable. |
| Share | No existe | Vértice `Share` (`Share.scala:8-21`) | Nuevo núcleo de compartición. |

### 2.4 API: v0, v1 y compatibilidad

**3.5.2** tiene una sola API, montada en `/api` (`thehive-backend/conf/routes:8-127`). Es la que después se llamó “v0”. Usa:

- `POST /api/<entidad>/_search` y `_stats` para listados y agregaciones (`routes:16-26`, `34-42`, `60-76`, `97-107`).
- `POST /api/_search` y `POST /api/_stats` globales (`routes:13-14`; `controllers/SearchCtrl.scala:31-70`).
- `GET /api/describe/_all` y `/api/describe/:model` para esquema (`routes:114-115`; `controllers/DescribeCtrl.scala:27-52`).
- Rutas de caso: `GET/POST /api/case`, `POST /api/case/_search`, `PATCH /api/case/_bulk`, `DELETE /api/case/:id/force`, `GET /api/case/:id/links`, `POST /api/case/:id1/_merge/:id2` (`routes:16-26`).
- Alertas: `create`, `update`, `delete`, `markAsRead/Unread`, `createCase`, `follow/unfollow`, `merge/:caseId`, `merge/_bulk`, `delete/_bulk`, `_fixStatus` (`routes:60-76`).
- Observables: bajo `/api/case/artifact` (`routes:34-42`); en alertas los artefactos van embebidos en el documento de alerta (`models/Alert.scala:73`).
- Tareas/logs: bajo `/api/case/task` y `/api/case/task/log` (`routes:44-58`).
- Plantillas: `/api/case/template` (`routes:28-32`).
- Dashboards: `/api/dashboard` (`routes:117-123`).
- Usuarios: `/api/user` (`routes:97-107`).
- No hay `/organisation`, `/profile`, `/permission`, `/tag`, `/taxonomy`, `/pattern`, `/procedure`, `/page`, `/share`, `/config`, `/admin`, `/monitor`.

**4.1.24** monta tres prefijos (`TheHiveRouter.scala:23-25`):

- `/api/v1/` — API nueva, rutas explícitas en `controllers/v1/Router.scala:27-194`.
- `/api/v0/` — API histórica, rutas en `controllers/v0/Router.scala:39-235`.
- `/api/` — alias de v0 para compatibilidad con clientes 3.x.

La API v1 usa un **Query DSL** genérico: los controladores exponen `publicProperties`, `initialQuery`, `pageQuery`, `outputQuery` y consultas extra (`controllers/v1/QueryableCtrl.scala:6-14`; `controllers/v1/CaseCtrl.scala:48-107`). No hay GraphQL operativo en 4.1.24: el test está comentado (`test/org/thp/thehive/controllers/v1/GraphqlTest.scala:12,43`).

**Capa de compatibilidad v0.** El DTO v0 traduce los nombres nuevos a los antiguos: `Observable -> case_artifact`, `Task -> case_task`, `Log -> case_task_log` (`controllers/v0/Conversion.scala:39-46`). También deriva el estado de alerta desde `caseId` + `read` (`Conversion.scala:62-70`). Esto demuestra que un clon moderno puede exponer una API nueva y, a la vez, una capa de compatibilidad para TheHive4py/clientes 3.x.

### 2.5 Tabla de endpoints por recurso

| Recurso | 3.5.2 | 4.1.24 v0 | 4.1.24 v1 | Nota |
|---|---|---|---|---|
| Login/logout | `/api/login`, `/api/logout` (`routes:8-9`) | `/api/v0/login`, `/api/v0/logout` (`v0/Router.scala:78-80`) | `/api/v1/login`, `/api/v1/logout`, TOTP (`v1/Router.scala:59-64`) | v1 añade MFA. |
| Caso | CRUD + bulk + stats + links + merge (`routes:16-26`) | CRUD + bulk + stats + links + merge (`v0/Router.scala:122-134`) | create/get/update/delete/merge/deleteCustomField (`v1/Router.scala:66-71`) | v1 no tiene bulk/stats; v0 sí. |
| Alerta | CRUD + bulk + merge + follow + fixStatus (`routes:60-76`) | CRUD + bulk + merge + follow (`v0/Router.scala:52-73`) | create/get/update/read/unread/follow/case/fixCaseLink (`v1/Router.scala:139-151`) | v1 no borra ni mergea alertas. |
| Observable/Artifact | `/case/artifact`; artefactos de alerta embebidos (`routes:34-42`; `Alert.scala:73`) | mismos paths (`v0/Router.scala:107-120`) | `/observable`, `/case/:id/observable`, `/alert/:id/artifact` (`v1/Router.scala:73-84`) | v1 normaliza el nombre. |
| Tarea | `/case/task` (`routes:44-50`) | `/case/task` (`v0/Router.scala:95-105`) | `/task`, `/case/:id/task` (`v1/Router.scala:122-129`) | v1 añade `actionRequired`. |
| Log | `/case/task/log` (`routes:51-58`) | `/case/task/log` (`v0/Router.scala:89-94`) | `/task/:id/log`, `/log/:id` (`v1/Router.scala:133-135`) | v1 simplifica. |
| Plantilla | `/case/template` (`routes:28-32`) | `/case/template` (`v0/Router.scala:82-88`) | `/caseTemplate` (`v1/Router.scala:86-89`) | v1 no borra plantillas. |
| Dashboard | `/dashboard` (`routes:117-123`) | `/dashboard` (`v0/Router.scala:153-159`) | sin ruta (controlador comentado) (`v1/Router.scala:20`) | Dashboards siguen en v0. |
| Usuario | `/user` (`routes:97-107`) | `/user` (`v0/Router.scala:220-233`) | `/user` + lock/delete/reset/avatar (`v1/Router.scala:92-104`) | v1 añade MFA/reset. |
| Organización | No existe | `/organisation` + links (`v0/Router.scala:180-187`) | create/get/update (`v1/Router.scala:106-108`) | Solo 4. |
| Perfil/permiso | No existe | `/profile`, `/permission` (`v0/Router.scala:196-204`) | `/profile` (`v1/Router.scala:176-179`) | Solo 4. |
| Tag | No existe | `/tag` (`v0/Router.scala:215-218`) | `/tag/:id` (`v1/Router.scala:181-183`) | Solo 4. |
| Custom field | Solo `useCount` (`routes:95`) | CRUD + useCount (`v0/Router.scala:144-151`) | list/create (`v1/Router.scala:137-138`) | 4 lo convierte en entidad. |
| Taxonomía | No existe | No existe | `/taxonomy` (`v1/Router.scala:153-158`) | Solo 4. |
| Pattern/Procedure | No existe | No existe | `/pattern`, `/procedure` (`v1/Router.scala:166-174`) | Solo 4. |
| Page | No existe | `/page` (`v0/Router.scala:189-194`) | No existe | API-only en 4. |
| Share | No existe | `/case/.../shares` (`v0/Router.scala:40-50`) | `/case/.../shares`, `/observable/.../shares` (`v1/Router.scala:110-120`) | Solo 4. |
| Config | No existe | `/config` (`v0/Router.scala:136-142`) | No existe | Solo 4. |
| Admin | No existe | No existe | `/admin/...` (`v1/Router.scala:45-56`) | Reindex, schema, logs, checks. |
| Monitor | No existe | No existe | `/monitor/disk` (`v1/Router.scala:192`) | Solo 4. |
| Describe | `/describe` (`routes:114-115`) | `/describe` (`v0/Router.scala:161-162`) | `/describe` (`v1/Router.scala:185-186`) | Ambos. |
| Stream | `/stream` (`routes:110-112`) | `/stream` (`v0/Router.scala:211-213`) | No existe | v1 no expone stream. |
| Stats global | `/api/_stats` (`routes:14`) | `/api/v0/_stats` (`v0/Router.scala:206`) | No existe | v1 tiene stats por entidad. |

---

## 3. Diferencias de UI y flujos

### 3.1 Stack de frontend

Ambas usan **AngularJS 1.7.8**, Bootstrap 3, UI-Router 0.4.3, Grunt y Bower (`thehive3/ui/bower.json:6-19`; `thehive4/frontend/bower.json:6-19`). 4 añade `qrcode.js` y `angular-qr` para MFA (`frontend/bower.json:55-57`) y multiselect.

No hay reescritura de frontend entre 3 y 4: la estructura de `views/partials` es casi la misma, con nuevas carpetas y pantallas en 4 (`thehive3/ui/app/views/partials` vs `thehive4/frontend/app/views/partials`).

### 3.2 Rutas y pantallas

| Pantalla / flujo | 3.5.2 | 4.1.24 |
|---|---|---|
| Ruta por defecto | `/cases` (`ui/app/scripts/app.js:48`) | `/index` -> home según permisos (`frontend/app/scripts/app.js:52-57,125-130`; `frontend/app/scripts/services/api/AuthenticationSrv.js:70-90`) |
| Home | My tasks / Waiting tasks (`app.js:111-118`; `views/app.main.html:1-80`) | My tasks / Waiting tasks, misma base (`app.js:131-135`; `views/partials/main/list.html`) |
| Casos | Lista + filtros + stats (`app.js:119-125`; `CaseListCtrl.js`) | Lista + filtros + mini-stats + acciones bulk + permisos (`app.js:143-152`; `CaseListCtrl.js:1-140`) |
| Caso: pestañas | Details, Tasks, Links, Alerts, Observables (`app.js:260-374`; `CaseTabsSrv.js:5-24`) | Details, Tasks, Observables, TTPs (`CaseTabsSrv.js:5-30`); Links/Alerts/Sharing como rutas (`app.js:369-425,453-465`) |
| Caso: métricas | Pestaña/sección Metrics (`views/partials/case/details/metrics.html:1-25`; `app.js:229-234`) | No existe; se sustituye por custom fields (`views/partials/case/details/custom.fields.html`) |
| Caso: TTPs | No existe | Pestaña TTPs con ATT&CK (`app.js:528-537`; `views/partials/case/case.procedures.html:1-20`) |
| Caso: sharing | No existe | Ruta/pestaña de compartición (`app.js:416-425`; `views/partials/case/case.sharing.html:1-30`) |
| Alertas | Lista + diálogo de evento + similitud + MISP link (`views/partials/alert/list.html`; `event.dialog.html`) | Lista + evento + similitud + `externalLink` + follow/unfollow (`views/partials/alert/list.html:196-203`; `AlertListCtrl.js:111-141`) |
| Dashboards | Lista/visor/creación/importación (`app.js:342-352`; `views/partials/dashboard/*`) | Igual, con compartición por organización (`app.js:549-567`; `Dashboard.scala:10-16`) |
| Búsqueda global | `/search?q` (`app.js:126-130`) | `/search?q` con Query v1 (`app.js:153-176`) |
| Settings personales | `/settings` (`app.js:147-175`) | `/settings` + MFA (`app.js:177-202`; `SettingsCtrl.js`) |
| Admin | Users, Case Templates, Report Templates, Metrics, Custom Fields, Observables, UI Settings (`app.js:196-258`) | Platform, Profiles, Taxonomies, ATT&CK, Organisations, Case Templates por org, Analyzer Templates, Custom Fields, Observables, UI Settings (`app.js:203-343`) |
| Cambio de organización | No existe | Modal de cambio + cookie `X-Organisation` (`RootCtrl.js:160-195`; `thehive/conf/reference.conf:31-32`) |
| MFA | No existe | Configuración TOTP en settings/admin (`SettingsCtrl.js`; `UserSrv.js`; `v1/Router.scala:62-64`) |
| TheHiveFS | No existe | WebDAV `/fs` (`TheHiveRouter.scala:26`; `controllers/dav/Router.scala:32-39`) |

### 3.3 Flujos de trabajo

**Caso: creación y plantillas.**

- 3: la plantilla es global, incluye tareas y métricas; el caso hereda `metrics` y `customFields` (`services/CaseSrv.scala:60-80`; `CaseTemplate.scala:28-30`).
- 4: la plantilla es por organización, incluye tareas y custom fields, y el caso guarda `caseTemplate` (`CaseTemplateSrv.scala:49-76`; `Case.scala:119`; `CaseTemplate.scala:35-46`). La creación desde plantilla se hace en `CaseCtrl.create` (`controllers/v1/CaseCtrl.scala:109-131`).

**Caso: cierre y merge.**

- 3: cerrar un caso cierra sus tareas abiertas (`controllers/CaseCtrl.scala:74-81`); el merge crea un caso nuevo, mueve tareas/artefactos y **marca los originales como `Resolved/Duplicated` con `mergeInto`** (`CaseMergeSrv.scala:296-326`). El borrado es lógico (`Case.scala:80`).
- 4: el cierre también cierra tareas, pero el merge **exige que todos los casos compartan organización/perfil y que el usuario sea `org-admin`**, y **borra los casos originales** (`services/CaseSrv.scala:388-450`; `:450`). El borrado es duro y solo lo puede hacer el propietario (`CaseSrv.scala:231-250`). Esto es una regresión de trazabilidad frente a 3.

**Alerta -> caso.**

- 3: `createCase` desde alerta, `mergeWithCase`, `bulkMerge`, `follow/unfollow`, estado explícito (`routes:60-76`; `controllers/AlertCtrl.scala:38-78`).
- 4: `createCase` y `fixCaseLink`, `read/unread`, `follow/unfollow`; el estado se deriva (`v1/Router.scala:139-151`; `v0/Conversion.scala:62-70`). El merge de alerta con caso existe en v0 (`v0/Router.scala:60-61`), pero no en v1.

**Observables.**

- 3: el artifact pertenece a un caso; en alertas los artefactos están embebidos (`Artifact.scala:55`; `Alert.scala:73`). La similitud se calcula por `dataType + data/attachment` (`services/ArtifactSrv.scala:152-195`). El ID se deriva del contenido y del padre (`Artifact.scala:99-116`).
- 4: el observable es un vértice con `relatedId` y `Data` deduplicado (`Observable.scala:35-48,73-83`; `ObservableSrv.scala:80-107`). Se puede compartir y enlazar a alertas/casos; `ignoreSimilarity` permite excluirlo de la similitud (`Observable.scala:40`; `CaseSrv.scala:651-671`).

**Permisos y administración.**

- 3: el acceso se controla con `authenticated(Roles.read/write/admin/alert)` en cada controlador (p. ej. `CaseCtrl.scala:43,61,95`; `AlertCtrl.scala:38,54,141`). El admin es un rol global (`Roles.scala:13-18`). La UI de administración exige rol `admin` (`ui/app/scripts/app.js:180-194`).
- 4: permisos por recurso y perfil (`Permissions.scala:5-27`; `Role.scala:16-37`), con guards en el frontend (`frontend/app/scripts/app.js:234-236,249-251,279-281,302-304`) y comprobaciones en backend (p. ej. `CaseCtrl.scala:150`; `AlertCtrl.scala:132`; `ObservableCtrl.scala:217`). El admin de plataforma y el `org-admin` son distintos (`Profile.scala:17,35`).

**MISP.**

- 3: el conector expone sincronización incremental, **sincronización completa** y **sincronización de artefactos** (`MispCtrl.scala:116-121`), además de exportación de caso (`MispCtrl.scala:149-159`).
- 4: el conector solo expone `_syncAlerts` y exportación (`misp/connector/.../Router.scala:13-20`; `MispCtrl.scala:32-50`). La importación convierte eventos MISP en alertas genéricas con `externalLink` (`MispImportSrv.scala:49-78`). Se pierden los endpoints manuales de sync total/artefactos de 3.

**Cortex.**

- 3: plantillas de reporte por analizador y tipo (`short`/`long`) (`thehive-cortex/.../ReportTemplate.scala:15-37`; `CortexCtrl.scala:114-137`).
- 4: plantillas de analizador (`AnalyzerTemplate`) con un contenido por worker (`cortex/connector/.../AnalyzerTemplate.scala:5-6`), manteniendo alias `/report/template` por compatibilidad (`cortex/connector/.../Router.scala:37-43`). Los reportes cortos se convierten en `ReportTag` (`ReportTag.scala:6-14`; `JobSrv.scala:238-241`).

### 3.4 Mejoras y regresiones de UI/UX

**Mejoras de 4:**

- Cambio de organización y multi-tenancy visible (`RootCtrl.js:160-195`; `reference.conf:31-32`).
- Administración por organización: usuarios, case templates, custom tags, UI config (`views/partials/admin/organisation/details.html:100-149`).
- Perfiles y permisos editables (`views/partials/admin/profile/list.html`; `ProfileListCtrl.js`).
- Taxonomías MISP y ATT&CK (`app.js:238-267`; `views/partials/admin/taxonomy/*`; `views/partials/admin/attack/*`).
- Pestaña TTPs en el caso (`CaseTabsSrv.js:24-29`; `case.procedures.html`).
- Compartición de caso/tarea/observable (`case.sharing.html:1-30`; `Share.scala:8-21`).
- Listados con Query v1, filtros rápidos, mini-stats y permisos por fila (`CaseListCtrl.js:1-140`; `views/partials/case/case.list.html:19-29`).
- Página de estado de plataforma, reindexación, logs y checks (`app.js:208-213`; `v1/Router.scala:45-56`).
- Plantillas de analizador y MFA (`app.js:306-343`; `bower.json:55-57`).

**Regresiones o pérdidas de 4:**

- Desaparecen las **métricas** de caso/plantilla y su administración (`3: app.js:229-234`; `metrics.html:1-25`; en 4 no hay campo `metrics`).
- Desaparecen las **report templates** de Cortex tal como existían; se sustituyen por analyzer templates (`3: ReportTemplate.scala:15-37`; `4: AnalyzerTemplate.scala:5-6`).
- El **merge** de 4 borra los casos originales y exige `org-admin`, frente al merge trazable de 3 (`3: CaseMergeSrv.scala:296-326`; `4: CaseSrv.scala:388-450`).
- El **borrado** de 4 es duro, frente al borrado lógico de 3 (`3: Case.scala:80`; `4: CaseSrv.scala:231-250`).
- El **estado de alerta** de 4 es derivado, no explícito; se pierde la semántica directa `New/Updated/Ignored/Imported` en el modelo (`3: Alert.scala:29-32,75`; `4: v0/Conversion.scala:62-70`).
- El **conector MISP** de 4 pierde la sync completa y la sync de artefactos (`3: MispCtrl.scala:116-121`; `4: misp Router.scala:13-20`).
- La **UI settings** de 4 se simplifica y pierde opciones de 3 como el operador AND/OR de tags (`3: views/partials/admin/ui-settings.html:28-70`; `4: views/partials/admin/ui-settings.html:1-30`).
- El frontend sigue en AngularJS 1.7, EOL, en ambas ramas.

---

## 4. Funcionalidades exclusivas de cada versión

### 4.1 Solo en 3.5.2

| Función | Evidencia | Valor para un clon |
|---|---|---|
| Elasticsearch como store único (documentos + búsqueda + adjuntos) | `thehive-backend/conf/reference.conf:27-55` | Despliegue simple para equipos pequeños; no escala a multi-tenant fino. |
| Métricas de caso y de plantilla | `models/Case.scala:49`; `models/CaseTemplate.scala:28`; `ui/app/scripts/app.js:229-234` | KPIs numéricos simples; se pueden modelar como custom fields de tipo número. |
| Administración de métricas | `ui/app/scripts/app.js:229-234`; `AdminMetricsCtrl.js` | Útil para reporting básico. |
| Report templates Cortex `short`/`long` | `thehive-cortex/.../ReportTemplate.scala:15-37`; `CortexCtrl.scala:114-137` | Se puede conservar como compatibilidad de analyzer templates. |
| Sync MISP completa y de artefactos | `thehive-misp/.../MispCtrl.scala:116-121` | Operación manual útil en incidentes; 4 la perdió. |
| Estado de alerta explícito (`New/Updated/Ignored/Imported`) y `fixStatus` | `models/Alert.scala:29-32,75`; `routes:64` | Ciclo de vida claro y auditable. |
| Rol `alert` para feeders | `models/Roles.scala:13-18` | Útil para cuentas de ingesta. |
| Plantillas de caso globales | `models/CaseTemplate.scala:16-41` | Simplicidad para single-tenant. |
| Borrado lógico de casos y artefactos | `models/Case.scala:80`; `models/Artifact.scala:59` | Recuperación y auditoría. |
| Merge trazable (marca duplicados, conserva originales) | `services/CaseMergeSrv.scala:296-326` | Linaje de casos; 4 lo pierde. |
| UI settings con operador AND/OR de tags | `ui/app/views/partials/admin/ui-settings.html:28-70` | Comportamiento de filtros configurable. |
| Webhooks simples (POST a URLs configuradas) | `services/WebHook.scala:26-46` | Integración mínima; 4 la sustituye por notificaciones con triggers. |
| API única sin versión | `thehive-backend/conf/routes:1-127` | Simplicidad para clientes; poca evolución. |
| Sin MFA, sin organizaciones, sin shares, sin TTPs, sin taxonomías, sin pages, sin S3/HDFS/WebDAV | Ausencia en `models/`, `conf/routes`; `Roles.scala` | Menos superficie y menos complejidad. |

### 4.2 Solo en 4.1.24

| Función | Evidencia | Valor para un clon |
|---|---|---|
| Modelo de grafo JanusGraph/TinkerPop | `project/Dependencies.scala:4,19-26`; `thehive/conf/reference.conf:1-13` | Relaciones fuertes; operación pesada. |
| Multi-tenancy: organizaciones y enlaces | `models/Organisation.scala:8-24`; `v0/Router.scala:180-187` | Base para MSSP/CSIRT multi-equipo. |
| RBAC: perfiles y permisos granulares | `models/Permissions.scala:5-27`; `models/Role.scala:16-37` | Seguridad y delegación. |
| Shares de caso/tarea/observable con perfil | `models/Share.scala:8-21`; `v1/Router.scala:110-120` | Colaboración inter-organización. |
| Observables de primera clase, compartibles y deduplicados | `models/Observable.scala:35-48,73-83`; `ObservableSrv.scala:80-107` | Núcleo de análisis moderno. |
| `ignoreSimilarity` en observables | `models/Observable.scala:40`; `CaseSrv.scala:651-671` | Control de falsos positivos en correlación. |
| `ReportTag` de analizadores Cortex | `models/ReportTag.scala:6-14`; `JobSrv.scala:238-241` | Resumen estructurado de análisis. |
| Custom fields tipados, obligatorios y con opciones | `models/CustomField.scala:222-230`; `Case.scala:50-65` | Formularios y validación serios. |
| TTPs: ATT&CK + procedimientos | `models/Pattern.scala:9-27`; `models/Procedure.scala:9-17`; `v1/Router.scala:166-174` | Mapeo de técnicas por caso. |
| Taxonomías MISP y tags con namespace/color | `models/Taxonomy.scala:9-16`; `models/Tag.scala:11-16`; `v1/Router.scala:153-158` | Estandarización de etiquetas. |
| Pages editables | `models/Page.scala:5-9`; `v0/Router.scala:189-194` | Contenido operativo; API-only en 4. |
| Plantillas de caso por organización | `models/CaseTemplate.scala:8-46`; `CaseTemplateSrv.scala:49-76` | Aislamiento multi-tenant. |
| Analyzer templates | `cortex/connector/.../AnalyzerTemplate.scala:5-6`; `Router.scala:29-43` | Plantillas de reporte unificadas. |
| Notificaciones: email, webhook, Mattermost, fichero y triggers | `TheHiveModule.scala:49-63`; `services/notification/*` | Automatización y alerting. |
| MFA/TOTP | `thehive/conf/reference.conf:33-36`; `models/User.scala:24`; `v1/Router.scala:62-64` | Requisito de seguridad actual. |
| Storage S3/HDFS/localfs/database | `TheHiveModule.scala:70-75` | Escalabilidad y separación de adjuntos. |
| WebDAV `/fs` | `TheHiveRouter.scala:26`; `controllers/dav/Router.scala:32-39` | Acceso tipo sistema de archivos. |
| API v1 + compatibilidad v0 | `TheHiveRouter.scala:23-25`; `v0/Conversion.scala:39-75` | Evolución sin romper clientes. |
| Endpoints de administración de plataforma | `v1/Router.scala:45-56` | Reindex, schema, logs, checks. |
| Compartición de dashboards por organización | `models/Dashboard.scala:12-16`; `Properties.scala:497-526` | Reporting multi-equipo. |
| `actionRequired` en tareas compartidas | `models/Share.scala:18`; `v1/Router.scala:127-129` | Coordinación entre organizaciones. |
| `externalLink` y `pap` en alertas | `models/Alert.scala:61,68` | Enlace a la fuente y PAP. |
| UI de organizaciones, perfiles, taxonomías, ATT&CK, platform status | `frontend/app/scripts/app.js:203-343` | Administración moderna. |

### 4.3 Funcionalidades compartidas

- Casos, tareas, logs, observables/artefactos, alertas, plantillas, dashboards.
- Búsqueda, filtros, estadísticas, auditoría y live stream (`3: routes:13-14,110-112`; `4: v0/Router.scala:211-213`).
- Cortex: análisis y responders (`3: CortexCtrl.scala:114-137`; `4: cortex Router.scala:17-50`).
- MISP: importación de eventos como alertas y exportación de casos (`3: MispCtrl.scala:149-159`; `4: misp Router.scala:13-20`).
- Exportación de observables a CSV/TXT/MISP (`3: CaseObservablesExportCtrl.js:40-58`; `4: CaseObservablesExportCtrl.js:40-58`).
- Similitud de observables y casos enlazados (`3: ArtifactSrv.scala:152-195`, `CaseSrv.scala:150-171`; `4: CaseSrv.scala:651-671`).
- Adjuntos, TLP/PAP, IOC/sighted, tags, custom fields (con implementaciones distintas).
- Autenticación AD/LDAP/OAuth2/PKI/API key (4 añade MFA).
- Dashboards con widgets `bar/line/donut/counter/text/multiline` (`3: ui/app/scripts/directives/dashboard/*`; `4: frontend/app/scripts/directives/dashboard/*`).

---

## 5. Recomendación razonada para un clon moderno

### 5.1 Veredicto: basar el dominio y la API en 4, no en 3

**Sí, conviene basar el clon en el modelo de 4**, por estas razones:

1. **Es el puente evolutivo real hacia 5/6.** 4 introduce organizaciones, RBAC, shares, observables de primera clase, TTPs y taxonomías, que son exactamente los ejes de producto que 5/6 mantienen y amplían. 3 es un callejón sin salida para multi-tenancy.
2. **La API v1 + v0 de 4 es el patrón correcto.** Permite una API nueva y una capa de compatibilidad para clientes 3.x (`TheHiveRouter.scala:23-25`; `v0/Conversion.scala:39-75`). Un clon moderno debe replicar esa estrategia, no la API única de 3.
3. **El modelo de 4 separa mejor las entidades.** Observables, shares, custom fields tipados, tags/taxonomías y TTPs son entidades de primera clase; en 3 son JSON, strings o artefactos embebidos.
4. **La seguridad de 4 es la base mínima actual.** Perfiles/permisos, MFA, scopes por organización y shares no existen en 3.

**Pero no conviene copiar el almacenamiento de 4.** JanusGraph 0.5.3 + Cassandra/BerkeleyDB + Lucene/ES es una carga operativa alta para un clon nuevo, y la librería `ScalliGraph` está fuera del árbol. La recomendación es **reimplementar la semántica de 4 sobre PostgreSQL** (entidades + tablas de aristas o JSONB) **+ OpenSearch** para búsqueda **+ S3** para adjuntos. Si se necesita grafo, usar PostgreSQL recursivo o una capa de aristas; no JanusGraph.

### 5.2 Qué tomar de 3.5.2

| Tomar | Por qué | Cómo llevarlo al clon |
|---|---|---|
| **Ciclo de vida explícito de alerta** (`New/Updated/Ignored/Imported`) | Es más claro y auditable que el estado derivado de 4 (`Alert.scala:29-32,75` vs `v0/Conversion.scala:62-70`). | Añadir `status` explícito además de `read/follow/caseId`, con transiciones auditadas. |
| **Borrado lógico y merge trazable** | 4 borra casos y pierde linaje (`Case.scala:80`; `CaseMergeSrv.scala:296-326` vs `CaseSrv.scala:442`). | `deleted_at`, `merged_into_id`, `merged_from_ids`, y conservar originales en solo lectura. |
| **Métricas como concepto de KPI** | 4 las eliminó, pero los equipos siguen necesitando KPIs numéricos (`Case.scala:49`; `CaseTemplate.scala:28`). | Implementarlas como custom fields de tipo `integer/float` con flag `metric`, o una entidad `Metric` separada. |
| **Sync MISP completa y de artefactos** | 4 solo conserva sync incremental (`MispCtrl.scala:116-121` vs `misp Router.scala:13-20`). | Endpoints/admin action para full sync y artifact sync, con progreso y auditoría. |
| **Plantillas globales y simplicidad single-tenant** | Útil para equipos pequeños y despliegues on-premise (`CaseTemplate.scala:16-41`). | Modo “single-org” que oculta la complejidad multi-tenant, pero con el mismo esquema. |
| **UI settings de filtros de tags (AND/OR)** | Comportamiento útil y barato (`ui-settings.html:28-70`). | Configuración por organización, no global. |
| **Compatibilidad de report templates `short`/`long`** | Hay clientes y plantillas existentes (`ReportTemplate.scala:15-37`). | Soportar `short`/`long` como alias de analyzer templates. |
| **Simplicidad operativa** | 3 se despliega con una app + ES (`docker-compose.yml:1-20`). | Ofrecer un “modo simple” con PostgreSQL + OpenSearch gestionados; evitar Cassandra/JanusGraph. |

### 5.3 Qué tomar de 4.1.24

| Tomar | Por qué | Cómo llevarlo al clon |
|---|---|---|
| **Organizaciones + shares + perfiles** | Es el núcleo de 5/6 (`Organisation.scala:8-24`; `Share.scala:8-21`; `Role.scala:16-37`). | Tablas `organisations`, `organisation_links`, `shares`, `profiles`, `permissions`; scoping por `org_id`. |
| **Observables de primera clase + `Data` deduplicado** | Permite correlación, compartición y análisis (`Observable.scala:35-48,73-83`). | `observables` + `observable_data` + `observable_links`; índice de `data` y hashes. |
| **Custom fields tipados** | Validación y reporting serios (`CustomField.scala:222-230`). | Tabla `custom_fields` + `custom_field_values` con columnas tipadas o JSONB validado. |
| **Tags con namespace/taxonomía** | Estandarización MISP (`Tag.scala:11-16`; `Taxonomy.scala:9-16`). | `tags(namespace,predicate,value,colour)` + `taxonomies` + import de `machinetag.json`. |
| **TTPs/ATT&CK** | Mapeo de técnicas por caso (`Pattern.scala:9-27`; `Procedure.scala:9-17`). | `patterns` + `procedures` + import STIX/ATT&CK. |
| **Plantillas por organización** | Aislamiento multi-tenant (`CaseTemplate.scala:8-46`). | `case_templates.org_id`; tareas/custom fields por tablas de unión. |
| **API v1 + v0 compat** | Evolución sin romper clientes (`TheHiveRouter.scala:23-25`). | `/api/v1` nuevo; `/api/v0` y `/api` adaptadores; DTO de conversión. |
| **Notificaciones y triggers** | Automatización (`TheHiveModule.scala:49-63`). | Email/webhook/Mattermost + reglas por evento; outbox transaccional. |
| **MFA/TOTP** | Requisito de seguridad (`User.scala:24`; `reference.conf:33-36`). | TOTP + recovery codes; política por organización. |
| **S3/HDFS/WebDAV** | Escalabilidad y acceso (`TheHiveModule.scala:70-75`; `TheHiveRouter.scala:26`). | S3 primero; WebDAV opcional. |
| **Admin de plataforma** | Operación real (`v1/Router.scala:45-56`). | Reindex, health, logs, checks, migraciones. |
| **`actionRequired` y shares de tareas** | Coordinación inter-org (`Share.scala:18`). | Estado por share, no por tarea global. |
| **`externalLink`, `pap`, `ignoreSimilarity`, `ReportTag`** | Riqueza de alertas/observables (`Alert.scala:61,68`; `Observable.scala:40`; `ReportTag.scala:6-14`). | Incluirlos desde el inicio. |

### 5.4 Qué tomar de 6 (comercial, solo comportamiento observable/documentación)

No hay código fuente de 5/6 en este workspace. Lo observable en una instancia local de TheHive 6.0.0 es:

- **SPA moderna:** bundles React con hashes (`index-*.js`, `flow-*.js`, `antd-*.js`), Ant Design, Bootstrap 5.3, Font Awesome 6 Pro, tipografía Nunito Sans.
- **API v1:** la página llama a `/api/v1/status` (`cases-inspect.json`, `metadata.responses`).
- **Versión 6.0.0, UI en español, banner de licencia “Platinum/Trial”** (`cases-inspect.json`, accesibilidad).
- **Navegación y listas:** “Casos”, “Exportar lista”, “Filtros rápidos”, “Add filter”, “Mostrar”, “Search”, “waiting Tasks” (`cases-inspect.json`, accesibilidad). Es una evolución de la arquitectura de la información de 4, no una revolución de dominio.

Recomendación para el clon:

1. **Frontend React + Ant Design (o equivalente)** en lugar de AngularJS 1.7. Replicar la arquitectura de información de 4/6: sidebar, lista de casos con filtros rápidos, detalle con pestañas, dashboards, administración por organización.
2. **API REST v1 con OpenAPI** y una capa v0 de compatibilidad. Mantener `/api/v1/status`, `/api/v1/case`, `/api/v1/observable`, etc.
3. **i18n desde el inicio** (español/inglés), como se observa en 6.
4. **UX de licenciamiento/trial** solo si el producto lo necesita; no copiar textos, marcas ni assets propietarios.
5. **No copiar código de 6**: es propietario. Reimplementar comportamiento a partir de documentación y observación.

### 5.5 Arquitectura propuesta para el clon

```
Frontend React/AntD
        |
API REST /api/v1 (+ /api/v0 compat, OpenAPI)
        |
Backend (capa de aplicación)
  - Casos, alertas, observables, tareas, logs, plantillas
  - Organizaciones, perfiles, shares, RBAC
  - TTPs, taxonomías, custom fields, dashboards
  - Notificaciones, auditoría, jobs
        |
PostgreSQL (sistema de registro)
  - entidades + tablas de aristas / JSONB
  - outbox para eventos
        |
OpenSearch (búsqueda y agregaciones)
        |
S3 (adjuntos) + antivirus/scan opcional
```

Decisiones clave:

- **PostgreSQL como sistema de registro**, no JanusGraph. Las relaciones se modelan con tablas de unión (`case_observables`, `case_tasks`, `shares`, `tags`) o con `JSONB` para atributos variables.
- **OpenSearch solo como índice derivado**, reconstruible desde PostgreSQL. Esto evita el acoplamiento de 3 (ES como store) y la complejidad de 4 (grafo + índice).
- **Outbox + worker** para notificaciones, webhooks y sincronización MISP/Cortex. No hacer llamadas externas dentro de la transacción.
- **API v1 estable + v0 adaptador** para migrar clientes. Mantener los nombres antiguos (`case_artifact`, `case_task`, `case_task_log`) en v0 (`v0/Conversion.scala:39-46`).
- **Auditoría inmutable** desde el día 1; 3 y 4 ya tienen `AuditSrv`, pero el clon debe hacerla explícita y consultable.
- **Importadores**: desde Elasticsearch 3.x y desde JanusGraph 4.x. La migración de 3 a 4 ya existe en 4 (`migration/`), y es una buena referencia de mapeo, no de código a copiar.

### 5.6 Roadmap de paridad sugerido

| Fase | Alcance | Referencia |
|---|---|---|
| 1. Núcleo | Casos, tareas, logs, observables, alertas, plantillas, adjuntos, auditoría, búsqueda | 3 y 4 |
| 2. Multi-tenant | Organizaciones, perfiles/permisos, shares, cambio de org, MFA | 4 |
| 3. Conocimiento | Tags/taxonomías, custom fields tipados, TTPs/ATT&CK, dashboards | 4 |
| 4. Integraciones | Cortex (analyzers/responders), MISP (import/export/sync), notificaciones | 3 + 4 |
| 5. Compatibilidad | API v0, importadores 3/4, exportación de observables | 4 |
| 6. UX moderna | SPA React/AntD, i18n, filtros rápidos, dashboards | 6 observable |

### 5.7 Riesgos y no objetivos

- **Licencia:** 3 y 4 son AGPL-3.0 (`LICENSE:1`). Si se reutiliza código, el clon debe cumplir AGPL (incluido el uso en red). Si se reimplementa desde cero, usar este documento como especificación y no copiar fragmentos. 5/6 son comerciales: no reutilizar su código.
- **No copiar JanusGraph/ScalliGraph** para un producto nuevo: la dependencia está fuera del árbol y su operación es costosa.
- **No copiar AngularJS 1.7**: está EOL y condiciona la UX.
- **No perder trazabilidad:** el borrado duro y el merge destructivo de 4 son un riesgo funcional; el clon debe conservar linaje.
- **No sobrecargar el modelo con métricas y custom fields a la vez:** elegir custom fields tipados y, si se necesitan KPIs, una marca `metric` sobre ellos.
- **No prometer paridad 1:1 con 5/6** sin acceso a su documentación completa; la sección 5.4 se limita a lo observable.

---

## 6. Anexo: archivos clave para revisar

| Tema | 3.5.2 | 4.1.24 |
|---|---|---|
| Build/módulos | `build.sbt:5-60` | `build.sbt:77-82,259-337` |
| Dependencias | `project/Dependencies.scala:4,22-25` | `project/Dependencies.scala:4,19-26` |
| Configuración | `thehive-backend/conf/reference.conf:27-72` | `thehive/conf/reference.conf:1-37`; `conf/application.sample.conf:10-53` |
| Rutas | `thehive-backend/conf/routes:1-127` | `thehive/app/org/thp/thehive/TheHiveRouter.scala:23-26`; `controllers/v1/Router.scala:27-194`; `controllers/v0/Router.scala:39-235` |
| Modelo caso | `models/Case.scala:36-58` | `models/Case.scala:101-121` |
| Modelo alerta | `models/Alert.scala:34-78` | `models/Alert.scala:57-75` |
| Modelo observable | `models/Artifact.scala:31-45` | `models/Observable.scala:35-48,73-83` |
| Multi-tenancy | No existe | `models/Organisation.scala:8-24`; `models/Share.scala:8-21`; `models/Role.scala:16-43` |
| TTPs | No existe | `models/Pattern.scala:9-27`; `models/Procedure.scala:9-17` |
| Taxonomías | No existe | `models/Taxonomy.scala:9-16`; `models/Tag.scala:11-16` |
| Custom fields | `models/Case.scala:57`; `controllers/CustomFieldsCtrl.scala:30-40` | `models/CustomField.scala:14-27,222-230` |
| Frontend rutas | `ui/app/scripts/app.js:48-390` | `frontend/app/scripts/app.js:52-568` |
| Frontend tabs | `ui/app/scripts/services/CaseTabsSrv.js:5-24` | `frontend/app/scripts/services/ui/CaseTabsSrv.js:5-30` |
| Cortex | `thehive-cortex/.../CortexCtrl.scala:114-137`; `ReportTemplate.scala:15-37` | `cortex/connector/.../Router.scala:17-50`; `AnalyzerTemplate.scala:5-6` |
| MISP | `thehive-misp/.../MispCtrl.scala:116-159` | `misp/connector/.../Router.scala:13-20`; `MispImportSrv.scala:49-78` |
| Licencia | `LICENSE:1` | `LICENSE:1` |
| Changelog | `CHANGELOG.md:3` | `CHANGELOG.md:3` |

**Documento complementario:** `/opt/myhive/docs/analysis/backend-thehive4.md` profundiza en el backend de 4 (modelo, endpoints, permisos y autenticación). Este documento se centra en la comparación 3 vs 4 y en la decisión de base para el clon.
