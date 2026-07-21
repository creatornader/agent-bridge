begin;

select pg_advisory_xact_lock(1646705660);

do $readiness$
begin
  if not agent_bridge.security_schema_ready() then
    raise exception 'managed authority compatibility security readiness validation failed';
  elsif not agent_bridge.owner_control_plane_ready() then
    raise exception 'managed authority compatibility owner readiness validation failed';
  elsif not agent_bridge.gateway_authority_ready() then
    raise exception 'managed authority compatibility gateway readiness validation failed';
  elsif not agent_bridge.endpoint_migration_challenge_ready() then
    raise exception 'managed authority compatibility endpoint readiness validation failed';
  elsif not agent_bridge.portable_archive_ready() then
    raise exception 'managed authority compatibility archive readiness validation failed';
  end if;
end
$readiness$;

alter table agent_bridge.portable_archive_attestations
  drop constraint portable_archive_attestation_name;
alter table agent_bridge.portable_archive_attestations
  add constraint portable_archive_attestation_name
  check(name ~ '^portable-archive-v[0-9]+$');

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
    select granted.rolname control_role,
      bool_or(membership.admin_option) admin_option,
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
    where member.rolname=session_user and granted.rolname in (operator_role,auditor_role)
    group by granted.rolname
  )
  select
    coalesce(bool_or(membership.control_role=operator_role
      and membership.inherit_option and membership.set_option and membership.grants_valid and (
        (session_user=schema_owner and membership.admin_option)
        or (latest.control_role='operator' and latest.action='register'
          and not membership.admin_option)
      )),false),
    coalesce(bool_or(membership.control_role=auditor_role
      and membership.inherit_option and membership.set_option and membership.grants_valid and (
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
      and not candidate.rolsuper
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
    membership.inherit_option and membership.set_option and membership.grants_valid and (
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

do $ownership$
declare
  owner_role text := 'agent_bridge_control_owner_'||substr(md5(current_database()),1,16);
begin
  execute format('grant create on schema agent_bridge to %I',owner_role);
  execute format(
    'grant insert on agent_bridge.owner_control_attestations to %I',
    owner_role
  );
  perform set_config('role',owner_role,false);
end
$ownership$;

create or replace function agent_bridge.owner_control_attestation_definition()
returns text language sql stable set search_path = '' as $$
  with names as (select
    ('agent_bridge_control_owner_'||substr(md5(current_database()),1,16))::name owner_role,
    ('agent_bridge_control_operator_'||substr(md5(current_database()),1,16))::name operator_role,
    ('agent_bridge_control_auditor_'||substr(md5(current_database()),1,16))::name auditor_role,
    (select namespace.nspowner from pg_catalog.pg_namespace namespace
      where namespace.nspname='agent_bridge') schema_owner
  ), control_roles(role_name) as (
    select owner_role from names union all select operator_role from names
    union all select auditor_role from names
  ), raw_records(record) as (
    select unnest(string_to_array(
      agent_bridge.owner_control_catalog_definition(),E'\x1e'
    ))
  ), protected_relations(oid) as (
    select distinct pg_catalog.to_regclass(split_part(record,E'\x1f',2))
    from raw_records where split_part(record,E'\x1f',1) in ('relation','relation_acl')
    union
    select distinct relation.oid
    from raw_records
    join pg_catalog.pg_attribute attribute
      on not attribute.attisdropped and attribute.attnum>0
    join pg_catalog.pg_class relation on relation.oid=attribute.attrelid
      and relation.oid::regclass::text||'.'||attribute.attname=
        split_part(record,E'\x1f',2)
    where split_part(record,E'\x1f',1)='column_acl'
  ), default_acl_keys(owner_oid,namespace_oid,object_type) as (
    select role.oid,0::oid,object_type
    from pg_catalog.pg_roles role
    cross join (values ('r'::"char"),('S'::"char"),('f'::"char"),
      ('T'::"char"),('n'::"char")) object_types(object_type)
    where role.oid in (
      (select schema_owner from names),
      (select oid from pg_catalog.pg_roles where rolname=(select owner_role from names))
    )
    union
    select default_acl.defaclrole,default_acl.defaclnamespace,default_acl.defaclobjtype
    from pg_catalog.pg_default_acl default_acl
    left join pg_catalog.pg_namespace namespace on namespace.oid=default_acl.defaclnamespace
    where (namespace.nspname='agent_bridge' or default_acl.defaclnamespace=0)
      and default_acl.defaclrole in (
        (select schema_owner from names),
        (select oid from pg_catalog.pg_roles where rolname=(select owner_role from names))
      )
  ), catalog_objects(kind,identity,definition) as (
    select split_part(record,E'\x1f',1),split_part(record,E'\x1f',2),
      split_part(record,E'\x1f',3)
    from raw_records where split_part(record,E'\x1f',1) not in (
      'membership','relation_acl','column_acl','default_acl'
    )
    union all
    select 'membership',granted.rolname||'->'||member.rolname,
      bool_or(membership.admin_option)::text||':'||
      bool_or(coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true))::text||':'||
      bool_or(coalesce((to_jsonb(membership)->>'set_option')::boolean,true))::text
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    where member.rolname in (select role_name from control_roles)
      or granted.rolname=(select owner_role from names)
    group by granted.rolname,member.rolname
    union all
    select 'relation_acl',relation.oid::regclass::text,
      pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
      case when privilege.grantee=0 then 'PUBLIC'
        else pg_catalog.pg_get_userbyid(privilege.grantee) end||':'||
      privilege.privilege_type||':'||privilege.is_grantable::text
    from pg_catalog.pg_class relation
    cross join lateral pg_catalog.aclexplode(coalesce(relation.relacl,
      pg_catalog.acldefault(
        case when relation.relkind='S' then 'S'::"char" else 'r'::"char" end,
        relation.relowner
      ))) privilege
    where relation.oid in (select oid from protected_relations)
      and relation.relkind in ('r','p','v','m','f','S')
      and privilege.grantee<>relation.relowner
    union all
    select 'column_acl',relation.oid::regclass::text||'.'||attribute.attname,
      pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
      case when privilege.grantee=0 then 'PUBLIC'
        else pg_catalog.pg_get_userbyid(privilege.grantee) end||':'||
      privilege.privilege_type||':'||privilege.is_grantable::text
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation on relation.oid=attribute.attrelid
    cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
    where relation.oid in (select oid from protected_relations)
      and attribute.attnum>0 and not attribute.attisdropped
      and attribute.attacl is not null and privilege.grantee<>relation.relowner
    union all
    select 'default_acl',owner.rolname||':'||coalesce(namespace.nspname,'')||':'||
      keys.object_type::text,
      pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
      case when privilege.grantee=0 then 'PUBLIC'
        else pg_catalog.pg_get_userbyid(privilege.grantee) end||':'||
      privilege.privilege_type||':'||privilege.is_grantable::text
    from default_acl_keys keys
    join pg_catalog.pg_roles owner on owner.oid=keys.owner_oid
    left join pg_catalog.pg_namespace namespace on namespace.oid=keys.namespace_oid
    left join pg_catalog.pg_default_acl default_acl
      on default_acl.defaclrole=keys.owner_oid
      and default_acl.defaclnamespace=keys.namespace_oid
      and default_acl.defaclobjtype=keys.object_type
    cross join lateral pg_catalog.aclexplode(case when keys.namespace_oid=0 then
      coalesce(default_acl.defaclacl,pg_catalog.acldefault(keys.object_type,keys.owner_oid))
      else coalesce(default_acl.defaclacl,'{}'::pg_catalog.aclitem[]) end) privilege
    where privilege.grantee<>keys.owner_oid
    union all
    select 'attestation_function',procedure.oid::regprocedure::text,
      pg_catalog.pg_get_userbyid(procedure.proowner)||':'||
      pg_catalog.pg_get_functiondef(procedure.oid)
    from pg_catalog.pg_proc procedure
    where procedure.oid=
      'agent_bridge.owner_control_attestation_definition()'::regprocedure
  )
  select string_agg(kind||E'\x1f'||identity||E'\x1f'||definition,E'\x1e'
    order by kind,identity,definition) from catalog_objects
$$;

reset role;

do $ownership$
declare
  owner_role text := 'agent_bridge_control_owner_'||substr(md5(current_database()),1,16);
begin
  execute format('revoke create on schema agent_bridge from %I',owner_role);
end
$ownership$;

create or replace function agent_bridge.portable_archive_attestation_definition()
returns text language sql stable set search_path = '' as $$
  with names as (select
    ('agent_bridge_archive_operator_'||substr(md5(current_database()),1,16))::name archive_role,
    namespace.nspowner schema_owner
    from pg_catalog.pg_namespace namespace where namespace.nspname='agent_bridge'
  ), raw_records(record) as (
    select unnest(string_to_array(
      agent_bridge.portable_archive_catalog_definition(),E'\x1e'
    ))
  ), protected_relations(oid) as (
    select distinct pg_catalog.to_regclass(split_part(record,E'\x1f',2))
    from raw_records where split_part(record,E'\x1f',1)='relation'
  ), default_acl_keys(owner_oid,namespace_oid,object_type) as (
    select (select schema_owner from names),0::oid,object_type
    from (values ('r'::"char"),('S'::"char"),('f'::"char"),
      ('T'::"char"),('n'::"char")) object_types(object_type)
    union
    select default_acl.defaclrole,default_acl.defaclnamespace,default_acl.defaclobjtype
    from pg_catalog.pg_default_acl default_acl
    left join pg_catalog.pg_namespace namespace on namespace.oid=default_acl.defaclnamespace
    where namespace.nspname='agent_bridge'
      or default_acl.defaclrole=(select schema_owner from names)
  ), catalog_objects(kind,identity,definition) as (
    select split_part(record,E'\x1f',1),split_part(record,E'\x1f',2),
      split_part(record,E'\x1f',3)
    from raw_records where split_part(record,E'\x1f',1) not in (
      'owner_membership','relation_acl','column_acl','default_acl'
    )
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
    select 'relation_acl',relation.oid::regclass::text,
      pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
      case when privilege.grantee=0 then 'PUBLIC'
        else pg_catalog.pg_get_userbyid(privilege.grantee) end||':'||
      privilege.privilege_type||':'||privilege.is_grantable::text
    from pg_catalog.pg_class relation
    cross join lateral pg_catalog.aclexplode(coalesce(relation.relacl,
      pg_catalog.acldefault(
        case when relation.relkind='S' then 'S'::"char" else 'r'::"char" end,
        relation.relowner
      ))) privilege
    where relation.oid in (select oid from protected_relations)
      and relation.relkind in ('r','p','v','m','f','S')
      and privilege.grantee<>relation.relowner
    union all
    select 'column_acl',relation.oid::regclass::text||'.'||attribute.attname,
      pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
      case when privilege.grantee=0 then 'PUBLIC'
        else pg_catalog.pg_get_userbyid(privilege.grantee) end||':'||
      privilege.privilege_type||':'||privilege.is_grantable::text
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation on relation.oid=attribute.attrelid
    cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
    where relation.oid in (select oid from protected_relations)
      and attribute.attnum>0 and not attribute.attisdropped
      and attribute.attacl is not null and privilege.grantee<>relation.relowner
    union all
    select 'default_acl',owner.rolname||':'||coalesce(namespace.nspname,'')||':'||
      keys.object_type::text,
      pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
      case when privilege.grantee=0 then 'PUBLIC'
        else pg_catalog.pg_get_userbyid(privilege.grantee) end||':'||
      privilege.privilege_type||':'||privilege.is_grantable::text
    from default_acl_keys keys
    join pg_catalog.pg_roles owner on owner.oid=keys.owner_oid
    left join pg_catalog.pg_namespace namespace on namespace.oid=keys.namespace_oid
    left join pg_catalog.pg_default_acl default_acl
      on default_acl.defaclrole=keys.owner_oid
      and default_acl.defaclnamespace=keys.namespace_oid
      and default_acl.defaclobjtype=keys.object_type
    cross join lateral pg_catalog.aclexplode(case when keys.namespace_oid=0 then
      coalesce(default_acl.defaclacl,pg_catalog.acldefault(keys.object_type,keys.owner_oid))
      else coalesce(default_acl.defaclacl,'{}'::pg_catalog.aclitem[]) end) privilege
    where privilege.grantee<>keys.owner_oid
    union all
    select 'attestation_function',procedure.oid::regprocedure::text,
      pg_catalog.pg_get_userbyid(procedure.proowner)||':'||
      pg_catalog.pg_get_functiondef(procedure.oid)
    from pg_catalog.pg_proc procedure
    where procedure.oid=
      'agent_bridge.portable_archive_attestation_definition()'::regprocedure
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
      attestation.catalog_definition=agent_bridge.portable_archive_attestation_definition()
    ) from agent_bridge.portable_archive_attestations attestation
      where attestation.name='portable-archive-v4')
    and not exists(
      (select granted_role,member_role,admin_option,inherit_option,set_option from actual_memberships
       except select granted_role,member_role,admin_option,inherit_option,set_option from expected_memberships)
      union all
      (select granted_role,member_role,admin_option,inherit_option,set_option from expected_memberships
       except select granted_role,member_role,admin_option,inherit_option,set_option from actual_memberships)
    )
    and not exists(select 1 from actual_memberships membership
      where not membership.grants_valid)
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
      from agent_bridge.owner_control_attestations where name='owner-control-v7')
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

select set_config(
  'role','agent_bridge_control_owner_'||substr(md5(current_database()),1,16),false
);
do $owner_attestation$
begin
  insert into agent_bridge.owner_control_attestations(name,catalog_definition)
  values('owner-control-v7',agent_bridge.owner_control_attestation_definition());
exception when others then
  raise exception 'managed authority compatibility owner attestation append failed: %',sqlerrm;
end
$owner_attestation$;
reset role;

do $archive_attestation$
begin
  insert into agent_bridge.portable_archive_attestations(name,catalog_definition)
  values('portable-archive-v4',agent_bridge.portable_archive_attestation_definition());
exception when others then
  raise exception 'managed authority compatibility archive attestation append failed: %',sqlerrm;
end
$archive_attestation$;

do $final_readiness$
begin
  if not agent_bridge.security_schema_ready() then
    raise exception 'managed authority compatibility final security readiness validation failed';
  elsif not agent_bridge.owner_control_plane_ready() then
    raise exception 'managed authority compatibility final owner readiness validation failed';
  elsif not agent_bridge.gateway_authority_ready() then
    raise exception 'managed authority compatibility final gateway readiness validation failed';
  elsif not agent_bridge.endpoint_migration_challenge_ready() then
    raise exception 'managed authority compatibility final endpoint readiness validation failed';
  elsif not agent_bridge.portable_archive_ready() then
    raise exception 'managed authority compatibility final archive readiness validation failed';
  end if;
exception when others then
  raise exception 'managed authority compatibility final readiness execution failed: %',sqlerrm;
end
$final_readiness$;

insert into agent_bridge.schema_migrations(version,name,checksum)
values(20,'managed_authority_compat','__AGENT_BRIDGE_MIGRATION_CHECKSUM__');

commit;
