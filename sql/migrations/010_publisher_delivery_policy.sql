begin;

select pg_advisory_xact_lock(1646705660);

drop trigger if exists messages_immutable on agent_bridge.messages;

alter table agent_bridge.messages
  add column if not exists delivery_mode text,
  add column if not exists delivery_max_attempts integer,
  add column if not exists delivery_retry_base_delay_ms integer,
  add column if not exists delivery_retry_max_delay_ms integer,
  add column if not exists delivery_retry_jitter_ratio double precision,
  add column if not exists delivery_not_before timestamptz;

update agent_bridge.messages
set delivery_mode = case when jsonb_array_length(targets) = 0 then 'mailbox' else 'leased' end,
    delivery_max_attempts = case when jsonb_array_length(targets) = 0 then null else 5 end,
    delivery_retry_base_delay_ms = case when jsonb_array_length(targets) = 0 then null else 1000 end,
    delivery_retry_max_delay_ms = case when jsonb_array_length(targets) = 0 then null else 60000 end,
    delivery_retry_jitter_ratio = case when jsonb_array_length(targets) = 0 then null else 0.2 end
where delivery_mode is null;

alter table agent_bridge.messages alter column delivery_mode set not null;
alter table agent_bridge.messages drop constraint if exists messages_delivery_policy_valid;
alter table agent_bridge.messages add constraint messages_delivery_policy_valid check (
  (delivery_mode = 'mailbox'
    and delivery_max_attempts is null
    and delivery_retry_base_delay_ms is null
    and delivery_retry_max_delay_ms is null
    and delivery_retry_jitter_ratio is null
    and delivery_not_before is null)
  or
  (delivery_mode = 'leased'
    and jsonb_array_length(targets) > 0
    and delivery_max_attempts between 1 and 100
    and delivery_retry_base_delay_ms between 1 and 3600000
    and delivery_retry_max_delay_ms between delivery_retry_base_delay_ms and 86400000
    and delivery_retry_jitter_ratio between 0 and 1
    and (delivery_not_before is null or expires_at is null or delivery_not_before < expires_at))
);

create trigger messages_immutable before update or delete on agent_bridge.messages
for each row execute function agent_bridge.reject_message_mutation();

alter table agent_bridge.deliveries drop constraint if exists deliveries_state_check;
alter table agent_bridge.deliveries add constraint deliveries_state_check
  check (state in ('pending','claimed','acked','retrying','dead','cancelled'));
alter table agent_bridge.deliveries
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists priority_rank smallint not null default 2,
  add column if not exists cycle_attempt integer,
  add column if not exists requeue_count integer not null default 0,
  add column if not exists last_actor text,
  add column if not exists last_action text;

update agent_bridge.deliveries delivery
set created_at = message.created_at,
    priority_rank = case message.priority when 'urgent' then 0 when 'high' then 1 else 2 end,
    cycle_attempt = coalesce(delivery.cycle_attempt, delivery.attempt),
    last_actor = coalesce(delivery.last_actor, case
      when delivery.state='pending' and delivery.attempt=0 then message.source
      when delivery.state='dead' and delivery.last_error in ('message expired','maximum attempts reached') then 'agent-bridge'
      else coalesce(
        delivery.lease_owner,
        (select event.lease_owner from agent_bridge.delivery_events event
         where event.delivery_id=delivery.id and event.lease_owner is not null
           and event.to_state='claimed' and event.attempt=delivery.attempt
         order by event.sequence desc limit 1),
        delivery.recipient)
    end),
    last_action = coalesce(delivery.last_action, case
      when delivery.state='pending' and delivery.attempt=0 then 'created'
      when delivery.state='claimed' then 'claim'
      when delivery.state='acked' then 'ack'
      when delivery.state='retrying' then 'nack_retry'
      when delivery.state='dead' and delivery.last_error='message expired' then 'message_expired'
      when delivery.state='dead' and delivery.last_error='maximum attempts reached' then 'attempts_exhausted'
      when delivery.state='dead' then 'nack_dead'
      when delivery.state='cancelled' then 'cancel'
      else 'created'
    end)
from agent_bridge.messages message
where message.workspace = delivery.workspace and message.id = delivery.message_id;

alter table agent_bridge.deliveries
  alter column cycle_attempt set not null,
  alter column cycle_attempt set default 0,
  alter column last_action set not null;
alter table agent_bridge.deliveries drop constraint if exists deliveries_lifecycle_valid;
alter table agent_bridge.deliveries add constraint deliveries_lifecycle_valid check (
  priority_rank between 0 and 2
  and cycle_attempt >= 0
  and cycle_attempt <= attempt
  and requeue_count >= 0
  and last_action in (
    'created','claim','ack','nack_retry','nack_dead','lease_expired',
    'attempts_exhausted','message_expired','cancel','requeue'
  )
);

alter table agent_bridge.delivery_events
  add column if not exists cycle_attempt integer,
  add column if not exists requeue_count integer not null default 0,
  add column if not exists actor text,
  add column if not exists action text;

update agent_bridge.delivery_events event
set cycle_attempt = coalesce(event.cycle_attempt, event.attempt),
    actor = coalesce(event.actor, case
      when event.from_state is null then message.source
      when event.to_state='dead' and event.error in ('message expired','maximum attempts reached') then 'agent-bridge'
      when event.to_state in ('acked','retrying','dead') then coalesce(
        event.lease_owner,
        (select claim.lease_owner from agent_bridge.delivery_events claim
         where claim.delivery_id=event.delivery_id and claim.to_state='claimed'
           and claim.attempt=event.attempt and claim.sequence<event.sequence
           and claim.lease_owner is not null
         order by claim.sequence desc limit 1),
        delivery.recipient)
      else coalesce(event.lease_owner,delivery.recipient)
    end),
    action = coalesce(event.action, case
      when event.from_state is null then 'created'
      when event.to_state = 'claimed' then 'claim'
      when event.to_state = 'acked' then 'ack'
      when event.to_state = 'retrying' then 'nack_retry'
      when event.to_state = 'dead' and event.error = 'message expired' then 'message_expired'
      when event.to_state = 'dead' and event.error = 'maximum attempts reached' then 'attempts_exhausted'
      when event.to_state = 'dead' then 'nack_dead'
      when event.to_state = 'cancelled' then 'cancel'
      else 'created'
    end)
from agent_bridge.deliveries delivery, agent_bridge.messages message
where delivery.id = event.delivery_id
  and message.workspace=event.workspace and message.id=event.message_id;

alter table agent_bridge.delivery_events
  alter column cycle_attempt set not null,
  alter column actor set not null,
  alter column action set not null;
alter table agent_bridge.delivery_events drop constraint if exists delivery_events_action_valid;
alter table agent_bridge.delivery_events add constraint delivery_events_action_valid check (
  action in (
    'created','claim','ack','nack_retry','nack_dead','lease_expired',
    'attempts_exhausted','message_expired','cancel','requeue'
  )
);

create or replace function agent_bridge.record_delivery_event() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT'
    or old.state is distinct from new.state
    or old.attempt is distinct from new.attempt
    or old.requeue_count is distinct from new.requeue_count
    or old.last_action is distinct from new.last_action then
    insert into agent_bridge.delivery_events (
      delivery_id, message_id, workspace, recipient, from_state, to_state,
      attempt, cycle_attempt, requeue_count, lease_owner, error, actor, action
    ) values (
      new.id, new.message_id, new.workspace, new.recipient,
      case when tg_op = 'INSERT' then null else old.state end,
      new.state, new.attempt, new.cycle_attempt, new.requeue_count,
      new.lease_owner, new.last_error, coalesce(new.last_actor, new.recipient), new.last_action
    );
  end if;
  return new;
end
$$;
drop trigger if exists deliveries_record_event on agent_bridge.deliveries;
create trigger deliveries_record_event
after insert or update on agent_bridge.deliveries
for each row execute function agent_bridge.record_delivery_event();

drop index if exists agent_bridge.deliveries_claim;
create index deliveries_claim on agent_bridge.deliveries
  (workspace, recipient, priority_rank, available_at, created_at, id)
  where state in ('pending','retrying','claimed');
create index if not exists deliveries_publisher_lookup on agent_bridge.deliveries
  (workspace, message_id, created_at, id);
create index if not exists deliveries_terminal_lookup on agent_bridge.deliveries
  (workspace, recipient, state, created_at, id)
  where state in ('dead','cancelled');

insert into agent_bridge.schema_migrations (version, name, checksum)
values (10, 'publisher_delivery_policy', '__AGENT_BRIDGE_MIGRATION_CHECKSUM__')
on conflict (version) do update set applied_at=agent_bridge.schema_migrations.applied_at
where agent_bridge.schema_migrations.name=excluded.name
  and agent_bridge.schema_migrations.checksum=excluded.checksum;

do $migration$
begin
  if not exists (
    select 1 from agent_bridge.schema_migrations
    where version=10 and name='publisher_delivery_policy'
      and checksum='__AGENT_BRIDGE_MIGRATION_CHECKSUM__'
  ) then
    raise exception 'migration 10_publisher_delivery_policy conflicts with recorded schema state';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid='agent_bridge.messages'::regclass
      and tgname='messages_immutable' and not tgisinternal
  ) then
    raise exception 'message immutability trigger was not restored';
  end if;
end
$migration$;

commit;
