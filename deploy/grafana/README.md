# Grafana para Nuestracolmena

Gráficas de lo que se ve en Nuestracolmena: Grafana lee **directamente** la base PostgreSQL con un rol de
solo lectura (`nuestracolmena_grafana`) y la web la sirve en la subruta **`/grafana/`**. En la app hay un
botón «Gráficas» en el menú lateral que la abre en otra pestaña.

## Dashboards (carpeta «Nuestracolmena»)

Todos tienen el filtro **Organización** (SOC, Partner… o todas), rango de tiempo (por defecto 7 días) y
se refrescan cada 30 s.

| Dashboard | Qué muestra |
|---|---|
| **Resumen SOC** (`nc-resumen`, página de inicio) | Alertas nuevas, alertas y casos del rango, tareas pendientes, tiempo medio de resolución; alertas en el tiempo por severidad; por fuente, estado, tags y reglas (`rule:`/`sid:`); casos creados vs. cerrados, por severidad, estado y analista; tablas de casos abiertos y últimas alertas (el número de caso abre el caso en Nuestracolmena). |
| **Observables e inteligencia** (`nc-inteligencia`) | Observables por tipo y en el tiempo, IOC, avistados, observables repetidos (correlación), análisis de Cortex por analizador y estado, veredictos por nivel de taxonomía, tabla de maliciosos/sospechosos, técnicas y tácticas MITRE ATT&CK. |
| **Operación** (`nc-operacion`) | Tareas por estado, vencidas y completadas; eventos de SLA; actividad de auditoría por objeto, usuario y acción; % de alertas que pasan a caso y tiempo alerta → caso (mediana y p90). |

## Instalar / actualizar

**Servidor de casa (servidor de casa)** — Postgres publicado en `192.0.2.10:5433`, Grafana en `:3030`:

```bash
bash deploy/grafana/setup.sh                 # crea .env y contraseñas, el rol de solo lectura y el contenedor
docker exec myhive-web nginx -s reload       # la primera vez (deploy/myhive-nginx.conf ya trae /grafana/)
```

URL: `https://nuestracolmena.example.com/grafana/` · usuario `admin` · contraseña en `deploy/grafana/.env`
(`GRAFANA_ADMIN_PASSWORD`). El login de Grafana es independiente del de Nuestracolmena.

**VM del CyberSOC** — servicio opcional `grafana` en `deploy/cybersoc-vm/docker-compose.yml`
(perfil `grafana`); pasos en `deploy/cybersoc-vm/README.md`, sección Grafana.

## Cambiar o añadir paneles

Los JSON de `dashboards/` se generan con `build-dashboards.py` (Python 3, sin dependencias):

```bash
python3 deploy/grafana/build-dashboards.py   # regenera dashboards/*.json
python3 deploy/grafana/check-dashboards.py   # ejecuta en Grafana la consulta de cada panel y avisa de errores
```

Grafana recarga los JSON solo (cada 30 s). Los dashboards aprovisionados no se pueden guardar desde la UI:
para experimentar usa «Guardar como» en otra carpeta, o edita el generador.

Notas para escribir consultas: las tablas de Prisma van entre comillas (`"Alert"`, `"Case"`, columnas como
`"organisationId"`); las fechas son UTC sin zona; los usuarios se leen de la vista `grafana_user` (sin hashes).
Si una consulta necesita otra tabla, añade el `GRANT SELECT` en `grafana-readonly.sql` y vuelve a ejecutar
`setup.sh`. Los enlaces a la app usan el prefijo `/grafana/..` porque Grafana antepone su subruta a los
enlaces que empiezan por `/`.
