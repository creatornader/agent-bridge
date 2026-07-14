begin;

select pg_advisory_xact_lock(1646705660);

create table agent_bridge.request_authorities (
  backend_pid integer not null,
  transaction_id xid8 not null,
  request_id uuid not null,
  credential_id uuid not null,
  workspace_id text not null,
  principal text not null,
  scopes text[] not null,
  opened_session_user name not null,
  opened_at timestamptz not null default clock_timestamp(),
  primary key (backend_pid, transaction_id),
  unique (request_id)
);

revoke all on agent_bridge.request_authorities from public;

create or replace function agent_bridge.resolve_credential_hash(credential_hash text)
returns table(credential_id uuid, workspace_id text, principal text, scopes text[])
language sql volatile security definer set search_path = '' as $$
  select credential.id,credential.workspace_id,agent.principal,credential.scopes
  from agent_bridge.credentials credential
  join agent_bridge.agents agent on agent.id=credential.agent_id and agent.workspace_id=credential.workspace_id
  join agent_bridge.workspaces workspace on workspace.id=credential.workspace_id
  where credential_hash ~ '^[0-9a-f]{64}$'
    and credential.token_hash=credential_hash::character(64)
    and credential.revoked_at is null
    and (credential.expires_at is null or credential.expires_at>clock_timestamp())
    and (not exists (select 1 from agent_bridge.credentials successor where successor.replaces_credential_id=credential.id)
      or credential.expiry_grace_until>clock_timestamp())
    and agent.disabled_at is null and workspace.disabled_at is null
  limit 1
$$;

create or replace function agent_bridge.open_request_authority(
  requested_credential_id uuid,
  credential_hash text,
  requested_request_id uuid
) returns table(credential_id uuid, workspace_id text, principal text, scopes text[])
language plpgsql security definer set search_path = '' as $$
declare
  runtime_role name := ('agent_bridge_runtime_' || substr(pg_catalog.md5(pg_catalog.current_database()),1,16))::name;
  authority_credential_id uuid;
  authority_workspace_id text;
  authority_principal text;
  authority_scopes text[];
  request_time timestamptz := clock_timestamp();
begin
  if not pg_catalog.pg_has_role(session_user,runtime_role,'MEMBER')
    or credential_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='42501',message='request authority is restricted to the runtime login';
  end if;

  select credential.id,credential.workspace_id,agent.principal,credential.scopes
    into authority_credential_id,authority_workspace_id,authority_principal,authority_scopes
  from agent_bridge.credentials credential
  join agent_bridge.agents agent on agent.id=credential.agent_id and agent.workspace_id=credential.workspace_id
  join agent_bridge.workspaces workspace on workspace.id=credential.workspace_id
  where credential.id=requested_credential_id
    and credential.token_hash=credential_hash::character(64)
    and credential.revoked_at is null
    and (credential.expires_at is null or credential.expires_at>request_time)
    and (not exists (select 1 from agent_bridge.credentials successor where successor.replaces_credential_id=credential.id)
      or credential.expiry_grace_until>request_time)
    and agent.disabled_at is null and workspace.disabled_at is null
  for share of credential,agent,workspace;

  if not found then return; end if;

  insert into agent_bridge.request_authorities(
    backend_pid,transaction_id,request_id,credential_id,workspace_id,principal,scopes,opened_session_user
  ) values (
    pg_catalog.pg_backend_pid(),pg_catalog.pg_current_xact_id(),requested_request_id,
    authority_credential_id,authority_workspace_id,authority_principal,authority_scopes,session_user
  );
  credential_id := authority_credential_id;
  workspace_id := authority_workspace_id;
  principal := authority_principal;
  scopes := authority_scopes;
  return next;
end
$$;

create or replace function agent_bridge.active_request_authority()
returns agent_bridge.request_authorities
language sql volatile security definer set search_path = '' as $$
  select authority
  from agent_bridge.request_authorities authority
  where authority.backend_pid=pg_catalog.pg_backend_pid()
    and authority.transaction_id=pg_catalog.pg_current_xact_id_if_assigned()
    and authority.opened_session_user=session_user
$$;

create or replace function agent_bridge.assert_active_request_credential(requested_credential_id uuid)
returns agent_bridge.request_authorities
language plpgsql volatile security definer set search_path = '' as $$
declare authority agent_bridge.request_authorities%rowtype;
begin
  select * into authority from agent_bridge.active_request_authority();
  if not found or authority.credential_id is distinct from requested_credential_id then
    raise exception using errcode='28000',message='active request authority is required';
  end if;
  return authority;
end
$$;

create or replace function agent_bridge.close_request_authority() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare authority agent_bridge.request_authorities%rowtype;
begin
  select * into authority from agent_bridge.active_request_authority();
  if not found then
    raise exception using errcode='28000',message='active request authority is required';
  end if;
  delete from agent_bridge.request_authorities
  where backend_pid=authority.backend_pid and transaction_id=authority.transaction_id;
end
$$;

alter function agent_bridge.record_scope_denial(uuid,text,uuid) rename to record_scope_denial_unbound_011;
alter function agent_bridge.consume_rate_limit(uuid,text,uuid) rename to consume_rate_limit_unbound_011;

create function agent_bridge.record_scope_denial(uuid,text,uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform agent_bridge.assert_active_request_credential($1);
  perform agent_bridge.record_scope_denial_unbound_011($1,$2,$3);
end
$$;

create function agent_bridge.consume_rate_limit(uuid,text,uuid)
returns table(allowed boolean,limit_value integer,remaining_value integer,retry_after_seconds numeric,denied_policy_id text)
language plpgsql security definer set search_path = '' as $$
begin
  perform agent_bridge.assert_active_request_credential($1);
  return query select * from agent_bridge.consume_rate_limit_unbound_011($1,$2,$3);
end
$$;

revoke all on function agent_bridge.open_request_authority(uuid,text,uuid) from public;
revoke all on function agent_bridge.resolve_credential_hash(text) from public;
revoke all on function agent_bridge.active_request_authority() from public;
revoke all on function agent_bridge.assert_active_request_credential(uuid) from public;
revoke all on function agent_bridge.close_request_authority() from public;
revoke all on function agent_bridge.record_scope_denial_unbound_011(uuid,text,uuid) from public;
revoke all on function agent_bridge.consume_rate_limit_unbound_011(uuid,text,uuid) from public;
revoke all on function agent_bridge.record_scope_denial(uuid,text,uuid) from public;
revoke all on function agent_bridge.consume_rate_limit(uuid,text,uuid) from public;

do $roles$
declare
  runtime_role text := 'agent_bridge_runtime_' || substr(md5(current_database()),1,16);
  role_name text;
begin
  foreach role_name in array array[runtime_role,'anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on function agent_bridge.record_scope_denial_unbound_011(uuid,text,uuid) from %I',role_name);
      execute format('revoke all on function agent_bridge.consume_rate_limit_unbound_011(uuid,text,uuid) from %I',role_name);
    end if;
  end loop;
  execute format('revoke select on agent_bridge.credentials,agent_bridge.agents,agent_bridge.workspaces from %I',runtime_role);
  execute format('revoke all on agent_bridge.request_authorities from %I',runtime_role);
  execute format('grant execute on function agent_bridge.open_request_authority(uuid,text,uuid) to %I',runtime_role);
  execute format('grant execute on function agent_bridge.resolve_credential_hash(text) to %I',runtime_role);
  execute format('grant execute on function agent_bridge.close_request_authority() to %I',runtime_role);
  execute format('grant execute on function agent_bridge.record_scope_denial(uuid,text,uuid) to %I',runtime_role);
  execute format('grant execute on function agent_bridge.consume_rate_limit(uuid,text,uuid) to %I',runtime_role);
end
$roles$;

insert into agent_bridge.schema_migrations(version,name,checksum)
values (12,'request_authority','__AGENT_BRIDGE_MIGRATION_CHECKSUM__');

commit;
