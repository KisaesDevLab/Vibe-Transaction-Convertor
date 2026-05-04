# ADR-019 — LLM provider abstraction (Local Gateway + Anthropic)

## Status

Accepted.

## Context

The product invariants in `BuildPlan.md` §0 say processing is local by
default — Qwen3-8B Q4_K_M behind the Vibe LLM Gateway is the canonical
extractor. But operators sometimes want higher-fidelity extraction for
edge cases (heavily formatted statements, scanned-and-OCR'd
edge-formatting, multi-column layouts) and are willing to send OCR text
to a cloud LLM in exchange for that quality. We need to support that
opt-in path without (a) compromising the default-local stance, (b)
mixing provider concerns into business logic, or (c) sending source PDFs
or rasterized images to anyone.

## Decision

LLM extraction runs through a single interface in
`packages/extractor/src/llm-client.ts`:

```ts
interface LlmProvider {
  extract(prompt: string, schema: JSONSchema): Promise<ExtractResult>;
}
```

Two implementations:

- **`LocalGatewayProvider`** — default. Talks to the OpenAI-compatible
  Vibe LLM Gateway at `LLM_GATEWAY_URL` with `LLM_MODEL_ID` (typically
  `qwen3-8b`). Uses `guided_json` / grammar-constrained generation.
- **`AnthropicProvider`** — optional. See ADR-020 for details. Off by
  default; admin must explicitly enable it through
  `Settings → LLM Provider`, supply an API key, and acknowledge a typed
  warning that OCR text egresses.

**Selection is system-wide**, persisted in `system_settings.llm.provider`,
audit-logged on change. The provider used at extraction time is recorded
on the `statements.llm_provider` column so a switch later doesn't
rewrite history. **Downstream code never branches on provider** — both
providers obey the same contract; the reconciler, the review UI, and the
exporters do not know or care which one ran.

Selection of model variant within the Anthropic provider is configurable
in admin (default `claude-sonnet-4-6`).

## Consequences

- **Pro:** Operator-controlled quality / privacy trade-off, with the
  right defaults.
- **Pro:** Provider swap is one DB row; no redeploy, no code change.
- **Pro:** Statements carry their provenance, so a customer can later
  ask "which extractions ran on cloud?" and get an exact answer.
- **Con:** The interface forces both providers to share a schema-driven
  output contract — that's the whole point.
- **Con:** Two code paths to test; mitigated by a shared contract test
  suite that runs against each provider.

## References

- `packages/extractor/src/llm-client.ts`
- `apps/api/src/services/auth.ts` (provider switch is admin-only)
- ADR-020
- BuildPlan.md §3 ADR-019, Phase 13.
