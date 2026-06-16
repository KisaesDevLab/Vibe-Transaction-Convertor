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

## Status of the original QA blockers — RESOLVED in Vibe Shield v1.12

The two critical blockers found in QA were fixed Shield-side in
`feat(v1.12): Tx Converter OCR-via-Shield enablers` (verified against the
Vibe-Shield source):

1. **RESOLVED — token-overlay masker (was: black-box).** The
   `cpa-converter-output` policy now sets `image_masker: 'token-overlay'`.
   The gateway redactor OCRs each page image, allocates session-stable
   vault tokens for the PII spans, and stamps those `<ENTITY_N>` tokens
   into the image (`engine.overlayImage`) before Claude sees it. Claude
   transcribes the tokens (not black holes); the tokenized markdown
   round-trips through materialize at export. No Converter code change was
   needed — the `/v1/messages` image path picks up the policy's masker.
2. **RESOLVED — session TTL.** `POST /v1/sessions` now applies a
   per-policy ceiling; `cpa-converter-output` raises it to **30 days**
   (`max_session_ttl_minutes`). The Converter requests the full 30-day TTL
   at session create, so late exports still materialize.

### Verifying a deployment

Run the live smoke test from the API container (or anywhere with the
Shield env/DB config) — one command, exits non-zero with a remediation
line per failed prerequisite:

```
pnpm shield:smoke        # or: just shield-smoke   (add --no-llm to skip the tiny /v1/messages probe)
```

It checks gateway reachability, that the key's appId is `converter` (via a
30-day session create), the materialize policy gate, and ZDR (via a
minimal `/v1/messages` call). It does **not** spend Anthropic tokens when
a prerequisite fails earlier in the chain.

### Operator prerequisites (hard requirements)

- **Vibe Shield ≥ v1.12** (token-overlay masker + per-policy TTL).
- The Shield tenant key (`vs_live_…`) MUST be issued with
  **`appId='converter'`** — the `cpa-converter-output` policy, its
  token-overlay masker, its 30-day TTL ceiling, and the materialize gate
  are all bound to that appId. A wrong appId silently falls back to the
  bookkeeping policy (black-box masker, 24h TTL, `403` at materialize).
- The gateway MUST run with **ZDR enabled** (`ZDR_ENABLED=true`):
  `cpa-converter-output` sets `zdr_required: true`, so every Converter
  request is rejected if the gateway isn't ZDR-configured.

### Remaining known limitation

- **FITID determinism on forced re-extract (ADR-005 / ADR-016) — FIXED.**
  The extraction worker now derives `seq_in_day` + `FITID` from the
  **materialized cleartext** (materialize-before-FITID — see
  `materializeDescriptionsForFitid` in `extraction.worker.ts`), not the
  session-scoped tokens. So even a forced re-extract under a _new_ session
  (renumbered tokens) produces the same FITID and re-import stays
  idempotent in QuickBooks/Quicken. The tokenized form is still what's
  persisted at rest; only the non-PII FITID hash (date | amount |
  normalized_desc | seq) is derived from cleartext. Best-effort: if Shield
  is unreachable at extraction time, FITIDs fall back to token-derivation
  (still unique within the statement) with a logged warning.
- **check-payee resolution through Shield — partial, by design.**
  _Transcription_ works: Claude reads the token-overlaid `<PERSON_n>` and
  `materialize` resolves it to the real payee at export. What does **not**
  work — and cannot, by design — is asking Claude to _normalize / fuzzy-
  match_ the actual payee name (e.g. "WALMART #1234" → "Walmart"), because
  that needs the cleartext name to reach Claude, which violates Shield hard
  rule #1. Keep any such normalization out of Shield: disable check-resolve
  through the gateway, or run it against a local model. The transcription
  path should still be exercised end-to-end before relying on it.
