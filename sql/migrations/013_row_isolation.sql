begin;

select pg_advisory_xact_lock(1646705660);

do $roles$
declare
  suffix text := substr(md5(current_database()),1,16);
  data_owner text := 'agent_bridge_data_owner_' || suffix;
  context_reader text := 'agent_bridge_context_reader_' || suffix;
  event_writer text := 'agent_bridge_event_writer_' || suffix;
  role_name text;
begin
  foreach role_name in array array[data_owner,context_reader,event_writer] loop
    if not exists (select 1 from pg_roles where rolname=role_name) then
      execute format(
        'create role %I nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls',
        role_name
      );
    end if;
    execute format(
      'alter role %I nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls',
      role_name
    );
    execute format('grant %I to %I with admin option',role_name,current_user);
  end loop;
end
$roles$;

alter table agent_bridge.messages
  add constraint messages_workspace_id_source_unique unique(workspace,id,source);

alter table agent_bridge.deliveries add column publisher text;
update agent_bridge.deliveries delivery
set publisher=message.source
from agent_bridge.messages message
where message.workspace=delivery.workspace and message.id=delivery.message_id;
alter table agent_bridge.deliveries alter column publisher set not null;
alter table agent_bridge.deliveries
  add constraint deliveries_publisher_message_fk
  foreign key(workspace,message_id,publisher)
  references agent_bridge.messages(workspace,id,source) on delete cascade,
  add constraint deliveries_event_identity_unique
  unique(workspace,id,message_id,publisher);

alter table agent_bridge.delivery_events add column publisher text;
update agent_bridge.delivery_events event
set publisher=delivery.publisher
from agent_bridge.deliveries delivery
where delivery.workspace=event.workspace
  and delivery.id=event.delivery_id
  and delivery.message_id=event.message_id;
alter table agent_bridge.delivery_events alter column publisher set not null;
alter table agent_bridge.delivery_events
  add constraint delivery_events_delivery_publisher_fk
  foreign key(workspace,delivery_id,message_id,publisher)
  references agent_bridge.deliveries(workspace,id,message_id,publisher) on delete cascade;

create table agent_bridge.row_isolation_attestations (
  name text primary key,
  catalog_definition text not null,
  attested_at timestamptz not null default now(),
  constraint row_isolation_attestation_name check(name='domain-v1')
);

create or replace function agent_bridge.reject_delivery_identity_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.id is distinct from new.id
    or old.message_id is distinct from new.message_id
    or old.workspace is distinct from new.workspace
    or old.recipient is distinct from new.recipient
    or old.publisher is distinct from new.publisher
    or old.created_at is distinct from new.created_at then
    raise exception 'delivery identity is immutable';
  end if;
  return new;
end
$$;
revoke all on function agent_bridge.reject_delivery_identity_mutation() from public;
drop trigger if exists deliveries_identity_immutable on agent_bridge.deliveries;
create trigger deliveries_identity_immutable
before update on agent_bridge.deliveries
for each row execute function agent_bridge.reject_delivery_identity_mutation();

create or replace function agent_bridge.enforce_delivery_actor_role() returns trigger
language plpgsql set search_path = '' as $$
declare
  data_owner name := ('agent_bridge_data_owner_' || substr(pg_catalog.md5(pg_catalog.current_database()),1,16))::name;
  writes_event boolean;
  principal text;
begin
  if pg_catalog.pg_has_role(current_user,data_owner,'MEMBER') then
    return new;
  end if;
  principal := agent_bridge.current_request_principal();
  if tg_op='INSERT' then
    if principal is distinct from new.publisher then
      raise exception 'only the delivery publisher may create delivery state';
    end if;
    if new.state<>'pending' or new.attempt<>0 or new.cycle_attempt<>0
      or new.requeue_count<>0 or new.lease_token is not null
      or new.lease_owner is not null or new.lease_expires_at is not null
      or new.last_error is not null or new.last_action<>'created'
      or new.last_actor is distinct from principal then
      raise exception 'publisher delivery creation must use canonical initial state';
    end if;
    return new;
  end if;
  writes_event := old.state is distinct from new.state
    or old.attempt is distinct from new.attempt
    or old.cycle_attempt is distinct from new.cycle_attempt
    or old.requeue_count is distinct from new.requeue_count
    or old.last_action is distinct from new.last_action;
  if not writes_event then
    if principal is distinct from old.recipient then
      raise exception 'only the delivery recipient may update lease state';
    end if;
    if old.last_actor is distinct from new.last_actor then
      raise exception 'delivery actor may change only with an audited transition';
    end if;
    return new;
  end if;
  if new.state='cancelled' or new.last_action='cancel' then
    if principal is distinct from old.publisher then
      raise exception 'only the delivery publisher may cancel';
    end if;
    if old.state not in ('pending','retrying','claimed')
      or new.state<>'cancelled' or new.last_action<>'cancel' then
      raise exception 'publisher cancel requires a cancellation transition';
    end if;
    if new.last_actor is distinct from principal then
      raise exception 'publisher delivery actor must match request authority';
    end if;
  elsif (old.state in ('dead','cancelled') and new.state='pending')
    or new.last_action='requeue' then
    if principal is distinct from old.publisher then
      raise exception 'only the delivery publisher may requeue';
    end if;
    if old.state not in ('dead','cancelled')
      or new.state<>'pending' or new.last_action<>'requeue' then
      raise exception 'publisher requeue requires a terminal-to-pending transition';
    end if;
    if new.last_actor is distinct from principal then
      raise exception 'publisher delivery actor must match request authority';
    end if;
  elsif principal is distinct from old.recipient then
    raise exception 'only the delivery recipient may update delivery state';
  elsif new.last_action in ('message_expired','lease_expired') then
    if new.last_actor is distinct from 'agent-bridge' then
      raise exception 'system delivery actor is invalid';
    end if;
  elsif new.last_action='attempts_exhausted' then
    if new.last_actor is distinct from 'agent-bridge'
      and new.last_actor is distinct from principal then
      raise exception 'exhausted delivery actor must match request authority or system';
    end if;
  elsif new.last_actor is distinct from principal then
    raise exception 'recipient delivery actor must match request authority';
  end if;
  return new;
end
$$;
revoke all on function agent_bridge.enforce_delivery_actor_role() from public;
drop trigger if exists deliveries_actor_role on agent_bridge.deliveries;
create trigger deliveries_actor_role
before insert or update on agent_bridge.deliveries
for each row execute function agent_bridge.enforce_delivery_actor_role();

create or replace function agent_bridge.reject_delivery_event_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'delivery events are append-only';
end
$$;
revoke all on function agent_bridge.reject_delivery_event_mutation() from public;
drop trigger if exists delivery_events_append_only on agent_bridge.delivery_events;
create trigger delivery_events_append_only
before update or delete or truncate on agent_bridge.delivery_events
for each statement execute function agent_bridge.reject_delivery_event_mutation();

create or replace function agent_bridge.record_delivery_event() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT'
    or old.state is distinct from new.state
    or old.attempt is distinct from new.attempt
    or old.cycle_attempt is distinct from new.cycle_attempt
    or old.requeue_count is distinct from new.requeue_count
    or old.last_action is distinct from new.last_action then
    insert into agent_bridge.delivery_events (
      delivery_id,message_id,workspace,publisher,recipient,from_state,to_state,
      attempt,cycle_attempt,requeue_count,lease_owner,error,actor,action
    ) values (
      new.id,new.message_id,new.workspace,new.publisher,new.recipient,
      case when tg_op='INSERT' then null else old.state end,
      new.state,new.attempt,new.cycle_attempt,new.requeue_count,
      new.lease_owner,new.last_error,coalesce(new.last_actor,new.recipient),new.last_action
    );
  end if;
  return new;
end
$$;

create or replace function agent_bridge.current_request_workspace() returns text
language sql stable security definer set search_path = '' as $$
  select authority.workspace_id
  from agent_bridge.request_authorities authority
  where pg_catalog.pg_has_role(
      session_user,
      ('agent_bridge_runtime_' || substr(pg_catalog.md5(pg_catalog.current_database()),1,16))::name,
      'MEMBER'
    )
    and authority.backend_pid=pg_catalog.pg_backend_pid()
    and authority.transaction_id=pg_catalog.pg_current_xact_id_if_assigned()
    and authority.opened_session_user=session_user
$$;

create or replace function agent_bridge.current_request_principal() returns text
language sql stable security definer set search_path = '' as $$
  select authority.principal
  from agent_bridge.request_authorities authority
  where pg_catalog.pg_has_role(
      session_user,
      ('agent_bridge_runtime_' || substr(pg_catalog.md5(pg_catalog.current_database()),1,16))::name,
      'MEMBER'
    )
    and authority.backend_pid=pg_catalog.pg_backend_pid()
    and authority.transaction_id=pg_catalog.pg_current_xact_id_if_assigned()
    and authority.opened_session_user=session_user
$$;

create or replace function agent_bridge.row_isolation_catalog_definition() returns text
language sql stable set search_path = '' as $$
  with domain_tables(table_name) as (
    values ('messages'),('receipts'),('deliveries'),('delivery_events'),('agent_instances')
  ), catalog_objects(kind,identity,definition) as (
    select 'policy',relation.relname || '.' || policy.polname,
      policy.polcmd::text || ':' || policy.polpermissive::text || ':' ||
      coalesce(pg_catalog.pg_get_expr(policy.polqual,policy.polrelid),'') || ':' ||
      coalesce(pg_catalog.pg_get_expr(policy.polwithcheck,policy.polrelid),'')
    from pg_catalog.pg_policy policy
    join pg_catalog.pg_class relation on relation.oid=policy.polrelid
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='agent_bridge'
      and relation.relname in (select table_name from domain_tables)
    union all
    select 'constraint',constraint_record.conrelid::regclass::text || '.' || constraint_record.conname,
      pg_catalog.pg_get_constraintdef(constraint_record.oid,true)
    from pg_catalog.pg_constraint constraint_record
    join pg_catalog.pg_class constraint_relation on constraint_relation.oid=constraint_record.conrelid
    join pg_catalog.pg_namespace constraint_namespace on constraint_namespace.oid=constraint_relation.relnamespace
    where constraint_namespace.nspname='agent_bridge'
      and constraint_relation.relname in (
        select table_name from domain_tables
        union all select 'row_isolation_attestations'
      )
    union all
    select 'trigger',trigger.tgrelid::regclass::text || '.' || trigger.tgname,
      pg_catalog.pg_get_triggerdef(trigger.oid,true)
    from pg_catalog.pg_trigger trigger
    join pg_catalog.pg_class trigger_relation on trigger_relation.oid=trigger.tgrelid
    join pg_catalog.pg_namespace trigger_namespace on trigger_namespace.oid=trigger_relation.relnamespace
    where not trigger.tgisinternal
      and trigger_namespace.nspname='agent_bridge'
      and trigger_relation.relname in (select table_name from domain_tables)
    union all
    select 'function',procedure.oid::regprocedure::text,
      pg_catalog.pg_get_userbyid(procedure.proowner) || ':' ||
        pg_catalog.pg_get_functiondef(procedure.oid)
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
    where namespace.nspname='agent_bridge' and procedure.proname in (
      'current_request_workspace','current_request_principal','record_delivery_event',
      'reject_delivery_identity_mutation','enforce_delivery_actor_role',
      'reject_delivery_event_mutation','row_isolation_catalog_definition'
    )
  )
  select string_agg(kind || E'\x1f' || identity || E'\x1f' || definition,E'\x1e'
    order by kind,identity)
  from catalog_objects
$$;

revoke all on function agent_bridge.current_request_workspace() from public;
revoke all on function agent_bridge.current_request_principal() from public;
revoke all on function agent_bridge.row_isolation_catalog_definition() from public;

do $owners$
declare
  suffix text := substr(md5(current_database()),1,16);
  data_owner text := 'agent_bridge_data_owner_' || suffix;
  context_reader text := 'agent_bridge_context_reader_' || suffix;
  event_writer text := 'agent_bridge_event_writer_' || suffix;
  table_name text;
begin
  execute format('grant usage on schema agent_bridge to %I',data_owner);
  foreach table_name in array array[
    'messages','receipts','deliveries','delivery_events','agent_instances'
  ] loop
    execute format('alter table agent_bridge.%I owner to %I',table_name,data_owner);
  end loop;
  execute format('alter function agent_bridge.current_request_workspace() owner to %I',context_reader);
  execute format('alter function agent_bridge.current_request_principal() owner to %I',context_reader);
  execute format('alter function agent_bridge.record_delivery_event() owner to %I',event_writer);
  execute format('grant usage on schema agent_bridge to %I',context_reader);
  execute format('grant select on agent_bridge.request_authorities to %I',context_reader);
  execute format('grant usage on schema agent_bridge to %I',event_writer);
  execute format('grant insert on agent_bridge.delivery_events to %I',event_writer);
  execute format('grant usage on sequence agent_bridge.delivery_events_sequence_seq to %I',event_writer);
end
$owners$;

revoke execute on all functions in schema agent_bridge from public;

alter table agent_bridge.messages enable row level security;
alter table agent_bridge.messages force row level security;
alter table agent_bridge.receipts enable row level security;
alter table agent_bridge.receipts force row level security;
alter table agent_bridge.deliveries enable row level security;
alter table agent_bridge.deliveries force row level security;
alter table agent_bridge.delivery_events enable row level security;
alter table agent_bridge.delivery_events force row level security;
alter table agent_bridge.agent_instances enable row level security;
alter table agent_bridge.agent_instances force row level security;

do $policies$
declare
  suffix text := substr(md5(current_database()),1,16);
  runtime_role text := 'agent_bridge_runtime_' || suffix;
  data_owner text := 'agent_bridge_data_owner_' || suffix;
  event_writer text := 'agent_bridge_event_writer_' || suffix;
  table_name text;
begin
  foreach table_name in array array[
    'messages','receipts','deliveries','delivery_events','agent_instances'
  ] loop
    execute format(
      'create policy %I on agent_bridge.%I for all to %I using (true) with check (true)',
      table_name || '_owner_all',table_name,data_owner
    );
  end loop;

  execute format($policy$
    create policy messages_runtime_select on agent_bridge.messages
    for select to %I using (
      workspace=(select agent_bridge.current_request_workspace())
      and (
        source=(select agent_bridge.current_request_principal())
        or targets='[]'::jsonb
        or targets ? (select agent_bridge.current_request_principal())
      )
    )$policy$,runtime_role);
  execute format($policy$
    create policy messages_runtime_insert on agent_bridge.messages
    for insert to %I with check (
      workspace=(select agent_bridge.current_request_workspace())
      and source=(select agent_bridge.current_request_principal())
    )$policy$,runtime_role);

  execute format($policy$
    create policy receipts_runtime_select on agent_bridge.receipts
    for select to %I using (
      workspace=(select agent_bridge.current_request_workspace())
      and principal=(select agent_bridge.current_request_principal())
    )$policy$,runtime_role);
  execute format($policy$
    create policy receipts_runtime_insert on agent_bridge.receipts
    for insert to %I with check (
      workspace=(select agent_bridge.current_request_workspace())
      and principal=(select agent_bridge.current_request_principal())
    )$policy$,runtime_role);

  execute format($policy$
    create policy deliveries_runtime_select on agent_bridge.deliveries
    for select to %I using (
      workspace=(select agent_bridge.current_request_workspace())
      and (
        recipient=(select agent_bridge.current_request_principal())
        or publisher=(select agent_bridge.current_request_principal())
      )
    )$policy$,runtime_role);
  execute format($policy$
    create policy deliveries_runtime_insert on agent_bridge.deliveries
    for insert to %I with check (
      workspace=(select agent_bridge.current_request_workspace())
      and publisher=(select agent_bridge.current_request_principal())
    )$policy$,runtime_role);
  execute format($policy$
    create policy deliveries_runtime_update on agent_bridge.deliveries
    for update to %I using (
      workspace=(select agent_bridge.current_request_workspace())
      and (
        recipient=(select agent_bridge.current_request_principal())
        or publisher=(select agent_bridge.current_request_principal())
      )
    ) with check (
      workspace=(select agent_bridge.current_request_workspace())
      and (
        recipient=(select agent_bridge.current_request_principal())
        or publisher=(select agent_bridge.current_request_principal())
      )
    )$policy$,runtime_role);

  execute format($policy$
    create policy delivery_events_runtime_select on agent_bridge.delivery_events
    for select to %I using (
      workspace=(select agent_bridge.current_request_workspace())
      and (
        recipient=(select agent_bridge.current_request_principal())
        or publisher=(select agent_bridge.current_request_principal())
      )
    )$policy$,runtime_role);
  execute format(
    'create policy delivery_events_writer_insert on agent_bridge.delivery_events for insert to %I with check (true)',
    event_writer
  );

  execute format($policy$
    create policy agent_instances_runtime_select on agent_bridge.agent_instances
    for select to %I using (
      workspace=(select agent_bridge.current_request_workspace())
    )$policy$,runtime_role);
  execute format($policy$
    create policy agent_instances_runtime_insert on agent_bridge.agent_instances
    for insert to %I with check (
      workspace=(select agent_bridge.current_request_workspace())
      and agent=(select agent_bridge.current_request_principal())
    )$policy$,runtime_role);
  execute format($policy$
    create policy agent_instances_runtime_update on agent_bridge.agent_instances
    for update to %I using (
      workspace=(select agent_bridge.current_request_workspace())
      and agent=(select agent_bridge.current_request_principal())
    ) with check (
      workspace=(select agent_bridge.current_request_workspace())
      and agent=(select agent_bridge.current_request_principal())
    )$policy$,runtime_role);
  execute format($policy$
    create policy agent_instances_runtime_delete on agent_bridge.agent_instances
    for delete to %I using (
      workspace=(select agent_bridge.current_request_workspace())
      and (
        agent=(select agent_bridge.current_request_principal())
        or lease_expires_at<=now()
      )
    )$policy$,runtime_role);
end
$policies$;

do $grants$
declare
  suffix text := substr(md5(current_database()),1,16);
  runtime_role text := 'agent_bridge_runtime_' || suffix;
  data_owner text := 'agent_bridge_data_owner_' || suffix;
  context_reader text := 'agent_bridge_context_reader_' || suffix;
  event_writer text := 'agent_bridge_event_writer_' || suffix;
  role_name text;
begin
  execute format('revoke %I,%I,%I from %I',data_owner,context_reader,event_writer,runtime_role);
  execute format(
    'revoke all on agent_bridge.messages,agent_bridge.receipts,agent_bridge.deliveries,agent_bridge.delivery_events,agent_bridge.agent_instances from %I',
    runtime_role
  );
  execute format('grant select,insert on agent_bridge.messages,agent_bridge.receipts to %I',runtime_role);
  execute format('grant select,insert,update on agent_bridge.deliveries to %I',runtime_role);
  execute format('grant select on agent_bridge.delivery_events to %I',runtime_role);
  execute format('grant select,insert,update,delete on agent_bridge.agent_instances to %I',runtime_role);
  execute format('grant select on agent_bridge.row_isolation_attestations to %I',runtime_role);
  execute format('revoke all on all sequences in schema agent_bridge from %I',runtime_role);
  revoke all on sequence agent_bridge.messages_sequence_seq from public;
  revoke all on sequence agent_bridge.delivery_events_sequence_seq from public;
  execute format('grant usage on sequence agent_bridge.messages_sequence_seq to %I',runtime_role);
  execute format('grant execute on function agent_bridge.current_request_workspace() to %I',runtime_role);
  execute format('grant execute on function agent_bridge.current_request_principal() to %I',runtime_role);
  execute format('grant execute on function agent_bridge.row_isolation_catalog_definition() to %I',runtime_role);
  execute format('revoke all on function agent_bridge.record_delivery_event() from %I',runtime_role);
  execute format('revoke all on function agent_bridge.reject_delivery_identity_mutation() from %I',runtime_role);
  execute format('revoke all on function agent_bridge.reject_delivery_event_mutation() from %I',runtime_role);
  execute format('revoke all on function agent_bridge.enforce_delivery_actor_role() from %I',runtime_role);
  foreach role_name in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on function agent_bridge.current_request_workspace() from %I',role_name);
      execute format('revoke all on function agent_bridge.current_request_principal() from %I',role_name);
      execute format('revoke all on function agent_bridge.record_delivery_event() from %I',role_name);
    end if;
  end loop;
end
$grants$;

insert into agent_bridge.row_isolation_attestations(name,catalog_definition)
values ('domain-v1',agent_bridge.row_isolation_catalog_definition());

insert into agent_bridge.schema_migrations(version,name,checksum)
values (13,'row_isolation','__AGENT_BRIDGE_MIGRATION_CHECKSUM__');

commit;
