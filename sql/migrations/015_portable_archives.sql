begin;

select pg_advisory_xact_lock(1646705660);

do $preflight$
begin
  if not agent_bridge.security_schema_ready()
    or not agent_bridge.owner_control_plane_ready()
    or not exists(
      select 1 from agent_bridge.row_isolation_attestations attestation
      where attestation.name='domain-v1'
        and attestation.catalog_definition=agent_bridge.row_isolation_catalog_definition()
    ) then
    raise exception 'portable archive prerequisite readiness validation failed';
  end if;
end
$preflight$;

do $roles$
declare
  role_name text := 'agent_bridge_archive_operator_'||substr(md5(current_database()),1,16);
begin
  if not exists(select 1 from pg_catalog.pg_roles where rolname=role_name) then
    execute format(
      'create role %I nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls',
      role_name
    );
  end if;
  if exists (
    select 1 from pg_catalog.pg_roles where rolname=role_name and (
      rolcanlogin or not rolinherit or rolsuper or rolcreatedb or rolcreaterole
      or rolreplication or rolbypassrls or rolconnlimit<>-1
    )
  ) then
    raise exception 'Agent Bridge archive role has unsafe attributes';
  end if;
  if current_setting('server_version_num')::integer>=160000 then
    if not exists (
      select 1 from pg_catalog.pg_auth_members membership
      join pg_catalog.pg_roles granted on granted.oid=membership.roleid
      join pg_catalog.pg_roles member on member.oid=membership.member
      where granted.rolname=role_name and member.rolname=current_user
        and membership.admin_option
    ) then
      execute format(
        'grant %I to %I with admin true,inherit true,set true',role_name,current_user
      );
    elsif not exists (
      select 1 from pg_catalog.pg_auth_members membership
      join pg_catalog.pg_roles granted on granted.oid=membership.roleid
      join pg_catalog.pg_roles member on member.oid=membership.member
      where granted.rolname=role_name and member.rolname=current_user
        and coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true)
        and coalesce((to_jsonb(membership)->>'set_option')::boolean,true)
    ) then
      execute format('grant %I to %I with inherit true,set true',role_name,current_user);
    end if;
  elsif not exists (
    select 1 from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    where granted.rolname=role_name and member.rolname=current_user
      and membership.admin_option
  ) then
    execute format('grant %I to %I with admin option',role_name,current_user);
  end if;
  if not exists (
    select 1 from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    where granted.rolname=role_name and member.rolname=current_user
      and membership.admin_option
  ) or not exists (
    select 1 from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    where granted.rolname=role_name and member.rolname=current_user
      and coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true)
      and coalesce((to_jsonb(membership)->>'set_option')::boolean,true)
  ) or exists (
    select 1 from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    where granted.rolname=role_name and member.rolname=current_user
      and not (
        (membership.grantor=10 and membership.admin_option
          and coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true)
            =coalesce((to_jsonb(membership)->>'set_option')::boolean,true))
        or (membership.grantor=member.oid
          and coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true)
          and coalesce((to_jsonb(membership)->>'set_option')::boolean,true))
      )
  ) then
    raise exception 'Agent Bridge archive role has unsafe owner authority';
  end if;
end
$roles$;

create table agent_bridge.archive_membership_events (
  sequence bigint generated always as identity primary key,
  request_id uuid not null unique,
  action text not null,
  member_role name not null,
  actor name not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint archive_membership_events_action check(action in ('register','revoke'))
);

create table agent_bridge.archive_operations (
  sequence bigint generated always as identity primary key,
  request_id uuid not null,
  phase text not null,
  operation text not null,
  workspace text not null,
  client_verified_digest char(64),
  message_count bigint,
  receipt_count bigint,
  message_inserted_count bigint,
  receipt_inserted_count bigint,
  server_content_binding char(64),
  outcome text,
  failure_code text,
  published_at timestamptz,
  apply boolean,
  actor name not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint archive_operations_request_phase unique(request_id,phase),
  constraint archive_operations_phase check(phase in ('begin','complete')),
  constraint archive_operations_operation check(operation in ('export','import')),
  constraint archive_operations_digest check(
    (phase='begin' and operation='export' and client_verified_digest is null)
    or (phase='complete' and outcome='abandoned' and client_verified_digest is null)
    or (client_verified_digest ~ '^[0-9a-f]{64}$')
  ),
  constraint archive_operations_counts check(
    (phase='begin' and (
      (operation='export' and message_count is null and receipt_count is null)
      or (operation='import' and message_count>=0 and receipt_count>=0)
    ) and message_inserted_count is null and receipt_inserted_count is null
      and server_content_binding is null and outcome is null and failure_code is null
      and published_at is null
      and apply is null)
    or (phase='complete' and message_count>=0 and receipt_count>=0
      and message_inserted_count>=0 and message_inserted_count<=message_count
      and receipt_inserted_count>=0 and receipt_inserted_count<=receipt_count
      and server_content_binding ~ '^[0-9a-f]{64}$' and apply is not null
      and outcome in ('published','client_reconciled','applied','dry-run') and failure_code is null
      and ((outcome in ('published','client_reconciled') and published_at is not null)
        or (outcome in ('applied','dry-run') and published_at is null)))
    or (phase='complete' and outcome='abandoned'
      and failure_code ~ '^[a-z][a-z0-9_]{0,63}$' and client_verified_digest is null
      and message_count=0 and receipt_count=0 and message_inserted_count=0
      and receipt_inserted_count=0 and server_content_binding=
        encode(sha256(convert_to('','UTF8')),'hex') and published_at is null and apply=false)
  ),
  constraint archive_operations_outcome check(
    outcome is null or outcome in ('published','client_reconciled','applied','dry-run','abandoned')
  )
);

create table agent_bridge.archive_operation_batches (
  sequence bigint generated always as identity primary key,
  request_id uuid not null,
  record_kind text not null,
  batch_ordinal bigint not null,
  record_count bigint not null,
  batch_fingerprint char(64) not null,
  chain_binding char(64) not null,
  actor name not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint archive_operation_batches_identity unique(request_id,record_kind,batch_ordinal),
  constraint archive_operation_batches_kind check(record_kind in ('message','receipt')),
  constraint archive_operation_batches_ordinal check(batch_ordinal>=0),
  constraint archive_operation_batches_count check(record_count between 1 and 1000),
  constraint archive_operation_batches_fingerprint check(batch_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint archive_operation_batches_chain check(chain_binding ~ '^[0-9a-f]{64}$')
);

create table agent_bridge.archive_import_records (
  sequence bigint generated always as identity primary key,
  request_id uuid not null,
  record_kind text not null,
  record_key text not null,
  batch_ordinal bigint not null,
  semantic_fingerprint char(64) not null,
  inserted boolean not null,
  actor name not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint archive_import_records_identity unique(request_id,record_kind,record_key),
  constraint archive_import_records_kind check(record_kind in ('message','receipt')),
  constraint archive_import_records_key check(record_key<>''),
  constraint archive_import_records_ordinal check(batch_ordinal>=0),
  constraint archive_import_records_fingerprint check(semantic_fingerprint ~ '^[0-9a-f]{64}$')
);

create table agent_bridge.archive_transaction_authorizations (
  backend_pid integer not null,
  transaction_id text not null,
  request_id uuid not null,
  operation text not null,
  workspace text not null,
  client_verified_digest char(64),
  actor name not null,
  messages_consumed boolean not null default false,
  receipts_consumed boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  primary key(backend_pid,transaction_id,request_id),
  constraint archive_transaction_authorizations_backend check(backend_pid>0),
  constraint archive_transaction_authorizations_transaction check(transaction_id~'^[0-9]+$'),
  constraint archive_transaction_authorizations_operation check(operation in ('export','import')),
  constraint archive_transaction_authorizations_digest check(
    (operation='export' and client_verified_digest is null)
    or (operation='import' and client_verified_digest~'^[0-9a-f]{64}$')
  )
);

create table agent_bridge.portable_archive_attestations (
  name text primary key,
  catalog_definition text not null,
  attested_at timestamptz not null default now(),
  constraint portable_archive_attestation_name check(name='portable-archive-v1')
);

create index archive_operations_workspace_sequence
  on agent_bridge.archive_operations(workspace,sequence desc);
create index archive_membership_events_member_sequence
  on agent_bridge.archive_membership_events(member_role,sequence desc);
create index archive_operation_batches_request_sequence
  on agent_bridge.archive_operation_batches(request_id,sequence);
create index archive_import_records_request_sequence
  on agent_bridge.archive_import_records(request_id,sequence);

create or replace function agent_bridge.reject_archive_ledger_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'portable archive ledgers are append-only';
end
$$;

create trigger archive_membership_events_append_only
before update or delete or truncate on agent_bridge.archive_membership_events
for each statement execute function agent_bridge.reject_archive_ledger_mutation();
create trigger archive_operations_append_only
before update or delete or truncate on agent_bridge.archive_operations
for each statement execute function agent_bridge.reject_archive_ledger_mutation();
create trigger archive_operation_batches_append_only
before update or delete or truncate on agent_bridge.archive_operation_batches
for each statement execute function agent_bridge.reject_archive_ledger_mutation();
create trigger archive_import_records_append_only
before update or delete or truncate on agent_bridge.archive_import_records
for each statement execute function agent_bridge.reject_archive_ledger_mutation();
create trigger portable_archive_attestations_append_only
before update or delete or truncate on agent_bridge.portable_archive_attestations
for each statement execute function agent_bridge.reject_archive_ledger_mutation();

create or replace function agent_bridge.assert_archive_actor()
returns void language plpgsql security definer set search_path = '' as $$
declare
  suffix text := substr(md5(current_database()),1,16);
  schema_owner name;
  archive_role name := ('agent_bridge_archive_operator_'||suffix)::name;
  archive_allowed boolean := false;
begin
  if not agent_bridge.portable_archive_ready() then
    raise exception 'portable archive readiness validation failed';
  end if;
  select pg_catalog.pg_get_userbyid(namespace.nspowner)::name into schema_owner
  from pg_catalog.pg_namespace namespace where namespace.nspname='agent_bridge';
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'archive-membership'||chr(31)||session_user||chr(31)||'global',1646705662
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'archive-membership'||chr(31)||session_user||chr(31)||'operator',1646705662
  ));

  with latest as (
    select event.action from agent_bridge.archive_membership_events event
    where event.member_role=session_user order by event.sequence desc limit 1
  ), direct_membership as (
    select bool_or(membership.admin_option) admin_option,
      bool_or(coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true)) inherit_option,
      bool_or(coalesce((to_jsonb(membership)->>'set_option')::boolean,true)) set_option,
      bool_and(case when member.rolname=schema_owner then
        (membership.grantor=10 and membership.admin_option
          and coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true)
            =coalesce((to_jsonb(membership)->>'set_option')::boolean,true))
        or (membership.grantor=member.oid
          and coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true)
          and coalesce((to_jsonb(membership)->>'set_option')::boolean,true))
      else membership.grantor=(select oid from pg_catalog.pg_roles where rolname=schema_owner)
        and not membership.admin_option
        and coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true)
        and coalesce((to_jsonb(membership)->>'set_option')::boolean,true) end) grants_valid
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    where member.rolname=session_user and granted.rolname=archive_role
  )
  select coalesce(bool_or(
    membership.inherit_option and membership.set_option
    and membership.grants_valid and (
      (session_user=schema_owner and membership.admin_option)
      or (latest.action='register' and not membership.admin_option)
    )
  ),false) into archive_allowed
  from direct_membership membership left join latest on true;

  if session_user<>schema_owner and (exists (
    select 1 from pg_catalog.pg_roles inherited
    where inherited.rolname<>session_user
      and pg_catalog.pg_has_role(session_user,inherited.rolname,'MEMBER')
      and inherited.rolname<>archive_role
  ) or exists (
    select 1 from pg_catalog.pg_roles candidate
    where candidate.rolname not in (session_user,schema_owner)
      and not candidate.rolsuper
      and pg_catalog.pg_has_role(candidate.rolname,session_user,'MEMBER')
  ) or exists (
    select 1 from pg_catalog.pg_roles actor where actor.rolname=session_user and (
      not actor.rolcanlogin or actor.rolsuper or actor.rolcreaterole or actor.rolcreatedb
      or actor.rolreplication or actor.rolbypassrls
    )
  )) then
    raise exception 'archive actor has an unsafe membership graph';
  end if;
  if not archive_allowed then
    raise exception 'archive actor is not registered';
  end if;
end
$$;

create or replace function agent_bridge.register_archive_member(
  requested_request_id uuid, requested_member_role name
) returns table(replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  suffix text := substr(md5(current_database()),1,16);
  archive_role name := ('agent_bridge_archive_operator_'||suffix)::name;
  prior agent_bridge.archive_membership_events%rowtype;
  member_record pg_catalog.pg_roles%rowtype;
begin
  if not agent_bridge.portable_archive_ready() then
    raise exception 'portable archive readiness validation failed';
  end if;
  if requested_request_id is null or requested_member_role is null
    or requested_member_role in (current_user::name,archive_role) then
    raise exception 'invalid archive membership registration';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'archive-membership'||chr(31)||requested_member_role||chr(31)||'global',1646705662
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'archive-membership'||chr(31)||requested_member_role||chr(31)||'operator',1646705662
  ));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_request_id::text,1646705660)
  );
  select * into prior from agent_bridge.archive_membership_events
  where request_id=requested_request_id;
  if found then
    if prior.action<>'register' or prior.member_role<>requested_member_role then
      raise exception 'request id was already used with different content';
    end if;
    return query select true;
    return;
  end if;
  select * into member_record from pg_catalog.pg_roles where rolname=requested_member_role;
  if not found or not member_record.rolcanlogin or member_record.rolsuper
    or member_record.rolcreaterole or member_record.rolcreatedb
    or member_record.rolreplication or member_record.rolbypassrls then
    raise exception 'archive membership target is not an eligible login';
  end if;
  if exists (
    select 1 from pg_catalog.pg_roles inherited
    where inherited.rolname<>requested_member_role
      and pg_catalog.pg_has_role(requested_member_role,inherited.rolname,'MEMBER')
      and inherited.rolname<>archive_role
  ) or exists (
    select 1 from pg_catalog.pg_roles candidate
    where candidate.rolname not in (requested_member_role,current_user)
      and not candidate.rolsuper
      and pg_catalog.pg_has_role(candidate.rolname,requested_member_role,'MEMBER')
  ) then
    raise exception 'archive membership target has an unsafe membership graph';
  end if;
  if exists (
    select 1 from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    join pg_catalog.pg_roles grantor on grantor.oid=membership.grantor
    where granted.rolname=archive_role and member.rolname=requested_member_role and (
      membership.admin_option
      or not coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true)
      or not coalesce((to_jsonb(membership)->>'set_option')::boolean,true)
      or grantor.rolname<>current_user
    )
  ) then
    raise exception 'archive membership target has an unsafe direct grant';
  end if;
  execute format('grant %I to %I',archive_role,requested_member_role);
  insert into agent_bridge.archive_membership_events(request_id,action,member_role,actor)
  values(requested_request_id,'register',requested_member_role,session_user);
  return query select false;
end
$$;

create or replace function agent_bridge.revoke_archive_member(
  requested_request_id uuid, requested_member_role name
) returns table(replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  suffix text := substr(md5(current_database()),1,16);
  archive_role name := ('agent_bridge_archive_operator_'||suffix)::name;
  prior agent_bridge.archive_membership_events%rowtype;
begin
  if not agent_bridge.portable_archive_ready() then
    raise exception 'portable archive readiness validation failed';
  end if;
  if requested_request_id is null or requested_member_role is null
    or requested_member_role in (current_user::name,archive_role) then
    raise exception 'invalid archive membership revocation';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'archive-membership'||chr(31)||requested_member_role||chr(31)||'global',1646705662
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'archive-membership'||chr(31)||requested_member_role||chr(31)||'operator',1646705662
  ));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_request_id::text,1646705660)
  );
  select * into prior from agent_bridge.archive_membership_events
  where request_id=requested_request_id;
  if found then
    if prior.action<>'revoke' or prior.member_role<>requested_member_role then
      raise exception 'request id was already used with different content';
    end if;
    return query select true;
    return;
  end if;
  if exists(select 1 from pg_catalog.pg_roles where rolname=requested_member_role) then
    execute format('revoke %I from %I',archive_role,requested_member_role);
  end if;
  insert into agent_bridge.archive_membership_events(request_id,action,member_role,actor)
  values(requested_request_id,'revoke',requested_member_role,session_user);
  return query select false;
end
$$;

create or replace function agent_bridge.archive_assert_operation(
  requested_request_id uuid, requested_operation text, requested_workspace text,
  requested_digest character(64)
) returns void language plpgsql security definer set search_path = '' as $$
declare
  binding agent_bridge.archive_operations%rowtype;
begin
  perform agent_bridge.assert_archive_actor();
  if requested_request_id is null or requested_operation not in ('export','import')
    or requested_workspace is null or requested_workspace='' or requested_workspace<>btrim(requested_workspace)
    or (requested_operation='import' and (
      requested_digest is null or requested_digest!~'^[0-9a-f]{64}$'
    )) or (requested_operation='export' and requested_digest is not null) then
    raise exception 'archive operation binding is invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'portable-archive'||chr(31)||requested_workspace,1646705663
  ));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_request_id::text,1646705660)
  );
  select * into binding from agent_bridge.archive_operations
  where request_id=requested_request_id and phase='begin';
  if not found or binding.operation<>requested_operation
    or binding.workspace<>requested_workspace
    or binding.client_verified_digest is distinct from requested_digest
    or binding.actor<>session_user then
    raise exception 'archive operation binding does not match the active request';
  end if;
  if exists(select 1 from agent_bridge.archive_operations
    where request_id=requested_request_id and phase='complete') then
    raise exception 'archive operation is final';
  end if;
end
$$;

create or replace function agent_bridge.archive_authorize_transaction(
  requested_request_id uuid, requested_operation text, requested_workspace text,
  requested_digest character(64)
) returns void language plpgsql security definer set search_path = '' as $$
declare prior agent_bridge.archive_transaction_authorizations%rowtype;
begin
  perform agent_bridge.archive_assert_operation(
    requested_request_id,requested_operation,requested_workspace,requested_digest
  );
  select * into prior from agent_bridge.archive_transaction_authorizations transaction_auth
    where transaction_auth.backend_pid=pg_catalog.pg_backend_pid()
      and transaction_auth.transaction_id=pg_catalog.pg_current_xact_id()::text
      and transaction_auth.request_id=requested_request_id;
  if found then
    if prior.operation<>requested_operation or prior.workspace<>requested_workspace
      or prior.client_verified_digest is distinct from requested_digest
      or prior.actor<>session_user then
      raise exception 'archive transaction authorization conflicts with prior content';
    end if;
    return;
  end if;
  insert into agent_bridge.archive_transaction_authorizations(
    backend_pid,transaction_id,request_id,operation,workspace,client_verified_digest,actor
  ) values (
    pg_catalog.pg_backend_pid(),pg_catalog.pg_current_xact_id()::text,
    requested_request_id,requested_operation,requested_workspace,requested_digest,session_user
  );
end
$$;

create or replace function agent_bridge.archive_assert_transaction(
  requested_request_id uuid, requested_operation text, requested_workspace text,
  requested_digest character(64)
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from agent_bridge.archive_transaction_authorizations transaction_auth
    where transaction_auth.backend_pid=pg_catalog.pg_backend_pid()
      and transaction_auth.transaction_id=pg_catalog.pg_current_xact_id()::text
      and transaction_auth.request_id=requested_request_id
      and transaction_auth.operation=requested_operation
      and transaction_auth.workspace=requested_workspace
      and transaction_auth.client_verified_digest is not distinct from requested_digest
      and transaction_auth.actor=session_user) then
    raise exception 'archive transaction is not authorized';
  end if;
end
$$;

create or replace function agent_bridge.archive_close_transaction_authorization(
  requested_request_id uuid
) returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from agent_bridge.archive_transaction_authorizations transaction_auth
    where transaction_auth.backend_pid=pg_catalog.pg_backend_pid()
      and transaction_auth.transaction_id=pg_catalog.pg_current_xact_id()::text
      and transaction_auth.request_id=requested_request_id and transaction_auth.actor=session_user;
  if not found then raise exception 'archive transaction authorization is missing'; end if;
end
$$;

create or replace function agent_bridge.archive_begin_operation(
  requested_request_id uuid, requested_operation text, requested_workspace text,
  requested_digest character(64), requested_message_count bigint,
  requested_receipt_count bigint
) returns table(
  replayed boolean, completed boolean, outcome text, message_count bigint,
  receipt_count bigint, message_inserted_count bigint, receipt_inserted_count bigint,
  apply boolean, client_verified_digest character(64), published_at text
)
language plpgsql security definer set search_path = '' as $$
declare
  binding agent_bridge.archive_operations%rowtype;
  terminal agent_bridge.archive_operations%rowtype;
begin
  perform agent_bridge.assert_archive_actor();
  if requested_request_id is null or requested_operation not in ('export','import')
    or requested_workspace is null or requested_workspace='' or requested_workspace<>btrim(requested_workspace)
    or (requested_operation='import' and (
      requested_digest is null or requested_digest!~'^[0-9a-f]{64}$'
      or requested_message_count is null or requested_message_count<0
      or requested_receipt_count is null or requested_receipt_count<0
    )) or (requested_operation='export' and (
      requested_digest is not null or requested_message_count is not null
      or requested_receipt_count is not null
    )) then
    raise exception 'archive operation binding is invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'portable-archive'||chr(31)||requested_workspace,1646705663
  ));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_request_id::text,1646705660)
  );
  if not exists(select 1 from agent_bridge.workspaces where id=requested_workspace) then
    raise exception 'archive workspace does not exist';
  end if;
  select * into binding from agent_bridge.archive_operations
  where request_id=requested_request_id and phase='begin';
  if found then
    if binding.operation<>requested_operation or binding.workspace<>requested_workspace
      or binding.client_verified_digest is distinct from requested_digest
      or binding.message_count is distinct from requested_message_count
      or binding.receipt_count is distinct from requested_receipt_count
      or binding.actor<>session_user then
      raise exception 'request id was already used with different content';
    end if;
    select * into terminal from agent_bridge.archive_operations
      where request_id=requested_request_id and phase='complete';
    if found and terminal.outcome='abandoned' then
      raise exception 'archive operation was abandoned';
    end if;
    return query select true,found,terminal.outcome,terminal.message_count,
      terminal.receipt_count,terminal.message_inserted_count,
      terminal.receipt_inserted_count,terminal.apply,terminal.client_verified_digest,
      case when terminal.published_at is null then null else to_char(
        terminal.published_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) end;
    return;
  end if;
  insert into agent_bridge.archive_operations(
    request_id,phase,operation,workspace,client_verified_digest,message_count,receipt_count,actor
  ) values (
    requested_request_id,'begin',requested_operation,requested_workspace,
    requested_digest,requested_message_count,requested_receipt_count,session_user
  );
  return query select false,false,null::text,null::bigint,null::bigint,
    null::bigint,null::bigint,null::boolean,null::character(64),null::text;
end
$$;

create or replace function agent_bridge.archive_export_messages(
  requested_request_id uuid, requested_workspace text,
  after_created_at timestamptz, after_id uuid, requested_limit integer
) returns table(
  sequence bigint,id uuid,workspace text,project text,source text,type text,content text,
  content_type text,data jsonb,targets jsonb,thread_id text,reply_to_id text,
  correlation_id text,causation_id text,priority text,expires_at text,idempotency_key text,
  atrib_receipt_id text,informed_by jsonb,metadata jsonb,delivery_mode text,
  delivery_max_attempts integer,delivery_retry_base_delay_ms integer,
  delivery_retry_max_delay_ms integer,delivery_retry_jitter_ratio double precision,
  delivery_not_before text,created_at text
) language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare returned_rows bigint;
begin
  perform agent_bridge.archive_assert_transaction(
    requested_request_id,'export',requested_workspace,null
  );
  if requested_limit is null or requested_limit not between 1 and 500
    or ((after_created_at is null)<>(after_id is null)) then
    raise exception 'archive export message page is invalid';
  end if;
  if coalesce((select pg_catalog.octet_length(to_jsonb(message)::text)+512
      from agent_bridge.messages message where message.workspace=requested_workspace
        and (after_created_at is null or (message.created_at,message.id)>(after_created_at,after_id))
      order by message.created_at,message.id limit 1),0)>3670016 then
    raise exception 'archive message exceeds the export record byte budget';
  end if;
  return query with size_candidate as materialized (
    select message.id,message.created_at,
      pg_catalog.octet_length(to_jsonb(message)::text)+512 raw_bytes
    from agent_bridge.messages message where message.workspace=requested_workspace
      and (after_created_at is null or (message.created_at,message.id)>(after_created_at,after_id))
    order by message.created_at,message.id limit requested_limit
  ), admitted as (
    select size_candidate.*,
      sum(size_candidate.raw_bytes) over(order by size_candidate.created_at,size_candidate.id)
        archive_cumulative_bytes
    from size_candidate
  )
  select message.sequence,message.id,message.workspace,message.project,message.source,message.type,
    message.content,message.content_type,message.data,message.targets,message.thread_id,
    message.reply_to_id,message.correlation_id,message.causation_id,message.priority,
    case when message.expires_at is null then null else
      to_char(message.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
    message.idempotency_key,message.atrib_receipt_id,message.informed_by,message.metadata,
    message.delivery_mode,message.delivery_max_attempts,message.delivery_retry_base_delay_ms,
    message.delivery_retry_max_delay_ms,message.delivery_retry_jitter_ratio,
    case when message.delivery_not_before is null then null else
      to_char(message.delivery_not_before at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
    to_char(message.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  from admitted join agent_bridge.messages message on message.id=admitted.id
  where admitted.archive_cumulative_bytes<=4194304
  order by admitted.created_at,admitted.id;
  get diagnostics returned_rows = row_count;
  if returned_rows=0 then
    update agent_bridge.archive_transaction_authorizations transaction_auth
      set messages_consumed=true
      where transaction_auth.backend_pid=pg_catalog.pg_backend_pid()
        and transaction_auth.transaction_id=pg_catalog.pg_current_xact_id()::text
        and transaction_auth.request_id=requested_request_id and transaction_auth.actor=session_user;
    if not found then raise exception 'archive transaction authorization is missing'; end if;
  end if;
end
$$;

create or replace function agent_bridge.archive_export_receipts(
  requested_request_id uuid, requested_workspace text, after_created_at timestamptz,
  after_message_id uuid, after_principal text, requested_limit integer
) returns table(message_id uuid,principal text,read_at text,message_created_at text)
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare returned_rows bigint;
begin
  perform agent_bridge.archive_assert_transaction(
    requested_request_id,'export',requested_workspace,null
  );
  if requested_limit is null or requested_limit not between 1 and 1000
    or ((after_created_at is null)<>(after_message_id is null))
    or ((after_created_at is null)<>(after_principal is null)) then
    raise exception 'archive export receipt page is invalid';
  end if;
  if coalesce((select pg_catalog.octet_length(jsonb_build_object(
      'message_id',receipt.message_id,'principal',receipt.principal,
      'read_at',receipt.read_at,'message_created_at',message.created_at
    )::text)+256 from agent_bridge.receipts receipt
    join agent_bridge.messages message on message.workspace=receipt.workspace
      and message.id=receipt.message_id
    where receipt.workspace=requested_workspace
      and (after_created_at is null or (message.created_at,message.id,receipt.principal)>
        (after_created_at,after_message_id,after_principal))
    order by message.created_at,message.id,receipt.principal limit 1),0)>1048576 then
    raise exception 'archive receipt exceeds the export record byte budget';
  end if;
  return query with size_candidate as materialized (
    select receipt.message_id,receipt.principal,message.created_at,
      pg_catalog.octet_length(jsonb_build_object(
        'message_id',receipt.message_id,'principal',receipt.principal,
        'read_at',receipt.read_at,'message_created_at',message.created_at
      )::text)+256 raw_bytes
    from agent_bridge.receipts receipt
    join agent_bridge.messages message on message.workspace=receipt.workspace
      and message.id=receipt.message_id
    where receipt.workspace=requested_workspace
      and (after_created_at is null or (message.created_at,message.id,receipt.principal)>
        (after_created_at,after_message_id,after_principal))
    order by message.created_at,message.id,receipt.principal limit requested_limit
  ), admitted as (
    select size_candidate.*,
      sum(size_candidate.raw_bytes)
        over(order by size_candidate.created_at,size_candidate.message_id,size_candidate.principal)
        archive_cumulative_bytes
    from size_candidate
  )
  select receipt.message_id,receipt.principal,
    to_char(receipt.read_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    to_char(message.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  from admitted join agent_bridge.receipts receipt on receipt.workspace=requested_workspace
    and receipt.message_id=admitted.message_id and receipt.principal=admitted.principal
  join agent_bridge.messages message on message.workspace=receipt.workspace
    and message.id=receipt.message_id
  where admitted.archive_cumulative_bytes<=4194304
  order by admitted.created_at,admitted.message_id,admitted.principal;
  get diagnostics returned_rows = row_count;
  if returned_rows=0 then
    update agent_bridge.archive_transaction_authorizations transaction_auth
      set receipts_consumed=true
      where transaction_auth.backend_pid=pg_catalog.pg_backend_pid()
        and transaction_auth.transaction_id=pg_catalog.pg_current_xact_id()::text
        and transaction_auth.request_id=requested_request_id and transaction_auth.actor=session_user;
    if not found then raise exception 'archive transaction authorization is missing'; end if;
  end if;
end
$$;

create or replace function agent_bridge.archive_json_depth(requested_value jsonb)
returns integer language sql immutable strict set search_path = '' as $$
  with recursive walk(value,depth) as (
    select requested_value,0
    union all
    select child.value,walk.depth+1 from walk
    cross join lateral (
      select element.value from jsonb_array_elements(case when jsonb_typeof(walk.value)='array'
        then walk.value else '[]'::jsonb end) element
      union all
      select property.value from jsonb_each(case when jsonb_typeof(walk.value)='object'
        then walk.value else '{}'::jsonb end) property
    ) child
    where walk.depth<=16
  )
  select coalesce(max(depth),0) from walk
$$;

create or replace function agent_bridge.archive_import_messages(
  requested_request_id uuid, requested_workspace text, requested_digest character(64),
  requested_batch_ordinal bigint, requested_batch jsonb
) returns table(processed bigint,inserted bigint)
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  item jsonb;
  existing agent_bridge.messages%rowtype;
  delivery jsonb;
  data_value jsonb;
  metadata_value jsonb;
  message_id uuid;
  created_at_value timestamptz;
  expires_at_value timestamptz;
  not_before_value timestamptz;
  prior_batch agent_bridge.archive_operation_batches%rowtype;
  prior_record agent_bridge.archive_import_records%rowtype;
  batch_fingerprint_value text;
  previous_chain_binding text;
  chain_binding_value text;
  item_fingerprint text;
  was_inserted boolean;
  processed_value bigint := 0;
  inserted_value bigint := 0;
begin
  perform agent_bridge.archive_assert_transaction(
    requested_request_id,'import',requested_workspace,requested_digest
  );
  if requested_batch is null or jsonb_typeof(requested_batch)<>'array'
    or requested_batch_ordinal is null or requested_batch_ordinal<0
    or jsonb_array_length(requested_batch)=0
    or jsonb_array_length(requested_batch)>1000
    or pg_catalog.pg_column_size(requested_batch)>4194304 then
    raise exception 'archive message batch is invalid';
  end if;
  batch_fingerprint_value := encode(sha256(convert_to(requested_batch::text,'UTF8')),'hex');
  select * into prior_batch from agent_bridge.archive_operation_batches
    where request_id=requested_request_id and record_kind='message'
      and batch_ordinal=requested_batch_ordinal;
  if found then
    if prior_batch.batch_fingerprint<>batch_fingerprint_value
      or prior_batch.record_count<>jsonb_array_length(requested_batch)
      or prior_batch.actor<>session_user then
      raise exception 'archive message batch ordinal was already used with different content';
    end if;
    return query select prior_batch.record_count,
      coalesce((select count(*) from agent_bridge.archive_import_records record
        where record.request_id=requested_request_id and record.record_kind='message'
          and record.batch_ordinal=requested_batch_ordinal and record.inserted),0)::bigint;
    return;
  end if;
  if requested_batch_ordinal<>coalesce((select max(batch.batch_ordinal)+1
      from agent_bridge.archive_operation_batches batch
      where batch.request_id=requested_request_id and batch.record_kind='message'),0)
    or exists(select 1 from agent_bridge.archive_operation_batches batch
      where batch.request_id=requested_request_id and batch.record_kind='receipt') then
    raise exception 'archive message batches must be contiguous and precede receipts';
  end if;
  if requested_batch_ordinal=0 then
    previous_chain_binding := encode(sha256(convert_to('','UTF8')),'hex');
  else
    select batch.chain_binding into previous_chain_binding
      from agent_bridge.archive_operation_batches batch
      where batch.request_id=requested_request_id and batch.record_kind='message'
        and batch.batch_ordinal=requested_batch_ordinal-1;
  end if;
  chain_binding_value := encode(sha256(convert_to(
    previous_chain_binding||chr(31)||'message'||chr(31)||requested_batch_ordinal::text||
    chr(31)||jsonb_array_length(requested_batch)::text||chr(31)||batch_fingerprint_value,
    'UTF8')),'hex');
  for item in select value from jsonb_array_elements(requested_batch) loop
    was_inserted := false;
    if jsonb_typeof(item)<>'object'
      or (select count(*) from jsonb_object_keys(item))<>20
      or not item ?& array[
        'atribReceiptId','causationId','content','contentType','correlationId','createdAt',
        'data','deliveryPolicy','expiresAt','id','idempotencyKey','informedBy','metadata',
        'priority','project','replyToId','source','targets','threadId','type'
      ]
      or exists(select 1 from unnest(array[
        'id','source','type','content','contentType','priority','createdAt'
      ]) key where jsonb_typeof(item->key)<>'string')
      or exists(select 1 from unnest(array[
        'project','threadId','replyToId','correlationId','causationId','expiresAt',
        'idempotencyKey','atribReceiptId'
      ]) key where jsonb_typeof(item->key) not in ('string','null'))
      or jsonb_typeof(item->'targets')<>'array'
      or jsonb_typeof(item->'informedBy')<>'array'
      or jsonb_typeof(item->'deliveryPolicy')<>'object'
      or exists(select 1 from jsonb_array_elements(item->'targets') value
        where jsonb_typeof(value)<>'string')
      or exists(select 1 from jsonb_array_elements(item->'informedBy') value
        where jsonb_typeof(value)<>'string')
      or item->>'createdAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$'
      or (item->>'expiresAt' is not null and item->>'expiresAt'
        !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$')
      or (item#>>'{deliveryPolicy,notBefore}' is not null
        and item#>>'{deliveryPolicy,notBefore}'
          !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$') then
      raise exception 'archive message record is invalid';
    end if;
    if item->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or exists(select 1 from unnest(array['source','type','contentType']) key
        where item->>key='' or item->>key<>btrim(item->>key) or char_length(item->>key)>128)
      or item->>'content' is null or btrim(item->>'content')=''
      or pg_catalog.octet_length(item->>'content')>65536
      or item->>'priority' not in ('info','high','urgent')
      or (item->>'project' is not null and (
        item->>'project'='' or item->>'project'<>btrim(item->>'project')
        or char_length(item->>'project')>128
      ))
      or exists(select 1 from unnest(array[
        'threadId','replyToId','correlationId','causationId'
      ]) key where item->>key is not null and (
        item->>key='' or item->>key<>btrim(item->>key) or char_length(item->>key)>128
      ))
      or (item->>'idempotencyKey' is not null and (
        item->>'idempotencyKey'='' or item->>'idempotencyKey'<>btrim(item->>'idempotencyKey')
        or char_length(item->>'idempotencyKey')>256
      ))
      or (item->>'atribReceiptId' is not null and item->>'atribReceiptId'
        !~ '^[A-Za-z0-9_-]{43}[.][A-Za-z0-9_-]{43}$')
      or pg_catalog.octet_length((item->'data')::text)>3670016
      or pg_catalog.octet_length((item->'metadata')::text)>3670016
      or agent_bridge.archive_json_depth(item->'data')>16
      or agent_bridge.archive_json_depth(item->'metadata')>16
      or jsonb_array_length(item->'targets')>64
      or (select count(distinct value#>>'{}') from jsonb_array_elements(item->'targets') value)
        <>jsonb_array_length(item->'targets')
      or exists(select 1 from jsonb_array_elements(item->'targets') value where
        value#>>'{}'='' or value#>>'{}'<>btrim(value#>>'{}') or char_length(value#>>'{}')>128)
      or jsonb_array_length(item->'informedBy')>64
      or (select count(distinct value#>>'{}') from jsonb_array_elements(item->'informedBy') value)
        <>jsonb_array_length(item->'informedBy')
      or exists(select 1 from jsonb_array_elements(item->'informedBy') value
        where value#>>'{}' !~ '^sha256:[0-9a-f]{64}$') then
      raise exception 'archive message violates the persisted domain contract';
    end if;
    message_id := (item->>'id')::uuid;
    item_fingerprint := encode(sha256(convert_to(item::text,'UTF8')),'hex');
    select * into prior_record from agent_bridge.archive_import_records record
      where record.request_id=requested_request_id and record.record_kind='message'
        and record.record_key=message_id::text;
    if found then
      if prior_record.semantic_fingerprint<>item_fingerprint then
        raise exception 'archive message id was repeated with different content';
      end if;
      raise exception 'archive message id was repeated across batches';
    end if;
    created_at_value := (item->>'createdAt')::timestamptz;
    expires_at_value := case when item->>'expiresAt' is null then null
      else (item->>'expiresAt')::timestamptz end;
    not_before_value := case when item#>>'{deliveryPolicy,notBefore}' is null then null
      else (item#>>'{deliveryPolicy,notBefore}')::timestamptz end;
    if to_char(created_at_value at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        <>item->>'createdAt'
      or (expires_at_value is not null and to_char(expires_at_value at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')<>item->>'expiresAt')
      or (not_before_value is not null and to_char(not_before_value at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')<>item#>>'{deliveryPolicy,notBefore}') then
      raise exception 'archive message timestamp is not canonical';
    end if;
    delivery := item->'deliveryPolicy';
    data_value := case when jsonb_typeof(item->'data')='null' then null else item->'data' end;
    metadata_value := case when jsonb_typeof(item->'metadata')='null' then null else item->'metadata' end;
    if delivery->>'mode' not in ('mailbox','leased')
      or (delivery->>'mode'='mailbox' and delivery<>jsonb_build_object('mode','mailbox'))
      or (not_before_value is not null and expires_at_value is not null
        and not_before_value>=expires_at_value)
      or (delivery->>'mode'='leased' and (
        jsonb_array_length(item->'targets')=0
        or not delivery ?& array[
          'mode','maxAttempts','retryBaseDelayMs','retryMaxDelayMs','retryJitterRatio'
        ]
        or jsonb_typeof(delivery->'maxAttempts')<>'number'
        or jsonb_typeof(delivery->'retryBaseDelayMs')<>'number'
        or jsonb_typeof(delivery->'retryMaxDelayMs')<>'number'
        or jsonb_typeof(delivery->'retryJitterRatio')<>'number'
        or exists(select 1 from jsonb_object_keys(delivery) key
          where key not in ('mode','maxAttempts','retryBaseDelayMs','retryMaxDelayMs',
            'retryJitterRatio','notBefore'))
        or (delivery ? 'notBefore' and jsonb_typeof(delivery->'notBefore')<>'string')
        or (delivery->>'maxAttempts')::numeric<>trunc((delivery->>'maxAttempts')::numeric)
        or (delivery->>'maxAttempts')::numeric not between 1 and 100
        or (delivery->>'retryBaseDelayMs')::numeric<>
          trunc((delivery->>'retryBaseDelayMs')::numeric)
        or (delivery->>'retryBaseDelayMs')::numeric not between 1 and 3600000
        or (delivery->>'retryMaxDelayMs')::numeric<>
          trunc((delivery->>'retryMaxDelayMs')::numeric)
        or (delivery->>'retryMaxDelayMs')::numeric<
          (delivery->>'retryBaseDelayMs')::numeric
        or (delivery->>'retryMaxDelayMs')::numeric>86400000
        or (delivery->>'retryJitterRatio')::numeric not between 0 and 1
      )) then
      raise exception 'archive message delivery policy is invalid';
    end if;
    select * into existing from agent_bridge.messages where id=message_id;
    if found then
      if existing.workspace is distinct from requested_workspace
        or existing.project is distinct from item->>'project'
        or existing.source is distinct from item->>'source'
        or existing.type is distinct from item->>'type'
        or existing.content is distinct from item->>'content'
        or existing.content_type is distinct from item->>'contentType'
        or existing.data is distinct from data_value
        or existing.targets is distinct from item->'targets'
        or existing.thread_id is distinct from item->>'threadId'
        or existing.reply_to_id is distinct from item->>'replyToId'
        or existing.correlation_id is distinct from item->>'correlationId'
        or existing.causation_id is distinct from item->>'causationId'
        or existing.priority is distinct from item->>'priority'
        or existing.expires_at is distinct from expires_at_value
        or existing.idempotency_key is distinct from item->>'idempotencyKey'
        or existing.atrib_receipt_id is distinct from item->>'atribReceiptId'
        or coalesce(existing.informed_by,'[]'::jsonb) is distinct from item->'informedBy'
        or existing.metadata is distinct from metadata_value
        or existing.delivery_mode is distinct from delivery->>'mode'
        or existing.delivery_max_attempts is distinct from (delivery->>'maxAttempts')::integer
        or existing.delivery_retry_base_delay_ms is distinct from (delivery->>'retryBaseDelayMs')::integer
        or existing.delivery_retry_max_delay_ms is distinct from (delivery->>'retryMaxDelayMs')::integer
        or existing.delivery_retry_jitter_ratio is distinct from (delivery->>'retryJitterRatio')::double precision
        or existing.delivery_not_before is distinct from not_before_value
        or existing.created_at is distinct from created_at_value then
        raise exception 'archive message conflicts with existing immutable content';
      end if;
    else
      insert into agent_bridge.messages(
        id,workspace,project,source,type,content,content_type,data,targets,thread_id,
        reply_to_id,correlation_id,causation_id,priority,expires_at,idempotency_key,
        atrib_receipt_id,informed_by,metadata,delivery_mode,delivery_max_attempts,
        delivery_retry_base_delay_ms,delivery_retry_max_delay_ms,
        delivery_retry_jitter_ratio,delivery_not_before,created_at
      ) values (
        message_id,requested_workspace,item->>'project',item->>'source',item->>'type',
        item->>'content',item->>'contentType',data_value,item->'targets',item->>'threadId',
        item->>'replyToId',item->>'correlationId',item->>'causationId',item->>'priority',
        expires_at_value,item->>'idempotencyKey',item->>'atribReceiptId',item->'informedBy',
        metadata_value,delivery->>'mode',(delivery->>'maxAttempts')::integer,
        (delivery->>'retryBaseDelayMs')::integer,(delivery->>'retryMaxDelayMs')::integer,
        (delivery->>'retryJitterRatio')::double precision,not_before_value,created_at_value
      );
      inserted_value := inserted_value+1;
      was_inserted := true;
    end if;
    insert into agent_bridge.archive_import_records(
      request_id,record_kind,record_key,batch_ordinal,semantic_fingerprint,inserted,actor
    ) values (
      requested_request_id,'message',message_id::text,requested_batch_ordinal,
      item_fingerprint,was_inserted,session_user
    );
    processed_value := processed_value+1;
  end loop;
  insert into agent_bridge.archive_operation_batches(
    request_id,record_kind,batch_ordinal,record_count,batch_fingerprint,chain_binding,actor
  ) values (
    requested_request_id,'message',requested_batch_ordinal,
    jsonb_array_length(requested_batch),batch_fingerprint_value,chain_binding_value,session_user
  );
  return query select processed_value,inserted_value;
end
$$;

create or replace function agent_bridge.archive_import_receipts(
  requested_request_id uuid, requested_workspace text, requested_digest character(64),
  requested_batch_ordinal bigint, requested_batch jsonb
) returns table(processed bigint,inserted bigint)
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  item jsonb;
  message_id_value uuid;
  read_at_value timestamptz;
  existing_read_at timestamptz;
  prior_batch agent_bridge.archive_operation_batches%rowtype;
  prior_record agent_bridge.archive_import_records%rowtype;
  batch_fingerprint_value text;
  previous_chain_binding text;
  chain_binding_value text;
  item_fingerprint text;
  record_key_value text;
  was_inserted boolean;
  processed_value bigint := 0;
  inserted_value bigint := 0;
begin
  perform agent_bridge.archive_assert_transaction(
    requested_request_id,'import',requested_workspace,requested_digest
  );
  if requested_batch is null or jsonb_typeof(requested_batch)<>'array'
    or requested_batch_ordinal is null or requested_batch_ordinal<0
    or jsonb_array_length(requested_batch)=0
    or jsonb_array_length(requested_batch)>1000
    or pg_catalog.pg_column_size(requested_batch)>4194304 then
    raise exception 'archive receipt batch is invalid';
  end if;
  if (select count(*) from agent_bridge.archive_import_records record
      where record.request_id=requested_request_id and record.record_kind='message')
      is distinct from (select operation.message_count from agent_bridge.archive_operations operation
        where operation.request_id=requested_request_id and operation.phase='begin') then
    raise exception 'archive receipts require the complete unique message pass';
  end if;
  batch_fingerprint_value := encode(sha256(convert_to(requested_batch::text,'UTF8')),'hex');
  select * into prior_batch from agent_bridge.archive_operation_batches
    where request_id=requested_request_id and record_kind='receipt'
      and batch_ordinal=requested_batch_ordinal;
  if found then
    if prior_batch.batch_fingerprint<>batch_fingerprint_value
      or prior_batch.record_count<>jsonb_array_length(requested_batch)
      or prior_batch.actor<>session_user then
      raise exception 'archive receipt batch ordinal was already used with different content';
    end if;
    return query select prior_batch.record_count,
      coalesce((select count(*) from agent_bridge.archive_import_records record
        where record.request_id=requested_request_id and record.record_kind='receipt'
          and record.batch_ordinal=requested_batch_ordinal and record.inserted),0)::bigint;
    return;
  end if;
  if requested_batch_ordinal<>coalesce((select max(batch.batch_ordinal)+1
      from agent_bridge.archive_operation_batches batch
      where batch.request_id=requested_request_id and batch.record_kind='receipt'),0) then
    raise exception 'archive receipt batches must be contiguous';
  end if;
  if requested_batch_ordinal=0 then
    select batch.chain_binding into previous_chain_binding
      from agent_bridge.archive_operation_batches batch
      where batch.request_id=requested_request_id and batch.record_kind='message'
      order by batch.batch_ordinal desc limit 1;
    previous_chain_binding := coalesce(previous_chain_binding,
      encode(sha256(convert_to('','UTF8')),'hex'));
  else
    select batch.chain_binding into previous_chain_binding
      from agent_bridge.archive_operation_batches batch
      where batch.request_id=requested_request_id and batch.record_kind='receipt'
        and batch.batch_ordinal=requested_batch_ordinal-1;
  end if;
  chain_binding_value := encode(sha256(convert_to(
    previous_chain_binding||chr(31)||'receipt'||chr(31)||requested_batch_ordinal::text||
    chr(31)||jsonb_array_length(requested_batch)::text||chr(31)||batch_fingerprint_value,
    'UTF8')),'hex');
  for item in select value from jsonb_array_elements(requested_batch) loop
    was_inserted := false;
    if jsonb_typeof(item)<>'object'
      or (select count(*) from jsonb_object_keys(item))<>3
      or not item ?& array['messageId','principal','readAt']
      or jsonb_typeof(item->'messageId')<>'string'
      or jsonb_typeof(item->'principal')<>'string'
      or jsonb_typeof(item->'readAt')<>'string'
      or item->>'principal'=''
      or item->>'principal'<>btrim(item->>'principal')
      or char_length(item->>'principal')>128
      or item->>'messageId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or item->>'readAt' is null
      or item->>'readAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$' then
      raise exception 'archive receipt record is invalid';
    end if;
    message_id_value := (item->>'messageId')::uuid;
    read_at_value := (item->>'readAt')::timestamptz;
    if to_char(read_at_value at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        <>item->>'readAt' then
      raise exception 'archive receipt timestamp is not canonical';
    end if;
    record_key_value := message_id_value::text||chr(31)||(item->>'principal');
    item_fingerprint := encode(sha256(convert_to(item::text,'UTF8')),'hex');
    select * into prior_record from agent_bridge.archive_import_records record
      where record.request_id=requested_request_id and record.record_kind='receipt'
        and record.record_key=record_key_value;
    if found then
      if prior_record.semantic_fingerprint<>item_fingerprint then
        raise exception 'archive receipt key was repeated with different content';
      end if;
      raise exception 'archive receipt key was repeated across batches';
    end if;
    if not exists(select 1 from agent_bridge.messages message
      where message.workspace=requested_workspace and message.id=message_id_value
        and (message.targets='[]'::jsonb or message.targets ? (item->>'principal'))) then
      raise exception 'archive receipt principal is not eligible to read the destination message';
    end if;
    select receipt.read_at into existing_read_at from agent_bridge.receipts receipt
    where receipt.workspace=requested_workspace and receipt.message_id=message_id_value
      and receipt.principal=item->>'principal';
    if found then
      if existing_read_at is distinct from read_at_value then
        raise exception 'archive receipt conflicts with existing content';
      end if;
    else
      insert into agent_bridge.receipts(workspace,message_id,principal,read_at)
      values(requested_workspace,message_id_value,item->>'principal',read_at_value);
      inserted_value := inserted_value+1;
      was_inserted := true;
    end if;
    insert into agent_bridge.archive_import_records(
      request_id,record_kind,record_key,batch_ordinal,semantic_fingerprint,inserted,actor
    ) values (
      requested_request_id,'receipt',record_key_value,requested_batch_ordinal,
      item_fingerprint,was_inserted,session_user
    );
    processed_value := processed_value+1;
  end loop;
  insert into agent_bridge.archive_operation_batches(
    request_id,record_kind,batch_ordinal,record_count,batch_fingerprint,chain_binding,actor
  ) values (
    requested_request_id,'receipt',requested_batch_ordinal,
    jsonb_array_length(requested_batch),batch_fingerprint_value,chain_binding_value,session_user
  );
  return query select processed_value,inserted_value;
end
$$;

create or replace function agent_bridge.archive_complete_export(
  requested_request_id uuid, requested_workspace text, requested_digest character(64),
  requested_message_count bigint, requested_receipt_count bigint,
  requested_published_at timestamptz, requested_completion_kind text
) returns table(replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  binding agent_bridge.archive_operations%rowtype;
  prior agent_bridge.archive_operations%rowtype;
  content_binding_value text;
begin
  perform agent_bridge.archive_assert_transaction(
    requested_request_id,'export',requested_workspace,null
  );
  if requested_digest is null or requested_digest!~'^[0-9a-f]{64}$'
    or requested_message_count is null or requested_message_count<0
    or requested_receipt_count is null or requested_receipt_count<0
    or requested_published_at is null
    or requested_completion_kind<>'published'
    or not exists(select 1 from agent_bridge.archive_transaction_authorizations transaction_auth
      where transaction_auth.backend_pid=pg_catalog.pg_backend_pid()
        and transaction_auth.transaction_id=pg_catalog.pg_current_xact_id()::text
        and transaction_auth.request_id=requested_request_id and transaction_auth.actor=session_user
        and transaction_auth.messages_consumed and transaction_auth.receipts_consumed) then
    raise exception 'archive completion counts are invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'portable-archive'||chr(31)||requested_workspace,1646705663
  ));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_request_id::text,1646705660)
  );
  select * into binding from agent_bridge.archive_operations
  where request_id=requested_request_id and phase='begin';
  if not found or binding.workspace<>requested_workspace
    or binding.operation<>'export' or binding.actor<>session_user then
    raise exception 'archive operation binding does not match the active request';
  end if;
  content_binding_value := encode(sha256(convert_to(
    requested_digest||chr(31)||requested_message_count::text||chr(31)||
      requested_receipt_count::text||chr(31)||to_char(
      requested_published_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )||chr(31)||requested_completion_kind,'UTF8')),'hex');
  select * into prior from agent_bridge.archive_operations
  where request_id=requested_request_id and phase='complete';
  if found then
    if prior.operation<>'export' or prior.workspace<>requested_workspace
      or prior.client_verified_digest<>requested_digest or prior.message_count<>requested_message_count
      or prior.receipt_count<>requested_receipt_count or prior.apply<>true
      or prior.outcome<>'published'
      or prior.server_content_binding<>content_binding_value
      or prior.published_at is distinct from requested_published_at
      or prior.actor<>session_user then
      raise exception 'request id was already completed with different content';
    end if;
    return query select true;
    return;
  end if;
  insert into agent_bridge.archive_operations(
    request_id,phase,operation,workspace,client_verified_digest,message_count,receipt_count,
    message_inserted_count,receipt_inserted_count,server_content_binding,
    outcome,published_at,apply,actor
  ) values (
    requested_request_id,'complete','export',requested_workspace,requested_digest,
    requested_message_count,requested_receipt_count,0,0,content_binding_value,
    'published',requested_published_at,true,session_user
  );
  return query select false;
end
$$;

create or replace function agent_bridge.archive_reconcile_export(
  requested_request_id uuid, requested_workspace text, requested_digest character(64),
  requested_message_count bigint, requested_receipt_count bigint,
  requested_published_at timestamptz
) returns table(replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  binding agent_bridge.archive_operations%rowtype;
  prior agent_bridge.archive_operations%rowtype;
  content_binding_value text;
begin
  perform agent_bridge.assert_archive_actor();
  if requested_digest is null or requested_digest!~'^[0-9a-f]{64}$'
    or requested_message_count is null or requested_message_count<0
    or requested_receipt_count is null or requested_receipt_count<0
    or requested_published_at is null then
    raise exception 'archive reconciliation metadata is invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'portable-archive'||chr(31)||requested_workspace,1646705663
  ));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_request_id::text,1646705660)
  );
  select * into binding from agent_bridge.archive_operations
    where request_id=requested_request_id and phase='begin';
  if not found or binding.workspace<>requested_workspace
    or binding.operation<>'export' or binding.actor<>session_user then
    raise exception 'archive operation binding does not match the active request';
  end if;
  content_binding_value := encode(sha256(convert_to(
    requested_digest||chr(31)||requested_message_count::text||chr(31)||
    requested_receipt_count::text||chr(31)||to_char(
      requested_published_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )||chr(31)||'reconciled','UTF8')),'hex');
  select * into prior from agent_bridge.archive_operations
    where request_id=requested_request_id and phase='complete';
  if found then
    if prior.operation<>'export' or prior.workspace<>requested_workspace
      or prior.client_verified_digest<>requested_digest or prior.message_count<>requested_message_count
      or prior.receipt_count<>requested_receipt_count or prior.apply<>true
      or prior.outcome<>'client_reconciled' or prior.server_content_binding<>content_binding_value
      or prior.published_at is distinct from requested_published_at
      or prior.actor<>session_user then
      raise exception 'request id was already completed with different content';
    end if;
    return query select true;
    return;
  end if;
  insert into agent_bridge.archive_operations(
    request_id,phase,operation,workspace,client_verified_digest,message_count,receipt_count,
    message_inserted_count,receipt_inserted_count,server_content_binding,
    outcome,published_at,apply,actor
  ) values (
    requested_request_id,'complete','export',requested_workspace,requested_digest,
    requested_message_count,requested_receipt_count,0,0,content_binding_value,
    'client_reconciled',requested_published_at,true,session_user
  );
  return query select false;
end
$$;

create or replace function agent_bridge.archive_complete_import(
  requested_request_id uuid, requested_workspace text, requested_apply boolean
) returns table(
  replayed boolean, message_count bigint, receipt_count bigint,
  message_inserted_count bigint, receipt_inserted_count bigint
)
language plpgsql security definer set search_path = '' as $$
declare
  binding agent_bridge.archive_operations%rowtype;
  prior agent_bridge.archive_operations%rowtype;
  actual_message_count bigint;
  actual_receipt_count bigint;
  actual_message_inserted bigint;
  actual_receipt_inserted bigint;
  content_binding_value text;
begin
  if requested_apply is null then raise exception 'archive completion mode is invalid'; end if;
  select * into binding from agent_bridge.archive_operations
    where request_id=requested_request_id and phase='begin';
  if not found or binding.workspace<>requested_workspace or binding.operation<>'import'
    or binding.actor<>session_user then
    raise exception 'archive operation binding does not match the active request';
  end if;
  perform agent_bridge.archive_assert_transaction(
    requested_request_id,'import',requested_workspace,binding.client_verified_digest
  );
  select * into prior from agent_bridge.archive_operations
    where request_id=requested_request_id and phase='complete';
  if found then
    if prior.outcome='abandoned' then raise exception 'archive operation was abandoned'; end if;
    if prior.operation<>'import' or prior.workspace<>requested_workspace
      or prior.apply<>requested_apply or prior.actor<>session_user then
      raise exception 'request id was already completed with different content';
    end if;
    return query select true,prior.message_count,prior.receipt_count,
      prior.message_inserted_count,prior.receipt_inserted_count;
    return;
  end if;
  select count(*)::bigint,count(*) filter(where record.inserted)::bigint
    into actual_message_count,actual_message_inserted
  from agent_bridge.archive_import_records record
  where record.request_id=requested_request_id and record.record_kind='message';
  select count(*)::bigint,count(*) filter(where record.inserted)::bigint
    into actual_receipt_count,actual_receipt_inserted
  from agent_bridge.archive_import_records record
  where record.request_id=requested_request_id and record.record_kind='receipt';
  if actual_message_count<>binding.message_count or actual_receipt_count<>binding.receipt_count then
    raise exception 'archive import record counts do not match the bound footer';
  end if;
  select batch.chain_binding into content_binding_value
    from agent_bridge.archive_operation_batches batch
    where batch.request_id=requested_request_id
    order by batch.sequence desc limit 1;
  content_binding_value := encode(sha256(convert_to(
    coalesce(content_binding_value,encode(sha256(convert_to('','UTF8')),'hex'))||chr(31)||
    actual_message_count::text||chr(31)||actual_receipt_count::text||chr(31)||
    actual_message_inserted::text||chr(31)||actual_receipt_inserted::text,
    'UTF8')),'hex');
  insert into agent_bridge.archive_operations(
    request_id,phase,operation,workspace,client_verified_digest,message_count,receipt_count,
    message_inserted_count,receipt_inserted_count,server_content_binding,
    outcome,apply,actor
  ) values (
    requested_request_id,'complete','import',requested_workspace,binding.client_verified_digest,
    actual_message_count,actual_receipt_count,actual_message_inserted,actual_receipt_inserted,
    content_binding_value,case when requested_apply then 'applied' else 'dry-run' end,
    requested_apply,session_user
  );
  perform agent_bridge.archive_close_transaction_authorization(requested_request_id);
  return query select false,actual_message_count,actual_receipt_count,
    actual_message_inserted,actual_receipt_inserted;
end
$$;

create or replace function agent_bridge.archive_abandon_operation(
  requested_request_id uuid, requested_workspace text, requested_failure_code text
) returns table(replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  binding agent_bridge.archive_operations%rowtype;
  terminal agent_bridge.archive_operations%rowtype;
  schema_owner name;
begin
  perform agent_bridge.assert_archive_actor();
  if requested_failure_code is null
    or requested_failure_code!~'^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'archive abandonment code is invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'portable-archive'||chr(31)||requested_workspace,1646705663
  ));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_request_id::text,1646705660)
  );
  select pg_catalog.pg_get_userbyid(namespace.nspowner)::name into schema_owner
    from pg_catalog.pg_namespace namespace where namespace.nspname='agent_bridge';
  select * into binding from agent_bridge.archive_operations
    where request_id=requested_request_id and phase='begin';
  if not found or binding.workspace<>requested_workspace or binding.operation<>'export'
    or (binding.actor<>session_user and not (
      session_user=schema_owner and requested_failure_code='owner_reconciled'
    )) or (requested_failure_code='owner_reconciled' and session_user<>schema_owner) then
    raise exception 'archive operation binding does not match the active request';
  end if;
  select * into terminal from agent_bridge.archive_operations
    where request_id=requested_request_id and phase='complete';
  if found then
    if terminal.outcome<>'abandoned' or terminal.failure_code<>requested_failure_code then
      raise exception 'archive operation is already final';
    end if;
    return query select true;
    return;
  end if;
  insert into agent_bridge.archive_operations(
    request_id,phase,operation,workspace,client_verified_digest,message_count,receipt_count,
    message_inserted_count,receipt_inserted_count,server_content_binding,
    outcome,failure_code,apply,actor
  ) values (
    requested_request_id,'complete','export',requested_workspace,null,0,0,0,0,
    encode(sha256(convert_to('','UTF8')),'hex'),
    'abandoned',requested_failure_code,false,session_user
  );
  return query select false;
end
$$;

create or replace function agent_bridge.portable_archive_catalog_definition()
returns text language sql stable set search_path = '' set timezone = 'UTC' as $$
  with names as (select
    ('agent_bridge_archive_operator_'||substr(md5(current_database()),1,16))::name archive_role,
    namespace.oid schema_oid,namespace.nspowner schema_owner
    from pg_catalog.pg_namespace namespace where namespace.nspname='agent_bridge'
  ), protected_functions(function_name) as (values
    ('reject_archive_ledger_mutation'),('assert_archive_actor'),('register_archive_member'),
    ('revoke_archive_member'),('archive_assert_operation'),('archive_authorize_transaction'),
    ('archive_assert_transaction'),('archive_close_transaction_authorization'),('archive_begin_operation'),
    ('archive_export_messages'),('archive_export_receipts'),('archive_json_depth'),('archive_import_messages'),
    ('archive_import_receipts'),('archive_complete_export'),('archive_reconcile_export'),
    ('archive_complete_import'),
    ('archive_abandon_operation'),('portable_archive_catalog_definition'),
    ('portable_archive_ready')
  ), protected_tables(oid) as (
    select relation.oid from pg_catalog.pg_class relation
    where relation.relnamespace=(select schema_oid from names) and relation.relname in (
      'archive_membership_events','archive_operations','archive_operation_batches',
      'archive_import_records','archive_transaction_authorizations','portable_archive_attestations'
    )
  ), protected_relations(oid) as (
    select oid from protected_tables
    union
    select index_record.indexrelid from pg_catalog.pg_index index_record
      where index_record.indrelid in (select oid from protected_tables)
    union
    select dependency.objid from pg_catalog.pg_depend dependency
      join pg_catalog.pg_class sequence_relation on sequence_relation.oid=dependency.objid
      where dependency.refobjid in (select oid from protected_tables)
        and sequence_relation.relkind='S'
  ), catalog_objects(kind,identity,definition) as (
    select 'archive_role',role.rolname,concat_ws(':',role.rolsuper,role.rolinherit,
      role.rolcreaterole,role.rolcreatedb,role.rolcanlogin,role.rolreplication,
      role.rolbypassrls,role.rolconnlimit)
    from pg_catalog.pg_roles role where role.rolname=(select archive_role from names)
    union all
    select 'owner_membership',granted.rolname||'->'||member.rolname,
      bool_or(membership.admin_option)::text||':'||
      bool_or(coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true))::text||':'||
      bool_or(coalesce((to_jsonb(membership)->>'set_option')::boolean,true))::text
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    where granted.rolname=(select archive_role from names)
      and member.oid=(select schema_owner from names)
    group by granted.rolname,member.rolname
    union all
    select 'schema','agent_bridge',pg_catalog.pg_get_userbyid(namespace.nspowner)
    from pg_catalog.pg_namespace namespace where namespace.oid=(select schema_oid from names)
    union all
    select 'schema_acl','agent_bridge',pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
      case when privilege.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(privilege.grantee) end
      ||':'||privilege.privilege_type||':'||privilege.is_grantable::text
    from pg_catalog.pg_namespace namespace
    cross join lateral pg_catalog.aclexplode(coalesce(namespace.nspacl,
      pg_catalog.acldefault('n',namespace.nspowner))) privilege
    where namespace.oid=(select schema_oid from names)
    union all
    select 'default_acl',default_acl.oid::text,
      pg_catalog.pg_get_userbyid(default_acl.defaclrole)||':'||default_acl.defaclobjtype::text||':'||
      coalesce(default_acl.defaclnamespace::regnamespace::text,'global')||':'||
      pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
      case when privilege.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(privilege.grantee) end
      ||':'||privilege.privilege_type||':'||privilege.is_grantable::text
    from pg_catalog.pg_default_acl default_acl
    cross join lateral pg_catalog.aclexplode(default_acl.defaclacl) privilege
    where default_acl.defaclnamespace=(select schema_oid from names)
      or default_acl.defaclrole=(select schema_owner from names)
    union all
    select 'relation',relation.oid::regclass::text,
      pg_catalog.pg_get_userbyid(relation.relowner)||':'||relation.relkind::text||':'||
      relation.relpersistence::text||':'||relation.relrowsecurity::text||':'||
      relation.relforcerowsecurity::text||':'||relation.relreplident::text
    from pg_catalog.pg_class relation where relation.oid in (select oid from protected_relations)
    union all
    select 'relation_acl',relation.oid::regclass::text,
      pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
      case when privilege.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(privilege.grantee) end
      ||':'||privilege.privilege_type||':'||privilege.is_grantable::text
    from pg_catalog.pg_class relation
    cross join lateral pg_catalog.aclexplode(coalesce(relation.relacl,
      pg_catalog.acldefault(case when relation.relkind='S' then 'S'::"char" else 'r'::"char" end,
        relation.relowner))) privilege
    where relation.oid in (select oid from protected_relations)
      and relation.relkind in ('r','p','v','m','f','S')
    union all
    select 'column',relation.oid::regclass::text||'.'||attribute.attname,
      attribute.attnum||':'||attribute.atttypid::regtype::text||':'||attribute.atttypmod||':'||
      attribute.attnotnull::text||':'||attribute.attidentity::text||':'||attribute.attgenerated::text||':'||
      attribute.attstorage::text||':'||attribute.attcompression::text||':'||attribute.attcollation||':'||
      coalesce(pg_catalog.pg_get_expr(default_value.adbin,default_value.adrelid),'')
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation on relation.oid=attribute.attrelid
    left join pg_catalog.pg_attrdef default_value on default_value.adrelid=attribute.attrelid
      and default_value.adnum=attribute.attnum
    where relation.oid in (select oid from protected_tables)
      and attribute.attnum>0 and not attribute.attisdropped
    union all
    select 'column_acl',relation.oid::regclass::text||'.'||attribute.attname,
      pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
      case when privilege.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(privilege.grantee) end
      ||':'||privilege.privilege_type||':'||privilege.is_grantable::text
    from pg_catalog.pg_attribute attribute join pg_catalog.pg_class relation on relation.oid=attribute.attrelid
    cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
    where relation.oid in (select oid from protected_tables)
      and attribute.attnum>0 and not attribute.attisdropped and attribute.attacl is not null
    union all
    select 'constraint',constraint_record.conrelid::regclass::text||'.'||constraint_record.conname,
      constraint_record.contype::text||':'||constraint_record.condeferrable::text||':'||
      constraint_record.condeferred::text||':'||constraint_record.convalidated::text||':'||
      pg_catalog.pg_get_constraintdef(constraint_record.oid,true)
    from pg_catalog.pg_constraint constraint_record
    where constraint_record.conrelid in (select oid from protected_tables)
    union all
    select 'index',index_record.indexrelid::regclass::text,
      pg_catalog.pg_get_userbyid(index_relation.relowner)||':'||index_relation.relkind::text||':'||
      index_record.indisunique::text||':'||index_record.indisprimary::text||':'||
      index_record.indisvalid::text||':'||index_record.indisready::text||':'||
      index_record.indislive::text||':'||access_method.amname||':'||
      pg_catalog.pg_get_indexdef(index_record.indexrelid)
    from pg_catalog.pg_index index_record
    join pg_catalog.pg_class table_relation on table_relation.oid=index_record.indrelid
    join pg_catalog.pg_class index_relation on index_relation.oid=index_record.indexrelid
    join pg_catalog.pg_am access_method on access_method.oid=index_relation.relam
    where table_relation.oid in (select oid from protected_tables)
    union all
    select 'trigger',trigger.tgrelid::regclass::text||'.'||trigger.tgname,
      trigger.tgenabled::text||':'||pg_catalog.pg_get_userbyid(procedure.proowner)||':'||
      pg_catalog.pg_get_triggerdef(trigger.oid,true)
    from pg_catalog.pg_trigger trigger join pg_catalog.pg_class relation on relation.oid=trigger.tgrelid
    join pg_catalog.pg_proc procedure on procedure.oid=trigger.tgfoid
    where not trigger.tgisinternal and relation.oid in (select oid from protected_tables)
    union all
    select 'policy',policy.polrelid::regclass::text||'.'||policy.polname,
      policy.polcmd::text||':'||policy.polpermissive::text||':'||policy.polroles::text||':'||
      coalesce(pg_catalog.pg_get_expr(policy.polqual,policy.polrelid),'')||':'||
      coalesce(pg_catalog.pg_get_expr(policy.polwithcheck,policy.polrelid),'')
    from pg_catalog.pg_policy policy join pg_catalog.pg_class relation on relation.oid=policy.polrelid
    where relation.oid in (select oid from protected_tables)
    union all
    select 'function',procedure.oid::regprocedure::text,
      pg_catalog.pg_get_userbyid(procedure.proowner)||':'||procedure.prokind::text||':'||
      procedure.prosecdef::text||':'||procedure.proleakproof::text||':'||procedure.provolatile::text||':'||
      procedure.proparallel::text||':'||procedure.proisstrict::text||':'||
      coalesce(array_to_string(procedure.proconfig,','),'')||':'||
      pg_catalog.pg_get_functiondef(procedure.oid)
    from pg_catalog.pg_proc procedure where procedure.pronamespace=(select schema_oid from names)
      and procedure.proname in (select function_name from protected_functions)
    union all
    select 'function_acl',procedure.oid::regprocedure::text,
      pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
      case when privilege.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(privilege.grantee) end
      ||':'||privilege.privilege_type||':'||privilege.is_grantable::text
    from pg_catalog.pg_proc procedure
    cross join lateral pg_catalog.aclexplode(coalesce(procedure.proacl,
      pg_catalog.acldefault('f',procedure.proowner))) privilege
    where procedure.pronamespace=(select schema_oid from names)
      and procedure.proname in (select function_name from protected_functions)
    union all
    select 'sequence',sequence_record.seqrelid::regclass::text,
      sequence_record.seqtypid::regtype::text||':'||sequence_record.seqstart||':'||
      sequence_record.seqincrement||':'||sequence_record.seqmax||':'||sequence_record.seqmin||':'||
      sequence_record.seqcache||':'||sequence_record.seqcycle::text
    from pg_catalog.pg_sequence sequence_record join pg_catalog.pg_class relation
      on relation.oid=sequence_record.seqrelid
    where relation.oid in (select oid from protected_relations)
  )
  select string_agg(kind||E'\x1f'||identity||E'\x1f'||definition,E'\x1e'
    order by kind,identity,definition) from catalog_objects
$$;

create or replace function agent_bridge.portable_archive_ready()
returns boolean language sql stable security definer set search_path = '' as $$
  with names as (select
    ('agent_bridge_archive_operator_'||substr(md5(current_database()),1,16))::name archive_role,
    (select pg_catalog.pg_get_userbyid(nspowner)::name from pg_catalog.pg_namespace
      where nspname='agent_bridge') schema_owner
  ), latest_registry as (
    select distinct on (event.member_role) event.member_role,event.action
    from agent_bridge.archive_membership_events event order by event.member_role,event.sequence desc
  ), active_registry as (
    select member_role from latest_registry where action='register'
  ), expected_memberships as (
    select names.archive_role granted_role,names.schema_owner member_role,
      true admin_option,true inherit_option,true set_option from names
    union all select names.archive_role,registry.member_role,false,true,true
      from active_registry registry cross join names
  ), raw_memberships as (
    select granted.rolname::name granted_role,member.rolname::name member_role,
      membership.admin_option,
      coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true) inherit_option,
      coalesce((to_jsonb(membership)->>'set_option')::boolean,true) set_option,
      membership.grantor,member.oid member_oid
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    where granted.rolname=(select archive_role from names)
  ), actual_memberships as (
    select membership.granted_role,membership.member_role,
      bool_or(membership.admin_option) admin_option,
      bool_or(membership.inherit_option) inherit_option,
      bool_or(membership.set_option) set_option,
      bool_and(case when membership.member_role=names.schema_owner then
        (membership.grantor=10 and membership.admin_option
          and membership.inherit_option=membership.set_option)
        or (membership.grantor=membership.member_oid
          and membership.inherit_option and membership.set_option)
      else membership.grantor=(select oid from pg_catalog.pg_roles where rolname=names.schema_owner)
        and not membership.admin_option
        and membership.inherit_option and membership.set_option end) grants_valid
    from raw_memberships membership cross join names
    group by membership.granted_role,membership.member_role
  )
  select current_setting('server_version_num')::integer/10000=any(array[15,16,17,18])
    and exists(select 1 from pg_catalog.pg_roles role,names where role.rolname=names.archive_role
      and not role.rolcanlogin and not role.rolsuper and not role.rolcreatedb
      and not role.rolcreaterole and not role.rolreplication and not role.rolbypassrls)
    and (select count(*)=1 and bool_and(
      attestation.catalog_definition=agent_bridge.portable_archive_catalog_definition()
    ) from agent_bridge.portable_archive_attestations attestation
      where attestation.name='portable-archive-v1')
    and not exists(
      (select granted_role,member_role,admin_option,inherit_option,set_option from actual_memberships
       except select granted_role,member_role,admin_option,inherit_option,set_option from expected_memberships)
      union all
      (select granted_role,member_role,admin_option,inherit_option,set_option from expected_memberships
       except select granted_role,member_role,admin_option,inherit_option,set_option from actual_memberships)
    )
    and not exists(select 1 from actual_memberships membership where not membership.grants_valid)
    and not exists(select 1 from active_registry registry
      left join pg_catalog.pg_roles role on role.rolname=registry.member_role
      where role.oid is null or not role.rolcanlogin or role.rolsuper or role.rolcreaterole
        or role.rolcreatedb or role.rolreplication or role.rolbypassrls)
    and not exists(select 1 from active_registry registry
      join pg_catalog.pg_roles inherited on inherited.rolname<>registry.member_role
      cross join names
      where pg_catalog.pg_has_role(registry.member_role,inherited.rolname,'MEMBER')
        and inherited.rolname<>names.archive_role)
    and not exists(select 1 from active_registry registry cross join pg_catalog.pg_roles candidate,names
      where candidate.rolname not in (registry.member_role,names.schema_owner)
        and not candidate.rolsuper
        and pg_catalog.pg_has_role(candidate.rolname,registry.member_role,'MEMBER'))
    and has_schema_privilege((select archive_role from names),'agent_bridge','USAGE')
    and not has_schema_privilege((select archive_role from names),'agent_bridge','CREATE')
    and not exists(select 1 from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
      where namespace.nspname='agent_bridge' and relation.relkind in ('r','p','v','m','f')
        and has_table_privilege((select archive_role from names),relation.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
    and not exists(select 1 from pg_catalog.pg_class sequence_record
      join pg_catalog.pg_namespace namespace on namespace.oid=sequence_record.relnamespace
      where namespace.nspname='agent_bridge'
        and case when sequence_record.relkind='S' then has_sequence_privilege(
          (select archive_role from names),sequence_record.oid,'USAGE,SELECT,UPDATE'
        ) else false end)
    and not exists(select 1 from pg_catalog.pg_proc procedure
      join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
      where namespace.nspname='agent_bridge' and has_function_privilege('public',procedure.oid,'EXECUTE'))
    and not exists(select 1 from pg_catalog.pg_proc procedure
      join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
      where namespace.nspname='agent_bridge'
        and has_function_privilege((select archive_role from names),procedure.oid,'EXECUTE')
        and procedure.oid not in (
          'agent_bridge.archive_begin_operation(uuid,text,text,character,bigint,bigint)'::regprocedure,
          'agent_bridge.archive_authorize_transaction(uuid,text,text,character)'::regprocedure,
          'agent_bridge.archive_close_transaction_authorization(uuid)'::regprocedure,
          'agent_bridge.archive_export_messages(uuid,text,timestamp with time zone,uuid,integer)'::regprocedure,
          'agent_bridge.archive_export_receipts(uuid,text,timestamp with time zone,uuid,text,integer)'::regprocedure,
          'agent_bridge.archive_import_messages(uuid,text,character,bigint,jsonb)'::regprocedure,
          'agent_bridge.archive_import_receipts(uuid,text,character,bigint,jsonb)'::regprocedure,
          'agent_bridge.archive_complete_export(uuid,text,character,bigint,bigint,timestamp with time zone,text)'::regprocedure,
          'agent_bridge.archive_reconcile_export(uuid,text,character,bigint,bigint,timestamp with time zone)'::regprocedure,
          'agent_bridge.archive_complete_import(uuid,text,boolean)'::regprocedure,
          'agent_bridge.archive_abandon_operation(uuid,text,text)'::regprocedure,
          'agent_bridge.portable_archive_ready()'::regprocedure
        ))
    and has_function_privilege((select archive_role from names),
      'agent_bridge.archive_begin_operation(uuid,text,text,character,bigint,bigint)','EXECUTE')
    and has_function_privilege((select archive_role from names),
      'agent_bridge.archive_authorize_transaction(uuid,text,text,character)','EXECUTE')
    and has_function_privilege((select archive_role from names),
      'agent_bridge.archive_close_transaction_authorization(uuid)','EXECUTE')
    and has_function_privilege((select archive_role from names),
      'agent_bridge.archive_export_messages(uuid,text,timestamp with time zone,uuid,integer)','EXECUTE')
    and has_function_privilege((select archive_role from names),
      'agent_bridge.archive_export_receipts(uuid,text,timestamp with time zone,uuid,text,integer)','EXECUTE')
    and has_function_privilege((select archive_role from names),
      'agent_bridge.archive_import_messages(uuid,text,character,bigint,jsonb)','EXECUTE')
    and has_function_privilege((select archive_role from names),
      'agent_bridge.archive_import_receipts(uuid,text,character,bigint,jsonb)','EXECUTE')
    and has_function_privilege((select archive_role from names),
      'agent_bridge.archive_complete_export(uuid,text,character,bigint,bigint,timestamp with time zone,text)','EXECUTE')
    and has_function_privilege((select archive_role from names),
      'agent_bridge.archive_reconcile_export(uuid,text,character,bigint,bigint,timestamp with time zone)','EXECUTE')
    and has_function_privilege((select archive_role from names),
      'agent_bridge.archive_complete_import(uuid,text,boolean)','EXECUTE')
    and has_function_privilege((select archive_role from names),
      'agent_bridge.archive_abandon_operation(uuid,text,text)','EXECUTE')
    and has_function_privilege((select archive_role from names),
      'agent_bridge.portable_archive_ready()','EXECUTE')
$$;

revoke all on agent_bridge.archive_membership_events,agent_bridge.archive_operations,
  agent_bridge.archive_operation_batches,agent_bridge.archive_import_records,
  agent_bridge.archive_transaction_authorizations,agent_bridge.portable_archive_attestations from public;
revoke all on sequence agent_bridge.archive_membership_events_sequence_seq,
  agent_bridge.archive_operations_sequence_seq,agent_bridge.archive_operation_batches_sequence_seq,
  agent_bridge.archive_import_records_sequence_seq from public;
revoke execute on all functions in schema agent_bridge from public;

do $grants$
declare
  suffix text := substr(md5(current_database()),1,16);
  archive_role text := 'agent_bridge_archive_operator_'||suffix;
  runtime_role text := 'agent_bridge_runtime_'||suffix;
  relation_record record;
  column_name text;
begin
  execute format('revoke all on schema agent_bridge from %I',archive_role);
  for relation_record in select relation.relname,relation.relkind from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='agent_bridge' and relation.relkind in ('r','p','v','S','m','f')
  loop
    if relation_record.relkind='S' then
      execute format('revoke all on sequence agent_bridge.%I from %I',relation_record.relname,archive_role);
    else
      execute format('revoke all on table agent_bridge.%I from %I',relation_record.relname,archive_role);
      for column_name in select attribute.attname from pg_catalog.pg_attribute attribute
        join pg_catalog.pg_class relation on relation.oid=attribute.attrelid
        join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
        where namespace.nspname='agent_bridge' and relation.relname=relation_record.relname
          and attribute.attnum>0 and not attribute.attisdropped
      loop
        execute format('revoke select(%I),insert(%I),update(%I),references(%I) on agent_bridge.%I from %I',
          column_name,column_name,column_name,column_name,relation_record.relname,archive_role);
      end loop;
    end if;
  end loop;
  execute format('revoke execute on all functions in schema agent_bridge from %I',archive_role);
  execute format('grant usage on schema agent_bridge to %I',archive_role);
  execute format('grant execute on function agent_bridge.archive_begin_operation(uuid,text,text,character,bigint,bigint),agent_bridge.archive_authorize_transaction(uuid,text,text,character),agent_bridge.archive_close_transaction_authorization(uuid),agent_bridge.archive_export_messages(uuid,text,timestamp with time zone,uuid,integer),agent_bridge.archive_export_receipts(uuid,text,timestamp with time zone,uuid,text,integer),agent_bridge.archive_import_messages(uuid,text,character,bigint,jsonb),agent_bridge.archive_import_receipts(uuid,text,character,bigint,jsonb),agent_bridge.archive_complete_export(uuid,text,character,bigint,bigint,timestamp with time zone,text),agent_bridge.archive_reconcile_export(uuid,text,character,bigint,bigint,timestamp with time zone),agent_bridge.archive_complete_import(uuid,text,boolean),agent_bridge.archive_abandon_operation(uuid,text,text),agent_bridge.portable_archive_ready() to %I',archive_role);
  execute format('grant execute on function agent_bridge.portable_archive_ready() to %I',runtime_role);
end
$grants$;

create or replace function agent_bridge.owner_control_plane_ready()
returns boolean language sql stable security definer set search_path = '' as $$
  with names as (select
    ('agent_bridge_control_owner_'||substr(md5(current_database()),1,16))::name owner_role,
    ('agent_bridge_control_operator_'||substr(md5(current_database()),1,16))::name operator_role,
    ('agent_bridge_control_auditor_'||substr(md5(current_database()),1,16))::name auditor_role,
    (select pg_catalog.pg_get_userbyid(nspowner)::name from pg_catalog.pg_namespace
      where nspname='agent_bridge') schema_owner
  ), latest_registry as (
    select distinct on (event.member_role,event.control_role)
      event.member_role,event.control_role,event.action
    from agent_bridge.control_membership_events event
    order by event.member_role,event.control_role,event.sequence desc
  ), active_registry as (
    select member_role,control_role from latest_registry where action='register'
  ), expected_memberships as (
    select names.owner_role granted_role,names.schema_owner member_role,
      true admin_option,true inherit_option,true set_option
      from names
    union all select names.operator_role,names.schema_owner,true,true,true from names
    union all select names.auditor_role,names.schema_owner,true,true,true from names
    union all
    select case registry.control_role when 'operator' then names.operator_role
      else names.auditor_role end,registry.member_role,false,true,true
    from active_registry registry cross join names
  ), raw_memberships as (
    select granted.rolname::name granted_role,member.rolname::name member_role,
      membership.admin_option,
      coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true) inherit_option,
      coalesce((to_jsonb(membership)->>'set_option')::boolean,true) set_option,
      membership.grantor,member.oid member_oid
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    where granted.rolname in (
      (select owner_role from names),(select operator_role from names),(select auditor_role from names)
    )
  ), actual_memberships as (
    select membership.granted_role,membership.member_role,
      bool_or(membership.admin_option) admin_option,
      bool_or(membership.inherit_option) inherit_option,
      bool_or(membership.set_option) set_option,
      bool_and(case when membership.member_role=names.schema_owner then
        (membership.grantor=10 and membership.admin_option
          and membership.inherit_option=membership.set_option)
        or (membership.grantor=membership.member_oid
          and membership.inherit_option and membership.set_option)
      else membership.grantor=(select oid from pg_catalog.pg_roles where rolname=names.schema_owner)
        and not membership.admin_option
        and membership.inherit_option and membership.set_option end) grants_valid
    from raw_memberships membership cross join names
    group by membership.granted_role,membership.member_role
  ), authority_closure as (
    select control_role.granted_role,candidate.rolname::name member_role
    from names
    cross join lateral (values
      (names.owner_role),(names.operator_role),(names.auditor_role)
    ) control_role(granted_role)
    cross join pg_catalog.pg_roles candidate
    where candidate.rolname not in (names.owner_role,names.operator_role,names.auditor_role)
      and (not candidate.rolsuper or candidate.rolname=names.schema_owner)
      and pg_catalog.pg_has_role(candidate.rolname,control_role.granted_role,'MEMBER')
  )
  select
    current_setting('server_version_num')::integer/10000=any(array[15,16,17,18])
    and (select count(*)=1 and bool_and(
      attestation.catalog_definition=agent_bridge.owner_control_catalog_definition()
    ) from agent_bridge.owner_control_attestations attestation
      where attestation.name='owner-control-v2')
    and not exists (
      (select granted_role,member_role,admin_option,inherit_option,set_option from actual_memberships
       except select granted_role,member_role,admin_option,inherit_option,set_option from expected_memberships)
      union all
      (select granted_role,member_role,admin_option,inherit_option,set_option from expected_memberships
       except select granted_role,member_role,admin_option,inherit_option,set_option from actual_memberships)
    )
    and not exists (
      select 1 from actual_memberships membership where not membership.grants_valid
    )
    and not exists (
      select 1 from active_registry registry
      left join pg_catalog.pg_roles role_record on role_record.rolname=registry.member_role
      where role_record.oid is null or not role_record.rolcanlogin or role_record.rolsuper
        or role_record.rolcreaterole or role_record.rolcreatedb
        or role_record.rolreplication or role_record.rolbypassrls
    )
    and not exists (
      (select granted_role,member_role from authority_closure
       except select granted_role,member_role from expected_memberships)
      union all
      (select granted_role,member_role from expected_memberships
       except select granted_role,member_role from authority_closure)
    )
    and not exists (
      select 1 from active_registry registry
      join pg_catalog.pg_roles inherited on inherited.rolname<>registry.member_role
      where pg_catalog.pg_has_role(registry.member_role,inherited.rolname,'MEMBER')
        and not exists (
          select 1 from active_registry permitted
          cross join names
          where permitted.member_role=registry.member_role
            and inherited.rolname=case permitted.control_role
              when 'operator' then names.operator_role else names.auditor_role end
        )
    )
    and not exists (
      select 1 from active_registry registry
      cross join pg_catalog.pg_roles candidate
      cross join names
      where candidate.rolname not in (registry.member_role,names.schema_owner)
        and not candidate.rolsuper
        and pg_catalog.pg_has_role(candidate.rolname,registry.member_role,'MEMBER')
    )
$$;

select set_config(
  'role','agent_bridge_control_owner_'||substr(md5(current_database()),1,16),false
);
insert into agent_bridge.owner_control_attestations(name,catalog_definition)
values('owner-control-v2',agent_bridge.owner_control_catalog_definition());
reset role;

insert into agent_bridge.portable_archive_attestations(name,catalog_definition)
values('portable-archive-v1',agent_bridge.portable_archive_catalog_definition());

do $preflight$
begin
  if not agent_bridge.portable_archive_ready()
    or not agent_bridge.owner_control_plane_ready() then
    raise exception 'portable archive readiness validation failed';
  end if;
end
$preflight$;

insert into agent_bridge.schema_migrations(version,name,checksum)
values(15,'portable_archives','__AGENT_BRIDGE_MIGRATION_CHECKSUM__');

commit;
