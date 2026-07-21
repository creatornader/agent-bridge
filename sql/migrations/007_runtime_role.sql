begin;

select pg_advisory_xact_lock(1646705660);

do $role$
declare
  role_name text := 'agent_bridge_runtime_' || substr(md5(current_database()), 1, 16);
begin
  if not exists (select 1 from pg_roles where rolname=role_name) then
    execute format(
      'create role %I nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls',
      role_name
    );
  end if;
  if exists (
    select 1 from pg_roles where rolname=role_name and (
      rolcanlogin or not rolinherit or rolsuper or rolcreatedb or rolcreaterole
      or rolreplication or rolbypassrls or rolconnlimit<>-1
    )
  ) then
    raise exception 'Agent Bridge runtime role has unsafe attributes';
  end if;
  execute format('revoke all on schema agent_bridge from %I', role_name);
  execute format('revoke all on all tables in schema agent_bridge from %I', role_name);
  execute format('revoke all on all sequences in schema agent_bridge from %I', role_name);
  execute format('revoke all on all functions in schema agent_bridge from %I', role_name);
  execute format('grant usage on schema agent_bridge to %I', role_name);
  execute format(
    'grant select on agent_bridge.schema_migrations, agent_bridge.workspaces, agent_bridge.agents, agent_bridge.credentials, agent_bridge.messages, agent_bridge.receipts, agent_bridge.deliveries, agent_bridge.delivery_events, agent_bridge.agent_instances to %I',
    role_name
  );
  execute format(
    'grant insert on agent_bridge.messages, agent_bridge.receipts, agent_bridge.deliveries, agent_bridge.delivery_events, agent_bridge.agent_instances to %I',
    role_name
  );
  execute format(
    'grant update on agent_bridge.deliveries, agent_bridge.agent_instances to %I',
    role_name
  );
  execute format('grant delete on agent_bridge.agent_instances to %I', role_name);
  execute format('grant usage, select on all sequences in schema agent_bridge to %I', role_name);
end
$role$;

insert into agent_bridge.schema_migrations (version, name, checksum)
values (7, 'runtime_role', '__AGENT_BRIDGE_MIGRATION_CHECKSUM__')
on conflict (version) do update set applied_at=agent_bridge.schema_migrations.applied_at
where agent_bridge.schema_migrations.name=excluded.name
  and agent_bridge.schema_migrations.checksum=excluded.checksum;

do $migration$
begin
  if not exists (
    select 1 from agent_bridge.schema_migrations
    where version=7 and name='runtime_role'
      and checksum='__AGENT_BRIDGE_MIGRATION_CHECKSUM__'
  ) then
    raise exception 'migration 7_runtime_role conflicts with recorded schema state';
  end if;
end
$migration$;

commit;
