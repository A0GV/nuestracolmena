-- Rol de solo lectura para Grafana sobre la base de Nuestracolmena. Idempotente.
-- Uso: psql -v ON_ERROR_STOP=1 -U myhive -d myhive -v grafana_password='...' < grafana-readonly.sql

SELECT format('CREATE ROLE nuestracolmena_grafana LOGIN PASSWORD %L', :'grafana_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuestracolmena_grafana') \gexec
SELECT format('ALTER ROLE nuestracolmena_grafana LOGIN PASSWORD %L', :'grafana_password') \gexec

ALTER ROLE nuestracolmena_grafana SET default_transaction_read_only = on;
ALTER ROLE nuestracolmena_grafana SET statement_timeout = '30s';

SELECT format('GRANT CONNECT ON DATABASE %I TO nuestracolmena_grafana', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO nuestracolmena_grafana;

-- Usuarios sin hashes ni secretos de MFA.
CREATE OR REPLACE VIEW public.grafana_user AS
  SELECT id, login, name, type, locked FROM public."User";

GRANT SELECT ON
  public."Organisation", public."Alert", public."AlertStatus", public."Case", public."CaseStatus",
  public."CaseTask", public."Observable", public."ObservableReport", public."Procedure",
  public."SlaEvent", public."AuditLog", public.grafana_user
TO nuestracolmena_grafana;
