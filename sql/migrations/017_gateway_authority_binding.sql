begin;

select pg_advisory_xact_lock(1646705660);

create table agent_bridge.gateway_authority (
  singleton boolean not null default true,
  authority_id uuid not null default gen_random_uuid(),
  constraint gateway_authority_singleton primary key (singleton),
  constraint gateway_authority_singleton_true check (singleton),
  constraint gateway_authority_id_unique unique (authority_id)
);

insert into agent_bridge.gateway_authority(singleton) values (true);

create function agent_bridge.reject_gateway_authority_mutation()
returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'gateway authority is immutable';
end
$$;

create trigger gateway_authority_immutable
before update or delete or truncate on agent_bridge.gateway_authority
for each statement execute function agent_bridge.reject_gateway_authority_mutation();

create function agent_bridge.gateway_authority_ready()
returns boolean
language sql stable security definer set search_path = '' as $$
  select count(*)=1 and bool_and(singleton and authority_id is not null)
  from agent_bridge.gateway_authority
$$;

create function agent_bridge.open_request_authority_bound(
  requested_credential_id uuid,
  credential_hash text,
  requested_request_id uuid
) returns table(
  gateway_authority_id uuid,
  credential_id uuid,
  workspace_id text,
  principal text,
  scopes text[]
)
language plpgsql volatile security definer set search_path = '' as $$
declare
  bound_gateway_authority_id uuid;
  authority_credential_id uuid;
  authority_workspace_id text;
  authority_principal text;
  authority_scopes text[];
begin
  select authority_id into strict bound_gateway_authority_id
  from agent_bridge.gateway_authority
  where singleton;

  select authority.credential_id,authority.workspace_id,authority.principal,authority.scopes
    into authority_credential_id,authority_workspace_id,authority_principal,authority_scopes
  from agent_bridge.open_request_authority(
    requested_credential_id,credential_hash,requested_request_id
  ) authority;

  if not found then return; end if;

  gateway_authority_id := bound_gateway_authority_id;
  credential_id := authority_credential_id;
  workspace_id := authority_workspace_id;
  principal := authority_principal;
  scopes := authority_scopes;
  return next;
end
$$;

revoke all on agent_bridge.gateway_authority from public;
revoke all on function agent_bridge.reject_gateway_authority_mutation() from public;
revoke all on function agent_bridge.gateway_authority_ready() from public;
revoke all on function agent_bridge.open_request_authority_bound(uuid,text,uuid) from public;

do $roles$
declare
  runtime_role text := 'agent_bridge_runtime_' || substr(md5(current_database()),1,16);
  role_name text;
begin
  foreach role_name in array array[runtime_role,'anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on agent_bridge.gateway_authority from %I',role_name);
      execute format('revoke all on function agent_bridge.gateway_authority_ready() from %I',role_name);
      execute format('revoke all on function agent_bridge.open_request_authority_bound(uuid,text,uuid) from %I',role_name);
    end if;
  end loop;
  execute format('grant execute on function agent_bridge.gateway_authority_ready() to %I',runtime_role);
  execute format('grant execute on function agent_bridge.open_request_authority_bound(uuid,text,uuid) to %I',runtime_role);
end
$roles$;

insert into agent_bridge.schema_migrations(version,name,checksum)
values (17,'gateway_authority_binding','__AGENT_BRIDGE_MIGRATION_CHECKSUM__');

commit;
