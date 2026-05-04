# ADR-004 — JSON-Schema-constrained LLM generation

## Status

Accepted.

## Context

Every extraction call asks the LLM to emit a structured representation of a
bank statement: an array of transactions with dates, amounts, descriptions,
balances, and a few statement-level fields. Naïve "ask the model for JSON,
parse the string" pipelines fail in production: models hallucinate fields,
trail off mid-array, emit prose around the JSON, or close braces in the wrong
order. Free-text JSON parsing is the wrong place to discover schema drift.

## Decision

**LLM extraction is constrained by JSON Schema at generation time.** No
free-text JSON parsing — if the model can produce a token that violates the
schema, the gateway must reject that token. Two providers implement this:

- **`LocalGatewayProvider`** uses the existing OpenAI-compatible Vibe LLM
  Gateway with `guided_json` (vLLM) or llama.cpp grammar.
- **`AnthropicProvider`** (see ADR-020) uses tool-use with the schema as a
  single tool's `input_schema` and `tool_choice` pinned to that tool, which
  forces a schema-conformant `tool_use` block.

The canonical schema lives at
`packages/shared/src/schemas/extraction.ts` and is the single source of
truth — TypeScript types, Zod runtime validators, and the LLM input schema
are all generated from it.

## Consequences

- **Pro:** Model output that _does_ arrive is structurally valid by
  construction. The repair pass in Phase 16 only has to handle business
  invariants (sums, balances), not JSON syntax.
- **Pro:** Provider swap is a config change; downstream code never branches
  on which provider produced an object.
- **Con:** Constrained decoding is slower than free decoding. We accept the
  tradeoff for correctness.
- **Con:** Schema changes are breaking — every tier-1 schema bump invalidates
  the extraction cache and forces re-extraction on next access.

## References

- `packages/shared/src/schemas/extraction.ts`
- `packages/extractor/src/llm-client.ts`
- BuildPlan.md §3 ADR-004, Phases 12-13.
