begin;

select pg_advisory_xact_lock(1646705660);

create index if not exists messages_source
  on agent_bridge.messages(workspace, source, sequence);
create index if not exists messages_thread
  on agent_bridge.messages(workspace, thread_id, sequence)
  where thread_id is not null;
create index if not exists messages_created
  on agent_bridge.messages(workspace, created_at, sequence);

insert into agent_bridge.schema_migrations (version, name, checksum)
values (4, 'message_query_indexes', '__AGENT_BRIDGE_MIGRATION_CHECKSUM__')
on conflict (version) do update set applied_at=agent_bridge.schema_migrations.applied_at
where agent_bridge.schema_migrations.name=excluded.name
  and agent_bridge.schema_migrations.checksum=excluded.checksum;

do $migration$
begin
  if not exists (
    select 1 from agent_bridge.schema_migrations
    where version=4 and name='message_query_indexes'
      and checksum='__AGENT_BRIDGE_MIGRATION_CHECKSUM__'
  ) then
    raise exception 'migration 4_message_query_indexes conflicts with recorded schema state';
  end if;
end
$migration$;

commit;
