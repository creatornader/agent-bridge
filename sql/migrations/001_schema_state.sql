begin;

select pg_advisory_xact_lock(1646705660);

create schema if not exists agent_bridge;
revoke all on schema agent_bridge from public;

create table if not exists agent_bridge.schema_migrations (
  version integer primary key,
  name text not null unique,
  checksum char(64) not null,
  applied_at timestamptz not null default now(),
  constraint schema_migrations_checksum check (checksum ~ '^[0-9a-f]{64}$')
);

insert into agent_bridge.schema_migrations (version, name, checksum)
values (1, 'schema_state', '__AGENT_BRIDGE_MIGRATION_CHECKSUM__')
on conflict (version) do update set applied_at=agent_bridge.schema_migrations.applied_at
where agent_bridge.schema_migrations.name=excluded.name
  and agent_bridge.schema_migrations.checksum=excluded.checksum;

do $migration$
begin
  if not exists (
    select 1 from agent_bridge.schema_migrations
    where version=1 and name='schema_state'
      and checksum='__AGENT_BRIDGE_MIGRATION_CHECKSUM__'
  ) then
    raise exception 'migration 1_schema_state conflicts with recorded schema state';
  end if;
end
$migration$;

commit;
