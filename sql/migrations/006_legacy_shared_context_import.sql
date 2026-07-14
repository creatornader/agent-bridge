begin;

select pg_advisory_xact_lock(1646705660);

create or replace function agent_bridge.safe_timestamptz(value text) returns timestamptz
language plpgsql immutable set search_path = '' as $$
begin
  return value::timestamptz;
exception when others then
  return null;
end
$$;

create or replace function agent_bridge.legacy_message_uuid(value bigint, metadata jsonb) returns uuid
language sql immutable set search_path = '' as $$
  select case
    when metadata #>> '{message_envelope,message_id}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (metadata #>> '{message_envelope,message_id}')::uuid
    when value between 0 and 281474976710655
      then ('00000000-0000-8000-8000-' || lpad(to_hex(value), 12, '0'))::uuid
    else (
      '00000000-0000-8' || substring(encoded, 1, 3) || '-9' ||
      substring(encoded, 4, 3) || '-' || substring(encoded, 7, 12)
    )::uuid
  end
  from (
    select lpad(to_hex(value), 16, '0')::text as raw
  ) mapped_raw
  cross join lateral (
    select lpad(mapped_raw.raw, 18, '0') as encoded
  ) mapped
$$;

do $import$
begin
  if to_regclass('public.shared_context') is not null then
    alter table public.shared_context
      add column if not exists atrib_receipt_id text;

    insert into agent_bridge.workspaces (id, name)
    select distinct coalesce(project, 'legacy'), coalesce(project, 'Legacy unscoped')
    from public.shared_context
    on conflict (id) do nothing;

    if exists (
      select mapped_id from (
        select agent_bridge.legacy_message_uuid(id, metadata) as mapped_id
        from public.shared_context
      ) mapped
      group by mapped_id having count(*) > 1
    ) then
      raise exception 'legacy shared_context contains duplicate message IDs';
    end if;

    if exists (
      select 1
      from public.shared_context context
      join agent_bridge.messages message
        on message.id = agent_bridge.legacy_message_uuid(context.id, context.metadata)
    ) then
      raise exception 'legacy shared_context message ID collides with existing v2 history';
    end if;

    insert into agent_bridge.messages (
      id, workspace, source, type, content, content_type, data, targets,
      thread_id, reply_to_id, correlation_id, causation_id, priority,
      expires_at, idempotency_key, atrib_receipt_id,
      informed_by, metadata, created_at
    )
    select
      agent_bridge.legacy_message_uuid(id, metadata),
      coalesce(project, 'legacy'),
      source,
      coalesce(metadata #>> '{message_envelope,kind}', category),
      content,
      coalesce(metadata #>> '{message_envelope,payload_mime}', 'text/plain'),
      metadata #> '{message_envelope,payload}',
      case
        when jsonb_typeof(metadata #> '{message_envelope,target_agents}')='array'
          then metadata #> '{message_envelope,target_agents}'
        else '[]'::jsonb
      end,
      metadata #>> '{message_envelope,thread_id}',
      metadata #>> '{message_envelope,reply_to_id}',
      metadata #>> '{message_envelope,correlation_id}',
      metadata #>> '{message_envelope,causation_id}',
      case when priority in ('info','high','urgent') then priority else 'info' end,
      agent_bridge.safe_timestamptz(metadata #>> '{message_envelope,expires_at}'),
      metadata #>> '{message_envelope,idempotency_key}',
      coalesce(atrib_receipt_id, metadata #>> '{message_envelope,atrib_receipt_id}'),
      metadata #> '{message_envelope,informed_by}',
      metadata,
      created_at
    from public.shared_context
    on conflict (id) do nothing;

    -- Targets on imported rows describe historical routing. Creating pending
    -- deliveries here would execute old work again during an upgrade.

    insert into agent_bridge.receipts (workspace, message_id, principal, read_at)
    select
      coalesce(context.project, 'legacy'),
      agent_bridge.legacy_message_uuid(context.id, context.metadata),
      principal,
      context.created_at
    from public.shared_context context
    cross join lateral unnest(context.acked_by) as principal
    on conflict do nothing;

    if (
      select count(*) from public.shared_context context
      join agent_bridge.messages message
        on message.id = agent_bridge.legacy_message_uuid(context.id, context.metadata)
    ) <> (select count(*) from public.shared_context) then
      raise exception 'legacy shared_context import count verification failed';
    end if;
  end if;
end
$import$;

insert into agent_bridge.schema_migrations (version, name, checksum)
values (6, 'legacy_shared_context_import', '__AGENT_BRIDGE_MIGRATION_CHECKSUM__')
on conflict (version) do update set applied_at=agent_bridge.schema_migrations.applied_at
where agent_bridge.schema_migrations.name=excluded.name
  and agent_bridge.schema_migrations.checksum=excluded.checksum;

do $migration$
begin
  if not exists (
    select 1 from agent_bridge.schema_migrations
    where version=6 and name='legacy_shared_context_import'
      and checksum='__AGENT_BRIDGE_MIGRATION_CHECKSUM__'
  ) then
    raise exception 'migration 6_legacy_shared_context_import conflicts with recorded schema state';
  end if;
end
$migration$;

commit;
