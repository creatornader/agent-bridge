begin;

select pg_advisory_xact_lock(1646705660);

-- Inbox/all visibility uses jsonb's key-existence operator. The existing
-- workspace/source/sequence indexes already cover sent history.
create index if not exists messages_targets_gin
  on agent_bridge.messages using gin (targets);

insert into agent_bridge.schema_migrations (version, name, checksum)
values (9, 'mailbox_query_indexes', '__AGENT_BRIDGE_MIGRATION_CHECKSUM__')
on conflict (version) do update set applied_at=agent_bridge.schema_migrations.applied_at
where agent_bridge.schema_migrations.name=excluded.name
  and agent_bridge.schema_migrations.checksum=excluded.checksum;

do $migration$
begin
  if not exists (
    select 1 from agent_bridge.schema_migrations
    where version=9 and name='mailbox_query_indexes'
      and checksum='__AGENT_BRIDGE_MIGRATION_CHECKSUM__'
  ) then
    raise exception 'migration 9_mailbox_query_indexes conflicts with recorded schema state';
  end if;
end
$migration$;

commit;
