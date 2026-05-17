# Changelog

All notable changes to agent-bridge are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-17

First tagged release. Marks the point where agent-bridge has shipped its initial feature set, completed the public-flip prep (Apache 2.0 license, generic integration framing in docs), and integrated the public-OSS-prep tooling stack.

### Added

- MCP server with three tools: `post_context`, `get_context`, `ack_context`. Direct fetch to Supabase REST API (no `@supabase/supabase-js`) so the MCP server and the bash CLI share the same lightweight approach.
- Bash CLI at `bin/agent-bridge` for shell-based agent integrations.
- SQL schema (`sql/setup.sql`) with the `shared_context` table, permissive RLS (anon key is the access control), and the `ack_context_atomic` RPC for race-free acknowledgement via `array_append`.
- Optional `atrib_receipt_id` column for callers that wrap writes behind an atrib signing layer. The column is format-validated and optional; agent-bridge does not require atrib integration.
- Integration with the public-OSS-prep stack: textleaks pre-commit hook, oss-twin structural mirror gate, oss-security-scan reusable CI workflow.

### Security

- gitleaks + trufflehog + osv-scanner via the reusable workflow at `creatornader/oss-security-scan@v0.1.0`.
- Narrative-leak detection in CI + on commit via `creatornader/textleaks@v0.2.0` (renamed from leakguard).

[0.1.0]: https://github.com/creatornader/agent-bridge/releases/tag/v0.1.0
