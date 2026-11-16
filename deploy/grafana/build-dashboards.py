#!/usr/bin/env python3
"""Genera los dashboards de Grafana de Nuestracolmena en deploy/grafana/dashboards/.

Uso: python3 deploy/grafana/build-dashboards.py
Edita las consultas aquí y vuelve a ejecutarlo; Grafana recarga los JSON solo (cada 30 s).
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent / "dashboards"
# Grafana antepone su subruta (/grafana) a los enlaces que empiezan por "/"; con "/grafana/.." el
# navegador vuelve a la raíz de Nuestracolmena (/cases, /alerts).
APP = "/grafana/.."
DS = {"type": "grafana-postgresql-datasource", "uid": "nuestracolmena-pg"}


def org(alias=None):
    col = f'{alias}."organisationId"' if alias else '"organisationId"'
    return f'{col} IN (SELECT id FROM "Organisation" WHERE name IN ($org))'


def sev(col="severity"):
    return (f"CASE {col} WHEN 1 THEN 'Baja' WHEN 2 THEN 'Media' WHEN 3 THEN 'Alta' "
            f"WHEN 4 THEN 'Crítica' ELSE 'Otra' END")


SEV_COLORS = {"Baja": "green", "Media": "yellow", "Alta": "orange", "Crítica": "red"}
LEVEL_COLORS = {"safe": "green", "info": "blue", "suspicious": "orange", "malicious": "red"}
STAGE_COLORS = {"New": "blue", "InProgress": "orange", "Closed": "green", "Imported": "purple", "Ignored": "text"}


def color_overrides(mapping):
    return [{"matcher": {"id": "byName", "options": name},
             "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": color}}]}
            for name, color in mapping.items()]


class Board:
    def __init__(self, uid, title, description):
        self.uid, self.title, self.description = uid, title, description
        self.panels = []
        self.y = 0
        self.row_h = 0
        self.x = 0

    def _place(self, w, h):
        if self.x + w > 24:
            self.y += self.row_h
            self.x, self.row_h = 0, 0
        pos = {"x": self.x, "y": self.y, "w": w, "h": h}
        self.x += w
        self.row_h = max(self.row_h, h)
        return pos

    def newline(self):
        if self.x:
            self.y += self.row_h
            self.x, self.row_h = 0, 0

    def add(self, ptype, title, sql, w, h, fmt="table", description="", options=None,
            defaults=None, overrides=None, transformations=None):
        panel = {
            "id": len(self.panels) + 1,
            "type": ptype,
            "title": title,
            "description": description,
            "datasource": DS,
            "gridPos": self._place(w, h),
            "targets": [{"refId": "A", "datasource": DS, "editorMode": "code", "format": fmt,
                         "rawQuery": True, "rawSql": " ".join(sql.split())}],
            "fieldConfig": {"defaults": defaults or {}, "overrides": overrides or []},
            "options": options or {},
        }
        if transformations:
            panel["transformations"] = transformations
        self.panels.append(panel)
        return panel

    # --- tipos de panel ---
    def stat(self, title, sql, w=4, h=4, unit="none", color="blue", decimals=None, description="",
             no_value="0"):
        defaults = {"unit": unit, "color": {"mode": "fixed", "fixedColor": color},
                    "noValue": no_value}
        if decimals is not None:
            defaults["decimals"] = decimals
        return self.add("stat", title, sql, w, h, description=description, defaults=defaults, options={
            "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
            "colorMode": "background", "graphMode": "none", "textMode": "value", "justifyMode": "center"})

    def series(self, title, sql, w=12, h=9, bars=True, stack=True, colors=None, description=""):
        custom = {"drawStyle": "bars" if bars else "line", "fillOpacity": 80 if bars else 15,
                  "lineWidth": 1 if bars else 2, "showPoints": "never" if bars else "auto",
                  "stacking": {"mode": "normal" if stack else "none", "group": "A"},
                  "spanNulls": False, "barAlignment": 0}
        panel = self.add("timeseries", title, sql, w, h, fmt="time_series", description=description,
                        defaults={"custom": custom, "min": 0, "decimals": 0,
                                  "color": {"mode": "palette-classic"}},
                        overrides=color_overrides(colors or {}),
                        options={"legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
                                 "tooltip": {"mode": "multi", "sort": "desc"}})
        panel["maxDataPoints"] = 60 if bars else 200
        return panel

    def pie(self, title, sql, w=8, h=9, colors=None, description=""):
        return self.add("piechart", title, sql, w, h, description=description,
                        defaults={"color": {"mode": "palette-classic"}, "decimals": 0},
                        overrides=color_overrides(colors or {}),
                        # Una fila = un campo, así cada categoría toma su propio color de la paleta.
                        transformations=[{"id": "rowsToFields", "options": {}}],
                        options={"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                                 "pieType": "donut", "displayLabels": ["value"],
                                 "legend": {"displayMode": "table", "placement": "right", "showLegend": True,
                                            "values": ["value", "percent"]},
                                 "tooltip": {"mode": "single"}})

    def bars(self, title, sql, w=8, h=9, colors=None, color="blue", description=""):
        # Barras horizontales: la 1.ª columna (texto) es la categoría, la 2.ª el valor.
        return self.add("barchart", title, sql, w, h, description=description,
                        defaults={"color": {"mode": "fixed", "fixedColor": color}, "min": 0, "decimals": 0,
                                  "custom": {"fillOpacity": 80, "lineWidth": 1, "gradientMode": "none",
                                             "axisPlacement": "auto", "axisSoftMin": 0}},
                        overrides=color_overrides(colors or {}),
                        options={"orientation": "horizontal", "showValue": "always", "barWidth": 0.75,
                                 "groupWidth": 0.7, "xTickLabelRotation": 0, "xTickLabelMaxLength": 32,
                                 "stacking": "none", "fullHighlight": False, "barRadius": 0.05,
                                 "legend": {"showLegend": False, "displayMode": "list", "placement": "bottom"},
                                 "tooltip": {"mode": "single", "sort": "none"}})

    def table(self, title, sql, w=24, h=9, overrides=None, description=""):
        return self.add("table", title, sql, w, h, description=description,
                        defaults={"custom": {"align": "auto", "filterable": True,
                                             "cellOptions": {"type": "auto"}}},
                        overrides=overrides or [],
                        options={"showHeader": True, "cellHeight": "sm",
                                 "footer": {"show": False, "reducer": ["sum"], "fields": ""}})

    def to_json(self):
        return {
            "uid": self.uid,
            "title": self.title,
            "description": self.description,
            "tags": ["nuestracolmena"],
            "timezone": "browser",
            "editable": False,
            "graphTooltip": 1,
            "schemaVersion": 39,
            "version": 1,
            "refresh": "30s",
            "time": {"from": "now-7d", "to": "now"},
            "timepicker": {"refresh_intervals": ["10s", "30s", "1m", "5m", "15m", "1h"]},
            "templating": {"list": [{
                "name": "org", "label": "Organización", "type": "query", "datasource": DS,
                "query": 'SELECT name FROM "Organisation" ORDER BY name',
                "definition": 'SELECT name FROM "Organisation" ORDER BY name',
                "refresh": 1, "multi": True, "includeAll": True,
                "current": {"selected": True, "text": ["All"], "value": ["$__all"]},
                "sort": 1, "hide": 0}]},
            "links": [
                {"title": "Resumen SOC", "type": "link", "url": "/grafana/d/nc-resumen", "icon": "dashboard",
                 "keepTime": True, "includeVars": True},
                {"title": "Observables e inteligencia", "type": "link", "url": "/grafana/d/nc-inteligencia",
                 "icon": "dashboard", "keepTime": True, "includeVars": True},
                {"title": "Operación", "type": "link", "url": "/grafana/d/nc-operacion", "icon": "dashboard",
                 "keepTime": True, "includeVars": True},
                {"title": "Abrir Nuestracolmena", "type": "link", "url": APP + "/cases", "icon": "external link",
                 "targetBlank": True},
            ],
            "annotations": {"list": []},
            "panels": self.panels,
        }


def link_override(column, url, title):
    return {"matcher": {"id": "byName", "options": column},
            "properties": [{"id": "links", "value": [{"title": title, "url": url, "targetBlank": True}]}]}


def color_text_override(column, mapping):
    return {"matcher": {"id": "byName", "options": column},
            "properties": [
                {"id": "custom.cellOptions", "value": {"type": "color-text"}},
                {"id": "mappings", "value": [{"type": "value", "options": {
                    k: {"color": v, "index": i} for i, (k, v) in enumerate(mapping.items())}}]}]}


# ---------------------------------------------------------------- Resumen SOC
def resumen():
    b = Board("nc-resumen", "Nuestracolmena — Resumen SOC",
              "Alertas y casos de Nuestracolmena: volumen, severidad, fuentes y estado.")
    b.stat("Alertas nuevas (sin revisar)",
           f"""SELECT count(*) AS "Alertas" FROM "Alert" WHERE stage = 'New' AND {org()}""",
           color="red", description="Alertas en estado New, sin importar el rango de tiempo.")
    b.stat("Alertas en el rango",
           f"""SELECT count(*) FROM "Alert" WHERE $__timeFilter(date) AND {org()}""", color="orange")
    b.stat("Casos abiertos",
           f"""SELECT count(*) FROM "Case" WHERE stage <> 'Closed' AND "mergedIntoCaseId" IS NULL
               AND {org()}""", color="purple")
    b.stat("Casos cerrados en el rango",
           f"""SELECT count(*) FROM "Case" WHERE "closedAt" IS NOT NULL AND $__timeFilter("closedAt")
               AND {org()}""", color="green")
    b.stat("Tareas pendientes",
           f"""SELECT count(*) FROM "CaseTask" WHERE status IN ('Waiting','InProgress') AND {org()}""",
           color="blue")
    b.stat("Tiempo medio de resolución",
           f"""SELECT avg(extract(epoch FROM ("closedAt" - "startDate")))::float AS "Resolución"
               FROM "Case" WHERE "closedAt" IS NOT NULL AND $__timeFilter("closedAt") AND {org()}""",
           unit="s", color="text", decimals=1, no_value="—",
           description="Promedio entre el inicio y el cierre de los casos cerrados en el rango.")
    b.newline()

    b.series("Alertas en el tiempo por severidad",
             f"""SELECT $__timeGroupAlias(date, $__interval, 0), {sev()} AS metric, count(*) AS value
                 FROM "Alert" WHERE $__timeFilter(date) AND {org()} GROUP BY 1, 2 ORDER BY 1""",
             w=16, colors=SEV_COLORS)
    b.pie("Alertas por fuente",
          f"""SELECT source AS "Fuente", count(*) AS "Alertas" FROM "Alert"
              WHERE $__timeFilter(date) AND {org()} GROUP BY 1 ORDER BY 2 DESC""")
    b.newline()

    b.bars("Alertas por estado",
           f"""SELECT COALESCE(s.value, a.stage) AS "Estado", count(*) AS "Alertas"
               FROM "Alert" a LEFT JOIN "AlertStatus" s ON s.id = a."statusId"
               WHERE $__timeFilter(a.date) AND {org('a')} GROUP BY 1 ORDER BY 2 DESC""",
           color="blue")
    b.bars("Top 10 tags de alertas",
           f"""SELECT t AS "Tag", count(*) AS "Alertas" FROM "Alert", unnest(tags) AS t
               WHERE $__timeFilter(date) AND {org()} GROUP BY 1 ORDER BY 2 DESC LIMIT 10""",
           color="purple")
    b.bars("Top 10 reglas (Wazuh / Suricata)",
           f"""SELECT t AS "Regla", count(*) AS "Alertas" FROM "Alert", unnest(tags) AS t
               WHERE (t LIKE 'rule:%' OR t LIKE 'sid:%') AND $__timeFilter(date) AND {org()}
               GROUP BY 1 ORDER BY 2 DESC LIMIT 10""",
           color="orange", description="Tags rule:<id> de Wazuh y sid:<id> de Suricata.")
    b.newline()

    b.series("Casos creados vs. cerrados",
             f"""SELECT $__timeGroupAlias("createdAt", $__interval, 0), 'Creados' AS metric, count(*) AS value
                 FROM "Case" WHERE $__timeFilter("createdAt") AND {org()} GROUP BY 1, 2
                 UNION ALL
                 SELECT $__timeGroupAlias("closedAt", $__interval, 0), 'Cerrados' AS metric, count(*) AS value
                 FROM "Case" WHERE "closedAt" IS NOT NULL AND $__timeFilter("closedAt") AND {org()}
                 GROUP BY 1, 2 ORDER BY 1""",
             w=12, stack=False, colors={"Creados": "purple", "Cerrados": "green"})
    b.pie("Casos abiertos por severidad",
          f"""SELECT {sev()} AS "Severidad", count(*) AS "Casos" FROM "Case"
              WHERE stage <> 'Closed' AND "mergedIntoCaseId" IS NULL AND {org()} GROUP BY 1 ORDER BY 2 DESC""",
          w=6, colors=SEV_COLORS)
    b.pie("Casos por estado (rango)",
          f"""SELECT COALESCE(s.value, c.stage) AS "Estado", count(*) AS "Casos"
              FROM "Case" c LEFT JOIN "CaseStatus" s ON s.id = c."statusId"
              WHERE $__timeFilter(c."createdAt") AND {org('c')} GROUP BY 1 ORDER BY 2 DESC""",
          w=6, colors={"New": "blue", "InProgress": "orange", "TruePositive": "red",
                       "FalsePositive": "green", "Indeterminate": "text", "Duplicated": "purple"})
    b.newline()

    b.bars("Casos abiertos por asignado",
           f"""SELECT COALESCE(u.name, 'Sin asignar') AS "Analista", count(*) AS "Casos"
               FROM "Case" c LEFT JOIN grafana_user u ON u.id = c."assigneeId"
               WHERE c.stage <> 'Closed' AND c."mergedIntoCaseId" IS NULL AND {org('c')}
               GROUP BY 1 ORDER BY 2 DESC""",
           w=8, color="purple")
    b.table("Casos abiertos",
            f"""SELECT c.number AS "Caso", c.title AS "Título", {sev('c.severity')} AS "Severidad",
                       COALESCE(s.value, c.stage) AS "Estado", COALESCE(u.name, 'Sin asignar') AS "Asignado",
                       round((extract(epoch FROM (now() AT TIME ZONE 'UTC' - c."startDate")) / 86400)::numeric, 1)
                         AS "Antigüedad (días)"
                FROM "Case" c LEFT JOIN "CaseStatus" s ON s.id = c."statusId"
                LEFT JOIN grafana_user u ON u.id = c."assigneeId"
                WHERE c.stage <> 'Closed' AND c."mergedIntoCaseId" IS NULL AND {org('c')}
                ORDER BY c.severity DESC, c."startDate" LIMIT 100""",
            w=16, h=9, overrides=[link_override("Caso", APP + "/cases/${__value.raw}", "Abrir caso"),
                                  color_text_override("Severidad", SEV_COLORS)])
    b.newline()

    b.table("Últimas alertas",
            f"""SELECT a.date AS "Fecha", {sev('a.severity')} AS "Severidad", a.title AS "Título",
                       a.source AS "Fuente", COALESCE(s.value, a.stage) AS "Estado",
                       array_to_string(a.tags, ', ') AS "Tags", c.number AS "Caso"
                FROM "Alert" a LEFT JOIN "AlertStatus" s ON s.id = a."statusId"
                LEFT JOIN "Case" c ON c.id = a."caseId"
                WHERE $__timeFilter(a.date) AND {org('a')} ORDER BY a.date DESC LIMIT 50""",
            h=10, overrides=[link_override("Título", APP + "/alerts", "Ver alertas"),
                             link_override("Caso", APP + "/cases/${__value.raw}", "Abrir caso"),
                             color_text_override("Severidad", SEV_COLORS),
                             {"matcher": {"id": "byName", "options": "Fecha"},
                              "properties": [{"id": "custom.width", "value": 170}]}])
    return b


# --------------------------------------------------- Observables e inteligencia
def inteligencia():
    b = Board("nc-inteligencia", "Nuestracolmena — Observables e inteligencia",
              "Observables, correlación, análisis de Cortex y técnicas MITRE ATT&CK.")
    b.stat("Observables en el rango",
           f"""SELECT count(*) FROM "Observable" WHERE $__timeFilter("createdAt") AND {org()}""")
    b.stat("Marcados como IOC",
           f"""SELECT count(*) FROM "Observable" WHERE ioc AND {org()}""", color="red",
           description="Total de observables marcados como IOC (sin filtro de tiempo).")
    b.stat("Avistados (sighted)",
           f"""SELECT count(*) FROM "Observable" WHERE sighted AND {org()}""", color="orange")
    b.stat("Análisis de Cortex en el rango",
           f"""SELECT count(*) FROM "ObservableReport" r JOIN "Observable" o ON o.id = r."observableId"
               WHERE $__timeFilter(r."createdAt") AND {org('o')}""", color="purple")
    b.stat("Veredictos maliciosos en el rango",
           f"""SELECT count(*) FROM "ObservableReport" r JOIN "Observable" o ON o.id = r."observableId",
               jsonb_array_elements(r.taxonomies) t
               WHERE t->>'level' = 'malicious' AND $__timeFilter(r."createdAt") AND {org('o')}""",
           color="red")
    b.stat("Técnicas MITRE distintas",
           f"""SELECT count(DISTINCT "patternId") FROM "Procedure" WHERE {org()}""", color="text")
    b.newline()

    b.series("Observables en el tiempo por tipo",
             f"""SELECT $__timeGroupAlias("createdAt", $__interval, 0), "dataType" AS metric, count(*) AS value
                 FROM "Observable" WHERE $__timeFilter("createdAt") AND {org()} GROUP BY 1, 2 ORDER BY 1""",
             w=16)
    b.pie("Observables por tipo",
          f"""SELECT "dataType" AS "Tipo", count(*) AS "Observables" FROM "Observable"
              WHERE $__timeFilter("createdAt") AND {org()} GROUP BY 1 ORDER BY 2 DESC""")
    b.newline()

    b.table("Observables repetidos (correlación)",
            f"""SELECT "dataType" AS "Tipo", data AS "Valor", count(*) AS "Veces",
                       count(DISTINCT "alertId") AS "Alertas", count(DISTINCT "caseId") AS "Casos",
                       bool_or(ioc) AS "IOC", max("createdAt") AS "Última vez"
                FROM "Observable" WHERE $__timeFilter("createdAt") AND {org()}
                GROUP BY 1, 2
                HAVING count(DISTINCT "alertId") + count(DISTINCT "caseId") >= 2
                ORDER BY 3 DESC, 7 DESC LIMIT 15""",
            h=9, description="Mismo tipo y valor visto en 2 o más alertas/casos distintos.")
    b.newline()

    b.bars("Análisis por analizador",
           f"""SELECT r.analyzer || ' · ' || r.status AS "Analizador", count(*) AS "Análisis"
               FROM "ObservableReport" r JOIN "Observable" o ON o.id = r."observableId"
               WHERE $__timeFilter(r."createdAt") AND {org('o')} GROUP BY 1 ORDER BY 2 DESC LIMIT 20""",
           w=12, color="purple")
    b.series("Análisis de Cortex en el tiempo por estado",
             f"""SELECT $__timeGroupAlias(r."createdAt", $__interval, 0), r.status AS metric, count(*) AS value
                 FROM "ObservableReport" r JOIN "Observable" o ON o.id = r."observableId"
                 WHERE $__timeFilter(r."createdAt") AND {org('o')} GROUP BY 1, 2 ORDER BY 1""",
             w=12, colors={"Success": "green", "Failure": "red", "InProgress": "orange", "Waiting": "blue"})
    b.newline()

    b.pie("Veredictos por nivel (taxonomías)",
          f"""SELECT t->>'level' AS "Nivel", count(*) AS "Veredictos"
              FROM "ObservableReport" r JOIN "Observable" o ON o.id = r."observableId",
              jsonb_array_elements(r.taxonomies) t
              WHERE $__timeFilter(r."createdAt") AND {org('o')} GROUP BY 1 ORDER BY 2 DESC""",
          colors=LEVEL_COLORS)
    b.table("Observables con veredicto malicioso o sospechoso",
            f"""SELECT r."createdAt" AS "Fecha", o."dataType" AS "Tipo", o.data AS "Valor",
                       r.analyzer AS "Analizador", t->>'level' AS "Nivel",
                       (t->>'namespace') || ':' || (t->>'predicate') || '=' || (t->>'value') AS "Taxonomía"
                FROM "ObservableReport" r JOIN "Observable" o ON o.id = r."observableId",
                jsonb_array_elements(r.taxonomies) t
                WHERE t->>'level' IN ('malicious', 'suspicious') AND $__timeFilter(r."createdAt")
                  AND {org('o')}
                ORDER BY r."createdAt" DESC LIMIT 100""",
            w=16, overrides=[color_text_override("Nivel", LEVEL_COLORS)])
    b.newline()

    b.bars("Técnicas MITRE ATT&CK más vistas",
           f"""SELECT "patternId" || ' ' || COALESCE("patternName", '') AS "Técnica", count(*) AS "Veces"
               FROM "Procedure" WHERE $__timeFilter("occurDate") AND {org()}
               GROUP BY 1 ORDER BY 2 DESC LIMIT 15""",
           w=10, color="red")
    b.pie("Procedimientos por táctica",
          f"""SELECT COALESCE(tactic, 'Sin táctica') AS "Táctica", count(*) AS "Procedimientos"
              FROM "Procedure" WHERE $__timeFilter("occurDate") AND {org()} GROUP BY 1 ORDER BY 2 DESC""",
          w=6)
    b.series("Técnicas MITRE en el tiempo",
             f"""SELECT $__timeGroupAlias("occurDate", $__interval, 0), "patternId" AS metric, count(*) AS value
                 FROM "Procedure" WHERE $__timeFilter("occurDate") AND {org()} GROUP BY 1, 2 ORDER BY 1""",
             w=8)
    return b


# ------------------------------------------------------------------ Operación
def operacion():
    b = Board("nc-operacion", "Nuestracolmena — Operación",
              "Tareas, SLA, actividad de los analistas y tiempos de reacción.")
    b.stat("Tareas pendientes",
           f"""SELECT count(*) FROM "CaseTask" WHERE status IN ('Waiting','InProgress') AND {org()}""")
    b.stat("Tareas vencidas",
           f"""SELECT count(*) FROM "CaseTask" WHERE "dueDate" < now() AT TIME ZONE 'UTC'
               AND status NOT IN ('Completed','Cancel') AND {org()}""", color="red")
    b.stat("Tareas completadas en el rango",
           f"""SELECT count(*) FROM "CaseTask" WHERE status = 'Completed' AND "endDate" IS NOT NULL
               AND $__timeFilter("endDate") AND {org()}""", color="green")
    b.stat("Alertas convertidas en caso",
           f"""SELECT CASE WHEN count(*) = 0 THEN NULL
                      ELSE 100.0 * count(*) FILTER (WHERE "caseId" IS NOT NULL) / count(*) END AS "%"
               FROM "Alert" WHERE $__timeFilter(date) AND {org()}""",
           unit="percent", color="purple", decimals=1, no_value="—",
           description="Porcentaje de las alertas del rango que se importaron a un caso.")
    b.stat("Alerta → caso (mediana)",
           f"""SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (c."createdAt" - a.date)))
               FROM "Alert" a JOIN "Case" c ON c.id = a."caseId"
               WHERE c."createdAt" >= a.date AND $__timeFilter(a.date) AND {org('a')}""",
           unit="s", color="blue", decimals=1, no_value="—")
    b.stat("Alerta → caso (p90)",
           f"""SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (c."createdAt" - a.date)))
               FROM "Alert" a JOIN "Case" c ON c.id = a."caseId"
               WHERE c."createdAt" >= a.date AND $__timeFilter(a.date) AND {org('a')}""",
           unit="s", color="orange", decimals=1, no_value="—")
    b.newline()

    b.pie("Tareas por estado",
          f"""SELECT status AS "Estado", count(*) AS "Tareas" FROM "CaseTask" WHERE {org()}
              GROUP BY 1 ORDER BY 2 DESC""",
          colors={"Waiting": "blue", "InProgress": "orange", "Completed": "green", "Cancel": "text"})
    b.series("Tareas completadas en el tiempo",
             f"""SELECT $__timeGroupAlias("endDate", $__interval, 0), 'Completadas' AS metric, count(*) AS value
                 FROM "CaseTask" WHERE status = 'Completed' AND "endDate" IS NOT NULL
                 AND $__timeFilter("endDate") AND {org()} GROUP BY 1, 2 ORDER BY 1""",
             w=16, colors={"Completadas": "green"})
    b.newline()

    b.table("Tareas vencidas",
            f"""SELECT c.number AS "Caso", c.title AS "Título del caso", t.title AS "Tarea",
                       t.status AS "Estado", COALESCE(u.name, 'Sin asignar') AS "Asignado",
                       t."dueDate" AS "Vencimiento"
                FROM "CaseTask" t JOIN "Case" c ON c.id = t."caseId"
                LEFT JOIN grafana_user u ON u.id = t."assigneeId"
                WHERE t."dueDate" < now() AT TIME ZONE 'UTC' AND t.status NOT IN ('Completed','Cancel')
                  AND {org('t')}
                ORDER BY t."dueDate" LIMIT 100""",
            h=8, overrides=[link_override("Caso", APP + "/cases/${__value.raw}", "Abrir caso")])
    b.newline()

    b.series("Eventos de SLA en el tiempo",
             f"""SELECT $__timeGroupAlias("createdAt", $__interval, 0),
                        CASE kind WHEN 'breach' THEN 'Incumplido' WHEN 'warning' THEN 'Aviso' ELSE kind END
                          AS metric, count(*) AS value
                 FROM "SlaEvent" WHERE $__timeFilter("createdAt") AND {org()} GROUP BY 1, 2 ORDER BY 1""",
             w=12, colors={"Incumplido": "red", "Aviso": "orange"})
    b.table("SLA por objetivo",
            f"""SELECT "objectType" AS "Objeto", objective AS "Objetivo",
                       count(*) FILTER (WHERE kind = 'warning') AS "Avisos",
                       count(*) FILTER (WHERE kind = 'breach') AS "Incumplidos",
                       max("createdAt") AS "Último"
                FROM "SlaEvent" WHERE $__timeFilter("createdAt") AND {org()}
                GROUP BY 1, 2 ORDER BY 4 DESC, 3 DESC""",
            w=12)
    b.newline()

    b.series("Actividad por tipo de objeto",
             f"""SELECT $__timeGroupAlias("createdAt", $__interval, 0), "objectType" AS metric, count(*) AS value
                 FROM "AuditLog" WHERE $__timeFilter("createdAt") AND {org()} GROUP BY 1, 2 ORDER BY 1""",
             w=24, h=9, description="Acciones registradas en la auditoría (crear, actualizar, borrar…).")
    b.newline()

    b.bars("Acciones por usuario",
           f"""SELECT COALESCE(u.name, 'Sistema / integración') AS "Usuario", count(*) AS "Acciones"
               FROM "AuditLog" l LEFT JOIN grafana_user u ON u.id = l."actorId"
               WHERE $__timeFilter(l."createdAt") AND {org('l')} GROUP BY 1 ORDER BY 2 DESC LIMIT 15""",
           w=12, color="blue")
    b.bars("Acciones por tipo",
           f"""SELECT action || ' ' || "objectType" AS "Acción", count(*) AS "Veces"
               FROM "AuditLog" WHERE $__timeFilter("createdAt") AND {org()} GROUP BY 1 ORDER BY 2 DESC LIMIT 15""",
           w=12, color="purple")
    return b


def main():
    OUT.mkdir(exist_ok=True)
    for name, board in (("nuestracolmena-resumen", resumen()),
                        ("nuestracolmena-inteligencia", inteligencia()),
                        ("nuestracolmena-operacion", operacion())):
        path = OUT / f"{name}.json"
        path.write_text(json.dumps(board.to_json(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"{path.name}: {len(board.panels)} paneles")


if __name__ == "__main__":
    main()
