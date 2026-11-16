#!/usr/bin/env python3
"""Ejecuta en Grafana la consulta de cada panel de Nuestracolmena e informa errores.

Uso: python3 deploy/grafana/check-dashboards.py [URL]   (por defecto http://127.0.0.1:3030/grafana)
Lee el usuario/contraseña de admin de deploy/grafana/.env (o GRAFANA_USER / GRAFANA_ADMIN_PASSWORD).
Sale con código 1 si algún panel falla.
"""
import base64
import json
import os
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3030/grafana").rstrip("/")


def env(name, default=None):
    if os.environ.get(name):
        return os.environ[name]
    f = HERE / ".env"
    if f.exists():
        for line in f.read_text().splitlines():
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip()
    return default


AUTH = "Basic " + base64.b64encode(
    f"{env('GRAFANA_USER', 'admin')}:{env('GRAFANA_ADMIN_PASSWORD', '')}".encode()).decode()


def call(path, body=None):
    req = urllib.request.Request(URL + path, data=json.dumps(body).encode() if body else None,
                                 headers={"Authorization": AUTH, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def main():
    status, found = call("/api/search?tag=nuestracolmena&type=dash-db")
    if status != 200 or not found:
        print(f"No se encontraron dashboards (HTTP {status}): {found}")
        return 1
    failures = 0
    for item in found:
        _, dash = call(f"/api/dashboards/uid/{item['uid']}")
        panels = dash["dashboard"]["panels"]
        print(f"\n== {item['title']} ({len(panels)} paneles)")
        for p in panels:
            queries = [dict(t, intervalMs=3600000, maxDataPoints=500) for t in p.get("targets", [])]
            body = {"queries": queries, "from": "now-90d", "to": "now",
                    "scopedVars": {"org": {"text": "All", "value": "$__all"}}}
            # Grafana no resuelve variables de dashboard en /api/ds/query: sustituimos $org a mano.
            raw = json.dumps(body).replace("$org", "SELECT name FROM \\\"Organisation\\\"")
            code, res = call("/api/ds/query", json.loads(raw))
            frames = res.get("results", {}).get("A", {}) if isinstance(res, dict) else {}
            err = frames.get("error") or (res.get("message") if code != 200 else None)
            rows = sum(len((f.get("data", {}).get("values") or [[]])[0]) for f in frames.get("frames", []))
            mark = "ERROR" if err else "ok"
            if err:
                failures += 1
            print(f"  [{mark:5}] {p['title']:<52} filas={rows}" + (f"  -> {err}" if err else ""))
    print(f"\n{'TODO OK' if not failures else f'{failures} panel(es) con error'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
