\set ON_ERROR_STOP on
\getenv runtime_login AGENT_BRIDGE_RUNTIME_LOGIN
\getenv runtime_password AGENT_BRIDGE_RUNTIME_PASSWORD

BEGIN;

SELECT 1 / CASE
  WHEN :'runtime_login' ~ '^[a-z_][a-z0-9_]{0,62}$' THEN 1
  ELSE 0
END AS valid_runtime_login;

SELECT 1 / CASE
  WHEN length(:'runtime_password') >= 32 THEN 1
  ELSE 0
END AS valid_runtime_password;

SELECT 1 / CASE
  WHEN :'runtime_login' !~ '^agent_bridge_(runtime|data_owner|context_reader|event_writer|control_owner|control_operator|control_auditor|archive_operator)_[0-9a-f]{16}$' THEN 1
  ELSE 0
END AS reserved_runtime_login;

SELECT 1 / CASE
  WHEN current_user = (
    SELECT pg_catalog.pg_get_userbyid(namespace.nspowner)
    FROM pg_catalog.pg_namespace namespace
    WHERE namespace.nspname = 'agent_bridge'
  ) THEN 1
  ELSE 0
END AS schema_owner_session;

SELECT 1 / CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'runtime_login'
  ) OR (
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles role_record
      WHERE role_record.rolname = :'runtime_login'
        AND role_record.rolcanlogin AND role_record.rolinherit
        AND NOT role_record.rolsuper AND NOT role_record.rolcreatedb
        AND NOT role_record.rolcreaterole AND NOT role_record.rolreplication
        AND NOT role_record.rolbypassrls AND role_record.rolconnlimit = -1
        AND role_record.rolvaliduntil IS NULL AND role_record.rolconfig IS NULL
    )
    AND (
      SELECT count(*) = 1
        AND bool_and(NOT membership.admin_option)
        AND bool_and(coalesce((to_jsonb(membership)->>'inherit_option')::boolean, true))
        AND bool_and(coalesce((to_jsonb(membership)->>'set_option')::boolean, true))
        AND bool_and(grantor.rolname = current_user)
      FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid = membership.member
      JOIN pg_catalog.pg_roles grantor ON grantor.oid = membership.grantor
      WHERE granted.rolname = 'agent_bridge_runtime_' || substr(md5(current_database()), 1, 16)
        AND member.rolname = :'runtime_login'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid = membership.member
      WHERE member.rolname = :'runtime_login'
        AND granted.rolname <> 'agent_bridge_runtime_' || substr(md5(current_database()), 1, 16)
    )
    AND (
      (
        current_setting('server_version_num')::integer >= 160000
        AND NOT (
          SELECT role_record.rolsuper
          FROM pg_catalog.pg_roles role_record
          WHERE role_record.rolname = current_user
        )
        AND (
          SELECT count(*) = 1
            AND bool_and(member.rolname = current_user)
            AND bool_and(membership.grantor = 10)
            AND bool_and(membership.admin_option)
            AND bool_and(NOT coalesce((to_jsonb(membership)->>'inherit_option')::boolean, true))
            AND bool_and(NOT coalesce((to_jsonb(membership)->>'set_option')::boolean, true))
          FROM pg_catalog.pg_auth_members membership
          JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
          JOIN pg_catalog.pg_roles member ON member.oid = membership.member
          WHERE granted.rolname = :'runtime_login'
        )
      ) OR (
        (
          current_setting('server_version_num')::integer < 160000
          OR (
            SELECT role_record.rolsuper
            FROM pg_catalog.pg_roles role_record
            WHERE role_record.rolname = current_user
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_auth_members membership
          JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
          WHERE granted.rolname = :'runtime_login'
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_database database_record
      JOIN pg_catalog.pg_roles role_record ON role_record.oid = database_record.datdba
      WHERE role_record.rolname = :'runtime_login'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_namespace namespace
      JOIN pg_catalog.pg_roles role_record ON role_record.oid = namespace.nspowner
      WHERE role_record.rolname = :'runtime_login'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_roles role_record ON role_record.oid = relation.relowner
      WHERE role_record.rolname = :'runtime_login'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_roles role_record ON role_record.oid = procedure.proowner
      WHERE role_record.rolname = :'runtime_login'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_type type_record
      JOIN pg_catalog.pg_roles role_record ON role_record.oid = type_record.typowner
      WHERE role_record.rolname = :'runtime_login'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_default_acl defaults
      JOIN pg_catalog.pg_roles role_record ON role_record.oid = defaults.defaclrole
      WHERE role_record.rolname = :'runtime_login'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_shdepend dependency
      JOIN pg_catalog.pg_roles role_record ON role_record.oid = dependency.refobjid
      WHERE role_record.rolname = :'runtime_login'
        AND dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        AND dependency.deptype = 'o'
    )
  ) THEN 1
  ELSE 0
END AS existing_runtime_login_contract;

SELECT format(
  'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'runtime_login',
  :'runtime_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = :'runtime_login'
) \gexec

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = :'runtime_login'
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
      AND rolconnlimit = -1
  ) THEN 1
  ELSE 0
END AS safe_runtime_login;

SELECT format(
  'ALTER ROLE %I WITH LOGIN INHERIT PASSWORD %L',
  :'runtime_login',
  :'runtime_password'
) \gexec

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = :'runtime_login'
      AND rolcanlogin AND rolinherit
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
      AND rolconnlimit = -1
  ) THEN 1
  ELSE 0
END AS exact_runtime_login;

SELECT CASE
  WHEN current_setting('server_version_num')::integer >= 160000 THEN format(
    'GRANT %I TO %I WITH ADMIN FALSE, INHERIT TRUE, SET TRUE',
    'agent_bridge_runtime_' || substr(md5(current_database()), 1, 16),
    :'runtime_login'
  )
  ELSE format(
    'GRANT %I TO %I',
    'agent_bridge_runtime_' || substr(md5(current_database()), 1, 16),
    :'runtime_login'
  )
END \gexec

SELECT 1 / CASE
  WHEN (
    SELECT count(*) = 1
      AND bool_and(NOT membership.admin_option)
      AND bool_and(coalesce((to_jsonb(membership)->>'inherit_option')::boolean, true))
      AND bool_and(coalesce((to_jsonb(membership)->>'set_option')::boolean, true))
      AND bool_and(grantor.rolname = current_user)
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = membership.member
    JOIN pg_catalog.pg_roles grantor ON grantor.oid = membership.grantor
    WHERE granted.rolname = 'agent_bridge_runtime_' || substr(md5(current_database()), 1, 16)
      AND member.rolname = :'runtime_login'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = membership.member
    WHERE member.rolname = :'runtime_login'
      AND granted.rolname <> 'agent_bridge_runtime_' || substr(md5(current_database()), 1, 16)
  ) AND (
    (
      current_setting('server_version_num')::integer >= 160000
      AND NOT (
        SELECT role_record.rolsuper
        FROM pg_catalog.pg_roles role_record
        WHERE role_record.rolname = current_user
      )
      AND (
        SELECT count(*) = 1
          AND bool_and(member.rolname = current_user)
          AND bool_and(membership.grantor = 10)
          AND bool_and(membership.admin_option)
          AND bool_and(NOT coalesce((to_jsonb(membership)->>'inherit_option')::boolean, true))
          AND bool_and(NOT coalesce((to_jsonb(membership)->>'set_option')::boolean, true))
        FROM pg_catalog.pg_auth_members membership
        JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
        JOIN pg_catalog.pg_roles member ON member.oid = membership.member
        WHERE granted.rolname = :'runtime_login'
      )
    ) OR (
      (
        current_setting('server_version_num')::integer < 160000
        OR (
          SELECT role_record.rolsuper
          FROM pg_catalog.pg_roles role_record
          WHERE role_record.rolname = current_user
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members membership
        JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
        WHERE granted.rolname = :'runtime_login'
      )
    )
  ) THEN 1
  ELSE 0
END AS exact_runtime_membership;

COMMIT;
