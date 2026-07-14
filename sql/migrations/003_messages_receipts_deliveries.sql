begin;

select pg_advisory_xact_lock(1646705660);

create table if not exists agent_bridge.messages (
  sequence bigint generated always as identity primary key,
  id uuid not null unique,
  workspace text not null references agent_bridge.workspaces(id),
  source text not null,
  type text not null,
  content text not null,
  content_type text not null default 'text/plain',
  data jsonb,
  targets jsonb not null default '[]'::jsonb,
  thread_id text,
  reply_to_id text,
  correlation_id text,
  causation_id text,
  priority text not null default 'info',
  expires_at timestamptz,
  idempotency_key text,
  atrib_receipt_id text,
  informed_by jsonb,
  metadata jsonb,
  created_at timestamptz not null default now(),
  unique (workspace, id),
  check (jsonb_typeof(targets)='array'),
  check (priority in ('info','high','urgent'))
);
create unique index if not exists messages_idempotency
  on agent_bridge.messages(workspace, source, idempotency_key)
  where idempotency_key is not null;
create index if not exists messages_cursor on agent_bridge.messages(workspace, sequence);
create index if not exists messages_expiry on agent_bridge.messages(workspace, expires_at)
  where expires_at is not null;

create table if not exists agent_bridge.receipts (
  workspace text not null,
  message_id uuid not null,
  principal text not null,
  read_at timestamptz not null default now(),
  primary key (workspace, message_id, principal),
  foreign key (workspace, message_id)
    references agent_bridge.messages(workspace, id) on delete cascade
);

create table if not exists agent_bridge.deliveries (
  id uuid primary key,
  message_id uuid not null,
  workspace text not null,
  recipient text not null,
  state text not null,
  attempt integer not null default 0,
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  unique (message_id, recipient),
  foreign key (workspace, message_id)
    references agent_bridge.messages(workspace, id) on delete cascade,
  check (state in ('pending','claimed','acked','retrying','dead')),
  check (attempt >= 0),
  check ((state='claimed' and lease_token is not null and lease_expires_at is not null)
    or (state<>'claimed' and lease_token is null and lease_owner is null and lease_expires_at is null))
);
create index if not exists deliveries_claim
  on agent_bridge.deliveries(workspace, recipient, state, available_at);

create or replace function agent_bridge.reject_message_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'bridge messages are immutable';
end
$$;
drop trigger if exists messages_immutable on agent_bridge.messages;
create trigger messages_immutable before update or delete on agent_bridge.messages
for each row execute function agent_bridge.reject_message_mutation();

revoke all on all tables in schema agent_bridge from public;
revoke all on all sequences in schema agent_bridge from public;
revoke all on all functions in schema agent_bridge from public;

do $roles$
declare role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on schema agent_bridge from %I', role_name);
      execute format('revoke all on all tables in schema agent_bridge from %I', role_name);
      execute format('revoke all on all sequences in schema agent_bridge from %I', role_name);
      execute format('revoke all on all functions in schema agent_bridge from %I', role_name);
    end if;
  end loop;
end
$roles$;

insert into agent_bridge.schema_migrations (version, name, checksum)
values (3, 'messages_receipts_deliveries', '__AGENT_BRIDGE_MIGRATION_CHECKSUM__')
on conflict (version) do update set applied_at=agent_bridge.schema_migrations.applied_at
where agent_bridge.schema_migrations.name=excluded.name
  and agent_bridge.schema_migrations.checksum=excluded.checksum;

do $migration$
begin
  if not exists (
    select 1 from agent_bridge.schema_migrations
    where version=3 and name='messages_receipts_deliveries'
      and checksum='__AGENT_BRIDGE_MIGRATION_CHECKSUM__'
  ) then
    raise exception 'migration 3_messages_receipts_deliveries conflicts with recorded schema state';
  end if;
end
$migration$;

commit;
