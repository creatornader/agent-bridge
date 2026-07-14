begin;

select pg_advisory_xact_lock(1646705660);

create table if not exists agent_bridge.delivery_events (
  sequence bigint generated always as identity primary key,
  delivery_id uuid not null,
  message_id uuid not null,
  workspace text not null,
  recipient text not null,
  from_state text,
  to_state text not null,
  attempt integer not null,
  lease_owner text,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists delivery_events_lookup
  on agent_bridge.delivery_events(workspace, delivery_id, sequence);

create or replace function agent_bridge.record_delivery_event() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' or old.state is distinct from new.state or old.attempt is distinct from new.attempt then
    insert into agent_bridge.delivery_events (
      delivery_id, message_id, workspace, recipient, from_state, to_state,
      attempt, lease_owner, error
    ) values (
      new.id, new.message_id, new.workspace, new.recipient,
      case when tg_op = 'INSERT' then null else old.state end,
      new.state, new.attempt, new.lease_owner, new.last_error
    );
  end if;
  return new;
end
$$;
drop trigger if exists deliveries_record_event on agent_bridge.deliveries;
create trigger deliveries_record_event
after insert or update on agent_bridge.deliveries
for each row execute function agent_bridge.record_delivery_event();

create table if not exists agent_bridge.agent_instances (
  workspace text not null,
  agent text not null,
  instance text not null,
  runtime_type text,
  capabilities jsonb not null default '[]'::jsonb,
  lease_expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  primary key (workspace, agent, instance),
  foreign key (workspace) references agent_bridge.workspaces(id) on delete cascade,
  check (jsonb_typeof(capabilities)='array')
);
create index if not exists agent_instances_active
  on agent_bridge.agent_instances(workspace, lease_expires_at);

revoke all on all tables in schema agent_bridge from public;
revoke all on all sequences in schema agent_bridge from public;
revoke all on all functions in schema agent_bridge from public;

insert into agent_bridge.schema_migrations (version, name, checksum)
values (5, 'delivery_events_presence', '__AGENT_BRIDGE_MIGRATION_CHECKSUM__')
on conflict (version) do update set applied_at=agent_bridge.schema_migrations.applied_at
where agent_bridge.schema_migrations.name=excluded.name
  and agent_bridge.schema_migrations.checksum=excluded.checksum;

do $migration$
begin
  if not exists (
    select 1 from agent_bridge.schema_migrations
    where version=5 and name='delivery_events_presence'
      and checksum='__AGENT_BRIDGE_MIGRATION_CHECKSUM__'
  ) then
    raise exception 'migration 5_delivery_events_presence conflicts with recorded schema state';
  end if;
end
$migration$;

commit;
