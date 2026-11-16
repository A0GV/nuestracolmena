#!/usr/bin/env python3
"""Integración Wazuh -> MyHive (función `wazuh-alert`).

Wazuh lo invoca como: custom-myhive <alert_file> <api_key> <hook_url>

- Lee el JSON de la alerta y lo envía tal cual por POST a <hook_url>.
- Cabeceras: Authorization: Bearer <api_key>, Content-Type: application/json.
- Timeout 10 s. TLS verificado por defecto; MYHIVE_VERIFY_TLS=false o el
  argumento opcional `--no-verify` lo desactiva (certificados autofirmados).
- Escribe una línea por alerta en /var/ossec/logs/integrations.log (si no se
  puede, por stderr).

Códigos de salida: 0 OK, 1 error de uso/lectura, 2 error HTTP/red.
Solo usa la biblioteca estándar de Python 3.
"""

import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

LOG_FILE = os.environ.get("MYHIVE_WAZUH_LOG", "/var/ossec/logs/integrations.log")
TIMEOUT = 10


def log(line):
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    text = f"{stamp} custom-myhive: {' '.join(str(line).split())}\n"
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as handle:
            handle.write(text)
    except OSError:
        sys.stderr.write(text)
        sys.stderr.flush()


def usage():
    log("uso: custom-myhive <alert_file> <api_key> <hook_url> [--no-verify]")
    return 1


def verify_tls(args):
    env = os.environ.get("MYHIVE_VERIFY_TLS", "true").strip().lower()
    if env in ("0", "false", "no", "off"):
        return False
    if "--no-verify" in args or "false" in [a.strip().lower() for a in args]:
        return False
    return True


def summary(alert):
    rule = alert.get("rule") or {}
    data = alert.get("data") or {}
    src = data.get("src_ip", "-")
    dst = data.get("dest_ip", "-")
    return f"rule={rule.get('id', '?')} level={rule.get('level', '?')} {src}->{dst}"


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--") and a.strip().lower() != "false"]
    if len(args) < 3:
        return usage()

    alert_file, api_key, hook_url = args[0], args[1], args[2]

    try:
        with open(alert_file, "r", encoding="utf-8") as handle:
            raw = handle.read()
        alert = json.loads(raw)
    except (OSError, ValueError) as exc:
        log(f"ERROR no se pudo leer la alerta {alert_file}: {exc}")
        return 1

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "myhive-wazuh-integration/1.0",
    }
    request = urllib.request.Request(
        hook_url, data=raw.encode("utf-8"), headers=headers, method="POST"
    )

    context = None
    if hook_url.lower().startswith("https") and not verify_tls(argv):
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE

    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT, context=context) as response:
            body = response.read(300).decode("utf-8", "replace")
            status = response.status
    except urllib.error.HTTPError as exc:
        detail = exc.read(300).decode("utf-8", "replace")
        log(f"ERROR HTTP {exc.code} {summary(alert)} {detail}")
        return 2
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        log(f"ERROR red {summary(alert)}: {exc}")
        return 2

    log(f"OK HTTP {status} {summary(alert)} {body}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
