begin;

select pg_advisory_xact_lock(1646705660);

create table if not exists agent_bridge.workspaces (
  id text primary key,
  name text not null,
  disabled_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists agent_bridge.agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references agent_bridge.workspaces(id),
  principal text not null,
  display_name text,
  runtime_type text,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, principal),
  unique (workspace_id, id)
);

create table if not exists agent_bridge.credentials (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  agent_id uuid not null,
  token_hash char(64) not null unique,
  label text,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  foreign key (workspace_id, agent_id)
    references agent_bridge.agents(workspace_id, id),
  constraint credentials_hash check (token_hash ~ '^[0-9a-f]{64}$')
);

create index if not exists credentials_active_hash
  on agent_bridge.credentials(token_hash)
  where revoked_at is null;

revoke all on all tables in schema agent_bridge from public;
revoke all on all sequences in schema agent_bridge from public;

do $roles$
declare role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on schema agent_bridge from %I', role_name);
      execute format('revoke all on all tables in schema agent_bridge from %I', role_name);
      execute format('revoke all on all sequences in schema agent_bridge from %I', role_name);
    end if;
  end loop;
end
$roles$;

insert into agent_bridge.schema_migrations (version, name, checksum)
values (2, 'workspaces_agents_credentials', '__AGENT_BRIDGE_MIGRATION_CHECKSUM__')
on conflict (version) do update set applied_at=agent_bridge.schema_migrations.applied_at
where agent_bridge.schema_migrations.name=excluded.name
  and agent_bridge.schema_migrations.checksum=excluded.checksum;

do $migration$
begin
  if not exists (
    select 1 from agent_bridge.schema_migrations
    where version=2 and name='workspaces_agents_credentials'
      and checksum='__AGENT_BRIDGE_MIGRATION_CHECKSUM__'
  ) then
    raise exception 'migration 2_workspaces_agents_credentials conflicts with recorded schema state';
  end if;
end
$migration$;

commit;
