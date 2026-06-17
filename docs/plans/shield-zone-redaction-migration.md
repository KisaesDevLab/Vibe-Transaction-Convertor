# Migration plan — Shield zone-redaction vision extraction

**Status:** Planned, not built. Becomes **ADR-023** on implementation.
**Trigger:** Vibe Shield is moving the `cpa-converter-output` policy from
token-overlay OCR to **classify + zone-redact-holder + cleartext vision
extraction**. This plan supersedes most of ADR-022 once it ships.

## Decisions (locked)

1. **Scope: scanned-only.** The new Shield vision-extraction flow replaces
   only the **scanned / OCR** path. Digital **text-layer** PDFs keep the
   existing deterministic text→markdown→extract path unchanged. (This also
   neutralizes the determinism risk: we only do vision extraction where
   there was never a text layer.)
2. **Sessions: keep for audit, drop materialize.** Still open a
   per-conversion Shield session and bind it to the call for audit/policy;
   remove the token vault + export-time materialize (nothing to resolve —
   responses are cleartext).
3. **Timing: plan now, build when live.** Implement once the Shield change
   ships and the new contract can be smoke-tested end-to-end.

## New flow (scanned path only)

```
Converter rasterizes pages → ORIGINAL page images + extraction prompt
  → Shield POST /v1/messages (cpa-converter-output, session_id, Bearer)
       1. classify each image: statement | credit_card | check | deposit | transmittal
       2. zone-redact the HOLDER IDENTITY for that type (solid black, permanent)
       3. forward the REDACTED image to Claude (vision)
  → Claude returns structured extraction JSON (cleartext descriptions + payee) via tool_use
  → Converter persists cleartext; OFX/QFX/QBO <NAME> ← payee directly
```

Single call replaces the old two-stage `produceOcrMarkdown` (image→tokenized
markdown) **then** `extract` (markdown→tokenized JSON). For scanned docs the
model now extracts straight from the redacted image.

## Converter changes

### Remove / retire

- `packages/extractor/src/shield-ocr-client.ts` — the markdown-OCR client.
  (Image-blocks + tool-use already live in `AnthropicProvider.complete()`.)
- `apps/api/src/services/shield.ts` → `materialize()`.
- Export-time `materializeTxFields` (`exports.ts`) and worker
  `materializeDescriptionsForFitid` (`extraction.worker.ts`) — no tokens.
- The "materialize-before-FITID" dance (ADR-022 fix) — FITID now derives
  from cleartext directly.
- Tokenization assumptions throughout the scanned path.

### Add / repurpose

- **Image vision-extraction path** for scanned docs: rasterize → send page
  images + extraction tool/schema (`ExtractionJsonSchema`) to Shield
  `/v1/messages`; parse `tool_use.input` → cleartext `ExtractionResult`.
  Reuse `AnthropicProvider.complete({ images, schema, sessionId, policyName })`
  or add `extractFromImages()`.
- **Page batching** for multi-page statements (see open questions) — whole
  statement in one call vs per-page-batch + merge, with cost/limit guards.
- OFX/QFX/QBO `<NAME>` ← cleartext payee directly.
- **Classification handling**: if Shield returns per-page type + confidence,
  surface low confidence as a review hold (don't silently export a page
  whose holder-zone redaction may have clipped real data).

### Keep

- `createSession` / `deleteSession` + `statements.shieldSessionId` (audit).
- `session_id` + `policy_name=cpa-converter-output` + Bearer on the call.
- `max_tokens` ceiling clamp (extraction output still routes through Shield).
- Truncation guard.
- Engines / LLM-provider admin config; the PDF-strategy selector (its
  "OCR" branches now mean "Shield vision extraction").

### Strategy selector semantics (scanned-only)

- `force-text` / text-layer present → unchanged text path.
- `force-ocr` and the scanned branch of `auto` → Shield vision extraction.
- `auto-ocr-fallback` (text first, fall back to OCR) → on text failure,
  fall back to **image vision-extraction**.
- `auto-text-fallback` → vision-extract first, fall back to text layer.

## Invariant / doc updates (at build time)

- `CLAUDE.md`: "OCR tokenized / page images leave only tokenized / tokens
  materialized at export" → "scanned pages are **holder-zone-redacted**
  (solid black, permanent) at Shield before Claude; transaction descriptions
  - counterparty payee return **cleartext**; no materialize." Note the
    at-rest change: DB now holds cleartext descriptions/payees (not tokens).
- New **ADR-023**; mark ADR-022 superseded for the scanned path.

## Risks to verify against the live contract

- **Irreversible mis-classification** — wrong zone blacked out, no recovery.
  Need per-page classification + confidence returned; hold low-confidence.
- **Redaction must spare extraction-critical fields** — masked acct #,
  institution, period, opening/closing balances, every txn row
  (date/amount/payee/memo). Highest risk on `check`/`deposit` types.
- **Cleartext transaction egress** to Claude accepted (only holder shielded)
  — deliberate firm decision; reverses a hard invariant.
- **Determinism** — mitigated by scanned-only scope (text-layer PDFs keep
  the deterministic path); scanned was always model-transcribed.

## Resolved by the Shield team — image-vision extraction (Shield v1.13.0)

1. **Response schema — native Anthropic, no Shield envelope.** `/v1/messages`
   is an Anthropic-compatible proxy: it redacts the image blocks in place,
   forwards to Claude, and returns Claude's native `Message` unchanged. We
   get our `tool_use` block with `ExtractionJsonSchema` input exactly as
   Claude emits it. `tools` + image blocks together: **supported** (Shield
   only rewrites image blocks; tools/tool_choice/text pass through). Under
   `cpa-converter-output`, `reid.mode='none'` + `identity-zones` produces no
   tokens → **descriptions/payee are cleartext**, nothing rewritten on the
   response path. → Reuse `AnthropicProvider` with image blocks; parse
   `tool_use.input` as today.

2. **Classification surfacing — internal-only at v1.13.0; feature request
   filed.** Per-page document-type classification runs inside the engine and
   is **not returned** on `/v1/messages`. It is a **heuristic** today (a
   type, no numeric confidence). Shield agrees with the rationale and will
   wire it on a requested shape. **Our ask (for Shield to implement):**
   return per-page type via a `vs-page-classifications` response header
   (ordered to match the image blocks), e.g. `["bank_statement","check"]`;
   add a numeric confidence later. **Non-blocking** for v1.13.0 because
   redaction is entity-span + fail-closed (see #5) — a misclassification
   changes _which holder zones_ are redacted, not whether transaction data
   survives. We proceed without it and add the review-hold when it lands.

3. **Sessions — unchanged, both work.** `cpa-converter-output` still accepts
   `session_id` on `/v1/messages` (valid+tenant-matched → reused; omitted →
   ephemeral). `DELETE /v1/sessions/:id` still applies; 30-day TTL ceiling
   holds. No tokens to materialize → session is continuity/audit only. →
   Keep `createSession`/`deleteSession` + `shieldSessionId`; **remove
   `materialize()`** and the export-time resolve.

4. **Batching — no Shield image-count cap; the binding limit is JSON body
   size.** Each image block is classified+redacted independently, so
   multi-image messages work. The real constraint is the gateway's
   **`MAX_REQUEST_BYTES`** (default **1 MB**) — base64 page images blow past
   that fast, and the multipart carve-out does **not** apply to
   `/v1/messages`. Plus Anthropic's own limits: ≤100 images/request,
   ≤5 MB/image, ~8000px. **Shield recommendation: 1–3 pages per call, and
   raise `MAX_REQUEST_BYTES` on the appliance to cover the largest batch
   (~10–20 MB).** → **This makes page-batching + merge a required build
   component** (see below).

5. **Redaction zones — entity-span + position driven (OCR/recognizer-based,
   not fixed rectangles); never blanket-blacks.** Always **kept**:
   transaction rows (date/amount/description/payee/memo), statement period,
   balances, and the bank-printed **masked account # (last-4)**. Redacted:
   full account/routing and holder name/address. Per type:
   - `bank_statement` / `credit_card`: PERSON/LOCATION/full account/routing/
     SSN **only in the header above the first transaction row**; everything
     from the first date+amount row down is untouched.
   - `check`: payer PERSON/LOCATION above "Pay to the order of", plus
     account/routing anywhere (MICR). **Kept: payee, amount, date, memo,
     check number.**
   - `deposit` / `transmittal` / `unknown`: full holder-identity set
     everywhere (fail-closed maximal — no payee to preserve).
   - **Fail-closed:** classification/zone/mask failure fails the request; it
     never forwards an unredacted image. → Our `account.masked_number`
     extraction still works; we never sourced full account/routing from the
     statement anyway (operator inputs them).

6. **Minimum Shield version: v1.13.0** with `cpa-converter-output` using
   `image_masker: 'identity-zones'` (built in to v1.13.0). **Go-live gate:**
   the appliance is currently pinned **below** v1.13.0 — the manifest must
   be bumped to ≥ v1.13.0 first.

## Required build component — page-batching + merge — ✅ BUILT

Forced by the 1 MB body cap (#4): the scanned image path cannot send a whole
statement in one call. Built (`packages/extractor/src/image-batch.ts`,
`merge-extraction.ts`, JPEG rasterization in `preprocess.ts`, wired in
`extraction.worker.ts` `extractFromImagesBatched`):

- Rasterize pages to **JPEG at a controlled DPI** (smaller than PNG; stay
  under ≤5 MB/image and ~8000px), pack **1–3 pages per `/v1/messages`**
  within a configurable byte budget (`VIBE_SHIELD_IMAGE_BATCH_BYTES`,
  default sized for `MAX_REQUEST_BYTES`).
- Each batch is one vision-extraction call (images + schema tool, shared
  `session_id`) → partial `ExtractionResult`.
- **Merge:** concatenate `transactions` in page order; take header metadata
  (institution/account/period/opening) from the first batch that carries it,
  closing balance from the last; then run the existing Golden Rule
  reconciliation over the merged whole. Keep it pure + unit-tested.
- Per-batch failure surfaces with the page range; `max_tokens` clamp +
  truncation guard apply per call (output per 1–3 pages stays well under
  32000).

## Go-live gates (operator / manifest)

1. Appliance Shield pinned **≥ v1.13.0** with `cpa-converter-output` →
   `image_masker: 'identity-zones'` (`vibe-app.yaml` / appliance manifest).
2. `MAX_REQUEST_BYTES` raised on the Shield gateway (~10–20 MB) to fit the
   image batch.
3. ~~(When available) Shield returns `vs-page-classifications` → wire the
   low-confidence/clipped-page review hold.~~ ✅ **BUILT** (Shield shipped the
   header). `parsePageClassifications` (llm-client) → threaded through
   `extractFromImagesBatched` (concatenated to global page order) →
   persisted to `statements.page_classifications`. A page typed `'unknown'`
   sets `review_hold_reason` and blocks export (`assertNotHeldForReview` in
   exports.ts) until the operator acknowledges via
   `POST /statements/:id/acknowledge-review-hold` (amber banner on the
   review page). Migration `0014_review_hold_classifications`. A numeric
   confidence threshold can layer on when Shield adds confidence (the
   header stays `string[]`, so parsing is forward-compatible).

```

```
