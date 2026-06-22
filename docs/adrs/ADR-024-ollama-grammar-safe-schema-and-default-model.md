# ADR-024 — Grammar-safe schemas for Ollama + non-thinking default text model

## Status

Accepted. Amends ADR-019 / ADR-020 (provider abstraction) and ADR-023 (local
Ollama). Changes the default `local` text-extraction model and the schema sent
to Ollama's structured-output endpoints. No change to the Anthropic provider or
to the canonical Zod schemas.

## Context

Local-first extraction was falling back to Anthropic (or failing outright) on
scanned statements. Diagnosis from an operator audit-log export, confirmed by
direct probes against the operator's Ollama host (`/api/tags`, `/api/ps`,
timed `/v1/chat/completions` and `/api/chat` calls):

1. **`pattern` silently disables Ollama's grammar.** The canonical
   `ExtractionJsonSchema` constrains date fields with a regex
   `pattern: "^\\d{4}-\\d{2}-\\d{2}$"`. Ollama's structured-output engine
   (llama.cpp GBNF, used by both `/v1` `response_format.json_schema` and native
   `format`) does not support JSON-Schema `pattern`. When present it drops
   grammar enforcement for the whole schema — the model then free-writes prose.
   Reproduced: the exact pattern-bearing schema returned a Markdown summary
   ("**Account Summary** …") instead of JSON, which fails Zod and bounces the
   statement to the Anthropic fallback. The same schema with `pattern` removed
   returned valid, ISO-dated, integer-cent JSON.

2. **The default text model was a thinking model.** `qwen3.5:35b-a3b` is a
   reasoning MoE: every extraction/enrichment call spent thousands of tokens on
   a hidden reasoning pass (measured 2,900–7,000 `reasoning` tokens per call),
   adding latency and cost, and `/no_think` is not honored on the `/v1` surface.
   It also intermittently returned `HTTP 500` on the full statement payload.

The host itself was healthy and GPU-backed (~40 tok/s generation), so neither
problem was a hardware limit.

## Decision

- **Strip `pattern` from every schema sent to Ollama.** A new
  `sanitizeSchemaForOllama()` in `packages/extractor/src/llm-client.ts` deep-
  copies a schema and removes every `pattern` key at any depth. Applied at all
  three Ollama send sites in `LocalGatewayProvider`: text `/v1` extraction
  (`callGateway`), enrichment `/v1` (`complete`), and native vision `format`
  (`callOllamaVision`). The **Anthropic** provider keeps the full schema — its
  tool `input_schema` honors `pattern`.

- **Validation is unchanged.** The regex lives in Zod (`DateString` in
  `packages/shared/src/schemas/extraction.ts`) and runs after parsing in
  `parseExtractionResponse`. Stripping `pattern` only simplifies the grammar the
  model is constrained to; a non-ISO date is still rejected.

- **Default `local` text model → `qwen2.5:32b-instruct`** (non-thinking
  instruct). Resolution order is unchanged: admin `llm.ollama.model` (DB) →
  `LLM_MODEL_ID` env → this default. `qwen2.5-instruct` enforces the schema
  reliably with zero reasoning overhead; enrichment (cleanse/categorize) shares
  the same default provider, so it inherits the better categorizer.

- **Surface Ollama error bodies.** `callGateway` / `complete` / `callOllamaVision`
  now append the response body to non-2xx errors (mirroring the Anthropic path),
  so a future `HTTP 500` (model not pulled, OOM, grammar-compile failure) is
  diagnosable from the audit trace instead of a bare status code.

## Consequences

- Local-only extraction succeeds on the previously-failing scanned statement
  without Anthropic fallback; no thinking overhead.
- Operators must pull the model (`ollama pull qwen2.5:32b-instruct`) and, if a
  DB override is set, point `llm.ollama.model` at it in `/admin/llm-provider`.
- If a future schema needs a constraint Ollama's grammar can't express, prefer a
  Zod-only check over a JSON-Schema keyword that the sanitizer would have to
  drop. Other unsupported keywords (beyond `pattern`) can be added to
  `sanitizeSchemaForOllama` as they surface.
