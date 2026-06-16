# ADR-022 — OCR via Vibe Shield (Claude vision), replacing local GLM-OCR

## Status

Accepted. Supersedes ADR-003 (GLM-OCR over HTTP).

## Context

OCR for scanned statements was previously handled by a local GLM-OCR
server (ADR-003): rasterized page images → GLM-OCR HTTP → markdown, all
on-appliance, zero egress. The operator chose to remove GLM-OCR and route
OCR through **Vibe Shield** — the firm's self-hosted PII-redaction gateway
that proxies the Anthropic Messages API — using **Claude vision** to
transcribe pages.

This is a deliberate, operator-approved change to two CLAUDE.md hard
invariants ("OCR is always local"; "rasterized page images never leave").
Vibe Shield's own integration blueprint for this app
(`Vibe-Shield/compliance/integrations/vibe-tx-converter.md`, §4.6)
recommends keeping GLM-OCR; we are knowingly diverging from it.

## Decision

- Rasterized pages are sent to the Shield gateway `POST /v1/messages`
  (Anthropic Messages shape, base64 image block + transcription prompt),
  authenticated with the Shield tenant key (`Authorization: Bearer
vs_live_…`). The client lives in
  `packages/extractor/src/shield-ocr-client.ts` and keeps the prior
  client's resilience scaffolding (cache, retry, circuit breaker,
  concurrency).
- A per-conversion **Shield session** is opened at upload under the
  `cpa-converter-output` policy and stored on `statements.shieldSessionId`.
  Both the OCR call and the extraction LLM call quote it, so their PII
  tokens share one vault.
- Under `cpa-converter-output` (reid.mode=`none`) the OCR markdown and the
  extracted transaction fields come back **tokenized** (`<ENTITY_N>`) and
  are stored tokenized. The export path is the single cleartext-emission
  point: it calls `POST /v1/sessions/:id/materialize` to resolve tokens
  before writing the OFX/QFX/QBO/CSV file.

## Consequences

- **Egress.** Page images now leave the Converter — but only to the
  on-appliance Shield gateway, which masks PII before Claude sees them.
  The no-egress allowlist swaps the GLM-OCR host for the Shield gateway
  host. The raw source PDF still never leaves the firm.
- **Hard dependency on the token-overlay masker.** Shield's default image
  masker draws a solid black box over PII; under that masker Claude OCRs
  holes and the statement's holder/account/payee data is permanently lost
  (image-sourced PII is not re-identifiable). The `cpa-converter-output`
  policy MUST use the **token-overlay masker**. This is a Shield-side
  configuration prerequisite, verified before rollout.
- **Cost.** OCR was free (local); it now costs Claude vision tokens per
  page. The worker folds the OCR `usage` into the statement's LLM cost
  columns.
- **Out of scope (follow-ons from the official plan):** encrypting
  operator-input account/routing numbers with the Converter's own DEK,
  session-deletion retention sweeps, and backfilling existing cleartext
  descriptions to tokens.

## Known limitations (QA, verified against Vibe-Shield source)

These are accepted, documented limitations — the integration is shipped
but is **not functional end-to-end until the Shield-side items are
addressed**. Verified by reading the Vibe-Shield gateway + engine.

1. **CRITICAL — image PII is black-boxed, not token-overlaid.** Shield's
   engine masks image regions with `apply_solid_black_mask` (solid black
   rectangles); there is no token-overlay masker and no config flag for
   one (`apps/engine/app/image/masker.py`). The gateway swaps in the
   black-boxed image and does **not** pass the engine's tokenized OCR
   text to Claude. So Claude transcribes a statement with the account
   holder, account number, addresses, and payee names blacked out — that
   data is lost. **Blocked on Shield adding a token-overlay masker for
   `cpa-converter-output`.** Until then, OCR output is missing all PII
   fields.
2. **CRITICAL — session TTL ≤ 24h.** `POST /v1/sessions` caps
   `ttl_minutes` at 1440 (appliance default 60). Materialize-at-export
   needs the session alive, so an export more than the TTL after upload
   fails (`404`) and must re-OCR. We request the 1440 max; the ceiling is
   a hard Shield constraint.
3. **HIGH — check-resolution can't work through Shield.** Vision check-
   payee resolution sends the check image to Claude; Shield black-boxes
   the payee region (the very text being read). Disable check-resolve, or
   route it outside Shield.
4. **HIGH — FITID determinism (ADR-005 / ADR-016).** `normalizedDescription`
   and `FITID` are computed over the tokenized description; Shield tokens
   are session-scoped, so a re-upload (new session) can renumber them and
   change FITIDs, breaking idempotent re-import. Needs a stable-token or
   materialize-before-FITID strategy.
5. **Operator requirement.** The Shield tenant key (`vs_live_…`) MUST be
   issued with `appId='converter'`; the `cpa-converter-output` policy
   (and the materialize gate) is bound to that appId, not to the session.
   A wrong appId yields `403` at export.
