-- Loop 5: cross-repo causal edges via atrib_receipt_id
--
-- Carries the signed-record receipt_id from the agent-bridge-atrib wrapper
-- (~/repos/atrib-internal/services/agent-bridge-atrib/) so that downstream
-- consumers (e.g. second-brain bridge_poller.py) can use it as the informed_by
-- anchor when emitting their own observation records. Result: cross-repo edges
-- link atrib session work to second-brain session work in the public graph at
-- explore.atrib.dev.
--
-- Apply via Supabase Studio SQL editor on the agent-bridge project.

alter table shared_context
  add column if not exists atrib_receipt_id text;

comment on column shared_context.atrib_receipt_id is
  'Signed atrib record receipt_id (record_hash "." creator_key, base64url) ' ||
  'emitted by the agent-bridge-atrib wrapper at insert time. Optional. ' ||
  'Consumers use this as the informed_by anchor for cross-repo causal edges.';
