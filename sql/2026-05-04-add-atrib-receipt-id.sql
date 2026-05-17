-- Optional column: atrib_receipt_id (verifiable agent-action receipts)
--
-- If you wrap your agent-bridge writes behind an atrib (https://atrib.dev)
-- signing layer, you can carry the signed-record receipt_id here. Downstream
-- consumers can then use it as the `informed_by` anchor when emitting their
-- own atrib observation records, producing cross-process causal edges in the
-- public graph at explore.atrib.dev.
--
-- The column is optional. Leaving it null is fine; agent-bridge does not
-- require atrib integration.
--
-- Apply via Supabase Studio SQL editor on your agent-bridge project.

alter table shared_context
  add column if not exists atrib_receipt_id text;

comment on column shared_context.atrib_receipt_id is
  'Optional signed atrib record receipt_id (record_hash "." creator_key, base64url) ' ||
  'emitted by an atrib-signing wrapper at insert time. ' ||
  'Consumers use this as the informed_by anchor for cross-process causal edges.';
