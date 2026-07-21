begin;

select pg_advisory_xact_lock(1646705660);

do $preflight$
begin
  if not agent_bridge.security_schema_ready() then
    raise exception 'native backup reader security readiness validation failed';
  elsif not agent_bridge.owner_control_plane_ready() then
    raise exception 'native backup reader owner readiness validation failed';
  elsif not agent_bridge.gateway_authority_ready() then
    raise exception 'native backup reader gateway readiness validation failed';
  elsif not agent_bridge.endpoint_migration_challenge_ready() then
    raise exception 'native backup reader endpoint readiness validation failed';
  elsif not agent_bridge.portable_archive_ready() then
    raise exception 'native backup reader archive readiness validation failed';
  elsif not exists(select 1 from agent_bridge.row_isolation_attestations attestation
    where attestation.name='domain-v1'
      and attestation.catalog_definition=agent_bridge.row_isolation_catalog_definition()) then
    raise exception 'native backup reader row-isolation attestation validation failed';
  elsif (select nspowner<>current_user::regrole::oid from pg_catalog.pg_namespace
    where nspname='agent_bridge') then
    raise exception 'native backup reader migration authority must own the Agent Bridge schema';
  end if;
end
$preflight$;

do $role$
declare
  backup_role text := 'agent_bridge_backup_reader_'||substr(md5(current_database()),1,16);
begin
  if exists(select 1 from pg_catalog.pg_roles where rolname=backup_role) then
    raise exception 'reserved Agent Bridge native backup role already exists';
  end if;
  execute format(
    'create role %I nologin inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls',
    backup_role
  );
  if current_setting('server_version_num')::integer>=160000 and not exists(
    select 1 from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    where granted.rolname=backup_role and member.rolname=current_user
      and membership.admin_option
  ) then
    execute format(
      'grant %I to %I with admin true,inherit true,set true',backup_role,current_user
    );
  elsif current_setting('server_version_num')::integer>=160000 and not exists(
    select 1 from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    where granted.rolname=backup_role and member.rolname=current_user
      and coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true)
      and coalesce((to_jsonb(membership)->>'set_option')::boolean,true)
  ) then
    execute format(
      'grant %I to %I with admin false,inherit true,set true',backup_role,current_user
    );
  else
    if current_setting('server_version_num')::integer<160000 then
      execute format('grant %I to %I with admin option',backup_role,current_user);
    end if;
  end if;
end
$role$;

create table agent_bridge.native_backup_attestations (
  name text primary key,
  catalog_definition text not null,
  attested_at timestamptz not null default now(),
  constraint native_backup_attestation_name check(name='native-backup-v1')
);

create function agent_bridge.reject_native_backup_attestation_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'native backup attestations are append-only';
end
$$;

create trigger native_backup_attestations_append_only
before update or delete on agent_bridge.native_backup_attestations
for each row execute function agent_bridge.reject_native_backup_attestation_mutation();

create trigger native_backup_attestations_no_truncate
before truncate on agent_bridge.native_backup_attestations
for each statement execute function agent_bridge.reject_native_backup_attestation_mutation();

do $grants$
declare
  backup_role text := 'agent_bridge_backup_reader_'||substr(md5(current_database()),1,16);
begin
  execute format('revoke all on schema agent_bridge from %I',backup_role);
  execute format('revoke all on all tables in schema agent_bridge from %I',backup_role);
  execute format('revoke all on all sequences in schema agent_bridge from %I',backup_role);
  execute format('revoke execute on all functions in schema agent_bridge from %I',backup_role);
  execute format('grant usage on schema agent_bridge to %I',backup_role);
  execute format('grant select on all tables in schema agent_bridge to %I',backup_role);
  execute format('grant select on all sequences in schema agent_bridge to %I',backup_role);
end
$grants$;

create function agent_bridge.native_backup_catalog_definition()
returns text language sql stable set search_path = '' as $$
  with names as (select
    ('agent_bridge_backup_reader_'||substr(md5(current_database()),1,16))::name backup_role,
    (select nspowner from pg_catalog.pg_namespace where nspname='agent_bridge') schema_owner
  ), catalog_objects(kind,identity,definition) as (
    select 'role',role.rolname,
      role.rolcanlogin::text||':'||role.rolinherit::text||':'||role.rolsuper::text||':'||
      role.rolcreatedb::text||':'||role.rolcreaterole::text||':'||
      role.rolreplication::text||':'||role.rolbypassrls::text||':'||role.rolconnlimit::text
    from pg_catalog.pg_roles role where role.rolname=(select backup_role from names)
    union all
    select 'membership',granted.rolname||'->'||member.rolname,
      bool_or(membership.admin_option)::text||':'||
      bool_or(coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true))::text||':'||
      bool_or(coalesce((to_jsonb(membership)->>'set_option')::boolean,true))::text
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    where membership.roleid=(select oid from pg_catalog.pg_roles
      where rolname=(select backup_role from names))
      or membership.member=(select oid from pg_catalog.pg_roles
        where rolname=(select backup_role from names))
    group by granted.rolname,member.rolname
    union all
    select 'schema_acl','agent_bridge',
      pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
      privilege.privilege_type||':'||privilege.is_grantable::text
    from pg_catalog.pg_namespace namespace
    cross join lateral pg_catalog.aclexplode(coalesce(namespace.nspacl,
      pg_catalog.acldefault('n',namespace.nspowner))) privilege
    where namespace.nspname='agent_bridge'
      and privilege.grantee=(select oid from pg_catalog.pg_roles
        where rolname=(select backup_role from names))
    union all
    select 'relation',relation.oid::regclass::text,
      relation.relkind::text||':'||pg_catalog.pg_get_userbyid(relation.relowner)||':'||
      coalesce(string_agg(privilege.privilege_type||':'||privilege.is_grantable::text,','
        order by privilege.privilege_type),'missing')
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    left join lateral pg_catalog.aclexplode(coalesce(relation.relacl,
      pg_catalog.acldefault(case when relation.relkind='S' then 'S'::"char" else 'r'::"char" end,
        relation.relowner))) privilege on privilege.grantee=(select oid from pg_catalog.pg_roles
          where rolname=(select backup_role from names))
    where namespace.nspname='agent_bridge' and relation.relkind in ('r','p','v','m','f','S')
    group by relation.oid,relation.relkind,relation.relowner
    union all
    select 'function',procedure.oid::regprocedure::text,
      pg_catalog.pg_get_userbyid(procedure.proowner)||':'||procedure.prosecdef::text||':'||
      procedure.provolatile::text||':'||coalesce(array_to_string(procedure.proconfig,','),'')||':'||
      pg_catalog.pg_get_functiondef(procedure.oid)
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
    where namespace.nspname='agent_bridge' and procedure.proname in (
      'reject_native_backup_attestation_mutation','native_backup_catalog_definition',
      'native_backup_ready'
    )
    union all
    select 'trigger',trigger.tgrelid::regclass::text||'.'||trigger.tgname,
      trigger.tgenabled::text||':'||pg_catalog.pg_get_triggerdef(trigger.oid,true)
    from pg_catalog.pg_trigger trigger
    where trigger.tgrelid='agent_bridge.native_backup_attestations'::regclass
      and not trigger.tgisinternal
  )
  select string_agg(kind||E'\x1f'||identity||E'\x1f'||definition,E'\x1e'
    order by kind,identity,definition) from catalog_objects
$$;

create function agent_bridge.native_backup_ready()
returns boolean language sql stable security definer set search_path = '' as $$
  with names as (select
    ('agent_bridge_backup_reader_'||substr(md5(current_database()),1,16))::name backup_role,
    ('agent_bridge_runtime_'||substr(md5(current_database()),1,16))::name runtime_role,
    (select nspowner from pg_catalog.pg_namespace where nspname='agent_bridge') schema_owner
  ), semantic_membership as (
    select count(distinct member.oid)=1
        and bool_and(member.oid=(select schema_owner from names))
        and bool_or(membership.admin_option)
        and bool_or(coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true))
        and bool_or(coalesce((to_jsonb(membership)->>'set_option')::boolean,true)) ready
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    where granted.rolname=(select backup_role from names)
  ), raw_membership as (
    select count(*)::integer row_count,
      count(*) filter(where membership.grantor=10 and membership.admin_option
        and not coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true)
        and not coalesce((to_jsonb(membership)->>'set_option')::boolean,true)) bootstrap_admin,
      count(*) filter(where membership.grantor=member.oid and not membership.admin_option
        and coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true)
        and coalesce((to_jsonb(membership)->>'set_option')::boolean,true)) self_inherit,
      count(*) filter(where membership.admin_option
        and coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true)
        and coalesce((to_jsonb(membership)->>'set_option')::boolean,true)
        and membership.grantor in (10,member.oid)) combined
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    where granted.rolname=(select backup_role from names)
      and member.oid=(select schema_owner from names)
  )
  select
    exists(select 1 from pg_catalog.pg_roles role,names where role.rolname=names.backup_role
      and not role.rolcanlogin and role.rolinherit and not role.rolsuper
      and not role.rolcreatedb and not role.rolcreaterole and not role.rolreplication
      and not role.rolbypassrls and role.rolconnlimit=-1)
    and exists(select 1 from pg_catalog.pg_roles role,names
      where (role.oid=names.schema_owner and (role.rolsuper or role.rolbypassrls))
         or (role.rolname=session_user and role.rolsuper))
    and (select ready from semantic_membership)
    and (select case when current_setting('server_version_num')::integer<160000
      then row_count=1 and combined=1
      else (row_count=1 and combined=1)
        or (row_count=2 and bootstrap_admin=1 and self_inherit=1)
      end from raw_membership)
    and not exists(
      select 1 from pg_catalog.pg_auth_members membership
      join pg_catalog.pg_roles member on member.oid=membership.member
      cross join names
      where membership.roleid=(select oid from pg_catalog.pg_roles
          where rolname=names.backup_role) and (
        member.oid<>names.schema_owner or not (
          (membership.grantor=10 and membership.admin_option
            and coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true)
              =coalesce((to_jsonb(membership)->>'set_option')::boolean,true))
          or (membership.grantor=member.oid
            and coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true)
            and coalesce((to_jsonb(membership)->>'set_option')::boolean,true))
        )
      )
    )
    and not exists(
      select 1 from pg_catalog.pg_auth_members membership
      cross join names
      where membership.member=(select oid from pg_catalog.pg_roles
        where rolname=names.backup_role)
    )
    and has_schema_privilege((select backup_role from names),'agent_bridge','USAGE')
    and not has_schema_privilege((select backup_role from names),'agent_bridge','CREATE')
    and not exists(
      select 1 from pg_catalog.pg_namespace namespace,names
      cross join lateral pg_catalog.aclexplode(coalesce(namespace.nspacl,
        pg_catalog.acldefault('n',namespace.nspowner))) privilege
      where namespace.nspname='agent_bridge'
        and privilege.grantee=(select oid from pg_catalog.pg_roles where rolname=names.backup_role)
        and (privilege.privilege_type<>'USAGE' or privilege.is_grantable)
    )
    and not exists(
      select 1 from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace,names
      where namespace.nspname='agent_bridge' and relation.relkind in ('r','p','v','m','f','S')
        and not case when relation.relkind='S'
          then has_sequence_privilege(names.backup_role,relation.oid,'SELECT')
            and not has_sequence_privilege(names.backup_role,relation.oid,'USAGE,UPDATE')
          else has_table_privilege(names.backup_role,relation.oid,'SELECT')
            and not has_table_privilege(names.backup_role,relation.oid,
              'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        end
    )
    and not exists(
      select 1 from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace,names
      cross join lateral pg_catalog.aclexplode(coalesce(relation.relacl,
        pg_catalog.acldefault(case when relation.relkind='S' then 'S'::"char" else 'r'::"char" end,
          relation.relowner))) privilege
      where namespace.nspname='agent_bridge' and relation.relkind in ('r','p','v','m','f','S')
        and privilege.grantee=(select oid from pg_catalog.pg_roles where rolname=names.backup_role)
        and (privilege.privilege_type<>'SELECT' or privilege.is_grantable)
    )
    and not exists(
      select 1 from pg_catalog.pg_attribute attribute
      join pg_catalog.pg_class relation on relation.oid=attribute.attrelid
      join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace,names
      cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
      where namespace.nspname='agent_bridge' and attribute.attnum>0 and not attribute.attisdropped
        and privilege.grantee=(select oid from pg_catalog.pg_roles where rolname=names.backup_role)
    )
    and not exists(
      select 1 from pg_catalog.pg_proc procedure
      join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace,names
      where namespace.nspname='agent_bridge'
        and has_function_privilege(names.backup_role,procedure.oid,'EXECUTE')
    )
    and (select count(*)=3 and bool_and(
      procedure.proowner=(select schema_owner from names)
      and procedure.proconfig @> array['search_path=""']::text[]
      and case procedure.proname when 'native_backup_ready' then procedure.prosecdef
        else not procedure.prosecdef end
      and case procedure.proname when 'reject_native_backup_attestation_mutation'
        then procedure.provolatile='v' else procedure.provolatile='s' end
    ) from pg_catalog.pg_proc procedure
      join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
      where namespace.nspname='agent_bridge' and procedure.proname in (
        'reject_native_backup_attestation_mutation','native_backup_catalog_definition',
        'native_backup_ready'))
    and has_function_privilege((select runtime_role from names),
      'agent_bridge.native_backup_ready()','EXECUTE')
    and not has_function_privilege('public','agent_bridge.native_backup_ready()','EXECUTE')
    and not has_function_privilege((select backup_role from names),
      'agent_bridge.native_backup_ready()','EXECUTE')
    and not exists(select 1 from pg_catalog.pg_proc procedure,names
      where procedure.oid in (
        'agent_bridge.reject_native_backup_attestation_mutation()'::regprocedure,
        'agent_bridge.native_backup_catalog_definition()'::regprocedure
      ) and (has_function_privilege(names.runtime_role,procedure.oid,'EXECUTE')
        or has_function_privilege('public',procedure.oid,'EXECUTE')
        or has_function_privilege(names.backup_role,procedure.oid,'EXECUTE')))
    and (select count(*)=2 and bool_and(trigger.tgenabled='O')
      from pg_catalog.pg_trigger trigger
      where trigger.tgrelid='agent_bridge.native_backup_attestations'::regclass
        and trigger.tgname in ('native_backup_attestations_append_only',
          'native_backup_attestations_no_truncate') and not trigger.tgisinternal)
    and (select count(*)=1 and bool_and(
      attestation.catalog_definition=agent_bridge.native_backup_catalog_definition())
      from agent_bridge.native_backup_attestations attestation
      where attestation.name='native-backup-v1')
$$;

revoke all on function agent_bridge.reject_native_backup_attestation_mutation() from public;
revoke all on function agent_bridge.native_backup_catalog_definition() from public;
revoke all on function agent_bridge.native_backup_ready() from public;

do $function_grants$
declare
  runtime_role text := 'agent_bridge_runtime_'||substr(md5(current_database()),1,16);
  backup_role text := 'agent_bridge_backup_reader_'||substr(md5(current_database()),1,16);
begin
  execute format('revoke execute on function agent_bridge.reject_native_backup_attestation_mutation() from %I,%I',runtime_role,backup_role);
  execute format('revoke execute on function agent_bridge.native_backup_catalog_definition() from %I,%I',runtime_role,backup_role);
  execute format('revoke execute on function agent_bridge.native_backup_ready() from %I',backup_role);
  execute format('grant execute on function agent_bridge.native_backup_ready() to %I',runtime_role);
end
$function_grants$;

do $readiness_versions$
declare
  owner_definition text;
  archive_definition text;
  endpoint_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'agent_bridge.owner_control_plane_ready()'::regprocedure
  ) into owner_definition;
  if owner_definition not like '%owner-control-v7%' then
    raise exception 'owner readiness contract is not the migration 020 definition';
  end if;
  execute replace(owner_definition,'owner-control-v7','owner-control-v8');

  select pg_catalog.pg_get_functiondef(
    'agent_bridge.portable_archive_ready()'::regprocedure
  ) into archive_definition;
  if archive_definition not like '%portable-archive-v4%' then
    raise exception 'archive readiness contract is not the migration 020 definition';
  end if;
  execute replace(archive_definition,'portable-archive-v4','portable-archive-v5');

  select pg_catalog.pg_get_functiondef(
    'agent_bridge.endpoint_migration_challenge_ready()'::regprocedure
  ) into endpoint_definition;
  if endpoint_definition not like '%endpoint-migration-v2%' then
    raise exception 'endpoint readiness contract is not the migration 019 definition';
  end if;
  execute replace(endpoint_definition,'endpoint-migration-v2','endpoint-migration-v3');
end
$readiness_versions$;

alter table agent_bridge.endpoint_migration_challenge_attestations
  drop constraint endpoint_migration_challenge_attestation_name;
alter table agent_bridge.endpoint_migration_challenge_attestations
  add constraint endpoint_migration_challenge_attestation_name
  check(name in ('endpoint-migration-v1','endpoint-migration-v2','endpoint-migration-v3'));

select set_config(
  'role','agent_bridge_control_owner_'||substr(md5(current_database()),1,16),false
);
insert into agent_bridge.owner_control_attestations(name,catalog_definition)
values('owner-control-v8',agent_bridge.owner_control_attestation_definition());
reset role;

insert into agent_bridge.portable_archive_attestations(name,catalog_definition)
values('portable-archive-v5',agent_bridge.portable_archive_attestation_definition());

insert into agent_bridge.endpoint_migration_challenge_attestations(name,catalog_definition)
values('endpoint-migration-v3',agent_bridge.endpoint_migration_challenge_catalog_definition());

insert into agent_bridge.native_backup_attestations(name,catalog_definition)
values('native-backup-v1',agent_bridge.native_backup_catalog_definition());

do $final_readiness$
begin
  if not agent_bridge.security_schema_ready() then
    raise exception 'native backup reader final security readiness validation failed';
  elsif not agent_bridge.owner_control_plane_ready() then
    raise exception 'native backup reader final owner readiness validation failed';
  elsif not agent_bridge.gateway_authority_ready() then
    raise exception 'native backup reader final gateway readiness validation failed';
  elsif not agent_bridge.endpoint_migration_challenge_ready() then
    raise exception 'native backup reader final endpoint readiness validation failed';
  elsif not agent_bridge.portable_archive_ready() then
    raise exception 'native backup reader final archive readiness validation failed';
  elsif not exists(select 1 from agent_bridge.row_isolation_attestations attestation
    where attestation.name='domain-v1'
      and attestation.catalog_definition=agent_bridge.row_isolation_catalog_definition()) then
    raise exception 'native backup reader final row-isolation attestation validation failed';
  elsif not agent_bridge.native_backup_ready() then
    raise exception 'native backup reader final readiness validation failed';
  end if;
exception when others then
  raise exception 'native backup reader final validation failed: %',sqlerrm;
end
$final_readiness$;

insert into agent_bridge.schema_migrations(version,name,checksum)
values(21,'native_backup_reader','__AGENT_BRIDGE_MIGRATION_CHECKSUM__');

commit;
