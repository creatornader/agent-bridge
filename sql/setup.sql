-- Agent Bridge: shared_context table
-- Provides cross-agent context sharing via Supabase REST API

create table shared_context (
  id bigserial primary key,
  source text not null,
  category text not null,
  content text not null,
  priority text not null default 'info',
  project text,
  metadata jsonb not null default '{}',
  atrib_receipt_id text,
  created_at timestamptz not null default now(),
  acked_by text[] not null default '{}'
);

-- Categories:
--   operational    — runtime status, health, delivery confirmations
--   config-change  — settings or wrapper modifications
--   goal-update    — goal progress, new goals, goal completion
--   flag           — urgent alerts, blockers, warnings
--   bridge-meta    — suggested improvements to the Agent Bridge itself

-- Indexes for common query patterns
create index idx_ctx_created on shared_context(created_at desc);
create index idx_ctx_source on shared_context(source);
create index idx_ctx_category on shared_context(category);
create index idx_ctx_atrib_receipt on shared_context(atrib_receipt_id)
  where atrib_receipt_id is not null;

-- RLS: allow anon key to read all rows and insert/update
alter table shared_context enable row level security;

create policy "Allow read access"
  on shared_context for select
  using (true);

create policy "Allow insert access"
  on shared_context for insert
  with check (true);

create policy "Allow update access"
  on shared_context for update
  using (true);

-- Atomic ack function (avoids fetch-then-update race condition)
create or replace function ack_context(entry_ids bigint[], agent_name text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update shared_context
  set acked_by = array_append(acked_by, agent_name)
  where id = any(entry_ids)
    and not (acked_by @> array[agent_name]);
  get diagnostics affected = row_count;
  return affected;
end;
$$;

comment on column shared_context.atrib_receipt_id is
  'Optional signed atrib record receipt_id (record_hash "." creator_key, base64url) ' ||
  'emitted by an atrib-signing wrapper at insert time. ' ||
  'Consumers use this as the informed_by anchor for cross-process causal edges.';
