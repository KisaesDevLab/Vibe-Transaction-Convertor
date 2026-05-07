# ADR-021 — LLM-driven description cleansing and business-category assignment

## Status

Accepted.

## Context

Bank statements arrive with cryptic, inconsistently-formatted
descriptions ("POS DBT 0123 SQ *AMTHAUS", "AMZN MKTP US*A1B2C3", "EFT
BC2026XXXXXX") and no business categorization. Bookkeepers either
import those raw strings into QuickBooks/Xero and re-edit each line
downstream, or hand-edit them in the review grid before exporting. Both
flows are slow and error-prone — the same merchant gets typed three
different ways across statements.

We already have an `LlmProvider` abstraction (ADR-019, ADR-020) used for
extraction. Adding a second batched LLM call that cleanses descriptions
and/or picks a category from an operator-editable list lets us reuse
the same provider plumbing — local Qwen3-8B by default, optional
Anthropic provider — without coupling downstream code to provider
identity.

## Decision

Two **opt-in, operator-triggered** transforms applied per statement:

1. **Cleanse description.** Normalize "POS DBT 0123 SQ \*AMTHAUS" into
   "Square — Amthaus". Stored on `transactions.cleansed_description`
   (text, nullable). Promoted to `<NAME>` at OFX/QFX/QBO export time
   when present, with the raw bank string preserved in `<MEMO>`.
2. **Assign business category.** Pick exactly one entry from the
   operator-editable `business_categories` table. Stored as a UUID FK
   on `transactions.business_category_id`. Surfaced in the Generic CSV
   export (`Category` column). Categories are case-insensitively unique;
   the default seed is IRS Schedule C-aligned (~20 entries).

### Provider abstraction

A new `LlmProvider.complete({ systemPrompt, userPrompt, schema, schemaName? })`
method handles arbitrary structured-output calls. Both `LocalGatewayProvider`
(OpenAI `response_format: json_schema`) and `AnthropicProvider` (tool
with `input_schema`) implement it. `extract()` keeps its specialized
behaviour (extraction system prompt, exemplars, prompt-budget truncation,
`ExtractionResult` validation); `complete()` is the lower-level escape
hatch the enrichment service uses.

### Run timing

**Manual trigger.** Two buttons on the review page — "Cleanse
descriptions" and "Assign categories" — make a single batched call per
click. Toggles in `system_settings` (`enrichment.cleanse_enabled`,
`enrichment.category_enabled`) hide either button when disabled. No
auto-run during extraction: the LLM cost should be deliberate, and a
button click is the cleanest place to honor "skip user-edited rows".

### Skip-user-edited semantics

`transactions.enrichment_user_edited` flips `true` whenever the operator
overrides either field via the review grid. A subsequent batch enrich
skips those rows, preserving manual edits. Flipping the toggle also
appears in the row's audit-log trail.

### Caching

Redis cache keyed by `(raw_description, account_type, request_kind)`
mirrors the OCR cache (`apps/api/src/services/ocr-cache.ts`). 30-day
TTL. The cache key bakes in `ENRICHMENT_PROMPT_VERSION` so a prompt
change invalidates every entry without a manual flush.

### Cost

Anthropic monthly-cap check (existing `llm.anthropic.monthly_cap_usd`
setting) gates enrichment exactly like extraction. Local provider is
free.

### Audit

One audit row per click: `action='statement.enriched'`, payload
`{ cleanse, categorize, txCount, enrichedCount, skippedUserEditedCount,
cacheHits, llmCalls, costMicros, model, provider }`.

## Consequences

- **Pro:** Bookkeepers see human-readable merchant names in QuickBooks
  imports without re-editing every line.
- **Pro:** Aggregating spend by category becomes possible
  (`SELECT business_category_id, SUM(amount_cents) FROM transactions`).
- **Pro:** Operator-editable category list adapts to per-firm
  vocabulary; the LLM gets the live list as prompt context and the
  schema enum.
- **Pro:** Same provider abstraction as extraction — adding a third
  enrichment (e.g., merchant geocoding) is a parallel call, not a new
  abstraction.
- **Con:** Anthropic users pay per click. Mitigation: the cache hits
  hard on second-and-subsequent statements per merchant.
- **Con:** Categories are operator-editable, so they can drift between
  firms. Acceptable: the Vibe product is single-firm-per-host.
- **Con:** The Generic CSV gains two columns. QBO/Xero/QFX/QBO
  importers don't accept extra columns, so those formats stay unchanged.
  Documented in `docs/operator-guide.md`.

## References

- BuildPlan §33 (enrichment phase).
- `apps/api/src/services/enrichment.ts` (service entry point).
- `packages/extractor/src/prompts/enrich.ts` (prompts).
- `packages/shared/src/schemas/enrichment.ts` (Zod + JSON Schema).
- `apps/api/src/db/migrations/0007_enrichment.sql` (schema + seed).
