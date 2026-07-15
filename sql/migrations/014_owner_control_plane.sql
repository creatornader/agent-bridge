begin;

select pg_advisory_xact_lock(1646705660);

do $roles$
declare
  suffix text := substr(md5(current_database()),1,16);
  role_name text;
begin
  foreach role_name in array array[
    'agent_bridge_control_owner_' || suffix,
    'agent_bridge_control_operator_' || suffix,
    'agent_bridge_control_auditor_' || suffix
  ] loop
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

create table agent_bridge.control_requests (
  request_id uuid primary key,
  operation text not null,
  fingerprint char(64) not null,
  actor name not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint control_requests_operation check(operation in ('provision','rotate','revoke')),
  constraint control_requests_fingerprint check(fingerprint ~ '^[0-9a-f]{64}$')
);

create table agent_bridge.control_events (
  sequence bigint generated always as identity primary key,
  event_id uuid not null default gen_random_uuid() unique,
  request_id uuid not null references agent_bridge.control_requests(request_id),
  operation text not null,
  outcome text not null,
  actor name not null,
  workspace_id text,
  principal text,
  credential_id uuid,
  related_credential_id uuid,
  reason_code text,
  created_at timestamptz not null default clock_timestamp(),
  constraint control_events_operation check(operation in ('provision','rotate','revoke')),
  constraint control_events_outcome check(outcome='succeeded')
);

create table agent_bridge.owner_control_attestations (
  name text primary key,
  catalog_definition text not null,
  attested_at timestamptz not null default now(),
  constraint owner_control_attestation_name check(name ~ '^owner-control-v[0-9]+$')
);

create table agent_bridge.control_membership_events (
  sequence bigint generated always as identity primary key,
  request_id uuid not null unique,
  action text not null,
  member_role name not null,
  control_role text not null,
  actor name not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint control_membership_events_action check(action in ('register','revoke')),
  constraint control_membership_events_role check(control_role in ('operator','auditor'))
);

create index control_events_workspace_sequence
  on agent_bridge.control_events(workspace_id,sequence desc);
create index control_membership_events_member_sequence
  on agent_bridge.control_membership_events(member_role,control_role,sequence desc);
create index credentials_inventory_global
  on agent_bridge.credentials(
    date_bin('1 millisecond',created_at,'2000-01-01 00:00:00+00'::timestamptz),id
  );
create index credentials_inventory_workspace
  on agent_bridge.credentials(
    workspace_id,
    date_bin('1 millisecond',created_at,'2000-01-01 00:00:00+00'::timestamptz),id
  );

create or replace function agent_bridge.reject_control_ledger_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'control ledgers are append-only';
end
$$;

create trigger control_requests_append_only
before update or delete or truncate on agent_bridge.control_requests
for each statement execute function agent_bridge.reject_control_ledger_mutation();
create trigger control_events_append_only
before update or delete or truncate on agent_bridge.control_events
for each statement execute function agent_bridge.reject_control_ledger_mutation();
create trigger owner_control_attestations_append_only
before update or delete or truncate on agent_bridge.owner_control_attestations
for each statement execute function agent_bridge.reject_control_ledger_mutation();
create trigger control_membership_events_append_only
before update or delete or truncate on agent_bridge.control_membership_events
for each statement execute function agent_bridge.reject_control_ledger_mutation();

alter table agent_bridge.credentials alter column scopes set default '{}'::text[];

create or replace function agent_bridge.assert_control_actor(requested_capability text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  suffix text := substr(md5(current_database()),1,16);
  schema_owner name;
  operator_role name := ('agent_bridge_control_operator_'||suffix)::name;
  auditor_role name := ('agent_bridge_control_auditor_'||suffix)::name;
  operator_allowed boolean := false;
  auditor_allowed boolean := false;
begin
  select pg_catalog.pg_get_userbyid(namespace.nspowner)::name into schema_owner
    from pg_catalog.pg_namespace namespace where namespace.nspname='agent_bridge';
  if requested_capability is null or requested_capability not in ('operator','inventory') then
    raise exception 'control capability is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'control-membership'||chr(31)||session_user||chr(31)||'global',1646705661
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'control-membership'||chr(31)||session_user||chr(31)||'operator',1646705661
  ));
  if requested_capability='inventory' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'control-membership'||chr(31)||session_user||chr(31)||'auditor',1646705661
    ));
  end if;

  with latest as (
    select distinct on (event.control_role) event.control_role,event.action
    from agent_bridge.control_membership_events event
    where event.member_role=session_user and event.control_role in ('operator','auditor')
    order by event.control_role,event.sequence desc
  ), direct_membership as (
    select granted.rolname control_role,membership.admin_option,
      coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true) inherit_option,
      coalesce((to_jsonb(membership)->>'set_option')::boolean,true) set_option,
      grantor.rolname grantor_role
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    join pg_catalog.pg_roles grantor on grantor.oid=membership.grantor
    where member.rolname=session_user and granted.rolname in (operator_role,auditor_role)
  )
  select
    coalesce(bool_or(membership.control_role=operator_role
      and membership.inherit_option and membership.set_option
      and membership.grantor_role=schema_owner and (
        (session_user=schema_owner and membership.admin_option)
        or (latest.control_role='operator' and latest.action='register'
          and not membership.admin_option)
      )),false),
    coalesce(bool_or(membership.control_role=auditor_role
      and membership.inherit_option and membership.set_option
      and membership.grantor_role=schema_owner and (
        (session_user=schema_owner and membership.admin_option)
        or (latest.control_role='auditor' and latest.action='register'
          and not membership.admin_option)
      )),false)
    into operator_allowed,auditor_allowed
  from direct_membership membership left join latest on latest.control_role=case
    membership.control_role when operator_role then 'operator' else 'auditor' end;

  if session_user<>schema_owner and (exists (
    select 1 from pg_catalog.pg_roles inherited
    where inherited.rolname<>session_user
      and pg_catalog.pg_has_role(session_user,inherited.rolname,'MEMBER')
      and not (
        (inherited.rolname=operator_role and operator_allowed)
        or (inherited.rolname=auditor_role and auditor_allowed)
      )
  ) or exists (
    select 1 from pg_catalog.pg_roles candidate
    where candidate.rolname not in (session_user,schema_owner)
      and pg_catalog.pg_has_role(candidate.rolname,session_user,'MEMBER')
  ) or exists (
    select 1 from pg_catalog.pg_roles actor
    where actor.rolname=session_user and (
      not actor.rolcanlogin or actor.rolsuper or actor.rolcreaterole or actor.rolcreatedb
      or actor.rolreplication or actor.rolbypassrls
    )
  )) then
    raise exception 'control actor has an unsafe membership graph';
  end if;

  if (requested_capability='operator' and not operator_allowed)
    or (requested_capability='inventory' and not (operator_allowed or auditor_allowed)) then
    raise exception 'control actor is not registered for requested capability';
  end if;
end
$$;

create or replace function agent_bridge.validate_credential_security()
returns trigger
language plpgsql set search_path = '' as $$
declare
  predecessor_workspace_id text;
  predecessor_agent_id uuid;
  profile_scopes text[];
  lifecycle text := coalesce(current_setting('agent_bridge.lifecycle_authorized',true),'');
begin
  if tg_op='UPDATE' then
    if old.id is distinct from new.id
      or old.workspace_id is distinct from new.workspace_id
      or old.agent_id is distinct from new.agent_id
      or old.token_hash is distinct from new.token_hash
      or old.scopes is distinct from new.scopes
      or old.scope_set_name is distinct from new.scope_set_name
      or old.label is distinct from new.label
      or old.expires_at is distinct from new.expires_at
      or old.created_at is distinct from new.created_at then
      raise exception 'credential issued state is immutable';
    end if;
    if old.replaces_credential_id is distinct from new.replaces_credential_id then
      raise exception 'credential replacement lineage is immutable';
    end if;
    if old.revoked_at is not null and (
      old.revoked_at is distinct from new.revoked_at
      or old.revoked_by is distinct from new.revoked_by
      or old.revocation_reason is distinct from new.revocation_reason
    ) then raise exception 'credential revocation is immutable'; end if;
    if old.revoked_at is null and new.revoked_at is not null and lifecycle<>'revocation' then
      raise exception 'credential revocation requires an owner lifecycle function';
    end if;
    if (old.revoked_by is distinct from new.revoked_by
      or old.revocation_reason is distinct from new.revocation_reason) and lifecycle<>'revocation' then
      raise exception 'credential revocation metadata requires an owner lifecycle function';
    end if;
    if old.expiry_grace_until is distinct from new.expiry_grace_until and lifecycle<>'replacement' then
      raise exception 'credential grace requires an owner lifecycle function';
    end if;
    if old.expiry_grace_until is not null and (
      new.expiry_grace_until is null or new.expiry_grace_until>old.expiry_grace_until
    ) then raise exception 'credential grace may only move earlier'; end if;
  end if;
  if tg_op='INSERT' then
    if new.scope_set_name is null then
      if new.scopes<>'{}'::text[] then
        raise exception 'credential scopes must match a named scope set';
      end if;
    else
      select scopes into profile_scopes from agent_bridge.credential_scope_sets
      where name=new.scope_set_name;
      if not found or profile_scopes is distinct from new.scopes then
        raise exception 'credential scopes must match a named scope set';
      end if;
    end if;
    if new.label is not null and (length(new.label) not between 1 and 128 or new.label ~ '[[:cntrl:]]') then
      raise exception 'credential label is invalid';
    end if;
  end if;
  if new.replaces_credential_id is not null then
    select workspace_id,agent_id into predecessor_workspace_id,predecessor_agent_id
    from agent_bridge.credentials where id=new.replaces_credential_id;
    if not found or predecessor_workspace_id is distinct from new.workspace_id
      or predecessor_agent_id is distinct from new.agent_id then
      raise exception 'replacement credentials must use the same workspace and agent';
    end if;
    if tg_op='INSERT' and lifecycle<>'replacement' then
      raise exception 'credential replacement requires an owner lifecycle function';
    end if;
  end if;
  if tg_op='INSERT' and (new.revoked_at is not null or new.revoked_by is not null
    or new.revocation_reason is not null or new.expiry_grace_until is not null) then
    raise exception 'new credentials cannot begin with lifecycle state';
  end if;
  if new.expiry_grace_until is not null and not exists (
    select 1 from agent_bridge.credentials successor where successor.replaces_credential_id=new.id
  ) then raise exception 'credential grace requires a successor'; end if;
  return new;
end
$$;

create or replace function agent_bridge.control_provision(
  requested_request_id uuid, requested_workspace_id text, requested_workspace_name text,
  requested_principal text, requested_display_name text, requested_runtime_type text,
  requested_token_hash char(64), requested_label text, requested_scope_set_name text,
  requested_expires_at timestamptz
) returns table(workspace_id text,agent_id uuid,credential_id uuid,replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  canonical_fingerprint char(64);
  prior agent_bridge.control_requests%rowtype;
  provisioned_agent_id uuid;
  provisioned_credential_id uuid;
  canonical_scopes text[];
  existing_workspace_name text;
begin
  perform agent_bridge.assert_control_actor('operator');
  if requested_request_id is null or requested_workspace_id is null
    or requested_workspace_id<>btrim(requested_workspace_id)
    or length(requested_workspace_id) not between 1 and 128
    or requested_workspace_id ~ '[[:cntrl:]]'
    or requested_workspace_name is null or requested_workspace_name<>btrim(requested_workspace_name)
    or length(requested_workspace_name) not between 1 and 128
    or requested_workspace_name ~ '[[:cntrl:]]'
    or requested_principal is null or requested_principal<>btrim(requested_principal)
    or length(requested_principal) not between 1 and 128
    or requested_principal ~ '[[:cntrl:]]'
    or (requested_display_name is not null and (
      requested_display_name<>btrim(requested_display_name)
      or length(requested_display_name) not between 1 and 128
      or requested_display_name ~ '[[:cntrl:]]'))
    or (requested_runtime_type is not null and (
      requested_runtime_type<>btrim(requested_runtime_type)
      or length(requested_runtime_type) not between 1 and 128
      or requested_runtime_type ~ '[[:cntrl:]]'))
    or (requested_label is not null and (
      requested_label<>btrim(requested_label) or length(requested_label) not between 1 and 128
      or requested_label ~ '[[:cntrl:]]'))
    or requested_scope_set_name is null
    or requested_scope_set_name<>btrim(requested_scope_set_name)
    or length(requested_scope_set_name) not between 1 and 128
    or requested_scope_set_name ~ '[[:cntrl:]]'
    or requested_token_hash is null
    or requested_token_hash::text !~ '^[0-9a-f]{64}$'
    then raise exception 'invalid provisioning request'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_request_id::text,1646705660)
  );
  canonical_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
    requested_workspace_id,requested_workspace_name,requested_principal,requested_display_name,
    requested_runtime_type,requested_token_hash::text,requested_label,requested_scope_set_name,
    case when requested_expires_at is null then null else
      trunc(extract(epoch from requested_expires_at)*1000000)::numeric end)::text,'UTF8')),'hex');
  select * into prior from agent_bridge.control_requests where request_id=requested_request_id;
  if found then
    if prior.operation<>'provision' or prior.fingerprint<>canonical_fingerprint then
      raise exception 'request id was already used with different content';
    end if;
    return query select prior.result->>'workspace_id',(prior.result->>'agent_id')::uuid,
      (prior.result->>'credential_id')::uuid,true;
    return;
  end if;
  if requested_expires_at is not null and requested_expires_at<=clock_timestamp() then
    raise exception 'invalid provisioning request';
  end if;
  select scopes into canonical_scopes from agent_bridge.credential_scope_sets
    where name=requested_scope_set_name;
  if not found then raise exception 'unknown credential scope set'; end if;
  insert into agent_bridge.workspaces(id,name) values(requested_workspace_id,requested_workspace_name)
    on conflict(id) do nothing;
  select name into existing_workspace_name from agent_bridge.workspaces
    where id=requested_workspace_id;
  if existing_workspace_name is distinct from requested_workspace_name then
    raise exception 'workspace id already has a different name';
  end if;
  insert into agent_bridge.agents(workspace_id,principal,display_name,runtime_type)
    values(requested_workspace_id,requested_principal,requested_display_name,requested_runtime_type)
    returning id into provisioned_agent_id;
  perform set_config('agent_bridge.lifecycle_authorized','provision',true);
  insert into agent_bridge.credentials(workspace_id,agent_id,token_hash,label,expires_at,scopes,scope_set_name)
    values(requested_workspace_id,provisioned_agent_id,requested_token_hash,requested_label,
      requested_expires_at,canonical_scopes,requested_scope_set_name)
    returning id into provisioned_credential_id;
  perform set_config('agent_bridge.lifecycle_authorized','',true);
  insert into agent_bridge.control_requests(request_id,operation,fingerprint,actor,result)
    values(requested_request_id,'provision',canonical_fingerprint,session_user,
      jsonb_build_object('workspace_id',requested_workspace_id,'agent_id',provisioned_agent_id,
        'credential_id',provisioned_credential_id));
  insert into agent_bridge.control_events(request_id,operation,outcome,actor,workspace_id,principal,credential_id)
    values(requested_request_id,'provision','succeeded',session_user,requested_workspace_id,
      requested_principal,provisioned_credential_id);
  return query select requested_workspace_id,provisioned_agent_id,provisioned_credential_id,false;
exception when unique_violation then
  select * into prior from agent_bridge.control_requests where request_id=requested_request_id;
  if found and prior.operation='provision' and prior.fingerprint=canonical_fingerprint then
    return query select prior.result->>'workspace_id',(prior.result->>'agent_id')::uuid,
      (prior.result->>'credential_id')::uuid,true;
    return;
  end if;
  raise exception using errcode='23505',message='provisioning request conflicts with existing state';
end
$$;

create or replace function agent_bridge.control_credential_inventory(
  requested_workspace_id text default null,
  requested_after_created_at timestamptz default null,
  requested_after_credential_id uuid default null,
  requested_limit integer default 100
)
returns table(credential_id uuid,workspace_id text,principal text,label text,scopes text[],scope_set_name text,
  expires_at timestamptz,revoked_at timestamptz,revoked_by text,revocation_reason text,
  replaces_credential_id uuid,expiry_grace_until timestamptz,created_at timestamptz,last_used_at timestamptz,
  agent_disabled_at timestamptz,workspace_disabled_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform agent_bridge.assert_control_actor('inventory');
  if requested_limit is null or requested_limit not between 1 and 1000
    or (requested_after_created_at is null)<>(requested_after_credential_id is null)
    or (requested_workspace_id is not null and (
      requested_workspace_id<>btrim(requested_workspace_id)
      or length(requested_workspace_id) not between 1 and 128
      or requested_workspace_id ~ '[[:cntrl:]]')) then
    raise exception 'credential inventory cursor or limit is invalid';
  end if;
  return query select credential.id,credential.workspace_id,agent.principal,credential.label,credential.scopes,
    credential.scope_set_name,credential.expires_at,credential.revoked_at,credential.revoked_by,
    credential.revocation_reason,credential.replaces_credential_id,credential.expiry_grace_until,
    credential.created_at,credential.last_used_at,agent.disabled_at,workspace.disabled_at
  from agent_bridge.credentials credential
  join agent_bridge.agents agent on agent.id=credential.agent_id and agent.workspace_id=credential.workspace_id
  join agent_bridge.workspaces workspace on workspace.id=credential.workspace_id
  where (requested_workspace_id is null or credential.workspace_id=requested_workspace_id)
    and (requested_after_created_at is null
      or (date_bin('1 millisecond',credential.created_at,
          '2000-01-01 00:00:00+00'::timestamptz),credential.id)>
        (date_bin('1 millisecond',requested_after_created_at,
          '2000-01-01 00:00:00+00'::timestamptz),requested_after_credential_id))
  order by date_bin('1 millisecond',credential.created_at,
    '2000-01-01 00:00:00+00'::timestamptz),credential.id
  limit requested_limit;
end
$$;

create or replace function agent_bridge.control_rotate_credential(
  requested_request_id uuid, requested_predecessor_id uuid, requested_token_hash char(64),
  requested_label text, requested_scope_set_name text, requested_expires_at timestamptz,
  requested_grace_until timestamptz
) returns table(credential_id uuid,replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  canonical_fingerprint char(64);
  prior agent_bridge.control_requests%rowtype;
  predecessor_workspace_id text;
  predecessor_agent_id uuid;
  predecessor_expires_at timestamptz;
  successor_id uuid;
  canonical_scopes text[];
  principal_value text;
begin
  perform agent_bridge.assert_control_actor('operator');
  if requested_request_id is null or requested_predecessor_id is null
    or requested_token_hash is null
    or requested_token_hash::text !~ '^[0-9a-f]{64}$'
    or (requested_label is not null and (
      requested_label<>btrim(requested_label) or length(requested_label) not between 1 and 128
      or requested_label ~ '[[:cntrl:]]'))
    or requested_scope_set_name is null
    or requested_scope_set_name<>btrim(requested_scope_set_name)
    or length(requested_scope_set_name) not between 1 and 128
    or requested_scope_set_name ~ '[[:cntrl:]]' then
    raise exception 'invalid credential rotation request';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_request_id::text,1646705660)
  );
  canonical_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(requested_predecessor_id,
    requested_token_hash::text,requested_label,requested_scope_set_name,
    case when requested_expires_at is null then null else
      trunc(extract(epoch from requested_expires_at)*1000000)::numeric end,
    case when requested_grace_until is null then null else
      trunc(extract(epoch from requested_grace_until)*1000000)::numeric end)::text,'UTF8')),'hex');
  select * into prior from agent_bridge.control_requests where request_id=requested_request_id;
  if found then
    if prior.operation<>'rotate' or prior.fingerprint<>canonical_fingerprint then
      raise exception 'request id was already used with different content'; end if;
    return query select (prior.result->>'credential_id')::uuid,true; return;
  end if;
  select credential.workspace_id,credential.agent_id,credential.expires_at
    into predecessor_workspace_id,predecessor_agent_id,predecessor_expires_at
  from agent_bridge.credentials credential join agent_bridge.agents agent
    on agent.id=credential.agent_id and agent.workspace_id=credential.workspace_id
  join agent_bridge.workspaces workspace on workspace.id=credential.workspace_id
  where credential.id=requested_predecessor_id and credential.revoked_at is null
    and (credential.expires_at is null or credential.expires_at>clock_timestamp())
    and agent.disabled_at is null
    and workspace.disabled_at is null
    and not exists(select 1 from agent_bridge.credentials successor
      where successor.replaces_credential_id=credential.id)
  for update of credential;
  if not found then raise exception 'predecessor credential is not active and replaceable'; end if;
  select agent.principal into principal_value from agent_bridge.agents agent
    where agent.id=predecessor_agent_id and agent.workspace_id=predecessor_workspace_id;
  if (requested_expires_at is not null and requested_expires_at<=clock_timestamp())
    or (requested_grace_until is not null and predecessor_expires_at is not null
      and requested_grace_until>predecessor_expires_at)
    or (requested_grace_until is not null and requested_expires_at is not null
      and requested_grace_until>requested_expires_at)
    or (requested_grace_until is not null and requested_grace_until<=clock_timestamp()) then
    raise exception 'credential grace is invalid'; end if;
  select scopes into canonical_scopes from agent_bridge.credential_scope_sets
    where name=requested_scope_set_name;
  if not found then raise exception 'unknown credential scope set'; end if;
  perform set_config('agent_bridge.lifecycle_authorized','replacement',true);
  insert into agent_bridge.credentials(workspace_id,agent_id,token_hash,label,expires_at,scopes,
    scope_set_name,replaces_credential_id) values(predecessor_workspace_id,predecessor_agent_id,
    requested_token_hash,requested_label,requested_expires_at,canonical_scopes,
    requested_scope_set_name,requested_predecessor_id) returning id into successor_id;
  update agent_bridge.credentials set expiry_grace_until=requested_grace_until
    where id=requested_predecessor_id;
  perform set_config('agent_bridge.lifecycle_authorized','',true);
  insert into agent_bridge.control_requests(request_id,operation,fingerprint,actor,result)
    values(requested_request_id,'rotate',canonical_fingerprint,session_user,
      jsonb_build_object('credential_id',successor_id));
  insert into agent_bridge.control_events(request_id,operation,outcome,actor,workspace_id,principal,
    credential_id,related_credential_id) values(requested_request_id,'rotate','succeeded',session_user,
    predecessor_workspace_id,principal_value,successor_id,requested_predecessor_id);
  return query select successor_id,false;
exception when unique_violation then
  raise exception using errcode='23505',message='credential rotation conflicts with existing state';
end
$$;

create or replace function agent_bridge.control_revoke_credential(
  requested_request_id uuid, requested_credential_id uuid, requested_reason_code text
) returns table(revoked boolean,replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  canonical_fingerprint char(64);
  prior agent_bridge.control_requests%rowtype;
  workspace_value text;
  principal_value text;
begin
  perform agent_bridge.assert_control_actor('operator');
  if requested_request_id is null or requested_credential_id is null
    or requested_reason_code is null
    or requested_reason_code not in ('operator_request','rotation','compromise','retired') then
    raise exception 'credential revocation reason is invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_request_id::text,1646705660)
  );
  canonical_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(requested_credential_id,requested_reason_code)::text,'UTF8')),'hex');
  select * into prior from agent_bridge.control_requests where request_id=requested_request_id;
  if found then
    if prior.operation<>'revoke' or prior.fingerprint<>canonical_fingerprint then
      raise exception 'request id was already used with different content'; end if;
    return query select (prior.result->>'revoked')::boolean,true; return;
  end if;
  select credential.workspace_id,agent.principal into workspace_value,principal_value
  from agent_bridge.credentials credential join agent_bridge.agents agent
    on agent.id=credential.agent_id and agent.workspace_id=credential.workspace_id
  where credential.id=requested_credential_id for update of credential;
  if not found then raise exception 'credential was not found'; end if;
  perform set_config('agent_bridge.lifecycle_authorized','revocation',true);
  update agent_bridge.credentials set revoked_at=clock_timestamp(),revoked_by=session_user,
    revocation_reason=requested_reason_code where id=requested_credential_id and revoked_at is null;
  if not found then raise exception 'credential is already revoked'; end if;
  perform set_config('agent_bridge.lifecycle_authorized','',true);
  insert into agent_bridge.control_requests(request_id,operation,fingerprint,actor,result)
    values(requested_request_id,'revoke',canonical_fingerprint,session_user,jsonb_build_object('revoked',true));
  insert into agent_bridge.control_events(request_id,operation,outcome,actor,workspace_id,principal,
    credential_id,reason_code) values(requested_request_id,'revoke','succeeded',session_user,
    workspace_value,principal_value,requested_credential_id,requested_reason_code);
  return query select true,false;
end
$$;

create or replace function agent_bridge.register_control_member(
  requested_request_id uuid, requested_member_role name, requested_control_role text
) returns table(replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  suffix text := substr(md5(current_database()),1,16);
  target_role name;
  prior agent_bridge.control_membership_events%rowtype;
  member_record pg_catalog.pg_roles%rowtype;
begin
  if requested_request_id is null or requested_member_role is null
    or requested_control_role is null
    or requested_control_role not in ('operator','auditor') then
    raise exception 'invalid control membership registration';
  end if;
  target_role := ('agent_bridge_control_'||requested_control_role||'_'||suffix)::name;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'control-membership'||chr(31)||requested_member_role||chr(31)||'global',
    1646705661
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'control-membership'||chr(31)||requested_member_role||chr(31)||requested_control_role,
    1646705661
  ));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_request_id::text,1646705660)
  );
  select * into prior from agent_bridge.control_membership_events
    where request_id=requested_request_id;
  if found then
    if prior.action<>'register' or prior.member_role<>requested_member_role
      or prior.control_role<>requested_control_role then
      raise exception 'request id was already used with different content';
    end if;
    return query select true;
    return;
  end if;
  select * into member_record from pg_catalog.pg_roles where rolname=requested_member_role;
  if not found or not member_record.rolcanlogin or member_record.rolsuper
    or member_record.rolcreaterole or member_record.rolcreatedb
    or member_record.rolreplication or member_record.rolbypassrls
    or requested_member_role in (
      current_user::name,
      ('agent_bridge_control_owner_'||suffix)::name,
      ('agent_bridge_control_operator_'||suffix)::name,
      ('agent_bridge_control_auditor_'||suffix)::name
    ) then
    raise exception 'control membership target is not an eligible login';
  end if;
  if exists (
    select 1 from pg_catalog.pg_roles inherited
    where inherited.rolname<>requested_member_role
      and pg_catalog.pg_has_role(requested_member_role,inherited.rolname,'MEMBER')
      and inherited.rolname<>target_role
      and not exists (
        select 1 from (
          select distinct on (event.control_role)
            event.control_role,event.action
          from agent_bridge.control_membership_events event
          where event.member_role=requested_member_role
          order by event.control_role,event.sequence desc
        ) latest
        where latest.action='register'
          and inherited.rolname=(
            'agent_bridge_control_'||latest.control_role||'_'||suffix
          )::name
      )
  ) or exists (
    select 1 from pg_catalog.pg_roles candidate
    where candidate.rolname not in (requested_member_role,current_user)
      and pg_catalog.pg_has_role(candidate.rolname,requested_member_role,'MEMBER')
  ) then
    raise exception 'control membership target has an unsafe membership graph';
  end if;
  if exists (
    select 1 from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    join pg_catalog.pg_roles grantor on grantor.oid=membership.grantor
    where granted.rolname=target_role and member.rolname=requested_member_role
      and (
        membership.admin_option
        or not coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true)
        or not coalesce((to_jsonb(membership)->>'set_option')::boolean,true)
        or grantor.rolname<>current_user
      )
  ) then
    raise exception 'control membership target has an unsafe direct grant';
  end if;
  execute format('grant %I to %I',target_role,requested_member_role);
  insert into agent_bridge.control_membership_events(
    request_id,action,member_role,control_role,actor
  ) values (
    requested_request_id,'register',requested_member_role,requested_control_role,session_user
  );
  return query select false;
end
$$;

create or replace function agent_bridge.revoke_control_member(
  requested_request_id uuid, requested_member_role name, requested_control_role text
) returns table(replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  suffix text := substr(md5(current_database()),1,16);
  target_role name;
  prior agent_bridge.control_membership_events%rowtype;
begin
  if requested_request_id is null or requested_member_role is null
    or requested_control_role is null
    or requested_control_role not in ('operator','auditor')
    or requested_member_role in (
      current_user::name,
      ('agent_bridge_control_owner_'||suffix)::name,
      ('agent_bridge_control_operator_'||suffix)::name,
      ('agent_bridge_control_auditor_'||suffix)::name
    ) then
    raise exception 'invalid control membership revocation';
  end if;
  target_role := ('agent_bridge_control_'||requested_control_role||'_'||suffix)::name;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'control-membership'||chr(31)||requested_member_role||chr(31)||'global',
    1646705661
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'control-membership'||chr(31)||requested_member_role||chr(31)||requested_control_role,
    1646705661
  ));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_request_id::text,1646705660)
  );
  select * into prior from agent_bridge.control_membership_events
    where request_id=requested_request_id;
  if found then
    if prior.action<>'revoke' or prior.member_role<>requested_member_role
      or prior.control_role<>requested_control_role then
      raise exception 'request id was already used with different content';
    end if;
    return query select true;
    return;
  end if;
  if exists(select 1 from pg_catalog.pg_roles where rolname=requested_member_role) then
    execute format('revoke %I from %I',target_role,requested_member_role);
  end if;
  insert into agent_bridge.control_membership_events(
    request_id,action,member_role,control_role,actor
  ) values (
    requested_request_id,'revoke',requested_member_role,requested_control_role,session_user
  );
  return query select false;
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

create or replace function agent_bridge.credential_security_prerequisite_definition()
returns text language sql stable set search_path = '' set timezone = 'UTC' as $$
  with dependency_relations(relation_name) as (values
    ('credentials'),('credential_scope_sets'),('security_events'),
    ('rate_limit_policies'),('rate_limit_buckets')
  ), protected_functions(function_name) as (values
    ('canonicalize_scopes'),('validate_credential_security'),
    ('reject_credential_delete'),('reject_scope_set_mutation'),
    ('reject_security_event_mutation'),('record_scope_denial'),
    ('consume_rate_limit'),('replace_credential'),('revoke_credential'),
    ('security_schema_ready')
  ), catalog_objects(kind,identity,definition) as (
    select 'relation',relation.relname,
      case when relation.relowner=namespace.nspowner then 'schema-owner' else 'unexpected-owner' end
      ||':'||relation.relkind::text||':'||relation.relpersistence::text||':'||
      relation.relrowsecurity::text||':'||relation.relforcerowsecurity::text
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='agent_bridge'
      and relation.relname in (select relation_name from dependency_relations)
    union all
    select 'column',relation.relname||'.'||attribute.attname,
      pg_catalog.format_type(attribute.atttypid,attribute.atttypmod)||':'||
      attribute.attnotnull::text||':'||attribute.attidentity::text||':'||
      attribute.attgenerated::text||':'||coalesce(pg_catalog.pg_get_expr(
        default_record.adbin,default_record.adrelid),'')
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation on relation.oid=attribute.attrelid
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    left join pg_catalog.pg_attrdef default_record on default_record.adrelid=attribute.attrelid
      and default_record.adnum=attribute.attnum
    where namespace.nspname='agent_bridge'
      and relation.relname in (select relation_name from dependency_relations)
      and attribute.attnum>0 and not attribute.attisdropped
    union all
    select 'constraint',relation.relname||'.'||constraint_record.conname,
      constraint_record.convalidated::text||':'||
      pg_catalog.pg_get_constraintdef(constraint_record.oid,true)
    from pg_catalog.pg_constraint constraint_record
    join pg_catalog.pg_class relation on relation.oid=constraint_record.conrelid
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='agent_bridge'
      and relation.relname in (select relation_name from dependency_relations)
    union all
    select 'index',index_relation.relname,
      index_record.indisunique::text||':'||index_record.indisvalid::text||':'||
      index_record.indisready::text||':'||pg_catalog.pg_get_indexdef(index_record.indexrelid)||':'||
      coalesce(pg_catalog.pg_get_expr(index_record.indpred,index_record.indrelid),'')
    from pg_catalog.pg_index index_record
    join pg_catalog.pg_class source_relation on source_relation.oid=index_record.indrelid
    join pg_catalog.pg_class index_relation on index_relation.oid=index_record.indexrelid
    join pg_catalog.pg_namespace namespace on namespace.oid=source_relation.relnamespace
    where namespace.nspname='agent_bridge'
      and source_relation.relname in (select relation_name from dependency_relations)
    union all
    select 'trigger',relation.relname||'.'||trigger.tgname,
      trigger.tgenabled::text||':'||pg_catalog.pg_get_triggerdef(trigger.oid,true)
    from pg_catalog.pg_trigger trigger
    join pg_catalog.pg_class relation on relation.oid=trigger.tgrelid
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    where not trigger.tgisinternal and namespace.nspname='agent_bridge'
      and relation.relname in (select relation_name from dependency_relations)
    union all
    select 'function',procedure.oid::regprocedure::text,
      case when procedure.proowner=namespace.nspowner then 'schema-owner' else 'unexpected-owner' end
      ||':'||pg_catalog.pg_get_functiondef(procedure.oid)
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
    where namespace.nspname='agent_bridge'
      and procedure.proname in (select function_name from protected_functions)
  )
  select string_agg(kind||E'\x1f'||identity||E'\x1f'||definition,E'\x1e'
    order by kind,identity,definition) from catalog_objects
$$;

create or replace function agent_bridge.owner_control_catalog_definition() returns text
language sql stable set search_path = '' set timezone = 'UTC' as $$
  with names as (select
    ('agent_bridge_control_owner_'||substr(md5(current_database()),1,16))::name owner_role,
    ('agent_bridge_control_operator_'||substr(md5(current_database()),1,16))::name operator_role,
    ('agent_bridge_control_auditor_'||substr(md5(current_database()),1,16))::name auditor_role,
    ('agent_bridge_runtime_'||substr(md5(current_database()),1,16))::name runtime_role,
    (select nspowner from pg_catalog.pg_namespace where nspname='agent_bridge') schema_owner
  ), control_roles(role_name) as (
    select owner_role from names union all select operator_role from names
    union all select auditor_role from names
  ), protected_functions(function_name) as (values
    ('reject_control_ledger_mutation'),('validate_credential_security'),('control_provision'),
    ('control_credential_inventory'),('control_rotate_credential'),('control_revoke_credential'),
    ('owner_control_catalog_definition'),('owner_control_plane_ready'),('canonicalize_scopes'),
    ('replace_credential'),('revoke_credential'),('security_schema_ready'),
    ('validate_credential_security'),('reject_credential_delete'),
    ('reject_scope_set_mutation'),('reject_security_event_mutation'),
    ('record_scope_denial'),('consume_rate_limit'),
    ('current_request_workspace'),('current_request_principal'),
    ('row_isolation_catalog_definition'),('credential_security_prerequisite_definition'),
    ('assert_control_actor'),('register_control_member'),('revoke_control_member')
  ), dependency_relations(relation_name) as (values
    ('control_requests'),('control_events'),('owner_control_attestations'),('workspaces'),
    ('control_membership_events'),('agents'),('credentials'),('credential_scope_sets')
  ), dependency_columns(relation_name,column_name) as (values
    ('control_requests','request_id'),('control_requests','operation'),
    ('control_requests','fingerprint'),('control_requests','actor'),
    ('control_requests','result'),('control_requests','created_at'),
    ('control_events','sequence'),('control_events','event_id'),
    ('control_events','request_id'),('control_events','operation'),
    ('control_events','outcome'),('control_events','actor'),
    ('control_events','workspace_id'),('control_events','principal'),
    ('control_events','credential_id'),('control_events','related_credential_id'),
    ('control_events','reason_code'),('control_events','created_at'),
    ('owner_control_attestations','name'),('owner_control_attestations','catalog_definition'),
    ('owner_control_attestations','attested_at'),
    ('control_membership_events','sequence'),('control_membership_events','request_id'),
    ('control_membership_events','action'),('control_membership_events','member_role'),
    ('control_membership_events','control_role'),('control_membership_events','actor'),
    ('control_membership_events','created_at'),
    ('workspaces','id'),('workspaces','name'),('workspaces','disabled_at'),
    ('agents','id'),('agents','workspace_id'),('agents','principal'),
    ('agents','display_name'),('agents','runtime_type'),('agents','disabled_at'),
    ('credentials','id'),('credentials','workspace_id'),('credentials','agent_id'),
    ('credentials','token_hash'),('credentials','label'),('credentials','expires_at'),
    ('credentials','revoked_at'),('credentials','created_at'),('credentials','last_used_at'),
    ('credentials','scopes'),('credentials','scope_set_name'),
    ('credentials','replaces_credential_id'),('credentials','revoked_by'),
    ('credentials','revocation_reason'),('credentials','expiry_grace_until'),
    ('credential_scope_sets','name'),('credential_scope_sets','scopes')
  ), catalog_objects(kind,identity,definition) as (
    select 'role',role.rolname,
      concat_ws(':',role.rolsuper,role.rolinherit,role.rolcreaterole,role.rolcreatedb,
        role.rolcanlogin,role.rolreplication,role.rolbypassrls,role.rolconnlimit,
        coalesce(role.rolvaliduntil::text,''),coalesce(role.rolconfig::text,''))
    from pg_catalog.pg_roles role where role.rolname in (select role_name from control_roles)
    union all
    select 'membership',granted.rolname||'->'||member.rolname,
      grantor.rolname||':'||membership.admin_option::text||':'||
        coalesce(to_jsonb(membership)->>'inherit_option','')||':'||
        coalesce(to_jsonb(membership)->>'set_option','')
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    join pg_catalog.pg_roles grantor on grantor.oid=membership.grantor
    where member.rolname in (select role_name from control_roles)
      or granted.rolname=(select owner_role from names)
    union all
    select 'schema',namespace.nspname,pg_catalog.pg_get_userbyid(namespace.nspowner)
    from pg_catalog.pg_namespace namespace where namespace.nspname='agent_bridge'
    union all
    select 'schema_acl',namespace.nspname,
      pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
        coalesce(pg_catalog.pg_get_userbyid(privilege.grantee),'PUBLIC')||':'||
        privilege.privilege_type||':'||privilege.is_grantable::text
    from pg_catalog.pg_namespace namespace
    cross join lateral pg_catalog.aclexplode(coalesce(namespace.nspacl,
      pg_catalog.acldefault('n',namespace.nspowner))) privilege
    where namespace.nspname='agent_bridge'
    union all
    select 'relation',relation.oid::regclass::text,
      pg_catalog.pg_get_userbyid(relation.relowner)||':'||relation.relkind::text||':'||
        relation.relpersistence::text||':'||relation.relrowsecurity::text||':'||
        relation.relforcerowsecurity::text
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='agent_bridge' and relation.relkind in ('r','p','S','v','m','f') and (
      relation.relname in (select relation_name from dependency_relations)
      or relation.relowner=(select oid from pg_catalog.pg_roles where rolname=(select owner_role from names)))
    union all
    select 'relation_acl',relation.oid::regclass::text,
      pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
        coalesce(pg_catalog.pg_get_userbyid(privilege.grantee),'PUBLIC')||':'||
        privilege.privilege_type||':'||privilege.is_grantable::text
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    cross join lateral pg_catalog.aclexplode(coalesce(relation.relacl,pg_catalog.acldefault(
      case when relation.relkind='S' then 'S'::"char" else 'r'::"char" end,relation.relowner
    ))) privilege
    where namespace.nspname='agent_bridge' and relation.relkind in ('r','p','S','v','m','f') and (
      relation.relname in (select relation_name from dependency_relations)
      or relation.relowner=(select oid from pg_catalog.pg_roles where rolname=(select owner_role from names))
      or privilege.grantee in (
        select oid from pg_catalog.pg_roles where rolname in (select role_name from control_roles)
      ))
    union all
    select 'index',index_relation.oid::regclass::text,
      index_record.indisunique::text||':'||index_record.indisvalid::text||':'||
        index_record.indisready::text||':'||pg_catalog.pg_get_indexdef(index_record.indexrelid)||':'||
        coalesce(pg_catalog.pg_get_expr(index_record.indpred,index_record.indrelid),'')
    from pg_catalog.pg_index index_record
    join pg_catalog.pg_class source_relation on source_relation.oid=index_record.indrelid
    join pg_catalog.pg_class index_relation on index_relation.oid=index_record.indexrelid
    join pg_catalog.pg_namespace namespace on namespace.oid=source_relation.relnamespace
    where namespace.nspname='agent_bridge'
      and source_relation.relname in (select relation_name from dependency_relations)
    union all
    select 'column',relation.oid::regclass::text||'.'||attribute.attname,
      pg_catalog.format_type(attribute.atttypid,attribute.atttypmod)||':'||
        attribute.attnotnull::text||':'||attribute.attidentity::text||':'||
        attribute.attgenerated::text||':'||coalesce(pg_catalog.pg_get_expr(
          default_record.adbin,default_record.adrelid),'')
    from dependency_columns dependency
    join pg_catalog.pg_namespace namespace on namespace.nspname='agent_bridge'
    join pg_catalog.pg_class relation on relation.relnamespace=namespace.oid
      and relation.relname=dependency.relation_name
    join pg_catalog.pg_attribute attribute on attribute.attrelid=relation.oid
      and attribute.attname=dependency.column_name and attribute.attnum>0 and not attribute.attisdropped
    left join pg_catalog.pg_attrdef default_record on default_record.adrelid=attribute.attrelid
      and default_record.adnum=attribute.attnum
    union all
    select 'column_acl',relation.oid::regclass::text||'.'||attribute.attname,
      pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
        coalesce(pg_catalog.pg_get_userbyid(privilege.grantee),'PUBLIC')||':'||
        privilege.privilege_type||':'||privilege.is_grantable::text
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation on relation.oid=attribute.attrelid
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
    where namespace.nspname='agent_bridge' and attribute.attnum>0 and not attribute.attisdropped
      and attribute.attacl is not null and (
        relation.relname in (select relation_name from dependency_relations)
        or relation.relowner=(select oid from pg_catalog.pg_roles where rolname=(select owner_role from names))
        or privilege.grantee in (
          select oid from pg_catalog.pg_roles where rolname in (select role_name from control_roles)
        ))
    union all
    select 'constraint',constraint_record.conrelid::regclass::text||'.'||constraint_record.conname,
      pg_catalog.pg_get_constraintdef(constraint_record.oid,true)
    from pg_catalog.pg_constraint constraint_record
    join pg_catalog.pg_class relation on relation.oid=constraint_record.conrelid
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='agent_bridge'
      and relation.relname in (select relation_name from dependency_relations)
    union all
    select 'trigger',trigger.tgrelid::regclass::text||'.'||trigger.tgname,
      trigger.tgenabled::text||':'||pg_catalog.pg_get_triggerdef(trigger.oid,true)
    from pg_catalog.pg_trigger trigger
    join pg_catalog.pg_class relation on relation.oid=trigger.tgrelid
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    where not trigger.tgisinternal and namespace.nspname='agent_bridge'
      and relation.relname in (
        'control_requests','control_events','owner_control_attestations',
        'control_membership_events','credentials'
      )
    union all
    select 'function',procedure.oid::regprocedure::text,
      pg_catalog.pg_get_userbyid(procedure.proowner)||':'||pg_catalog.pg_get_functiondef(procedure.oid)
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
    where namespace.nspname='agent_bridge' and (
      procedure.proname in (select function_name from protected_functions)
      or procedure.proowner=(select oid from pg_catalog.pg_roles where rolname=(select owner_role from names)))
    union all
    select 'function_acl',procedure.oid::regprocedure::text,
      pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
        coalesce(pg_catalog.pg_get_userbyid(privilege.grantee),'PUBLIC')||':'||
        privilege.privilege_type||':'||privilege.is_grantable::text
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
    cross join lateral pg_catalog.aclexplode(coalesce(procedure.proacl,
      pg_catalog.acldefault('f',procedure.proowner))) privilege
    where namespace.nspname='agent_bridge' and (
      procedure.proname in (select function_name from protected_functions)
      or procedure.proowner=(select oid from pg_catalog.pg_roles where rolname=(select owner_role from names))
      or privilege.grantee in (select oid from pg_catalog.pg_roles where rolname in (select role_name from control_roles))
      or privilege.grantee=0
    )
    union all
    select 'default_acl',owner.rolname||':'||coalesce(namespace.nspname,'')||':'||
      default_acl.defaclobjtype::text,
      pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
        coalesce(pg_catalog.pg_get_userbyid(privilege.grantee),'PUBLIC')||':'||
        privilege.privilege_type||':'||privilege.is_grantable::text
    from pg_catalog.pg_default_acl default_acl
    join pg_catalog.pg_roles owner on owner.oid=default_acl.defaclrole
    left join pg_catalog.pg_namespace namespace on namespace.oid=default_acl.defaclnamespace
    cross join lateral pg_catalog.aclexplode(default_acl.defaclacl) privilege
    where (namespace.nspname='agent_bridge' or default_acl.defaclnamespace=0)
      and default_acl.defaclrole in (
        (select schema_owner from names),
        (select oid from pg_catalog.pg_roles where rolname=(select owner_role from names))
      )
    union all
    select 'credential_security_prerequisite','v1',
      agent_bridge.credential_security_prerequisite_definition()
  )
  select string_agg(kind||E'\x1f'||identity||E'\x1f'||definition,E'\x1e'
    order by kind,identity,definition) from catalog_objects
$$;

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
    select names.owner_role granted_role,names.schema_owner member_role,true admin_option
      from names
    union all select names.operator_role,names.schema_owner,true from names
    union all select names.auditor_role,names.schema_owner,true from names
    union all
    select case registry.control_role when 'operator' then names.operator_role
      else names.auditor_role end,registry.member_role,false
    from active_registry registry cross join names
  ), actual_memberships as (
    select granted.rolname::name granted_role,member.rolname::name member_role,
      membership.admin_option,
      coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true) inherit_option,
      coalesce((to_jsonb(membership)->>'set_option')::boolean,true) set_option,
      grantor.rolname::name grantor_role
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    join pg_catalog.pg_roles grantor on grantor.oid=membership.grantor
    where granted.rolname in (
      (select owner_role from names),(select operator_role from names),(select auditor_role from names)
    )
  ), authority_closure as (
    select control_role.granted_role,candidate.rolname::name member_role
    from names
    cross join lateral (values
      (names.owner_role),(names.operator_role),(names.auditor_role)
    ) control_role(granted_role)
    cross join pg_catalog.pg_roles candidate
    where candidate.rolname not in (names.owner_role,names.operator_role,names.auditor_role)
      and pg_catalog.pg_has_role(candidate.rolname,control_role.granted_role,'MEMBER')
  )
  select
    current_setting('server_version_num')::integer/10000=any(array[15,16,17,18])
    and (select count(*)=1 and bool_and(
      attestation.catalog_definition=agent_bridge.owner_control_catalog_definition()
    ) from agent_bridge.owner_control_attestations attestation
      where attestation.name='owner-control-v1')
    and not exists (
      (select granted_role,member_role,admin_option from actual_memberships
       except select granted_role,member_role,admin_option from expected_memberships)
      union all
      (select granted_role,member_role,admin_option from expected_memberships
       except select granted_role,member_role,admin_option from actual_memberships)
    )
    and not exists (
      select 1 from actual_memberships membership,names
      where not membership.inherit_option or not membership.set_option
        or membership.grantor_role<>names.schema_owner
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
        and pg_catalog.pg_has_role(candidate.rolname,registry.member_role,'MEMBER')
    )
$$;

revoke all on agent_bridge.control_requests,agent_bridge.control_events,
  agent_bridge.owner_control_attestations,agent_bridge.control_membership_events from public;
revoke all on sequence agent_bridge.control_events_sequence_seq,
  agent_bridge.control_membership_events_sequence_seq from public;
revoke execute on all functions in schema agent_bridge from public;

do $grants$
declare
  suffix text := substr(md5(current_database()),1,16);
  owner_role text := 'agent_bridge_control_owner_'||suffix;
  operator_role text := 'agent_bridge_control_operator_'||suffix;
  auditor_role text := 'agent_bridge_control_auditor_'||suffix;
  runtime_role text := 'agent_bridge_runtime_'||suffix;
  data_owner_role text := 'agent_bridge_data_owner_'||suffix;
  context_reader_role text := 'agent_bridge_context_reader_'||suffix;
  event_writer_role text := 'agent_bridge_event_writer_'||suffix;
  role_name text;
  granted_role text;
  member_role text;
  relation_name text;
  column_name text;
  membership_record record;
  relation_record record;
begin
  execute format('alter table agent_bridge.control_requests owner to %I',owner_role);
  execute format('alter table agent_bridge.control_events owner to %I',owner_role);
  execute format('alter table agent_bridge.owner_control_attestations owner to %I',owner_role);
  execute format('alter table agent_bridge.control_membership_events owner to %I',owner_role);
  execute format('alter sequence agent_bridge.control_events_sequence_seq owner to %I',owner_role);
  execute format('alter sequence agent_bridge.control_membership_events_sequence_seq owner to %I',owner_role);
  foreach role_name in array array[
    'reject_control_ledger_mutation()',
    'control_provision(uuid,text,text,text,text,text,character,text,text,timestamp with time zone)',
    'control_credential_inventory(text,timestamp with time zone,uuid,integer)',
    'control_rotate_credential(uuid,uuid,character,text,text,timestamp with time zone,timestamp with time zone)',
    'control_revoke_credential(uuid,uuid,text)','owner_control_catalog_definition()',
    'owner_control_plane_ready()'
  ] loop execute format('alter function agent_bridge.%s owner to %I',role_name,owner_role); end loop;

  for membership_record in
    select granted.rolname granted_name,member.rolname member_name
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    where member.rolname in (owner_role,operator_role,auditor_role)
  loop
    execute format('revoke %I from %I',membership_record.granted_name,membership_record.member_name);
  end loop;
  for membership_record in
    select granted.rolname granted_name,member.rolname member_name
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    where granted.rolname in (owner_role,operator_role,auditor_role)
      and member.rolname<>current_user
  loop
    execute format('revoke %I from %I',membership_record.granted_name,membership_record.member_name);
  end loop;

  foreach role_name in array array[owner_role,operator_role,auditor_role] loop
    execute format('revoke all on schema agent_bridge from %I',role_name);
    for relation_record in
      select relation.relname,relation.relkind from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
      where namespace.nspname='agent_bridge' and relation.relkind in ('r','p','v','S','m','f')
    loop
      if relation_record.relkind='S' then
        execute format('revoke all on sequence agent_bridge.%I from %I',relation_record.relname,role_name);
      else
        execute format('revoke all on table agent_bridge.%I from %I',relation_record.relname,role_name);
        for column_name in select attribute.attname from pg_catalog.pg_attribute attribute
          join pg_catalog.pg_class relation on relation.oid=attribute.attrelid
          join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
          where namespace.nspname='agent_bridge' and relation.relname=relation_record.relname
            and attribute.attnum>0 and not attribute.attisdropped loop
          execute format('revoke select(%I),insert(%I),update(%I),references(%I) on agent_bridge.%I from %I',
            column_name,column_name,column_name,column_name,relation_record.relname,role_name);
        end loop;
      end if;
    end loop;
    execute format('revoke execute on all functions in schema agent_bridge from %I',role_name);
  end loop;

  foreach role_name in array array[operator_role,auditor_role,runtime_role,data_owner_role,
    context_reader_role,event_writer_role] loop
    execute format('revoke all on agent_bridge.control_requests,agent_bridge.control_events,agent_bridge.owner_control_attestations,agent_bridge.control_membership_events from %I',role_name);
    execute format('revoke all on sequence agent_bridge.control_events_sequence_seq,agent_bridge.control_membership_events_sequence_seq from %I',role_name);
  end loop;
  foreach role_name in array array[runtime_role,data_owner_role,context_reader_role,event_writer_role] loop
    execute format('revoke execute on function agent_bridge.control_provision(uuid,text,text,text,text,text,character,text,text,timestamp with time zone),agent_bridge.control_credential_inventory(text,timestamp with time zone,uuid,integer),agent_bridge.control_rotate_credential(uuid,uuid,character,text,text,timestamp with time zone,timestamp with time zone),agent_bridge.control_revoke_credential(uuid,uuid,text),agent_bridge.owner_control_catalog_definition(),agent_bridge.owner_control_plane_ready() from %I',role_name);
  end loop;

  execute format('grant usage on schema agent_bridge to %I,%I,%I',owner_role,operator_role,auditor_role);
  execute format('grant select,insert,update(request_id) on agent_bridge.control_requests to %I',owner_role);
  execute format('grant insert on agent_bridge.control_events to %I',owner_role);
  execute format('grant select on agent_bridge.owner_control_attestations to %I',owner_role);
  execute format('grant select,insert on agent_bridge.control_membership_events to %I',owner_role);
  execute format('grant usage on sequence agent_bridge.control_events_sequence_seq to %I',owner_role);
  execute format('grant usage on sequence agent_bridge.control_membership_events_sequence_seq to %I',owner_role);
  execute format('grant select(id,name,disabled_at),insert(id,name) on agent_bridge.workspaces to %I',owner_role);
  execute format('grant select(id,workspace_id,principal,disabled_at),insert(workspace_id,principal,display_name,runtime_type) on agent_bridge.agents to %I',owner_role);
  execute format('grant select(id,workspace_id,agent_id,label,expires_at,revoked_at,created_at,last_used_at,scopes,scope_set_name,replaces_credential_id,revoked_by,revocation_reason,expiry_grace_until) on agent_bridge.credentials to %I',owner_role);
  execute format('grant insert(workspace_id,agent_id,token_hash,label,expires_at,scopes,scope_set_name,replaces_credential_id) on agent_bridge.credentials to %I',owner_role);
  execute format('grant update(expiry_grace_until,revoked_at,revoked_by,revocation_reason) on agent_bridge.credentials to %I',owner_role);
  execute format('grant select(name,scopes) on agent_bridge.credential_scope_sets to %I',owner_role);
  execute format('grant execute on function agent_bridge.canonicalize_scopes(text[]) to %I',owner_role);
  execute format('grant execute on function agent_bridge.assert_control_actor(text) to %I',owner_role);
  execute format('grant execute on function agent_bridge.credential_security_prerequisite_definition() to %I',owner_role);
  execute format('grant execute on function agent_bridge.owner_control_catalog_definition() to %I',owner_role);
  execute format('grant execute on function agent_bridge.control_provision(uuid,text,text,text,text,text,character,text,text,timestamp with time zone) to %I',operator_role);
  execute format('grant execute on function agent_bridge.control_rotate_credential(uuid,uuid,character,text,text,timestamp with time zone,timestamp with time zone) to %I',operator_role);
  execute format('grant execute on function agent_bridge.control_revoke_credential(uuid,uuid,text) to %I',operator_role);
  execute format('grant execute on function agent_bridge.control_credential_inventory(text,timestamp with time zone,uuid,integer) to %I,%I',operator_role,auditor_role);
  execute format('grant execute on function agent_bridge.owner_control_plane_ready() to %I',runtime_role);
  execute format('revoke execute on function agent_bridge.replace_credential(uuid,character,text[],text,text,timestamp with time zone,timestamp with time zone,text,uuid) from %I,%I,%I',operator_role,auditor_role,runtime_role);
  execute format('revoke execute on function agent_bridge.revoke_credential(uuid,text,text,uuid) from %I,%I,%I',operator_role,auditor_role,runtime_role);
  foreach role_name in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on agent_bridge.control_requests,agent_bridge.control_events,agent_bridge.owner_control_attestations,agent_bridge.control_membership_events from %I',role_name);
      execute format('revoke all on sequence agent_bridge.control_events_sequence_seq,agent_bridge.control_membership_events_sequence_seq from %I',role_name);
      execute format('revoke execute on function agent_bridge.control_provision(uuid,text,text,text,text,text,character,text,text,timestamp with time zone),agent_bridge.control_credential_inventory(text,timestamp with time zone,uuid,integer),agent_bridge.control_rotate_credential(uuid,uuid,character,text,text,timestamp with time zone,timestamp with time zone),agent_bridge.control_revoke_credential(uuid,uuid,text),agent_bridge.owner_control_catalog_definition(),agent_bridge.owner_control_plane_ready() from %I',role_name);
    end if;
  end loop;
  foreach role_name in array array[current_user,owner_role] loop
    execute format('alter default privileges for role %I in schema agent_bridge revoke all on tables from public',role_name);
    execute format('alter default privileges for role %I in schema agent_bridge revoke all on sequences from public',role_name);
    execute format('alter default privileges for role %I in schema agent_bridge revoke all on functions from public',role_name);
    execute format('alter default privileges for role %I in schema agent_bridge revoke all on types from public',role_name);
    foreach member_role in array array['anon','authenticated'] loop
      if exists(select 1 from pg_catalog.pg_roles where rolname=member_role) then
        execute format('alter default privileges for role %I in schema agent_bridge revoke all on tables from %I',role_name,member_role);
        execute format('alter default privileges for role %I in schema agent_bridge revoke all on sequences from %I',role_name,member_role);
        execute format('alter default privileges for role %I in schema agent_bridge revoke all on functions from %I',role_name,member_role);
        execute format('alter default privileges for role %I in schema agent_bridge revoke all on types from %I',role_name,member_role);
      end if;
    end loop;
  end loop;
end
$grants$;

do $preflight$
declare
  suffix text := substr(md5(current_database()),1,16);
  owner_role name := ('agent_bridge_control_owner_'||suffix)::name;
  operator_role name := ('agent_bridge_control_operator_'||suffix)::name;
  auditor_role name := ('agent_bridge_control_auditor_'||suffix)::name;
  expected_count integer;
  actual_security_digest text;
  expected_security_digest text;
begin
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    agent_bridge.credential_security_prerequisite_definition(),'UTF8')),'hex')
    into actual_security_digest;
  expected_security_digest := case
    when current_setting('server_version_num')::integer/10000=15
      then '9db61d6bb63f753041bae021cfa006bc497fa0d3d12ea8636c747d095ff675cf'
    when current_setting('server_version_num')::integer/10000=16
      then '9db61d6bb63f753041bae021cfa006bc497fa0d3d12ea8636c747d095ff675cf'
    when current_setting('server_version_num')::integer/10000=17
      then '9db61d6bb63f753041bae021cfa006bc497fa0d3d12ea8636c747d095ff675cf'
    when current_setting('server_version_num')::integer/10000=18
      then 'cfb571d4d6d5a00ec5d46fcf3ec0f18403ebd2f2bf020302c5feb7701164fcf9'
    else null
  end;
  if expected_security_digest is null or actual_security_digest<>expected_security_digest then
    raise exception 'owner control preflight rejected credential security definition drift'
      using detail='observed prerequisite digest: '||actual_security_digest;
  end if;
  if not agent_bridge.security_schema_ready() then
    raise exception 'owner control preflight rejected credential security drift';
  end if;
  if not exists (
    select 1 from agent_bridge.row_isolation_attestations attestation
    where attestation.name='domain-v1'
      and attestation.catalog_definition=agent_bridge.row_isolation_catalog_definition()
  ) then
    raise exception 'owner control preflight rejected row isolation drift';
  end if;

  if exists (
    select 1 from pg_catalog.pg_namespace namespace
    cross join lateral pg_catalog.aclexplode(coalesce(
      namespace.nspacl,pg_catalog.acldefault('n',namespace.nspowner)
    )) access
    left join pg_catalog.pg_roles grantee on grantee.oid=access.grantee
    where namespace.nspname='agent_bridge' and (
      access.grantee=0 or grantee.rolname not in (
        current_user,owner_role,operator_role,auditor_role,
        'agent_bridge_runtime_'||suffix,'agent_bridge_data_owner_'||suffix,
        'agent_bridge_context_reader_'||suffix,'agent_bridge_event_writer_'||suffix
      )
    )
  ) then
    raise exception 'owner control preflight rejected schema privilege drift';
  end if;

  if exists (
    select 1 from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    cross join lateral pg_catalog.aclexplode(coalesce(relation.relacl,pg_catalog.acldefault(
      case when relation.relkind='S' then 'S'::"char" else 'r'::"char" end,relation.relowner
    ))) access
    where namespace.nspname='agent_bridge'
      and relation.relname in (
        'control_requests','control_events','owner_control_attestations',
        'control_membership_events','control_events_sequence_seq',
        'control_membership_events_sequence_seq','workspaces','agents','credentials',
        'credential_scope_sets'
      )
      and access.grantee not in (
        relation.relowner,(select oid from pg_catalog.pg_roles where rolname=owner_role)
      )
  ) then
    raise exception 'owner control preflight rejected relation privilege drift';
  end if;

  if exists (
    select 1 from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation on relation.oid=attribute.attrelid
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    cross join lateral pg_catalog.aclexplode(attribute.attacl) access
    where namespace.nspname='agent_bridge' and attribute.attacl is not null
      and relation.relname in (
        'control_requests','control_events','owner_control_attestations',
        'control_membership_events','workspaces','agents','credentials','credential_scope_sets'
      )
      and access.grantee<>(select oid from pg_catalog.pg_roles where rolname=owner_role)
  ) then
    raise exception 'owner control preflight rejected column privilege drift';
  end if;

  if exists (
    select 1 from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
    cross join lateral pg_catalog.aclexplode(coalesce(
      procedure.proacl,pg_catalog.acldefault('f',procedure.proowner)
    )) access
    left join pg_catalog.pg_roles grantee on grantee.oid=access.grantee
    where namespace.nspname='agent_bridge' and procedure.proname in (
      'canonicalize_scopes','validate_credential_security','reject_credential_delete',
      'reject_scope_set_mutation','reject_security_event_mutation','record_scope_denial',
      'consume_rate_limit','replace_credential','revoke_credential','security_schema_ready',
      'current_request_workspace','current_request_principal',
      'row_isolation_catalog_definition','credential_security_prerequisite_definition',
      'assert_control_actor',
      'reject_control_ledger_mutation','control_provision','control_credential_inventory',
      'control_rotate_credential','control_revoke_credential','register_control_member',
      'revoke_control_member','owner_control_catalog_definition','owner_control_plane_ready'
    ) and (access.grantee=0 or grantee.rolname not in (
      current_user,owner_role,operator_role,auditor_role,
      'agent_bridge_runtime_'||suffix,'agent_bridge_data_owner_'||suffix,
      'agent_bridge_context_reader_'||suffix,'agent_bridge_event_writer_'||suffix
    ))
  ) then
    raise exception 'owner control preflight rejected function privilege drift';
  end if;

  if exists (
    select 1 from pg_catalog.pg_default_acl default_acl
    left join pg_catalog.pg_namespace namespace on namespace.oid=default_acl.defaclnamespace
    cross join lateral pg_catalog.aclexplode(default_acl.defaclacl) access
    where default_acl.defaclrole in (
      current_user::regrole::oid,
      (select oid from pg_catalog.pg_roles where rolname=owner_role)
    ) and (namespace.nspname='agent_bridge' or default_acl.defaclnamespace=0)
      and access.grantee<>default_acl.defaclrole
  ) then
    raise exception 'owner control preflight rejected default privilege drift';
  end if;

  if exists (
    select 1 from (values
      ('workspaces','r','postgres'),('agents','r','postgres'),
      ('credentials','r','postgres'),('credential_scope_sets','r','postgres'),
      ('control_requests','r','owner'),('control_events','r','owner'),
      ('owner_control_attestations','r','owner'),
      ('control_membership_events','r','owner'),
      ('control_events_sequence_seq','S','owner'),
      ('control_membership_events_sequence_seq','S','owner')
    ) expected(relation_name,relation_kind,owner_kind)
    left join pg_catalog.pg_namespace namespace on namespace.nspname='agent_bridge'
    left join pg_catalog.pg_class relation on relation.relnamespace=namespace.oid
      and relation.relname=expected.relation_name
    where relation.oid is null or relation.relkind::text<>expected.relation_kind
      or relation.relpersistence<>'p' or relation.relrowsecurity or relation.relforcerowsecurity
      or relation.relowner<>case expected.owner_kind when 'owner'
        then (select oid from pg_catalog.pg_roles where rolname=owner_role)
        else current_user::regrole::oid end
  ) then
    raise exception 'owner control preflight rejected relation ownership or security drift';
  end if;

  if exists (
    select 1 from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='agent_bridge'
      and relation.relowner in (
        select oid from pg_catalog.pg_roles where rolname in (owner_role,operator_role,auditor_role)
      ) and not (
        relation.relowner=(select oid from pg_catalog.pg_roles where rolname=owner_role)
        and (
          (relation.relkind='r' and relation.relname in (
            'control_requests','control_events','owner_control_attestations',
            'control_membership_events'))
          or (relation.relkind='S' and relation.relname in (
            'control_events_sequence_seq','control_membership_events_sequence_seq'))
          or (relation.relkind='i' and exists (
            select 1 from pg_catalog.pg_index index_record
            join pg_catalog.pg_class source_relation on source_relation.oid=index_record.indrelid
            where index_record.indexrelid=relation.oid
              and source_relation.relname in (
                'control_requests','control_events','owner_control_attestations',
                'control_membership_events')
          ))
        )
      )
  ) then
    raise exception 'owner control preflight rejected unexpected control-owned relation';
  end if;

  if exists (
    select 1 from (values
      ('agent_bridge.workspaces'::regclass,'workspaces_pkey','p','PRIMARY KEY (id)'),
      ('agent_bridge.agents'::regclass,'agents_pkey','p','PRIMARY KEY (id)'),
      ('agent_bridge.agents'::regclass,'agents_workspace_id_fkey','f',
        'FOREIGN KEY (workspace_id) REFERENCES agent_bridge.workspaces(id)'),
      ('agent_bridge.agents'::regclass,'agents_workspace_id_id_key','u',
        'UNIQUE (workspace_id, id)'),
      ('agent_bridge.agents'::regclass,'agents_workspace_id_principal_key','u',
        'UNIQUE (workspace_id, principal)')
    ) expected(relation_id,constraint_name,constraint_type,constraint_definition)
    left join pg_catalog.pg_constraint constraint_record
      on constraint_record.conrelid=expected.relation_id
      and constraint_record.conname=expected.constraint_name
    where constraint_record.oid is null or not constraint_record.convalidated
      or constraint_record.contype::text<>expected.constraint_type
      or pg_catalog.pg_get_constraintdef(constraint_record.oid,true)
        <>expected.constraint_definition
  ) then
    raise exception 'owner control preflight rejected workspace or agent constraint drift';
  end if;

  if exists (
    select 1 from (values
      ('agent_bridge.agents_workspace_id_principal_key'::regclass,
        'CREATE UNIQUE INDEX agents_workspace_id_principal_key ON agent_bridge.agents USING btree (workspace_id, principal)',
        ''),
      ('agent_bridge.credentials_replacement_lineage'::regclass,
        'CREATE UNIQUE INDEX credentials_replacement_lineage ON agent_bridge.credentials USING btree (replaces_credential_id) WHERE (replaces_credential_id IS NOT NULL)',
        '(replaces_credential_id IS NOT NULL)')
    ) expected(index_id,index_definition,index_predicate)
    left join pg_catalog.pg_index index_record on index_record.indexrelid=expected.index_id
    where index_record.indexrelid is null or not index_record.indisunique
      or not index_record.indisvalid or not index_record.indisready
      or pg_catalog.pg_get_indexdef(index_record.indexrelid)<>expected.index_definition
      or coalesce(pg_catalog.pg_get_expr(index_record.indpred,index_record.indrelid),'')
        <>expected.index_predicate
  ) then
    raise exception 'owner control preflight rejected critical unique index drift';
  end if;

  select count(*) into expected_count from (values
    ('agent_bridge.reject_control_ledger_mutation()','owner',false,'v',false),
    ('agent_bridge.control_provision(uuid,text,text,text,text,text,character,text,text,timestamp with time zone)','owner',true,'v',false),
    ('agent_bridge.control_credential_inventory(text,timestamp with time zone,uuid,integer)','owner',true,'s',false),
    ('agent_bridge.control_rotate_credential(uuid,uuid,character,text,text,timestamp with time zone,timestamp with time zone)','owner',true,'v',false),
    ('agent_bridge.control_revoke_credential(uuid,uuid,text)','owner',true,'v',false),
    ('agent_bridge.owner_control_catalog_definition()','owner',false,'s',true),
    ('agent_bridge.owner_control_plane_ready()','owner',true,'s',false),
    ('agent_bridge.register_control_member(uuid,name,text)','migration',true,'v',false),
    ('agent_bridge.revoke_control_member(uuid,name,text)','migration',true,'v',false),
    ('agent_bridge.assert_control_actor(text)','migration',true,'v',false),
    ('agent_bridge.credential_security_prerequisite_definition()','migration',false,'s',true),
    ('agent_bridge.row_isolation_catalog_definition()','migration',false,'s',false),
    ('agent_bridge.validate_credential_security()','migration',false,'v',false),
    ('agent_bridge.canonicalize_scopes(text[])','migration',false,'i',false),
    ('agent_bridge.replace_credential(uuid,character,text[],text,text,timestamp with time zone,timestamp with time zone,text,uuid)','migration',true,'v',false),
    ('agent_bridge.revoke_credential(uuid,text,text,uuid)','migration',true,'v',false)
  ) expected(signature,owner_kind,security_definer,volatility,utc_config)
  left join pg_catalog.pg_proc procedure
    on procedure.oid=pg_catalog.to_regprocedure(expected.signature)
  where procedure.oid is null
    or procedure.proowner<>case expected.owner_kind when 'owner'
      then (select oid from pg_catalog.pg_roles where rolname=owner_role)
      else current_user::regrole::oid end
    or procedure.prosecdef<>expected.security_definer
    or procedure.provolatile::text<>expected.volatility
    or not procedure.proconfig @> array['search_path=""']::text[]
    or (expected.utc_config and not procedure.proconfig @> array['TimeZone=UTC']::text[])
    or (not expected.utc_config and cardinality(procedure.proconfig)<>1)
    or (expected.utc_config and cardinality(procedure.proconfig)<>2);
  if expected_count<>0 then
    raise exception 'owner control preflight rejected protected function drift';
  end if;

  if exists (
    select 1 from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
    where namespace.nspname='agent_bridge'
      and procedure.proowner in (
        select oid from pg_catalog.pg_roles where rolname in (owner_role,operator_role,auditor_role)
      ) and not (
        procedure.proowner=(select oid from pg_catalog.pg_roles where rolname=owner_role)
        and procedure.oid in (
          'agent_bridge.reject_control_ledger_mutation()'::regprocedure,
          'agent_bridge.control_provision(uuid,text,text,text,text,text,character,text,text,timestamp with time zone)'::regprocedure,
          'agent_bridge.control_credential_inventory(text,timestamp with time zone,uuid,integer)'::regprocedure,
          'agent_bridge.control_rotate_credential(uuid,uuid,character,text,text,timestamp with time zone,timestamp with time zone)'::regprocedure,
          'agent_bridge.control_revoke_credential(uuid,uuid,text)'::regprocedure,
          'agent_bridge.owner_control_catalog_definition()'::regprocedure,
          'agent_bridge.owner_control_plane_ready()'::regprocedure
        )
      )
  ) then
    raise exception 'owner control preflight rejected unexpected control-owned function';
  end if;

  if exists (
    select 1 from (values
      ('agent_bridge.control_requests'::regclass,'control_requests_append_only',
        'CREATE TRIGGER control_requests_append_only BEFORE DELETE OR UPDATE OR TRUNCATE ON agent_bridge.control_requests FOR EACH STATEMENT EXECUTE FUNCTION agent_bridge.reject_control_ledger_mutation()'),
      ('agent_bridge.control_events'::regclass,'control_events_append_only',
        'CREATE TRIGGER control_events_append_only BEFORE DELETE OR UPDATE OR TRUNCATE ON agent_bridge.control_events FOR EACH STATEMENT EXECUTE FUNCTION agent_bridge.reject_control_ledger_mutation()'),
      ('agent_bridge.owner_control_attestations'::regclass,'owner_control_attestations_append_only',
        'CREATE TRIGGER owner_control_attestations_append_only BEFORE DELETE OR UPDATE OR TRUNCATE ON agent_bridge.owner_control_attestations FOR EACH STATEMENT EXECUTE FUNCTION agent_bridge.reject_control_ledger_mutation()'),
      ('agent_bridge.control_membership_events'::regclass,'control_membership_events_append_only',
        'CREATE TRIGGER control_membership_events_append_only BEFORE DELETE OR UPDATE OR TRUNCATE ON agent_bridge.control_membership_events FOR EACH STATEMENT EXECUTE FUNCTION agent_bridge.reject_control_ledger_mutation()'),
      ('agent_bridge.credentials'::regclass,'credentials_validate_security',
        'CREATE TRIGGER credentials_validate_security BEFORE INSERT OR UPDATE ON agent_bridge.credentials FOR EACH ROW EXECUTE FUNCTION agent_bridge.validate_credential_security()')
    ) expected(relation_id,trigger_name,trigger_definition)
    left join pg_catalog.pg_trigger trigger on trigger.tgrelid=expected.relation_id
      and trigger.tgname=expected.trigger_name and not trigger.tgisinternal
    where trigger.oid is null or trigger.tgenabled<>'O'
      or pg_catalog.pg_get_triggerdef(trigger.oid,true)<>expected.trigger_definition
  ) then
    raise exception 'owner control preflight rejected protected trigger drift';
  end if;
end
$preflight$;

insert into agent_bridge.owner_control_attestations(name,catalog_definition)
values('owner-control-v1',agent_bridge.owner_control_catalog_definition());

insert into agent_bridge.schema_migrations(version,name,checksum)
values(14,'owner_control_plane','__AGENT_BRIDGE_MIGRATION_CHECKSUM__');

commit;
