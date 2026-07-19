begin;

select pg_advisory_xact_lock(1646705660);

do $preflight$
begin
  if not agent_bridge.security_schema_ready() then
    raise exception 'endpoint migration challenge preflight rejected security drift';
  elseif not agent_bridge.owner_control_plane_ready() then
    raise exception 'endpoint migration challenge preflight rejected owner control drift';
  elseif not agent_bridge.gateway_authority_ready() then
    raise exception 'endpoint migration challenge preflight rejected gateway authority drift';
  end if;
end
$preflight$;

alter table agent_bridge.request_authorities
  add column authorized_endpoint_migration_operation text;
alter table agent_bridge.request_authorities
  add constraint request_authorities_endpoint_migration_operation check (
    authorized_endpoint_migration_operation is null
    or authorized_endpoint_migration_operation in (
      'issue_endpoint_migration_challenge','consume_endpoint_migration_challenge'
    )
  );

alter table agent_bridge.rate_limit_policies
  drop constraint rate_limit_policy_operation;
alter table agent_bridge.rate_limit_policies
  add constraint rate_limit_policy_operation check (
    operation_id is null or operation_id in (
      'capabilities','status','gateway_metrics','publish_message','history',
      'record_receipt','claim_delivery','list_deliveries','list_delivery_events',
      'cancel_delivery','requeue_delivery','extend_delivery',
      'acknowledge_delivery','negative_acknowledge_delivery','heartbeat','presence',
      'issue_endpoint_migration_challenge','consume_endpoint_migration_challenge'
    )
  );

insert into agent_bridge.rate_limit_policies(policy_id,operation_id,capacity,refill_per_second,enabled)
values
  ('operation:issue_endpoint_migration_challenge','issue_endpoint_migration_challenge',30,1,true),
  ('operation:consume_endpoint_migration_challenge','consume_endpoint_migration_challenge',30,1,true);

create or replace function agent_bridge.record_scope_denial_unbound_011(
  requested_credential_id uuid,
  requested_operation_id text,
  requested_request_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  credential_workspace text;
  credential_principal text;
begin
  if requested_operation_id is null or requested_operation_id not in (
    'capabilities','status','gateway_metrics','publish_message','history',
    'record_receipt','claim_delivery','list_deliveries','list_delivery_events',
    'cancel_delivery','requeue_delivery','extend_delivery',
    'acknowledge_delivery','negative_acknowledge_delivery','heartbeat','presence',
    'issue_endpoint_migration_challenge','consume_endpoint_migration_challenge'
  ) then
    raise exception using errcode='55000', message='operation security policy is unavailable';
  end if;
  if not exists (
    select 1 from agent_bridge.rate_limit_policies
    where operation_id=requested_operation_id and enabled
  ) then
    raise exception using errcode='55000', message='operation security policy is unavailable';
  end if;
  select credential.workspace_id,agent.principal into credential_workspace,credential_principal
  from agent_bridge.credentials credential
  join agent_bridge.agents agent
    on agent.id=credential.agent_id and agent.workspace_id=credential.workspace_id
  where credential.id=requested_credential_id;
  if not found then raise exception 'credential is unavailable for security audit'; end if;
  insert into agent_bridge.security_events(
    event_type,outcome,reason_code,workspace_id,principal,actor_principal,
    credential_id,operation_id,request_id
  ) values (
    'scope_denied','denied','missing_scope',credential_workspace,
    credential_principal,credential_principal,requested_credential_id,
    requested_operation_id,requested_request_id
  );
end
$$;

create or replace function agent_bridge.consume_rate_limit_unbound_011(
  requested_credential_id uuid,
  requested_operation_id text,
  requested_request_id uuid
) returns table(
  allowed boolean,
  limit_value integer,
  remaining_value integer,
  retry_after_seconds numeric,
  denied_policy_id text
)
language plpgsql security definer set search_path = '' as $$
declare
  global_policy agent_bridge.rate_limit_policies%rowtype;
  operation_policy agent_bridge.rate_limit_policies%rowtype;
  request_time timestamptz := clock_timestamp();
  global_available numeric(30,6);
  operation_available numeric(30,6);
  global_after numeric(30,6);
  operation_after numeric(30,6);
  global_retry numeric(30,6) := 0;
  operation_retry numeric(30,6) := 0;
  credential_workspace text;
  credential_principal text;
begin
  if requested_operation_id is null or requested_operation_id not in (
    'capabilities','status','gateway_metrics','publish_message','history',
    'record_receipt','claim_delivery','list_deliveries','list_delivery_events',
    'cancel_delivery','requeue_delivery','extend_delivery',
    'acknowledge_delivery','negative_acknowledge_delivery','heartbeat','presence',
    'issue_endpoint_migration_challenge','consume_endpoint_migration_challenge'
  ) then
    raise exception using errcode='55000', message='operation rate limit policy is unavailable';
  end if;
  select * into global_policy from agent_bridge.rate_limit_policies
    where policy_id='global' and enabled for share;
  if not found then raise exception using errcode='55000', message='global rate limit policy is unavailable'; end if;
  select * into operation_policy from agent_bridge.rate_limit_policies
    where operation_id=requested_operation_id and enabled for share;
  if not found then raise exception using errcode='55000', message='operation rate limit policy is unavailable'; end if;

  insert into agent_bridge.rate_limit_buckets(credential_id,policy_id,tokens,updated_at)
  values
    (requested_credential_id,global_policy.policy_id,global_policy.capacity,request_time),
    (requested_credential_id,operation_policy.policy_id,operation_policy.capacity,request_time)
  on conflict do nothing;
  perform 1 from agent_bridge.rate_limit_buckets
  where credential_id=requested_credential_id
    and policy_id in (global_policy.policy_id,operation_policy.policy_id)
  order by policy_id for update;

  select least(global_policy.capacity::numeric,
    greatest(0::numeric,bucket.tokens)+greatest(0::numeric,
      extract(epoch from request_time-bucket.updated_at)::numeric)*global_policy.refill_per_second)
    into global_available
  from agent_bridge.rate_limit_buckets bucket
  where bucket.credential_id=requested_credential_id and bucket.policy_id=global_policy.policy_id;
  select least(operation_policy.capacity::numeric,
    greatest(0::numeric,bucket.tokens)+greatest(0::numeric,
      extract(epoch from request_time-bucket.updated_at)::numeric)*operation_policy.refill_per_second)
    into operation_available
  from agent_bridge.rate_limit_buckets bucket
  where bucket.credential_id=requested_credential_id and bucket.policy_id=operation_policy.policy_id;

  allowed := global_available>=1 and operation_available>=1;
  global_after := case when allowed then global_available-1 else global_available end;
  operation_after := case when allowed then operation_available-1 else operation_available end;
  update agent_bridge.rate_limit_buckets bucket set
    tokens=case when bucket.policy_id=global_policy.policy_id then global_after else operation_after end,
    updated_at=request_time
  where bucket.credential_id=requested_credential_id
    and bucket.policy_id in (global_policy.policy_id,operation_policy.policy_id);

  limit_value := least(global_policy.capacity,operation_policy.capacity);
  remaining_value := floor(least(global_after,operation_after))::integer;
  retry_after_seconds := 0;
  denied_policy_id := null;
  if not allowed then
    if global_available<1 then global_retry := (1-global_available)/global_policy.refill_per_second; end if;
    if operation_available<1 then operation_retry := (1-operation_available)/operation_policy.refill_per_second; end if;
    retry_after_seconds := greatest(global_retry,operation_retry);
    denied_policy_id := case when global_retry>=operation_retry then global_policy.policy_id else operation_policy.policy_id end;
    select credential.workspace_id,agent.principal into credential_workspace,credential_principal
    from agent_bridge.credentials credential
    join agent_bridge.agents agent on agent.id=credential.agent_id and agent.workspace_id=credential.workspace_id
    where credential.id=requested_credential_id;
    if not found then raise exception 'credential is unavailable for rate audit'; end if;
    insert into agent_bridge.security_events(
      event_type,outcome,reason_code,workspace_id,principal,actor_principal,
      credential_id,operation_id,request_id,policy_id,retry_after_seconds
    ) values (
      'rate_denied','denied','rate_limit_exceeded',credential_workspace,
      credential_principal,credential_principal,requested_credential_id,
      requested_operation_id,requested_request_id,denied_policy_id,
      greatest(1,ceil(retry_after_seconds)::integer)
    );
  end if;
  return next;
end
$$;

create or replace function agent_bridge.consume_rate_limit(
  requested_credential_id uuid,
  requested_operation_id text,
  requested_request_id uuid
) returns table(
  allowed boolean,
  limit_value integer,
  remaining_value integer,
  retry_after_seconds numeric,
  denied_policy_id text
)
language plpgsql security definer set search_path = '' as $$
declare
  authority agent_bridge.request_authorities%rowtype;
  decision record;
  stamped_operation text;
begin
  select * into authority from agent_bridge.assert_active_request_credential(requested_credential_id);
  select * into decision from agent_bridge.consume_rate_limit_unbound_011(
    requested_credential_id,requested_operation_id,requested_request_id
  );
  if decision.allowed and requested_operation_id in (
    'issue_endpoint_migration_challenge','consume_endpoint_migration_challenge'
  ) then
    update agent_bridge.request_authorities
      set authorized_endpoint_migration_operation=requested_operation_id
    where backend_pid=authority.backend_pid and transaction_id=authority.transaction_id
      and authorized_endpoint_migration_operation is null
    returning authorized_endpoint_migration_operation into stamped_operation;
    if not found then
      select authorized_endpoint_migration_operation into stamped_operation
      from agent_bridge.request_authorities
      where backend_pid=authority.backend_pid and transaction_id=authority.transaction_id;
      if stamped_operation is distinct from requested_operation_id then
        raise exception using errcode='42501',message='endpoint migration authorization is already bound to another operation';
      end if;
    end if;
  end if;
  allowed := decision.allowed;
  limit_value := decision.limit_value;
  remaining_value := decision.remaining_value;
  retry_after_seconds := decision.retry_after_seconds;
  denied_policy_id := decision.denied_policy_id;
  return next;
end
$$;

create table agent_bridge.endpoint_migration_challenges (
  challenge_hash char(64) primary key,
  authority_id uuid not null references agent_bridge.gateway_authority(authority_id) on delete restrict,
  workspace_id text not null references agent_bridge.workspaces(id) on delete restrict,
  principal text not null,
  issuer_credential_id uuid not null references agent_bridge.credentials(id) on delete restrict,
  verifier_credential_id uuid not null references agent_bridge.credentials(id) on delete restrict,
  issued_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_credential_id uuid references agent_bridge.credentials(id) on delete restrict,
  constraint endpoint_migration_challenges_expiry check(
    expires_at>issued_at and expires_at<=issued_at+interval '60 seconds'
  ),
  constraint endpoint_migration_challenges_consumption check(
    (consumed_at is null and consumed_credential_id is null)
    or (consumed_at is not null and consumed_credential_id=verifier_credential_id)
  )
);
create index endpoint_migration_challenges_cleanup
  on agent_bridge.endpoint_migration_challenges(expires_at);

create table agent_bridge.endpoint_migration_challenge_events (
  sequence bigint generated always as identity primary key,
  event_id uuid not null default gen_random_uuid() unique,
  request_id uuid not null unique,
  event_type text not null check(event_type in ('issued','consumed','expired')),
  outcome text not null check(outcome='succeeded'),
  authority_id uuid not null references agent_bridge.gateway_authority(authority_id) on delete restrict,
  workspace_id text not null references agent_bridge.workspaces(id) on delete restrict,
  principal text not null,
  issuer_credential_id uuid not null references agent_bridge.credentials(id) on delete restrict,
  verifier_credential_id uuid not null references agent_bridge.credentials(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp()
);
create index endpoint_migration_challenge_events_workspace_sequence
  on agent_bridge.endpoint_migration_challenge_events(workspace_id,sequence desc);

create function agent_bridge.reject_endpoint_migration_challenge_event_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'endpoint migration challenge events are append-only';
end
$$;
create trigger endpoint_migration_challenge_events_append_only
before update or delete or truncate on agent_bridge.endpoint_migration_challenge_events
for each statement execute function agent_bridge.reject_endpoint_migration_challenge_event_mutation();

create function agent_bridge.guard_endpoint_migration_challenge()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op='UPDATE' then
    if old.consumed_at is not null or new.consumed_at is null
      or new.consumed_credential_id is distinct from old.verifier_credential_id
      or new.challenge_hash is distinct from old.challenge_hash
      or new.authority_id is distinct from old.authority_id
      or new.workspace_id is distinct from old.workspace_id
      or new.principal is distinct from old.principal
      or new.issuer_credential_id is distinct from old.issuer_credential_id
      or new.verifier_credential_id is distinct from old.verifier_credential_id
      or new.issued_at is distinct from old.issued_at
      or new.expires_at is distinct from old.expires_at then
      raise exception 'endpoint migration challenge may only be consumed once';
    end if;
    return new;
  end if;
  if current_setting('agent_bridge.endpoint_migration_cleanup',true) is distinct from 'internal'
    or (old.expires_at>clock_timestamp() and old.consumed_at is null) then
    raise exception 'endpoint migration challenge deletion is restricted';
  end if;
  return old;
end
$$;
create trigger endpoint_migration_challenges_guard
before update or delete on agent_bridge.endpoint_migration_challenges
for each row execute function agent_bridge.guard_endpoint_migration_challenge();
create function agent_bridge.reject_endpoint_migration_challenge_truncate()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'endpoint migration challenge truncation is forbidden';
end
$$;
create trigger endpoint_migration_challenges_no_truncate
before truncate on agent_bridge.endpoint_migration_challenges
for each statement execute function agent_bridge.reject_endpoint_migration_challenge_truncate();

create function agent_bridge.cleanup_endpoint_migration_challenges()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  removed integer := 0;
  challenge record;
begin
  perform set_config('agent_bridge.endpoint_migration_cleanup','internal',true);
  for challenge in
    select challenge_hash,authority_id,workspace_id,principal,issuer_credential_id,verifier_credential_id
    from agent_bridge.endpoint_migration_challenges
    where expires_at<=clock_timestamp()
    order by expires_at,challenge_hash
    limit 100
    for update skip locked
  loop
    delete from agent_bridge.endpoint_migration_challenges where challenge_hash=challenge.challenge_hash;
    if challenge.authority_id is not null then
      insert into agent_bridge.endpoint_migration_challenge_events(
        request_id,event_type,outcome,authority_id,workspace_id,principal,
        issuer_credential_id,verifier_credential_id
      ) values (
        gen_random_uuid(),'expired','succeeded',challenge.authority_id,
        challenge.workspace_id,challenge.principal,challenge.issuer_credential_id,
        challenge.verifier_credential_id
      );
    end if;
    removed := removed+1;
  end loop;
  return removed;
end
$$;

create function agent_bridge.endpoint_migration_challenge_active_credential(
  requested_credential_id uuid,
  requested_workspace_id text,
  requested_principal text
) returns boolean language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from agent_bridge.credentials credential
    join agent_bridge.agents agent
      on agent.id=credential.agent_id and agent.workspace_id=credential.workspace_id
    where credential.id=requested_credential_id
      and credential.workspace_id=requested_workspace_id
      and agent.principal=requested_principal
      and credential.revoked_at is null
      and (credential.expires_at is null or credential.expires_at>clock_timestamp())
      and (not exists(select 1 from agent_bridge.credentials successor
        where successor.replaces_credential_id=credential.id)
        or credential.expiry_grace_until>clock_timestamp())
      and agent.disabled_at is null
  )
$$;

create function agent_bridge.endpoint_migration_challenge_direct_lineage(
  issuer_credential_id uuid,
  verifier_credential_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from agent_bridge.credentials credential
    where credential.id=verifier_credential_id
      and credential.replaces_credential_id=issuer_credential_id
  )
$$;

create function agent_bridge.issue_endpoint_migration_challenge(
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
  ) or not agent_bridge.endpoint_migration_challenge_direct_lineage(
    authority.credential_id,requested_verifier_credential_id
  ) then
    raise exception using errcode='28000',message='endpoint migration verifier is not an active direct replacement credential';
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

create function agent_bridge.consume_endpoint_migration_challenge(
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
    or not agent_bridge.endpoint_migration_challenge_direct_lineage(
      challenge.issuer_credential_id,authority.credential_id
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

create table agent_bridge.endpoint_migration_challenge_attestations (
  name text primary key,
  catalog_definition text not null,
  attested_at timestamptz not null default clock_timestamp(),
  constraint endpoint_migration_challenge_attestation_name check(name='endpoint-migration-v1')
);
create function agent_bridge.reject_endpoint_migration_challenge_attestation_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'endpoint migration challenge attestations are immutable';
end
$$;
create trigger endpoint_migration_challenge_attestations_append_only
before update or delete or truncate on agent_bridge.endpoint_migration_challenge_attestations
for each statement execute function agent_bridge.reject_endpoint_migration_challenge_attestation_mutation();

create function agent_bridge.endpoint_migration_challenge_catalog_definition()
returns text language sql stable security definer set search_path = '' as $$
  with protected_relations(relation_name) as (values
    ('endpoint_migration_challenges'),('endpoint_migration_challenge_events'),
    ('endpoint_migration_challenge_attestations'),('request_authorities')
  ), protected_functions(function_name) as (values
    ('guard_endpoint_migration_challenge'),('reject_endpoint_migration_challenge_truncate'),
    ('reject_endpoint_migration_challenge_event_mutation'),
    ('reject_endpoint_migration_challenge_attestation_mutation'),
    ('cleanup_endpoint_migration_challenges'),('endpoint_migration_challenge_active_credential'),
    ('endpoint_migration_challenge_direct_lineage'),('issue_endpoint_migration_challenge'),
    ('consume_endpoint_migration_challenge'),('endpoint_migration_challenge_catalog_definition'),
    ('endpoint_migration_challenge_ready')
  ), catalog(kind,identity,definition) as (
    select 'relation',relation.relname,pg_catalog.pg_get_userbyid(relation.relowner)||':'||
      relation.relkind::text||':'||relation.relpersistence::text||':'||relation.relrowsecurity::text||':'||relation.relforcerowsecurity::text
    from pg_catalog.pg_class relation join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='agent_bridge' and relation.relname in(select relation_name from protected_relations)
    union all
    select 'column',relation.relname||'.'||attribute.attname,pg_catalog.format_type(attribute.atttypid,attribute.atttypmod)||':'||
      attribute.attnotnull::text||':'||attribute.attidentity::text||':'||attribute.attgenerated::text||':'||
      coalesce(pg_catalog.pg_get_expr(default_record.adbin,default_record.adrelid),'')
    from pg_catalog.pg_attribute attribute join pg_catalog.pg_class relation on relation.oid=attribute.attrelid
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    left join pg_catalog.pg_attrdef default_record on default_record.adrelid=attribute.attrelid and default_record.adnum=attribute.attnum
    where namespace.nspname='agent_bridge' and relation.relname in(select relation_name from protected_relations)
      and attribute.attnum>0 and not attribute.attisdropped
    union all
    select 'constraint',relation.relname||'.'||constraint_record.conname,
      constraint_record.convalidated::text||':'||pg_catalog.pg_get_constraintdef(constraint_record.oid,true)
    from pg_catalog.pg_constraint constraint_record join pg_catalog.pg_class relation on relation.oid=constraint_record.conrelid
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='agent_bridge' and relation.relname in(select relation_name from protected_relations)
    union all
    select 'index',index_relation.relname,pg_catalog.pg_get_indexdef(index_record.indexrelid)||':'||
      coalesce(pg_catalog.pg_get_expr(index_record.indpred,index_record.indrelid),'')
    from pg_catalog.pg_index index_record join pg_catalog.pg_class source_relation on source_relation.oid=index_record.indrelid
    join pg_catalog.pg_class index_relation on index_relation.oid=index_record.indexrelid
    join pg_catalog.pg_namespace namespace on namespace.oid=source_relation.relnamespace
    where namespace.nspname='agent_bridge' and source_relation.relname in(select relation_name from protected_relations)
    union all
    select 'trigger',relation.relname||'.'||trigger.tgname,trigger.tgenabled::text||':'||pg_catalog.pg_get_triggerdef(trigger.oid,true)
    from pg_catalog.pg_trigger trigger join pg_catalog.pg_class relation on relation.oid=trigger.tgrelid
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='agent_bridge' and not trigger.tgisinternal
      and relation.relname in(select relation_name from protected_relations)
    union all
    select 'function',procedure.oid::regprocedure::text,pg_catalog.pg_get_userbyid(procedure.proowner)||':'||pg_catalog.pg_get_functiondef(procedure.oid)
    from pg_catalog.pg_proc procedure join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
    where namespace.nspname='agent_bridge' and procedure.proname in(select function_name from protected_functions)
    union all
    select 'function_acl',procedure.oid::regprocedure::text,
      pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
      case when privilege.grantee=0 then 'PUBLIC'
        else pg_catalog.pg_get_userbyid(privilege.grantee) end||':'||
      privilege.privilege_type||':'||privilege.is_grantable::text
    from pg_catalog.pg_proc procedure join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
    cross join lateral pg_catalog.aclexplode(coalesce(
      procedure.proacl,pg_catalog.acldefault('f',procedure.proowner)
    )) privilege
    where namespace.nspname='agent_bridge' and procedure.proname in(select function_name from protected_functions)
    union all
    select 'relation_acl',relation.relname,
      pg_catalog.pg_get_userbyid(privilege.grantor)||':'||
      case when privilege.grantee=0 then 'PUBLIC'
        else pg_catalog.pg_get_userbyid(privilege.grantee) end||':'||
      privilege.privilege_type||':'||privilege.is_grantable::text
    from pg_catalog.pg_class relation join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    cross join lateral pg_catalog.aclexplode(coalesce(
      relation.relacl,pg_catalog.acldefault(
        case when relation.relkind='S' then 'S'::"char" else 'r'::"char" end,
        relation.relowner
      )
    )) privilege
    where namespace.nspname='agent_bridge' and relation.relname in(select relation_name from protected_relations)
    union all
    select 'rate_policy',policy.policy_id,
      coalesce(policy.operation_id,'')||':'||policy.capacity::text||':'||
      policy.refill_per_second::text||':'||policy.enabled::text
    from agent_bridge.rate_limit_policies policy
    where policy.policy_id in (
      'operation:issue_endpoint_migration_challenge',
      'operation:consume_endpoint_migration_challenge'
    )
  ) select string_agg(kind||E'\x1f'||identity||E'\x1f'||definition,E'\x1e' order by kind,identity,definition) from catalog
$$;

create function agent_bridge.endpoint_migration_challenge_ready()
returns boolean language sql stable security definer set search_path = '' as $$
  with names as (
    select ('agent_bridge_runtime_'||substr(md5(current_database()),1,16))::name runtime_role
  ) select
    (select count(*)=1 and bool_and(catalog_definition=agent_bridge.endpoint_migration_challenge_catalog_definition())
      from agent_bridge.endpoint_migration_challenge_attestations where name='endpoint-migration-v1')
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

create or replace function agent_bridge.security_schema_ready()
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  runtime_role text := 'agent_bridge_runtime_'||substr(md5(current_database()),1,16);
begin
  return
    (select scopes=array[
      'deliveries:claim','deliveries:manage','deliveries:read','deliveries:settle',
      'gateway:metrics','messages:read','messages:write','presence:read',
      'presence:write','receipts:write','status:read'
    ]::text[] from agent_bridge.credential_scope_sets where name='release-a-full')
    and not exists(with expected(policy_id,operation_id,capacity,refill_per_second) as (values
      ('global',null::text,300,50::numeric),
      ('operation:capabilities','capabilities',30,1),('operation:status','status',30,1),
      ('operation:gateway_metrics','gateway_metrics',30,1),('operation:publish_message','publish_message',120,20),
      ('operation:history','history',120,20),('operation:record_receipt','record_receipt',120,20),
      ('operation:claim_delivery','claim_delivery',120,20),('operation:list_deliveries','list_deliveries',120,20),
      ('operation:list_delivery_events','list_delivery_events',120,20),('operation:cancel_delivery','cancel_delivery',60,10),
      ('operation:requeue_delivery','requeue_delivery',60,10),('operation:extend_delivery','extend_delivery',120,20),
      ('operation:acknowledge_delivery','acknowledge_delivery',120,20),('operation:negative_acknowledge_delivery','negative_acknowledge_delivery',120,20),
      ('operation:heartbeat','heartbeat',120,20),('operation:presence','presence',120,20),
      ('operation:issue_endpoint_migration_challenge','issue_endpoint_migration_challenge',30,1),
      ('operation:consume_endpoint_migration_challenge','consume_endpoint_migration_challenge',30,1)
    ) select 1 from expected left join agent_bridge.rate_limit_policies policy using(policy_id)
      where policy.policy_id is null or policy.operation_id is distinct from expected.operation_id
        or policy.capacity is distinct from expected.capacity or policy.refill_per_second is distinct from expected.refill_per_second
        or not policy.enabled)
    and (select count(*)=19 from agent_bridge.rate_limit_policies)
    and not exists (
      select 1 from (values
        ('security_events_append_only','agent_bridge.security_events'::regclass),
        ('credentials_validate_security','agent_bridge.credentials'::regclass),
        ('credentials_append_only','agent_bridge.credentials'::regclass),
        ('credential_scope_sets_immutable','agent_bridge.credential_scope_sets'::regclass)
      ) required(trigger_name,relation_id)
      left join pg_catalog.pg_trigger trigger on trigger.tgname=required.trigger_name
        and trigger.tgrelid=required.relation_id and not trigger.tgisinternal
      where trigger.oid is null or trigger.tgenabled<>'O'
    )
    and not exists (
      select 1 from (values
        ('agent_bridge.credentials'::regclass,'credentials_scopes_canonical'),
        ('agent_bridge.credentials'::regclass,'credentials_replacement_not_self'),
        ('agent_bridge.credentials'::regclass,'credentials_grace_shortens_expiry'),
        ('agent_bridge.credential_scope_sets'::regclass,'credential_scope_sets_scopes'),
        ('agent_bridge.security_events'::regclass,'security_events_type'),
        ('agent_bridge.security_events'::regclass,'security_events_outcome'),
        ('agent_bridge.security_events'::regclass,'security_events_reason'),
        ('agent_bridge.security_events'::regclass,'security_events_retry'),
        ('agent_bridge.security_events'::regclass,'security_events_actor'),
        ('agent_bridge.rate_limit_policies'::regclass,'rate_limit_policy_shape'),
        ('agent_bridge.rate_limit_policies'::regclass,'rate_limit_policy_operation'),
        ('agent_bridge.rate_limit_policies'::regclass,'rate_limit_policy_capacity'),
        ('agent_bridge.rate_limit_policies'::regclass,'rate_limit_policy_refill'),
        ('agent_bridge.rate_limit_buckets'::regclass,'rate_limit_buckets_tokens')
      ) required(relation_id,constraint_name)
      left join pg_catalog.pg_constraint constraint_record
        on constraint_record.conrelid=required.relation_id and constraint_record.conname=required.constraint_name
      where constraint_record.oid is null or not constraint_record.convalidated
    )
    and exists(select 1 from pg_catalog.pg_attribute attribute
      where attribute.attrelid='agent_bridge.credentials'::regclass and attribute.attname='scopes' and attribute.attnotnull)
    and pg_catalog.to_regclass('agent_bridge.credentials_replacement_lineage') is not null
    and pg_catalog.to_regclass('agent_bridge.rate_limit_buckets_cleanup') is not null
    and pg_catalog.to_regprocedure('agent_bridge.replace_credential(uuid,character,text[],text,text,timestamptz,timestamptz,text,uuid)') is not null
    and pg_catalog.to_regprocedure('agent_bridge.revoke_credential(uuid,text,text,uuid)') is not null
    and pg_catalog.to_regprocedure('agent_bridge.record_scope_denial_unbound_011(uuid,text,uuid)') is not null
    and pg_catalog.to_regprocedure('agent_bridge.consume_rate_limit_unbound_011(uuid,text,uuid)') is not null
    and pg_catalog.to_regprocedure('agent_bridge.consume_rate_limit(uuid,text,uuid)') is not null
    and pg_catalog.to_regprocedure('agent_bridge.endpoint_migration_challenge_ready()') is not null
    and (select count(*)=5 and bool_and(procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']::text[])
      from pg_catalog.pg_proc procedure where procedure.oid in (
        'agent_bridge.record_scope_denial(uuid,text,uuid)'::regprocedure,
        'agent_bridge.consume_rate_limit(uuid,text,uuid)'::regprocedure,
        'agent_bridge.replace_credential(uuid,character,text[],text,text,timestamptz,timestamptz,text,uuid)'::regprocedure,
        'agent_bridge.revoke_credential(uuid,text,text,uuid)'::regprocedure,
        'agent_bridge.security_schema_ready()'::regprocedure
      ))
    and not exists(select 1 from pg_catalog.pg_proc procedure
      cross join lateral pg_catalog.aclexplode(coalesce(procedure.proacl,pg_catalog.acldefault('f',procedure.proowner))) access
      where procedure.oid in (
        'agent_bridge.record_scope_denial(uuid,text,uuid)'::regprocedure,
        'agent_bridge.consume_rate_limit(uuid,text,uuid)'::regprocedure,
        'agent_bridge.replace_credential(uuid,character,text[],text,text,timestamptz,timestamptz,text,uuid)'::regprocedure,
        'agent_bridge.revoke_credential(uuid,text,text,uuid)'::regprocedure,
        'agent_bridge.security_schema_ready()'::regprocedure
      ) and access.grantee=0 and access.privilege_type='EXECUTE')
    and pg_catalog.has_function_privilege(runtime_role,'agent_bridge.record_scope_denial(uuid,text,uuid)','EXECUTE')
    and pg_catalog.has_function_privilege(runtime_role,'agent_bridge.consume_rate_limit(uuid,text,uuid)','EXECUTE')
    and pg_catalog.has_function_privilege(runtime_role,'agent_bridge.security_schema_ready()','EXECUTE')
    and not pg_catalog.has_function_privilege(runtime_role,'agent_bridge.replace_credential(uuid,character,text[],text,text,timestamptz,timestamptz,text,uuid)','EXECUTE')
    and not pg_catalog.has_function_privilege(runtime_role,'agent_bridge.revoke_credential(uuid,text,text,uuid)','EXECUTE')
    and not pg_catalog.has_table_privilege(runtime_role,'agent_bridge.credential_scope_sets','SELECT,INSERT,UPDATE,DELETE')
    and not pg_catalog.has_table_privilege(runtime_role,'agent_bridge.security_events','SELECT,INSERT,UPDATE,DELETE')
    and not pg_catalog.has_table_privilege(runtime_role,'agent_bridge.rate_limit_policies','SELECT,INSERT,UPDATE,DELETE')
    and not pg_catalog.has_table_privilege(runtime_role,'agent_bridge.rate_limit_buckets','SELECT,INSERT,UPDATE,DELETE')
    and agent_bridge.endpoint_migration_challenge_ready();
end
$$;

create or replace function agent_bridge.credential_security_prerequisite_definition()
returns text language sql stable set search_path = '' set timezone = 'UTC' as $$
  with dependency_relations(relation_name) as (values
    ('credentials'),('credential_scope_sets'),('security_events'),
    ('rate_limit_policies'),('rate_limit_buckets'),('endpoint_migration_challenges'),
    ('endpoint_migration_challenge_events'),('endpoint_migration_challenge_attestations')
  ), protected_functions(function_name) as (values
    ('canonicalize_scopes'),('validate_credential_security'),
    ('reject_credential_delete'),('reject_scope_set_mutation'),
    ('reject_security_event_mutation'),('record_scope_denial'),
    ('record_scope_denial_unbound_011'),('consume_rate_limit'),
    ('consume_rate_limit_unbound_011'),('replace_credential'),
    ('revoke_credential'),('security_schema_ready'),
    ('guard_endpoint_migration_challenge'),
    ('reject_endpoint_migration_challenge_truncate'),
    ('reject_endpoint_migration_challenge_event_mutation'),
    ('reject_endpoint_migration_challenge_attestation_mutation'),
    ('cleanup_endpoint_migration_challenges'),
    ('endpoint_migration_challenge_active_credential'),
    ('endpoint_migration_challenge_direct_lineage'),
    ('issue_endpoint_migration_challenge'),
    ('consume_endpoint_migration_challenge'),
    ('endpoint_migration_challenge_catalog_definition'),
    ('endpoint_migration_challenge_ready')
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
    union all
    select 'endpoint_catalog','v1',agent_bridge.endpoint_migration_challenge_catalog_definition()
  )
  select jsonb_agg(jsonb_build_object(
    'kind',kind,'identity',identity,'definition',definition
  ) order by kind,identity,definition)::text from catalog_objects
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
    select names.owner_role granted_role,names.schema_owner member_role,true admin_option from names
    union all select names.operator_role,names.schema_owner,true from names
    union all select names.auditor_role,names.schema_owner,true from names
    union all select case registry.control_role when 'operator' then names.operator_role else names.auditor_role end,
      registry.member_role,false from active_registry registry cross join names
  ), actual_memberships as (
    select granted.rolname::name granted_role,member.rolname::name member_role,membership.admin_option,
      coalesce((to_jsonb(membership)->>'inherit_option')::boolean,true) inherit_option,
      coalesce((to_jsonb(membership)->>'set_option')::boolean,true) set_option
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles granted on granted.oid=membership.roleid
    join pg_catalog.pg_roles member on member.oid=membership.member
    where granted.rolname in ((select owner_role from names),(select operator_role from names),(select auditor_role from names))
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
      from agent_bridge.owner_control_attestations where name='owner-control-v5')
    and not exists(
      (select granted_role,member_role,admin_option from actual_memberships except select granted_role,member_role,admin_option from expected_memberships)
      union all(select granted_role,member_role,admin_option from expected_memberships except select granted_role,member_role,admin_option from actual_memberships)
    )
    and not exists(select 1 from actual_memberships where not inherit_option or not set_option)
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

revoke all on agent_bridge.endpoint_migration_challenges,
  agent_bridge.endpoint_migration_challenge_events,
  agent_bridge.endpoint_migration_challenge_attestations from public;
revoke all on all sequences in schema agent_bridge from public;
revoke all on function agent_bridge.guard_endpoint_migration_challenge() from public;
revoke all on function agent_bridge.reject_endpoint_migration_challenge_truncate() from public;
revoke all on function agent_bridge.reject_endpoint_migration_challenge_event_mutation() from public;
revoke all on function agent_bridge.reject_endpoint_migration_challenge_attestation_mutation() from public;
revoke all on function agent_bridge.cleanup_endpoint_migration_challenges() from public;
revoke all on function agent_bridge.endpoint_migration_challenge_active_credential(uuid,text,text) from public;
revoke all on function agent_bridge.endpoint_migration_challenge_direct_lineage(uuid,uuid) from public;
revoke all on function agent_bridge.endpoint_migration_challenge_catalog_definition() from public;
revoke all on function agent_bridge.endpoint_migration_challenge_ready() from public;
revoke all on function agent_bridge.issue_endpoint_migration_challenge(uuid,uuid,text) from public;
revoke all on function agent_bridge.consume_endpoint_migration_challenge(uuid,uuid,text) from public;

do $ownership_and_grants$
declare
  runtime_role text := 'agent_bridge_runtime_'||substr(md5(current_database()),1,16);
  control_owner text := 'agent_bridge_control_owner_'||substr(md5(current_database()),1,16);
  role_name text;
begin
  execute format('alter function agent_bridge.owner_control_plane_ready() owner to %I',control_owner);
  foreach role_name in array array[
    'guard_endpoint_migration_challenge()',
    'reject_endpoint_migration_challenge_truncate()',
    'reject_endpoint_migration_challenge_event_mutation()',
    'reject_endpoint_migration_challenge_attestation_mutation()',
    'cleanup_endpoint_migration_challenges()',
    'endpoint_migration_challenge_active_credential(uuid,text,text)',
    'endpoint_migration_challenge_direct_lineage(uuid,uuid)',
    'endpoint_migration_challenge_catalog_definition()',
    'endpoint_migration_challenge_ready()',
    'issue_endpoint_migration_challenge(uuid,uuid,text)',
    'consume_endpoint_migration_challenge(uuid,uuid,text)'
  ] loop
    execute format('alter function agent_bridge.%s owner to %I',role_name,current_user);
  end loop;
  foreach role_name in array array[runtime_role,'anon','authenticated'] loop
    if exists(select 1 from pg_catalog.pg_roles where rolname=role_name) then
      execute format('revoke all on agent_bridge.endpoint_migration_challenges,agent_bridge.endpoint_migration_challenge_events,agent_bridge.endpoint_migration_challenge_attestations from %I',role_name);
      execute format('revoke all on function agent_bridge.issue_endpoint_migration_challenge(uuid,uuid,text) from %I',role_name);
      execute format('revoke all on function agent_bridge.consume_endpoint_migration_challenge(uuid,uuid,text) from %I',role_name);
      execute format('revoke all on function agent_bridge.cleanup_endpoint_migration_challenges() from %I',role_name);
      execute format('revoke all on function agent_bridge.endpoint_migration_challenge_catalog_definition() from %I',role_name);
      execute format('revoke all on function agent_bridge.endpoint_migration_challenge_ready() from %I',role_name);
    end if;
  end loop;
  execute format('revoke all on agent_bridge.request_authorities from %I',runtime_role);
  execute format('grant execute on function agent_bridge.issue_endpoint_migration_challenge(uuid,uuid,text) to %I',runtime_role);
  execute format('grant execute on function agent_bridge.consume_endpoint_migration_challenge(uuid,uuid,text) to %I',runtime_role);
  execute format('grant execute on function agent_bridge.endpoint_migration_challenge_catalog_definition() to %I',control_owner);
  execute format('grant execute on function agent_bridge.owner_control_plane_ready() to %I',runtime_role);
end
$ownership_and_grants$;

insert into agent_bridge.endpoint_migration_challenge_attestations(name,catalog_definition)
values('endpoint-migration-v1',agent_bridge.endpoint_migration_challenge_catalog_definition());
insert into agent_bridge.owner_control_attestations(name,catalog_definition)
values('owner-control-v5',agent_bridge.owner_control_attestation_definition());

do $final_readiness$
begin
  if not agent_bridge.security_schema_ready() then
    raise exception 'endpoint migration challenge final security readiness validation failed';
  elseif not agent_bridge.owner_control_plane_ready() then
    raise exception 'endpoint migration challenge final owner readiness validation failed';
  elseif not agent_bridge.gateway_authority_ready() then
    raise exception 'endpoint migration challenge final gateway authority readiness validation failed';
  elseif not agent_bridge.endpoint_migration_challenge_ready() then
    raise exception 'endpoint migration challenge final endpoint readiness validation failed';
  elseif not agent_bridge.portable_archive_ready() then
    raise exception 'endpoint migration challenge final portable archive readiness validation failed';
  end if;
end
$final_readiness$;

insert into agent_bridge.schema_migrations(version,name,checksum)
values(18,'endpoint_migration_challenges','__AGENT_BRIDGE_MIGRATION_CHECKSUM__');

commit;
