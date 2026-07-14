begin;

select pg_advisory_xact_lock(1646705660);

alter table agent_bridge.messages add column if not exists project text;
alter table agent_bridge.messages drop constraint if exists messages_project_label;
alter table agent_bridge.messages add constraint messages_project_label
  check (
    project is null or (
      project = btrim(project)
      and char_length(project) between 1 and 128
    )
  );
create index if not exists messages_project
  on agent_bridge.messages(workspace, project, sequence)
  where project is not null;

insert into agent_bridge.schema_migrations (version, name, checksum)
values (8, 'message_projects', '__AGENT_BRIDGE_MIGRATION_CHECKSUM__')
on conflict (version) do update set applied_at=agent_bridge.schema_migrations.applied_at
where agent_bridge.schema_migrations.name=excluded.name
  and agent_bridge.schema_migrations.checksum=excluded.checksum;

do $migration$
begin
  if not exists (
    select 1 from agent_bridge.schema_migrations
    where version=8 and name='message_projects'
      and checksum='__AGENT_BRIDGE_MIGRATION_CHECKSUM__'
  ) then
    raise exception 'migration 8_message_projects conflicts with recorded schema state';
  end if;
end
$migration$;

commit;
