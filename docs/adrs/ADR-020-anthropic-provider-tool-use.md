# ADR-020 — Anthropic provider: tool-use as schema-constrained generation

## Status

Accepted. **Amended by ADR-023:** the Anthropic provider is now **text-only** —
the vision/image path and the Vibe Shield session/base-URL routing have been
removed. It extracts from cleartext OCR/text-layer markdown via tool-use as
described below; scanned-page OCR runs locally on Ollama Qwen-VL.

## Context

The `AnthropicProvider` (ADR-019) needs a deterministic way to force
the model to emit a JSON object that conforms to our extraction schema.
Anthropic's Messages API exposes JSON-schema validation primarily via
**tool use**: a tool's `input_schema` is treated as a JSON Schema, and
the model is required to emit a `tool_use` block whose `input` validates
against it. Pinning `tool_choice` to a specific tool makes the model use
exactly that tool. This is the right primitive for our use case — the
extraction call is fundamentally "produce one schema-valid JSON
object."

We also need to (a) keep an API key off the filesystem in cleartext,
(b) forbid raw PDFs and rasterized images from leaving the box, (c)
account for cost, and (d) make the provider switchable to a regional
or proxy endpoint.

## Decision

The Anthropic provider has the following shape:

- **Tool-use mechanism** — the JSON Schema from
  `packages/shared/src/schemas/extraction.ts` is passed as a single
  tool's `input_schema` with
  `tool_choice: { type: "tool", name: "emit_extraction" }`. The model
  must emit a `tool_use` content block; we read `input` directly. No
  free-text JSON parsing.
- **Default model** — `claude-sonnet-4-6`. Configurable via
  `system_settings.llm.anthropic.model` to any Claude 4.x family model
  (Opus / Sonnet / Haiku).
- **API key storage** — AES-256-GCM-encrypted at rest in
  `system_settings.llm.anthropic.api_key`. The encryption key is
  derived from `SESSION_SECRET` via HKDF-SHA256 (separate `info` string
  so the cookie key and the API-key wrapping key cannot collide). The
  ciphertext stores 12-byte nonce + 16-byte auth tag inline.
  `ANTHROPIC_API_KEY` env var is accepted as a fallback when no
  DB-stored key exists (useful for short-lived debugging, not the
  primary path).
- **PII / data-handling rules** — only the OCR-extracted markdown text
  plus the JSON schema is sent. **Raw PDFs and page images never
  egress.** The HTTP client refuses to attach binary parts.
- **Cost accounting** — every call is audit-logged with
  `(model, input_tokens, output_tokens, ms, cost_micros)`. Costs are
  computed from a small price table baked into the build (refreshed
  on releases). The OCR text payload itself is not logged (consistent
  with the no-PII-in-logs rule).
- **Endpoint override** — `ANTHROPIC_BASE_URL` defaults to
  `https://api.anthropic.com` and can be overridden for proxies or
  regional endpoints.

## Consequences

- **Pro:** Schema conformance enforced at the API rather than at parse
  time.
- **Pro:** Encryption at rest plus opt-in by admin matches the
  zero-egress-by-default product invariant.
- **Pro:** Cost ledger gives operators visibility before the next
  invoice arrives.
- **Con:** Tool-use adds a small per-call wrapper compared to plain
  message generation; we accept the overhead for the schema guarantee.
- **Con:** Key derivation depends on `SESSION_SECRET` — rotating the
  session secret invalidates the stored API key. Operators rotating
  the secret must re-enter the API key. Documented in the operator
  guide.

## References

- `packages/extractor/src/llm-client.ts`
- ADR-019
- BuildPlan.md §3 ADR-020, Phase 13.
