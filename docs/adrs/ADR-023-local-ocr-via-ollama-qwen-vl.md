# ADR-023 — Local OCR + extraction via Ollama Qwen-VL, removing Vibe Shield

## Status

Accepted. Supersedes ADR-022 (OCR via Vibe Shield). Amends ADR-019 / ADR-020
(provider abstraction): the `local` provider is now Ollama; the Anthropic
provider is text-only.

## Context

ADR-022 routed OCR for scanned statements through the **Vibe Shield** gateway
(Claude vision, PII token-overlay), and the local LLM path went through a
separate "Vibe LLM Gateway". The operator is standing up a **locally-hosted
Ollama** runtime serving **Qwen** models and wants it to do _all_ local
processing — both text extraction and OCR — with **Vibe Shield and GLM-OCR
removed entirely**. The reference implementation is the sibling `myBooks`
project (`packages/api/src/services/ai-providers/ollama.provider.ts`), which
drives Ollama directly.

## Decision

- **Two paths, one local provider.** `LocalGatewayProvider` (id `local`) drives
  Ollama directly:
  - **Text-layer statements** → OpenAI-compatible `POST /v1/chat/completions`
    with `response_format: { type: 'json_schema', … }` (unchanged wire).
  - **Scanned/image statements** → native `POST /api/chat` with the page
    image(s) (`messages[].images: [<base64>]`) and `format: <extraction JSON
schema>`. Qwen-VL **OCRs and extracts in one call** (direct vision→JSON);
    there is no intermediate OCR-markdown step. `temperature: 0`, a longer
    (120 s) per-call budget than text, and the same one-shot
    missing-field reminder retry as the text path.
  - Models default to `qwen3.5:35b-a3b` (text) and `OLLAMA_VISION_MODEL`
    (vision; falls back to the text tag when it is itself multimodal), both
    operator-overridable from `/admin/llm-provider`.
- **Anthropic is text-only.** The optional `AnthropicProvider` keeps the
  tool-use JSON-schema extraction from OCR/text-layer **markdown** and now
  **rejects image inputs**. It talks to `https://api.anthropic.com`
  (`ANTHROPIC_BASE_URL` override retained for a plain Messages-API proxy).
- **The worker forces `local` for image runs** regardless of the operator's
  local/anthropic policy — Anthropic cannot read page images. The text-layer
  path still honors the policy (local-only / anthropic-only / local-first /
  anthropic-first).
- **Shield surface deleted:** `shield-ocr-client.ts`, `services/shield.ts`,
  the `shield:smoke` script, the `vibe-shield` engine, all `VIBE_SHIELD_*`
  env, the per-conversion session, the `<ENTITY_N>` tokenize/materialize
  cycle, and the Shield "unknown page" review hold.

## Consequences

- **Zero OCR/LLM egress by default — stronger than ADR-022.** Page images are
  processed on the local Ollama and **never leave the firm**. This _replaces_
  the ADR-022 invariant change ("page images leave only via Shield, redacted")
  with the original, stricter rule ("page images never leave"). The no-egress
  allowlist drops the Shield host; the only loopback target is Ollama. The
  optional Anthropic provider remains the single opt-in egress carve-out, and
  it only ever receives **cleartext OCR/text markdown** (never images), exactly
  as ADR-020 already permitted.
- **OCR output is cleartext.** With Shield gone there are no `<ENTITY_N>`
  tokens and no materialize step. Descriptions are stored and exported in
  cleartext; FITID/seq derive directly from them (still a non-PII hash of
  date | amount | normalized_desc | seq), so re-imports stay idempotent
  (ADR-005 / ADR-016) without the materialize-before-FITID dance.
- **OCR-error safety net (review hold).** Because OCR can misread a row whose
  amount still ties (so the Golden Rule passes), the worker holds a statement
  for human review before export when any transaction's model-reported
  confidence is below `VIBETC_REVIEW_CONFIDENCE_THRESHOLD` (default 0.7; set 0
  to disable). This reuses the existing review-hold gate — `reviewHoldReason`
  on the statement, `assertNotHeldForReview` in the export path, and the
  acknowledge endpoint — so a low-confidence extraction cannot be exported
  until an operator verifies it. Reconciliation-discrepancy gating is separate
  and unchanged.
- **Check payees read locally.** Reading the "Pay to the order of" payee off
  cancelled-check images (the `resolveCheckPayees` pass + the inline payee in
  the scanned-extraction prompt) runs on the same local Qwen-VL model via
  `LlmProvider.completeWithImages` — page images never egress. Matched payees
  are written to `transactions.payee` (the OFX `<NAME>` source). The pass
  auto-runs after extraction for check rows left without a payee
  (`VIBETC_CHECK_PAYEE_AUTO`, default on) and from the manual review-page
  button. The Anthropic provider plays no part (it is text-only).
- **Cost.** OCR is free again (local hardware); `costMicros` on the local
  provider is `0`. Anthropic text extraction still meters tokens/cost.
- **Dormant columns kept.** `statements.shield_session_id`,
  `page_classifications`, and `review_hold_reason` are retained (no longer
  written) to avoid a churny migration; a later migration may drop them.
- **Operator prerequisite.** A reachable Ollama (`OLLAMA_BASE_URL`, default
  `http://localhost:11434`) with the text tag pulled, and — for scanned PDFs —
  a multimodal tag (`OLLAMA_VISION_MODEL`, e.g. a Qwen `-VL` model) pulled.
  Verify with the `/admin/llm-provider` "Test connection" probe (Ollama
  `GET /api/tags`).

## Env

Removed: `VIBE_SHIELD_*`, `GLM_OCR_*`. Added/changed: `OLLAMA_BASE_URL`
(default `http://localhost:11434`), `OLLAMA_VISION_MODEL`,
`OLLAMA_VISION_TIMEOUT_MS` (default 120000), `OLLAMA_KEEP_ALIVE` (default
`30m`), `OLLAMA_NUM_CTX` (optional), `OLLAMA_VISION_THINK` (optional on/off),
`VIBETC_OCR_RASTER_DPI` (default 200), `VIBETC_OCR_RASTER_JPEG_QUALITY`
(default 80); `LLM_MODEL_ID` default is now `qwen3.5:35b-a3b`. `ANTHROPIC_*`
retained.
