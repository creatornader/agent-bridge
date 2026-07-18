\set ON_ERROR_STOP on
\getenv runtime_login AGENT_BRIDGE_RUNTIME_LOGIN
\getenv runtime_password AGENT_BRIDGE_RUNTIME_PASSWORD

SELECT 1 / CASE
  WHEN :'runtime_login' ~ '^[a-z_][a-z0-9_]{0,62}$' THEN 1
  ELSE 0
END AS valid_runtime_login;

SELECT 1 / CASE
  WHEN length(:'runtime_password') >= 32 THEN 1
  ELSE 0
END AS valid_runtime_password;

SELECT format(
  'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'runtime_login',
  :'runtime_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = :'runtime_login'
) \gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'runtime_login',
  :'runtime_password'
) \gexec

SELECT format(
  'GRANT %I TO %I',
  'agent_bridge_runtime_' || substr(md5(current_database()), 1, 16),
  :'runtime_login'
) \gexec
