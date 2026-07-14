begin;

select pg_advisory_xact_lock(1646705660);

create or replace function agent_bridge.canonicalize_scopes(requested_scopes text[])
returns text[]
language sql immutable strict parallel safe set search_path = '' as $$
  select coalesce(array_agg(scope order by scope), '{}'::text[])
  from (select distinct unnest(requested_scopes) as scope) canonical
$$;

create table if not exists agent_bridge.credential_scope_sets (
  name text primary key,
  scopes text[] not null,
  created_at timestamptz not null default now(),
  constraint credential_scope_sets_name check (name ~ '^[a-z][a-z0-9-]{0,63}$'),
  constraint credential_scope_sets_scopes check (
    scopes = agent_bridge.canonicalize_scopes(scopes)
    and scopes <@ array[
      'deliveries:claim','deliveries:manage','deliveries:read','deliveries:settle',
      'gateway:metrics','messages:read','messages:write','presence:read',
      'presence:write','receipts:write','status:read'
    ]::text[]
  )
);

insert into agent_bridge.credential_scope_sets (name, scopes) values
  ('release-a-full', array[
    'deliveries:claim','deliveries:manage','deliveries:read','deliveries:settle',
    'gateway:metrics','messages:read','messages:write','presence:read',
    'presence:write','receipts:write','status:read'
  ]::text[])
on conflict (name) do nothing;

do $scope_seed$
begin
  if not exists (
    select 1 from agent_bridge.credential_scope_sets
    where name='release-a-full' and scopes=array[
      'deliveries:claim','deliveries:manage','deliveries:read','deliveries:settle',
      'gateway:metrics','messages:read','messages:write','presence:read',
      'presence:write','receipts:write','status:read'
    ]::text[]
  ) then
    raise exception 'credential scope seed conflicts with required state';
  end if;
end
$scope_seed$;

alter table agent_bridge.credentials
  add column if not exists scopes text[],
  add column if not exists scope_set_name text references agent_bridge.credential_scope_sets(name),
  add column if not exists replaces_credential_id uuid references agent_bridge.credentials(id),
  add column if not exists revoked_by text,
  add column if not exists revocation_reason text,
  add column if not exists expiry_grace_until timestamptz;

update agent_bridge.credentials
set scopes = array[
      'deliveries:claim','deliveries:manage','deliveries:read','deliveries:settle',
      'gateway:metrics','messages:read','messages:write','presence:read',
      'presence:write','receipts:write','status:read'
    ]::text[],
    scope_set_name = 'release-a-full'
where scopes is null;

alter table agent_bridge.credentials
  alter column scopes set default array[
    'deliveries:claim','deliveries:manage','deliveries:read','deliveries:settle',
    'gateway:metrics','messages:read','messages:write','presence:read',
    'presence:write','receipts:write','status:read'
  ]::text[],
  alter column scopes set not null;

do $credential_constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='agent_bridge.credentials'::regclass
      and conname='credentials_scopes_canonical'
  ) then
    alter table agent_bridge.credentials add constraint credentials_scopes_canonical check (
      scopes = agent_bridge.canonicalize_scopes(scopes)
      and scopes <@ array[
        'deliveries:claim','deliveries:manage','deliveries:read','deliveries:settle',
        'gateway:metrics','messages:read','messages:write','presence:read',
        'presence:write','receipts:write','status:read'
      ]::text[]
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid='agent_bridge.credentials'::regclass
      and conname='credentials_replacement_not_self'
  ) then
    alter table agent_bridge.credentials add constraint credentials_replacement_not_self
      check (replaces_credential_id is distinct from id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid='agent_bridge.credentials'::regclass
      and conname='credentials_grace_shortens_expiry'
  ) then
    alter table agent_bridge.credentials add constraint credentials_grace_shortens_expiry check (
      expiry_grace_until is null or expires_at is null or expiry_grace_until <= expires_at
    );
  end if;
end
$credential_constraints$;

create unique index if not exists credentials_replacement_lineage
  on agent_bridge.credentials(replaces_credential_id)
  where replaces_credential_id is not null;

create or replace function agent_bridge.validate_credential_security()
returns trigger
language plpgsql set search_path = '' as $$
declare
  predecessor agent_bridge.credentials%rowtype;
  profile_scopes text[];
begin
  if tg_op='UPDATE' then
    if old.id is distinct from new.id
      or old.workspace_id is distinct from new.workspace_id
      or old.agent_id is distinct from new.agent_id
      or old.token_hash is distinct from new.token_hash then
      raise exception 'credential identity is immutable';
    end if;
    if old.replaces_credential_id is distinct from new.replaces_credential_id then
      raise exception 'credential replacement lineage is immutable';
    end if;
    if old.revoked_at is not null and (
      old.revoked_at is distinct from new.revoked_at
      or old.revoked_by is distinct from new.revoked_by
      or old.revocation_reason is distinct from new.revocation_reason
    ) then
      raise exception 'credential revocation is immutable';
    end if;
    if old.revoked_at is null and new.revoked_at is not null
      and coalesce(current_setting('agent_bridge.lifecycle_authorized',true),'') <> 'revocation' then
      raise exception 'credential revocation requires the lifecycle function';
    end if;
    if (
      old.revoked_by is distinct from new.revoked_by
      or old.revocation_reason is distinct from new.revocation_reason
    ) and coalesce(current_setting('agent_bridge.lifecycle_authorized',true),'') <> 'revocation' then
      raise exception 'credential revocation metadata requires the lifecycle function';
    end if;
    if old.expiry_grace_until is distinct from new.expiry_grace_until
      and coalesce(current_setting('agent_bridge.lifecycle_authorized',true),'') <> 'replacement' then
      raise exception 'credential grace requires the lifecycle function';
    end if;
    if old.expiry_grace_until is not null and (
      new.expiry_grace_until is null
      or new.expiry_grace_until > old.expiry_grace_until
    ) then
      raise exception 'credential grace may only move earlier';
    end if;
  end if;

  if new.scope_set_name is not null then
    select scopes into profile_scopes
    from agent_bridge.credential_scope_sets
    where name=new.scope_set_name;
    if not found or profile_scopes is distinct from new.scopes then
      raise exception 'credential scopes do not match the named scope set';
    end if;
  end if;

  if new.replaces_credential_id is not null then
    select * into predecessor
    from agent_bridge.credentials
    where id=new.replaces_credential_id;
    if not found
      or predecessor.workspace_id is distinct from new.workspace_id
      or predecessor.agent_id is distinct from new.agent_id then
      raise exception 'replacement credentials must use the same workspace and agent';
    end if;
    if exists (
      with recursive ancestry(id, replaces_credential_id) as (
        select id, replaces_credential_id from agent_bridge.credentials
        where id=new.replaces_credential_id
        union all
        select credential.id, credential.replaces_credential_id
        from agent_bridge.credentials credential
        join ancestry on credential.id=ancestry.replaces_credential_id
      )
      select 1 from ancestry where id=new.id
    ) then
      raise exception 'credential replacement cycle is not allowed';
    end if;
    if tg_op='INSERT'
      and coalesce(current_setting('agent_bridge.lifecycle_authorized',true),'') <> 'replacement' then
      raise exception 'credential replacement requires the lifecycle function';
    end if;
  end if;

  if tg_op='INSERT' and (
    new.revoked_at is not null or new.revoked_by is not null
    or new.revocation_reason is not null or new.expiry_grace_until is not null
  ) then
    raise exception 'credential lifecycle state requires a lifecycle function';
  end if;

  if new.expiry_grace_until is not null and not exists (
    select 1 from agent_bridge.credentials successor
    where successor.replaces_credential_id=new.id
  ) then
    raise exception 'credential grace requires a successor';
  end if;
  return new;
end
$$;

drop trigger if exists credentials_validate_security on agent_bridge.credentials;
create trigger credentials_validate_security
before insert or update on agent_bridge.credentials
for each row execute function agent_bridge.validate_credential_security();

create or replace function agent_bridge.reject_credential_delete()
returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'credentials are append-only';
end
$$;

drop trigger if exists credentials_append_only on agent_bridge.credentials;
create trigger credentials_append_only
before delete on agent_bridge.credentials
for each row execute function agent_bridge.reject_credential_delete();

create or replace function agent_bridge.reject_scope_set_mutation()
returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'credential scope sets are immutable';
end
$$;

drop trigger if exists credential_scope_sets_immutable on agent_bridge.credential_scope_sets;
create trigger credential_scope_sets_immutable
before update or delete on agent_bridge.credential_scope_sets
for each row execute function agent_bridge.reject_scope_set_mutation();

create table if not exists agent_bridge.security_events (
  sequence bigint generated always as identity primary key,
  event_id uuid not null default gen_random_uuid() unique,
  event_type text not null,
  outcome text not null,
  reason_code text not null,
  workspace_id text not null references agent_bridge.workspaces(id),
  principal text not null,
  actor_principal text not null,
  credential_id uuid references agent_bridge.credentials(id),
  related_credential_id uuid references agent_bridge.credentials(id),
  operation_id text,
  request_id uuid,
  policy_id text,
  retry_after_seconds integer,
  created_at timestamptz not null default clock_timestamp(),
  constraint security_events_type check (event_type in (
    'scope_denied','rate_denied','credential_replaced',
    'credential_replacement_failed','credential_revoked'
  )),
  constraint security_events_outcome check (outcome in ('denied','succeeded','failed')),
  constraint security_events_reason check (reason_code in (
    'missing_scope','rate_limit_exceeded','credential_rotated',
    'invalid_replacement','credential_revoked'
  )),
  constraint security_events_retry check (retry_after_seconds is null or retry_after_seconds >= 1),
  constraint security_events_actor check (
    length(actor_principal) between 1 and 128 and actor_principal !~ '[[:cntrl:]]'
  )
);

create index if not exists security_events_workspace_sequence
  on agent_bridge.security_events(workspace_id, sequence desc);
create index if not exists security_events_credential_sequence
  on agent_bridge.security_events(credential_id, sequence desc);
create index if not exists security_events_created
  on agent_bridge.security_events(created_at, sequence);

create or replace function agent_bridge.reject_security_event_mutation()
returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'security events are append-only';
end
$$;

drop trigger if exists security_events_append_only on agent_bridge.security_events;
create trigger security_events_append_only
before update or delete or truncate on agent_bridge.security_events
for each statement execute function agent_bridge.reject_security_event_mutation();

create table if not exists agent_bridge.rate_limit_policies (
  policy_id text primary key,
  operation_id text unique,
  capacity integer not null,
  refill_per_second numeric(20,6) not null,
  enabled boolean not null default true,
  constraint rate_limit_policy_shape check (
    (policy_id='global' and operation_id is null)
    or (policy_id='operation:' || operation_id and operation_id is not null)
  ),
  constraint rate_limit_policy_operation check (
    operation_id is null or operation_id in (
      'capabilities','status','gateway_metrics','publish_message','history',
      'record_receipt','claim_delivery','list_deliveries','list_delivery_events',
      'cancel_delivery','requeue_delivery','extend_delivery',
      'acknowledge_delivery','negative_acknowledge_delivery','heartbeat','presence'
    )
  ),
  constraint rate_limit_policy_capacity check (capacity > 0),
  constraint rate_limit_policy_refill check (refill_per_second > 0)
);

do $policy_constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='agent_bridge.rate_limit_policies'::regclass
      and conname='rate_limit_policy_operation'
  ) then
    alter table agent_bridge.rate_limit_policies add constraint rate_limit_policy_operation check (
      operation_id is null or operation_id in (
        'capabilities','status','gateway_metrics','publish_message','history',
        'record_receipt','claim_delivery','list_deliveries','list_delivery_events',
        'cancel_delivery','requeue_delivery','extend_delivery',
        'acknowledge_delivery','negative_acknowledge_delivery','heartbeat','presence'
      )
    );
  end if;
end
$policy_constraints$;

insert into agent_bridge.rate_limit_policies
  (policy_id, operation_id, capacity, refill_per_second) values
  ('global',null,300,50),
  ('operation:capabilities','capabilities',30,1),
  ('operation:status','status',30,1),
  ('operation:gateway_metrics','gateway_metrics',30,1),
  ('operation:publish_message','publish_message',120,20),
  ('operation:history','history',120,20),
  ('operation:record_receipt','record_receipt',120,20),
  ('operation:claim_delivery','claim_delivery',120,20),
  ('operation:list_deliveries','list_deliveries',120,20),
  ('operation:list_delivery_events','list_delivery_events',120,20),
  ('operation:cancel_delivery','cancel_delivery',60,10),
  ('operation:requeue_delivery','requeue_delivery',60,10),
  ('operation:extend_delivery','extend_delivery',120,20),
  ('operation:acknowledge_delivery','acknowledge_delivery',120,20),
  ('operation:negative_acknowledge_delivery','negative_acknowledge_delivery',120,20),
  ('operation:heartbeat','heartbeat',120,20),
  ('operation:presence','presence',120,20)
on conflict (policy_id) do nothing;

do $policy_seed$
declare
begin
  if (select count(*) from agent_bridge.rate_limit_policies) <> 17 or exists (
    with expected(policy_id,operation_id,capacity,refill_per_second) as (values
      ('global',null::text,300,50::numeric),
      ('operation:capabilities','capabilities',30,1),
      ('operation:status','status',30,1),
      ('operation:gateway_metrics','gateway_metrics',30,1),
      ('operation:publish_message','publish_message',120,20),
      ('operation:history','history',120,20),
      ('operation:record_receipt','record_receipt',120,20),
      ('operation:claim_delivery','claim_delivery',120,20),
      ('operation:list_deliveries','list_deliveries',120,20),
      ('operation:list_delivery_events','list_delivery_events',120,20),
      ('operation:cancel_delivery','cancel_delivery',60,10),
      ('operation:requeue_delivery','requeue_delivery',60,10),
      ('operation:extend_delivery','extend_delivery',120,20),
      ('operation:acknowledge_delivery','acknowledge_delivery',120,20),
      ('operation:negative_acknowledge_delivery','negative_acknowledge_delivery',120,20),
      ('operation:heartbeat','heartbeat',120,20),
      ('operation:presence','presence',120,20)
    )
    select 1 from expected
    left join agent_bridge.rate_limit_policies policy using (policy_id)
    where policy.policy_id is null
      or policy.operation_id is distinct from expected.operation_id
      or policy.capacity is distinct from expected.capacity
      or policy.refill_per_second is distinct from expected.refill_per_second
      or not policy.enabled
  ) then
    raise exception 'rate limit policy seed conflicts with required state';
  end if;
end
$policy_seed$;

create table if not exists agent_bridge.rate_limit_buckets (
  credential_id uuid not null references agent_bridge.credentials(id) on delete restrict,
  policy_id text not null references agent_bridge.rate_limit_policies(policy_id) on delete restrict,
  tokens numeric(30,6) not null,
  updated_at timestamptz not null,
  primary key (credential_id, policy_id),
  constraint rate_limit_buckets_tokens check (tokens >= 0)
);

create index if not exists rate_limit_buckets_cleanup
  on agent_bridge.rate_limit_buckets(updated_at);

create or replace function agent_bridge.record_scope_denial(
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
    'acknowledge_delivery','negative_acknowledge_delivery','heartbeat','presence'
  ) then
    raise exception using errcode='55000', message='operation security policy is unavailable';
  end if;
  if not exists (
    select 1 from agent_bridge.rate_limit_policies
    where operation_id=requested_operation_id and enabled
  ) then
    raise exception using errcode='55000', message='operation security policy is unavailable';
  end if;
  select credential.workspace_id, agent.principal
  into credential_workspace, credential_principal
  from agent_bridge.credentials credential
  join agent_bridge.agents agent
    on agent.id=credential.agent_id and agent.workspace_id=credential.workspace_id
  where credential.id=requested_credential_id;
  if not found then
    raise exception 'credential is unavailable for security audit';
  end if;
  insert into agent_bridge.security_events (
    event_type,outcome,reason_code,workspace_id,principal,actor_principal,
    credential_id,operation_id,request_id
  ) values (
    'scope_denied','denied','missing_scope',credential_workspace,
    credential_principal,credential_principal,requested_credential_id,
    requested_operation_id,requested_request_id
  );
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
    'acknowledge_delivery','negative_acknowledge_delivery','heartbeat','presence'
  ) then
    raise exception using errcode='55000', message='operation rate limit policy is unavailable';
  end if;
  select * into global_policy
  from agent_bridge.rate_limit_policies
  where policy_id='global' and enabled
  for share;
  if not found then
    raise exception using errcode='55000', message='global rate limit policy is unavailable';
  end if;
  select * into operation_policy
  from agent_bridge.rate_limit_policies
  where operation_id=requested_operation_id and enabled
  for share;
  if not found then
    raise exception using errcode='55000', message='operation rate limit policy is unavailable';
  end if;

  insert into agent_bridge.rate_limit_buckets(credential_id,policy_id,tokens,updated_at)
  values
    (requested_credential_id,global_policy.policy_id,global_policy.capacity,request_time),
    (requested_credential_id,operation_policy.policy_id,operation_policy.capacity,request_time)
  on conflict do nothing;

  perform 1 from agent_bridge.rate_limit_buckets
  where credential_id=requested_credential_id
    and policy_id in (global_policy.policy_id,operation_policy.policy_id)
  order by policy_id
  for update;

  select least(
    global_policy.capacity::numeric,
    greatest(0::numeric, bucket.tokens)
      + greatest(0::numeric, extract(epoch from request_time-bucket.updated_at)::numeric)
        * global_policy.refill_per_second
  ) into global_available
  from agent_bridge.rate_limit_buckets bucket
  where bucket.credential_id=requested_credential_id
    and bucket.policy_id=global_policy.policy_id;

  select least(
    operation_policy.capacity::numeric,
    greatest(0::numeric, bucket.tokens)
      + greatest(0::numeric, extract(epoch from request_time-bucket.updated_at)::numeric)
        * operation_policy.refill_per_second
  ) into operation_available
  from agent_bridge.rate_limit_buckets bucket
  where bucket.credential_id=requested_credential_id
    and bucket.policy_id=operation_policy.policy_id;

  allowed := global_available >= 1 and operation_available >= 1;
  global_after := case when allowed then global_available-1 else global_available end;
  operation_after := case when allowed then operation_available-1 else operation_available end;

  update agent_bridge.rate_limit_buckets bucket
  set tokens=case
        when bucket.policy_id=global_policy.policy_id then global_after
        else operation_after
      end,
      updated_at=request_time
  where bucket.credential_id=requested_credential_id
    and bucket.policy_id in (global_policy.policy_id,operation_policy.policy_id);

  limit_value := least(global_policy.capacity,operation_policy.capacity);
  remaining_value := floor(least(global_after,operation_after))::integer;
  retry_after_seconds := 0;
  denied_policy_id := null;

  if not allowed then
    if global_available < 1 then
      global_retry := (1-global_available)/global_policy.refill_per_second;
    end if;
    if operation_available < 1 then
      operation_retry := (1-operation_available)/operation_policy.refill_per_second;
    end if;
    retry_after_seconds := greatest(global_retry,operation_retry);
    denied_policy_id := case
      when global_retry >= operation_retry then global_policy.policy_id
      else operation_policy.policy_id
    end;

    select credential.workspace_id, agent.principal
    into credential_workspace, credential_principal
    from agent_bridge.credentials credential
    join agent_bridge.agents agent
      on agent.id=credential.agent_id and agent.workspace_id=credential.workspace_id
    where credential.id=requested_credential_id;
    if not found then
      raise exception 'credential is unavailable for rate audit';
    end if;
    insert into agent_bridge.security_events (
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

create or replace function agent_bridge.replace_credential(
  requested_predecessor_id uuid,
  requested_token_hash char(64),
  requested_scopes text[],
  requested_scope_set_name text,
  requested_label text,
  requested_expires_at timestamptz,
  requested_grace_until timestamptz,
  requested_actor text,
  requested_request_id uuid
) returns table(succeeded boolean, credential_id uuid, failure_code text)
language plpgsql security definer set search_path = '' as $$
declare
  predecessor agent_bridge.credentials%rowtype;
  predecessor_principal text;
  successor_id uuid;
begin
  if requested_actor is null or length(requested_actor) not between 1 and 128
    or requested_actor ~ '[[:cntrl:]]' then
    raise exception 'invalid replacement actor';
  end if;
  select credential.* into predecessor
  from agent_bridge.credentials credential
  join agent_bridge.agents agent
    on agent.id=credential.agent_id and agent.workspace_id=credential.workspace_id
  where credential.id=requested_predecessor_id
  for update of credential;
  if not found then
    succeeded := false; credential_id := null; failure_code := 'predecessor_not_found';
    return next; return;
  end if;
  select agent.principal into predecessor_principal
  from agent_bridge.agents agent
  where agent.id=predecessor.agent_id
    and agent.workspace_id=predecessor.workspace_id;
  if predecessor.expires_at is not null
    and requested_grace_until>predecessor.expires_at then
    succeeded := false; credential_id := null; failure_code := 'invalid_grace';
  else
    begin
      perform set_config('agent_bridge.lifecycle_authorized','replacement',true);
      insert into agent_bridge.credentials (
        workspace_id,agent_id,token_hash,label,expires_at,scopes,scope_set_name,
        replaces_credential_id
      ) values (
        predecessor.workspace_id,predecessor.agent_id,requested_token_hash,
        requested_label,requested_expires_at,requested_scopes,
        requested_scope_set_name,requested_predecessor_id
      ) returning id into successor_id;
      update agent_bridge.credentials
      set expiry_grace_until=requested_grace_until
      where id=requested_predecessor_id;
      insert into agent_bridge.security_events (
        event_type,outcome,reason_code,workspace_id,principal,actor_principal,
        credential_id,related_credential_id,request_id
      ) values (
        'credential_replaced','succeeded','credential_rotated',
        predecessor.workspace_id,predecessor_principal,requested_actor,
        successor_id,requested_predecessor_id,requested_request_id
      );
      perform set_config('agent_bridge.lifecycle_authorized','',true);
      succeeded := true; credential_id := successor_id; failure_code := null;
      return next; return;
    exception when others then
      succeeded := false; credential_id := null; failure_code := 'invalid_replacement';
    end;
  end if;

  insert into agent_bridge.security_events (
    event_type,outcome,reason_code,workspace_id,principal,actor_principal,
    credential_id,request_id
  ) values (
    'credential_replacement_failed','failed','invalid_replacement',
    predecessor.workspace_id,predecessor_principal,requested_actor,
    requested_predecessor_id,requested_request_id
  );
  return next;
end
$$;

create or replace function agent_bridge.revoke_credential(
  requested_credential_id uuid,
  requested_actor text,
  requested_reason_code text,
  requested_request_id uuid
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  credential_workspace text;
  credential_principal text;
begin
  if requested_actor is null or length(requested_actor) not between 1 and 128
    or requested_actor ~ '[[:cntrl:]]'
    or requested_reason_code not in ('operator_request','rotation','compromise','retired') then
    raise exception 'invalid credential revocation request';
  end if;
  perform set_config('agent_bridge.lifecycle_authorized','revocation',true);
  update agent_bridge.credentials credential
  set revoked_at=clock_timestamp(), revoked_by=requested_actor,
      revocation_reason=requested_reason_code
  from agent_bridge.agents agent
  where credential.id=requested_credential_id
    and credential.revoked_at is null
    and agent.id=credential.agent_id and agent.workspace_id=credential.workspace_id
  returning credential.workspace_id,agent.principal
  into credential_workspace,credential_principal;
  if not found then
    perform set_config('agent_bridge.lifecycle_authorized','',true);
    return false;
  end if;
  perform set_config('agent_bridge.lifecycle_authorized','',true);
  insert into agent_bridge.security_events (
    event_type,outcome,reason_code,workspace_id,principal,actor_principal,
    credential_id,request_id
  ) values (
    'credential_revoked','succeeded','credential_revoked',credential_workspace,
    credential_principal,requested_actor,requested_credential_id,requested_request_id
  );
  return true;
end
$$;

create or replace function agent_bridge.security_schema_ready()
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  runtime_role text := 'agent_bridge_runtime_' || substr(md5(current_database()), 1, 16);
begin
  return
    (select scopes=array[
      'deliveries:claim','deliveries:manage','deliveries:read','deliveries:settle',
      'gateway:metrics','messages:read','messages:write','presence:read',
      'presence:write','receipts:write','status:read'
    ]::text[] from agent_bridge.credential_scope_sets where name='release-a-full')
    and not exists (
      with expected(policy_id,operation_id,capacity,refill_per_second) as (values
        ('global',null::text,300,50::numeric),
        ('operation:capabilities','capabilities',30,1),
        ('operation:status','status',30,1),
        ('operation:gateway_metrics','gateway_metrics',30,1),
        ('operation:publish_message','publish_message',120,20),
        ('operation:history','history',120,20),
        ('operation:record_receipt','record_receipt',120,20),
        ('operation:claim_delivery','claim_delivery',120,20),
        ('operation:list_deliveries','list_deliveries',120,20),
        ('operation:list_delivery_events','list_delivery_events',120,20),
        ('operation:cancel_delivery','cancel_delivery',60,10),
        ('operation:requeue_delivery','requeue_delivery',60,10),
        ('operation:extend_delivery','extend_delivery',120,20),
        ('operation:acknowledge_delivery','acknowledge_delivery',120,20),
        ('operation:negative_acknowledge_delivery','negative_acknowledge_delivery',120,20),
        ('operation:heartbeat','heartbeat',120,20),
        ('operation:presence','presence',120,20)
      )
      select 1 from expected
      left join agent_bridge.rate_limit_policies policy using (policy_id)
      where policy.policy_id is null
        or policy.operation_id is distinct from expected.operation_id
        or policy.capacity is distinct from expected.capacity
        or policy.refill_per_second is distinct from expected.refill_per_second
        or not policy.enabled
    )
    and (select count(*)=17 from agent_bridge.rate_limit_policies)
    and not exists (
      select 1 from (values
        ('security_events_append_only','agent_bridge.security_events'::regclass),
        ('credentials_validate_security','agent_bridge.credentials'::regclass),
        ('credentials_append_only','agent_bridge.credentials'::regclass),
        ('credential_scope_sets_immutable','agent_bridge.credential_scope_sets'::regclass)
      ) required(trigger_name,relation_id)
      left join pg_catalog.pg_trigger trigger
        on trigger.tgname=required.trigger_name
       and trigger.tgrelid=required.relation_id
       and not trigger.tgisinternal
      where trigger.oid is null or trigger.tgenabled <> 'O'
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
        on constraint_record.conrelid=required.relation_id
       and constraint_record.conname=required.constraint_name
      where constraint_record.oid is null or not constraint_record.convalidated
    )
    and exists (
      select 1 from pg_catalog.pg_attribute attribute
      where attribute.attrelid='agent_bridge.credentials'::regclass
        and attribute.attname='scopes' and attribute.attnotnull
    )
    and pg_catalog.to_regclass('agent_bridge.credentials_replacement_lineage') is not null
    and pg_catalog.to_regclass('agent_bridge.rate_limit_buckets_cleanup') is not null
    and pg_catalog.to_regprocedure('agent_bridge.replace_credential(uuid,character,text[],text,text,timestamptz,timestamptz,text,uuid)') is not null
    and pg_catalog.to_regprocedure('agent_bridge.revoke_credential(uuid,text,text,uuid)') is not null
    and (select count(*)=5 and bool_and(
      procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']::text[]
    ) from pg_catalog.pg_proc procedure
      where procedure.oid in (
        'agent_bridge.record_scope_denial(uuid,text,uuid)'::regprocedure,
        'agent_bridge.consume_rate_limit(uuid,text,uuid)'::regprocedure,
        'agent_bridge.replace_credential(uuid,character,text[],text,text,timestamptz,timestamptz,text,uuid)'::regprocedure,
        'agent_bridge.revoke_credential(uuid,text,text,uuid)'::regprocedure,
        'agent_bridge.security_schema_ready()'::regprocedure
      ))
    and not exists (
      select 1
      from pg_catalog.pg_proc procedure
      cross join lateral pg_catalog.aclexplode(
        coalesce(procedure.proacl,pg_catalog.acldefault('f',procedure.proowner))
      ) access
      where procedure.oid in (
        'agent_bridge.record_scope_denial(uuid,text,uuid)'::regprocedure,
        'agent_bridge.consume_rate_limit(uuid,text,uuid)'::regprocedure,
        'agent_bridge.replace_credential(uuid,character,text[],text,text,timestamptz,timestamptz,text,uuid)'::regprocedure,
        'agent_bridge.revoke_credential(uuid,text,text,uuid)'::regprocedure,
        'agent_bridge.security_schema_ready()'::regprocedure
      ) and access.grantee=0 and access.privilege_type='EXECUTE'
    )
    and pg_catalog.has_function_privilege(runtime_role,'agent_bridge.record_scope_denial(uuid,text,uuid)','EXECUTE')
    and pg_catalog.has_function_privilege(runtime_role,'agent_bridge.consume_rate_limit(uuid,text,uuid)','EXECUTE')
    and pg_catalog.has_function_privilege(runtime_role,'agent_bridge.security_schema_ready()','EXECUTE')
    and not pg_catalog.has_function_privilege(runtime_role,'agent_bridge.replace_credential(uuid,character,text[],text,text,timestamptz,timestamptz,text,uuid)','EXECUTE')
    and not pg_catalog.has_function_privilege(runtime_role,'agent_bridge.revoke_credential(uuid,text,text,uuid)','EXECUTE')
    and not pg_catalog.has_table_privilege(runtime_role,'agent_bridge.credential_scope_sets','SELECT,INSERT,UPDATE,DELETE')
    and not pg_catalog.has_table_privilege(runtime_role,'agent_bridge.security_events','SELECT,INSERT,UPDATE,DELETE')
    and not pg_catalog.has_table_privilege(runtime_role,'agent_bridge.rate_limit_policies','SELECT,INSERT,UPDATE,DELETE')
    and not pg_catalog.has_table_privilege(runtime_role,'agent_bridge.rate_limit_buckets','SELECT,INSERT,UPDATE,DELETE');
end
$$;

revoke all on agent_bridge.credential_scope_sets, agent_bridge.security_events,
  agent_bridge.rate_limit_policies, agent_bridge.rate_limit_buckets from public;
revoke all on all sequences in schema agent_bridge from public;
revoke all on function agent_bridge.canonicalize_scopes(text[]) from public;
revoke all on function agent_bridge.record_scope_denial(uuid,text,uuid) from public;
revoke all on function agent_bridge.consume_rate_limit(uuid,text,uuid) from public;
revoke all on function agent_bridge.replace_credential(uuid,character,text[],text,text,timestamptz,timestamptz,text,uuid) from public;
revoke all on function agent_bridge.revoke_credential(uuid,text,text,uuid) from public;
revoke all on function agent_bridge.security_schema_ready() from public;

do $roles$
declare
  role_name text;
  runtime_role text := 'agent_bridge_runtime_' || substr(md5(current_database()), 1, 16);
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on agent_bridge.credential_scope_sets, agent_bridge.security_events, agent_bridge.rate_limit_policies, agent_bridge.rate_limit_buckets from %I', role_name);
      execute format('revoke all on function agent_bridge.record_scope_denial(uuid,text,uuid) from %I', role_name);
      execute format('revoke all on function agent_bridge.consume_rate_limit(uuid,text,uuid) from %I', role_name);
      execute format('revoke all on function agent_bridge.security_schema_ready() from %I', role_name);
    end if;
  end loop;
  execute format('revoke all on agent_bridge.credential_scope_sets, agent_bridge.security_events, agent_bridge.rate_limit_policies, agent_bridge.rate_limit_buckets from %I', runtime_role);
  execute format('grant execute on function agent_bridge.record_scope_denial(uuid,text,uuid) to %I', runtime_role);
  execute format('grant execute on function agent_bridge.consume_rate_limit(uuid,text,uuid) to %I', runtime_role);
  execute format('grant execute on function agent_bridge.security_schema_ready() to %I', runtime_role);
end
$roles$;

insert into agent_bridge.schema_migrations(version,name,checksum)
values (11,'credential_security','__AGENT_BRIDGE_MIGRATION_CHECKSUM__')
on conflict (version) do update set applied_at=agent_bridge.schema_migrations.applied_at
where agent_bridge.schema_migrations.name=excluded.name
  and agent_bridge.schema_migrations.checksum=excluded.checksum;

do $migration$
begin
  if not exists (select 1 from agent_bridge.schema_migrations
    where version=11 and name='credential_security'
      and checksum='__AGENT_BRIDGE_MIGRATION_CHECKSUM__') then
    raise exception 'migration 11_credential_security conflicts with recorded schema state';
  end if;
end
$migration$;

commit;
