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
