begin;

select pg_advisory_xact_lock(1646705660);

do $preflight$
begin
  if not agent_bridge.security_schema_ready() then
    raise exception 'endpoint migration same-successor preflight requires security readiness';
  elsif not agent_bridge.owner_control_plane_ready() then
    raise exception 'endpoint migration same-successor preflight requires owner readiness';
  elsif not agent_bridge.gateway_authority_ready() then
    raise exception 'endpoint migration same-successor preflight requires gateway authority readiness';
  elsif not agent_bridge.endpoint_migration_challenge_ready() then
    raise exception 'endpoint migration same-successor preflight requires endpoint challenge readiness';
  end if;
end
$preflight$;

alter table agent_bridge.endpoint_migration_challenge_attestations
  drop constraint endpoint_migration_challenge_attestation_name;
alter table agent_bridge.endpoint_migration_challenge_attestations
  add constraint endpoint_migration_challenge_attestation_name
  check(name in ('endpoint-migration-v1','endpoint-migration-v2'));

create or replace function agent_bridge.issue_endpoint_migration_challenge(
  requested_expected_gateway_authority_id uuid,
  requested_verifier_credential_id uuid,
  requested_challenge text
) returns table(
  gateway_authority_id uuid,
  issuer_credential_id uuid,
  verifier_credential_id uuid,
  expires_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  authority agent_bridge.request_authorities%rowtype;
  gateway_id uuid;
  now_time timestamptz := clock_timestamp();
  challenge_commitment char(64);
  existing agent_bridge.endpoint_migration_challenges%rowtype;
begin
  if requested_challenge is null or requested_challenge !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='endpoint migration challenge is invalid';
  end if;
  select * into authority from agent_bridge.active_request_authority();
  if not found or authority.authorized_endpoint_migration_operation is distinct from 'issue_endpoint_migration_challenge' then
    raise exception using errcode='42501',message='endpoint migration issue authorization is required';
  end if;
  select authority_id into strict gateway_id from agent_bridge.gateway_authority where singleton;
  if requested_expected_gateway_authority_id is distinct from gateway_id then
    raise exception using errcode='28000',message='expected gateway authority does not match';
  end if;
  if not agent_bridge.endpoint_migration_challenge_active_credential(
    authority.credential_id,authority.workspace_id,authority.principal
  ) or not agent_bridge.endpoint_migration_challenge_active_credential(
    requested_verifier_credential_id,authority.workspace_id,authority.principal
  ) or not (
    authority.credential_id=requested_verifier_credential_id
    or agent_bridge.endpoint_migration_challenge_direct_lineage(
      authority.credential_id,requested_verifier_credential_id
    )
  ) then
    raise exception using errcode='28000',message='endpoint migration verifier is not an active successor credential';
  end if;
  challenge_commitment := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    'agent-bridge.endpoint-migration-challenge.v1:'||requested_challenge,'UTF8'
  )),'hex')::character(64);
  perform agent_bridge.cleanup_endpoint_migration_challenges();
  select * into existing from agent_bridge.endpoint_migration_challenges
  where challenge_hash=challenge_commitment for update;
  if found then
    if existing.authority_id=gateway_id
      and existing.workspace_id=authority.workspace_id
      and existing.principal=authority.principal
      and existing.issuer_credential_id=authority.credential_id
      and existing.verifier_credential_id=requested_verifier_credential_id
      and existing.expires_at>now_time
      and existing.consumed_at is null then
      gateway_authority_id := existing.authority_id;
      issuer_credential_id := existing.issuer_credential_id;
      verifier_credential_id := existing.verifier_credential_id;
      expires_at := existing.expires_at;
      return next;
      return;
    end if;
    raise exception using errcode='23505',message='endpoint migration challenge commitment conflicts with an existing challenge';
  end if;
  insert into agent_bridge.endpoint_migration_challenges(
    challenge_hash,authority_id,workspace_id,principal,issuer_credential_id,verifier_credential_id,expires_at
  ) values (
    challenge_commitment,gateway_id,authority.workspace_id,authority.principal,
    authority.credential_id,requested_verifier_credential_id,now_time+interval '60 seconds'
  );
  insert into agent_bridge.endpoint_migration_challenge_events(
    request_id,event_type,outcome,authority_id,workspace_id,principal,issuer_credential_id,verifier_credential_id
  ) values (
    authority.request_id,'issued','succeeded',gateway_id,authority.workspace_id,authority.principal,
    authority.credential_id,requested_verifier_credential_id
  );
  gateway_authority_id := gateway_id;
  issuer_credential_id := authority.credential_id;
  verifier_credential_id := requested_verifier_credential_id;
  expires_at := now_time+interval '60 seconds';
  return next;
end
$$;

create or replace function agent_bridge.consume_endpoint_migration_challenge(
  requested_expected_gateway_authority_id uuid,
  requested_issuer_credential_id uuid,
  requested_challenge text
) returns table(
  gateway_authority_id uuid,
  issuer_credential_id uuid,
  verifier_credential_id uuid,
  expires_at timestamptz,
  consumed boolean
)
language plpgsql security definer set search_path = '' as $$
declare
  authority agent_bridge.request_authorities%rowtype;
  gateway_id uuid;
  challenge agent_bridge.endpoint_migration_challenges%rowtype;
  challenge_commitment char(64);
begin
  if requested_challenge is null or requested_challenge !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='endpoint migration challenge is invalid';
  end if;
  select * into authority from agent_bridge.active_request_authority();
  if not found or authority.authorized_endpoint_migration_operation is distinct from 'consume_endpoint_migration_challenge' then
    raise exception using errcode='42501',message='endpoint migration consume authorization is required';
  end if;
  select authority_id into strict gateway_id from agent_bridge.gateway_authority where singleton;
  if requested_expected_gateway_authority_id is distinct from gateway_id then
    raise exception using errcode='28000',message='expected gateway authority does not match';
  end if;
  challenge_commitment := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    'agent-bridge.endpoint-migration-challenge.v1:'||requested_challenge,'UTF8'
  )),'hex')::character(64);
  select * into challenge from agent_bridge.endpoint_migration_challenges
  where challenge_hash=challenge_commitment for update;
  if not found then
    gateway_authority_id := gateway_id;
    issuer_credential_id := requested_issuer_credential_id;
    verifier_credential_id := authority.credential_id;
    expires_at := null;
    consumed := false;
    return next;
    return;
  end if;
  gateway_authority_id := challenge.authority_id;
  issuer_credential_id := challenge.issuer_credential_id;
  verifier_credential_id := challenge.verifier_credential_id;
  expires_at := challenge.expires_at;
  consumed := false;
  if challenge.authority_id is distinct from gateway_id
    or challenge.authority_id is distinct from requested_expected_gateway_authority_id
    or challenge.workspace_id is distinct from authority.workspace_id
    or challenge.principal is distinct from authority.principal
    or challenge.issuer_credential_id is distinct from requested_issuer_credential_id
    or challenge.verifier_credential_id is distinct from authority.credential_id
    or challenge.expires_at<=clock_timestamp()
    or challenge.consumed_at is not null
    or not agent_bridge.endpoint_migration_challenge_active_credential(
      challenge.issuer_credential_id,challenge.workspace_id,challenge.principal
    )
    or not agent_bridge.endpoint_migration_challenge_active_credential(
      authority.credential_id,authority.workspace_id,authority.principal
    )
    or not (
      challenge.issuer_credential_id=authority.credential_id
      or agent_bridge.endpoint_migration_challenge_direct_lineage(
        challenge.issuer_credential_id,authority.credential_id
      )
    ) then
    return next;
    return;
  end if;
  update agent_bridge.endpoint_migration_challenges stored
  set consumed_at=clock_timestamp(),consumed_credential_id=authority.credential_id
  where stored.challenge_hash=challenge.challenge_hash and stored.consumed_at is null;
  consumed := found;
  if consumed then
    insert into agent_bridge.endpoint_migration_challenge_events(
      request_id,event_type,outcome,authority_id,workspace_id,principal,issuer_credential_id,verifier_credential_id
    ) values (
      authority.request_id,'consumed','succeeded',challenge.authority_id,
      challenge.workspace_id,challenge.principal,challenge.issuer_credential_id,
      challenge.verifier_credential_id
    );
  end if;
  return next;
end
$$;

create or replace function agent_bridge.endpoint_migration_challenge_ready()
returns boolean language sql stable security definer set search_path = '' as $$
  with names as (
    select ('agent_bridge_runtime_'||substr(md5(current_database()),1,16))::name runtime_role
  ) select
    (select count(*)=1 from agent_bridge.endpoint_migration_challenge_attestations where name='endpoint-migration-v1')
    and (select count(*)=1 and bool_and(catalog_definition=agent_bridge.endpoint_migration_challenge_catalog_definition())
      from agent_bridge.endpoint_migration_challenge_attestations where name='endpoint-migration-v2')
    and (select count(*)=1 from agent_bridge.gateway_authority where singleton)
    and not exists(select 1 from pg_catalog.pg_class relation join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
      where namespace.nspname='agent_bridge' and relation.relname in (
        'endpoint_migration_challenges','endpoint_migration_challenge_events','endpoint_migration_challenge_attestations'
      ) and (relation.relrowsecurity or relation.relforcerowsecurity))
    and not exists(select 1 from unnest(array[
      'agent_bridge.endpoint_migration_challenges','agent_bridge.endpoint_migration_challenge_events',
      'agent_bridge.endpoint_migration_challenge_attestations'
    ]) relation_name cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
      where has_table_privilege('public',relation_name,privilege)
        or has_table_privilege((select runtime_role from names),relation_name,privilege))
    and not exists(select 1 from unnest(array[
      'agent_bridge.endpoint_migration_challenges','agent_bridge.endpoint_migration_challenge_events',
      'agent_bridge.endpoint_migration_challenge_attestations'
    ]) relation_name cross join unnest(array['SELECT','INSERT','UPDATE','REFERENCES']) privilege
      where has_any_column_privilege('public',relation_name,privilege)
        or has_any_column_privilege((select runtime_role from names),relation_name,privilege))
    and has_function_privilege((select runtime_role from names),
      'agent_bridge.issue_endpoint_migration_challenge(uuid,uuid,text)','EXECUTE')
    and has_function_privilege((select runtime_role from names),
      'agent_bridge.consume_endpoint_migration_challenge(uuid,uuid,text)','EXECUTE')
    and not has_function_privilege('public',
      'agent_bridge.issue_endpoint_migration_challenge(uuid,uuid,text)','EXECUTE')
    and not has_function_privilege('public',
      'agent_bridge.consume_endpoint_migration_challenge(uuid,uuid,text)','EXECUTE')
    and not exists(select 1 from pg_catalog.pg_proc procedure join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
      where namespace.nspname='agent_bridge' and procedure.proname in (
        'cleanup_endpoint_migration_challenges','endpoint_migration_challenge_catalog_definition',
        'endpoint_migration_challenge_ready','guard_endpoint_migration_challenge',
        'reject_endpoint_migration_challenge_truncate','reject_endpoint_migration_challenge_event_mutation',
        'reject_endpoint_migration_challenge_attestation_mutation',
        'endpoint_migration_challenge_active_credential','endpoint_migration_challenge_direct_lineage'
      ) and has_function_privilege((select runtime_role from names),procedure.oid,'EXECUTE'))
$$;

create or replace function agent_bridge.owner_control_plane_ready()
returns boolean language sql stable security definer set search_path = '' as $$
  with names as (select
    ('agent_bridge_control_owner_'||substr(md5(current_database()),1,16))::name owner_role,
    ('agent_bridge_control_operator_'||substr(md5(current_database()),1,16))::name operator_role,
    ('agent_bridge_control_auditor_'||substr(md5(current_database()),1,16))::name auditor_role,
    (select pg_catalog.pg_get_userbyid(nspowner)::name from pg_catalog.pg_namespace where nspname='agent_bridge') schema_owner
  ), latest_registry as (
    select distinct on (event.member_role,event.control_role) event.member_role,event.control_role,event.action
    from agent_bridge.control_membership_events event
    order by event.member_role,event.control_role,event.sequence desc
  ), active_registry as (
    select member_role,control_role from latest_registry where action='register'
  ), expected_memberships as (
    select names.owner_role granted_role,names.schema_owner member_role,
      true admin_option,true inherit_option,true set_option from names
    union all select names.operator_role,names.schema_owner,true,true,true from names
    union all select names.auditor_role,names.schema_owner,true,true,true from names
    union all select case registry.control_role when 'operator' then names.operator_role else names.auditor_role end,
      registry.member_role,false,true,true from active_registry registry cross join names
  ), raw_memberships as (
    select granted.rolname::name granted_role,member.rolname::name member_role,
      membership.admin_option,
      coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true) inherit_option,
      coalesce((to_jsonb(membership)->>'set_option')::boolean,true) set_option,
      membership.grantor,member.oid member_oid
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    where granted.rolname in ((select owner_role from names),(select operator_role from names),(select auditor_role from names))
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
    from names cross join lateral(values(names.owner_role),(names.operator_role),(names.auditor_role)) control_role(granted_role)
    cross join pg_catalog.pg_roles candidate
    where candidate.rolname not in(names.owner_role,names.operator_role,names.auditor_role)
      and(not candidate.rolsuper or candidate.rolname=names.schema_owner)
      and pg_catalog.pg_has_role(candidate.rolname,control_role.granted_role,'MEMBER')
  ) select
    current_setting('server_version_num')::integer/10000=any(array[15,16,17,18])
    and(select count(*)=1 and bool_and(catalog_definition=agent_bridge.owner_control_attestation_definition())
      from agent_bridge.owner_control_attestations where name='owner-control-v6')
    and not exists(
      (select granted_role,member_role,admin_option,inherit_option,set_option from actual_memberships
        except select granted_role,member_role,admin_option,inherit_option,set_option from expected_memberships)
      union all(select granted_role,member_role,admin_option,inherit_option,set_option from expected_memberships
        except select granted_role,member_role,admin_option,inherit_option,set_option from actual_memberships)
    )
    and not exists(select 1 from actual_memberships where not grants_valid)
    and not exists(select 1 from active_registry registry left join pg_catalog.pg_roles role_record on role_record.rolname=registry.member_role
      where role_record.oid is null or not role_record.rolcanlogin or role_record.rolsuper or role_record.rolcreaterole
        or role_record.rolcreatedb or role_record.rolreplication or role_record.rolbypassrls)
    and not exists(
      (select granted_role,member_role from authority_closure except select granted_role,member_role from expected_memberships)
      union all(select granted_role,member_role from expected_memberships except select granted_role,member_role from authority_closure)
    )
    and not exists(select 1 from active_registry registry join pg_catalog.pg_roles inherited on inherited.rolname<>registry.member_role
      where pg_catalog.pg_has_role(registry.member_role,inherited.rolname,'MEMBER') and not exists(
        select 1 from active_registry permitted cross join names where permitted.member_role=registry.member_role
          and inherited.rolname=case permitted.control_role when 'operator' then names.operator_role else names.auditor_role end
      ))
    and not exists(select 1 from active_registry registry cross join pg_catalog.pg_roles candidate,names
      where candidate.rolname not in(registry.member_role,names.schema_owner) and not candidate.rolsuper
        and pg_catalog.pg_has_role(candidate.rolname,registry.member_role,'MEMBER'))
$$;

insert into agent_bridge.endpoint_migration_challenge_attestations(name,catalog_definition)
values('endpoint-migration-v2',agent_bridge.endpoint_migration_challenge_catalog_definition());
select set_config(
  'role','agent_bridge_control_owner_'||substr(md5(current_database()),1,16),false
);
insert into agent_bridge.owner_control_attestations(name,catalog_definition)
values('owner-control-v6',agent_bridge.owner_control_attestation_definition());
reset role;

do $final_readiness$
begin
  if not agent_bridge.security_schema_ready() then
    raise exception 'endpoint migration same-successor final security readiness validation failed';
  elsif not agent_bridge.owner_control_plane_ready() then
    raise exception 'endpoint migration same-successor final owner readiness validation failed';
  elsif not agent_bridge.gateway_authority_ready() then
    raise exception 'endpoint migration same-successor final gateway authority readiness validation failed';
  elsif not agent_bridge.endpoint_migration_challenge_ready() then
    raise exception 'endpoint migration same-successor final endpoint readiness validation failed';
  elsif not agent_bridge.portable_archive_ready() then
    raise exception 'endpoint migration same-successor final portable archive readiness validation failed';
  end if;
end
$final_readiness$;

insert into agent_bridge.schema_migrations(version,name,checksum)
values(19,'endpoint_migration_same_successor','__AGENT_BRIDGE_MIGRATION_CHECKSUM__');

commit;
