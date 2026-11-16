# Integración Wazuh → Nuestracolmena

Sustituye a `custom-w2thive.py` de TheHive. Wazuh ejecuta `custom-myhive` con tres argumentos:

```text
custom-myhive <alert_file> <api_key> <hook_url>
```

El wrapper `custom-myhive` llama a `custom-myhive.py`, que lee el JSON de la alerta y hace:

```http
POST <hook_url>
Authorization: Bearer <api_key>
Content-Type: application/json

{ ...alerta de Wazuh... }
```

Timeout de 10 s. TLS verificado por defecto; con certificado autofirmado usa `MYHIVE_VERIFY_TLS=false` en el entorno del manager o el 4.º argumento `--no-verify`.

## 1. Crear la función en Nuestracolmena

1. Entra en **Administración → Functions** (o Automatización → Functions).
2. **Nueva función** → plantilla **“Wazuh → alerta”**.
3. Nombre: `wazuh-alert` (la URL será `http://192.0.2.4:4100/api/v1/function/wazuh-alert`).
4. Tipo `api`, modo `Enabled`. Guarda.

La plantilla convierte el aviso en alerta (`type=wazuh`, `source=Wazuh`), crea observables (IPs, host, dominios, hashes…), añade TTPs MITRE y es idempotente por `id` de Wazuh.

## 2. Crear la API key

1. **Administración → API keys** (o perfil de usuario) → crear clave.
2. Copia el valor `mh_…`; no se vuelve a mostrar.
3. No la subas a git.

## 3. Instalar en el manager de Wazuh

```bash
sudo install -o root -g wazuh -m 750 custom-myhive     /var/ossec/integrations/custom-myhive
sudo install -o root -g wazuh -m 750 custom-myhive.py  /var/ossec/integrations/custom-myhive.py
```

Añade el bloque de `ossec.conf.snippet` dentro de `<ossec_config>` en `/var/ossec/etc/ossec.conf` (sustituye la API key):

```xml
<integration>
  <name>custom-myhive</name>
  <hook_url>http://192.0.2.4:4100/api/v1/function/wazuh-alert</hook_url>
  <api_key>mh_REEMPLAZA_CON_TU_API_KEY</api_key>
  <level>7</level>
  <alert_format>json</alert_format>
</integration>
```

Reinicia el manager:

```bash
sudo systemctl restart wazuh-manager
sudo tail -f /var/ossec/logs/integrations.log
```

Con `MYHIVE_VERIFY_TLS=false` (si usas HTTPS autofirmado):

```bash
sudo systemctl edit wazuh-manager
# [Service]
# Environment=MYHIVE_VERIFY_TLS=false
sudo systemctl restart wazuh-manager
```

## 4. Probar sin esperar a una alerta real

Contra una instancia de Nuestracolmena:

```bash
python3 custom-myhive.py sample-alert.json 'mh_TU_API_KEY' \
  'http://192.0.2.4:4100/api/v1/function/wazuh-alert'
echo $?    # 0 = aceptada
```

`sample-alert.json` reproduce una alerta de Suricata a través de Wazuh: regla `100199`, nivel 12, `data.src_ip`/`dest_ip`, SID `1000099` y MITRE `T1046`.

Prueba automática del transporte (no necesita Wazuh ni Nuestracolmena, solo `python3`):

```bash
node deploy/wazuh/test-custom-myhive.mjs
```

En Nuestracolmena debe aparecer una alerta con tags `wazuh`, `rule:100199`, `sid:1000099` y `T1046`. Reenvía el mismo fichero: no debe duplicarla (mismo `id`).

## Registro y códigos de salida

- Una línea por alerta en `/var/ossec/logs/integrations.log` (si no se puede escribir, por stderr).
- `0` alerta enviada · `1` error de uso/lectura · `2` error HTTP o de red.

## Ficheros

| Fichero | Uso |
|---|---|
| `custom-myhive` | Wrapper que ejecuta Wazuh |
| `custom-myhive.py` | Cliente HTTP (solo biblioteca estándar de Python 3) |
| `ossec.conf.snippet` | Bloque `<integration>` |
| `sample-alert.json` | Alerta de prueba Suricata/Wazuh |
| `test-custom-myhive.mjs` | Prueba del POST contra un receptor local |
