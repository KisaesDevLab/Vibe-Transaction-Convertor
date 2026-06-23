# INTEGRATION — purpose-built statement-extraction models

Canonical contract for integrating the two purpose-built statement models into
Transaction Converter. Source: operator handoff (model box at
`192.168.68.105`). This is the repo-side mirror of
`~/transaction-converter/INTEGRATION.md`.

> **STATUS: awaiting `statement_schema.json`.** The schema (§7) drives the
> `format` payload, the Zod mirror, and the deterministic reconciliation. Paste
> it into §7 (and commit `statement_schema.json` next to this file) before
> implementation starts.

## 1. Connection

| Item            | Value                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| Ollama base URL | `http://192.168.68.105:11434` (LAN) / `http://localhost:11434` (same box)                                    |
| Endpoint        | `POST /api/chat` (native — **not** `/v1/chat/completions`)                                                   |
| Auth            | none                                                                                                         |
| OCR upstream    | GLM-OCR `http://…:8082/v1/chat/completions` (per page) **or** Vibe-PaddleOCR `http://…:8099/ocr` (whole PDF) |

Firewall: allow `11434` from `192.168.68.0/22` (same as `8082`).

## 2. Models (selectable per call)

| Model              | Size | Use                         |
| ------------------ | ---- | --------------------------- |
| `qwen2.5-stmt`     | 7B   | fast — triage / high volume |
| `qwen2.5-stmt-32b` | 32B  | booking-grade / zero-review |

Both bake in the full CPA prompt + `temperature 0` + `num_ctx 32768` +
`repeat_penalty 1.0`. **The app sends no system prompt.**

## 3. Exact request

```jsonc
{
  "model": "qwen2.5-stmt", // or qwen2.5-stmt-32b
  "stream": false,
  "format": {
    /* statement_schema.json — REQUIRED every call */
  },
  "messages": [
    {
      "role": "user",
      "content": "<statement_ocr>\n{ONE_PAGE_OF_GLM_OCR_OUTPUT}\n</statement_ocr>",
    },
  ],
}
```

Three non-negotiables: **send `format`** (the hard grammar that blocks the
array-collapse), **no system message** (baked), **one page per call** (whole
statement ≈ 25k+ tokens → truncation).

## 4. Processing order (Transaction Converter pipeline)

Each step emits one `statement.extraction-step` audit row (per-step logging,
v0.1.40).

| #   | Step                                                                                                                                                                                | once / per-page | Endpoint / model | New?           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------- | -------------- |
| 0   | Upload & dedup (SHA-256)                                                                                                                                                            | once            | —                | unchanged      |
| 1   | Preprocess / route (text-layer vs scanned, page count)                                                                                                                              | once            | —                | adapted        |
| 2   | Per-page text: OCR (`:8099` PDF / `:8082` per page) split on `<!-- page N -->`, **or** text-layer per page                                                                          | per-page        | OCR              | adapted        |
| 3   | Header-crop read: crop top ~16% of page 1, OCR it → `account`/`institution`/`period`                                                                                                | once            | GLM-OCR          | **new**        |
| 4   | Per-page extraction: `/api/chat` + `format`, no system prompt                                                                                                                       | per-page        | statement model  | **new engine** |
| 5   | Merge per-page `transactions`; stamp `source_page` from page index; near-dup guard                                                                                                  | once            | —                | **new**        |
| 6   | Coerce (`normalize.repair`) + **per-row** Zod-validate; failures → review, not batch-reject                                                                                         | once            | —                | extended       |
| 7   | Deterministic reconciliation: `opening = rb[0]−amt[0]`, `closing = rb[-1]`, chain `rb[i]=rb[i-1]+amt[i]`, flag breaks. **Ignore the model's per-page `balances`/`reconciliation`.** | once            | —                | **changed**    |
| 8   | Persist (FITID, infer TRNTYPE), status → review; hold chain-break / low-confidence rows                                                                                             | once            | —                | unchanged      |
| 9   | Check-payee resolution                                                                                                                                                              | once            | GLM / qwen3-vl   | unchanged      |
| 10  | Enrichment (cleanse/categorize, structured fields)                                                                                                                                  | on-demand       | text model       | unchanged      |
| 11  | Export (CSV/OFX/QFX/QBO), gated by step 7                                                                                                                                           | on-demand       | —                | unchanged      |

The current single whole-statement `/v1` call (system prompt + 10 exemplars) is
replaced by **2→5**: split → per-page `/api/chat`+`format` → merge. Truncation
and array-collapse disappear (grammar always on; per-page output is small).

## 5. App responsibilities (the model can't do these)

- Get page OCR first; split on `<!-- page N -->`.
- Header/metadata via a **separate header-crop OCR of page 1** (table-dominated
  body drops the bank/account/opening/closing prose).
- Merge per-page `transactions`; set `source_page` from the page index
  (per-page calls each see only one page → all say page 1).
- **Authoritative reconciliation downstream, deterministically** — derive
  opening/closing from the running-balance chain; do **not** trust the per-page
  model's `balances`/`reconciliation`.
- Coerce + per-row Zod-validate; route failures to review, never reject the
  batch.

## 6. Quality notes

- `format` is the hard guarantee; the baked prompt only steers.
- 7B occasionally mis-tags `payee`/`check_number` — swap `model` to 32B for
  booking-grade (same call).

## 7. `statement_schema.json` — **TODO (paste verbatim)**

```jsonc
// PLACEHOLDER — paste the contents of ~/transaction-converter/statement_schema.json here,
// and commit the file as docs/integrations/statement_schema.json.
// This drives: (a) the `format` payload on every /api/chat call,
//              (b) the per-row Zod validator (§6),
//              (c) which fields feed deterministic reconciliation (§7 of the pipeline).
```

**Zod mirror — TODO:** generated from the schema above once provided, kept in
lockstep so `format` (model) and the validator (app) cannot drift.

## 8. Open decisions (resolutions — operator delegated "do what's best")

1. **New selectable engine vs. full replacement.** → **Selectable engine.** Add
   a "statement-model" engine (like the VibeOCR selector); keep the current
   `/v1` + exemplars path as a fallback.
2. **Default model.** → `qwen2.5-stmt` (7B) default + per-statement / per-firm
   switch to `qwen2.5-stmt-32b`.
3. **Reconciliation authority.** → Move export-gating to the **derived
   running-balance chain** when the per-page engine lands; the whole-statement
   fallback keeps the model's `balances` Golden Rule until then.
4. **Per-row confidence.** The new prompt schema has only a doc-level
   `confidence`. → **Keep per-row `confidence` in our schema** (don't regress the
   per-row review-hold gate); the model fills it per row.
5. **Privacy invariant.** The new schema captures `account.holder_name`,
   `account_number`, `institution.address` — our invariant forbade extracting
   account-holder identity. → Capture them (operator's own single-firm data),
   but **keep holder identity out of audit payloads** / audit-viewer exposure.
6. **`source_text`.** → Add a `source_text` column (per-row grounding; great for
   the per-step "what we received" audit).

## 9. What shipped now vs. deferred

**Now (current schema, no break):** the new prompt's _methodology_ was ported
into `SYSTEM_PROMPT` + `IMAGE_SYSTEM_PROMPT` — role framing, the four core
principles (completeness / grounded-not-generated / **no-arithmetic-fixing** /
integer-cents), the 3-phase SURVEY → TRANSCRIBE → SELF-VERIFY procedure, the
detailed bank-vs-credit-card sign convention, the date-detection rules, and the
worked example. Field names stay on the current schema (`posted_date`,
`description`, `balances.opening_cents`, `source_date_format` object, per-row
`confidence`). ~90% of this wording carries into the new-schema prompt.

**Deferred (one clean migration, driven by `statement_schema.json`):** swap the
Zod `ExtractionResult` + JSON `format` + exemplars + worker parse→persist
mapping to the new shape (§10), so the fallback prompt and the new statement
models share one schema. Decisions 3–6 above land here.

## 10. New-schema fallback prompt + schema (verbatim — for the migration)

> Apply when `statement_schema.json` lands. The methodology below already ships
> (against the current schema, §9); this is the new-schema target.

### New schema (operator handoff `<schema>`)

```jsonc
{
  "account": {
    "holder_name": "string|null",
    "account_number": "string|null",
    "account_type": "bank|credit_card",
  },
  "institution": { "name": "string|null", "address": "string|null" },
  "period": { "start_date": "string|null", "end_date": "string|null", "currency": "string" },
  "balances": { "opening_balance_cents": "integer|null", "closing_balance_cents": "integer|null" },
  "source_date_format": "MDY|DMY|YMD|TEXTUAL|AMBIGUOUS",
  "transactions": [
    {
      "date": "string|null",
      "payee": "string|null",
      "amount_cents": "integer",
      "running_balance_cents": "integer|null",
      "trntype": "string",
      "check_number": "string|null",
      "source_page": "integer|null",
      "source_text": "string|null",
    },
  ],
  "reconciliation": {
    "sum_of_transactions_cents": "integer",
    "reconciles": "boolean",
    "reconciliation_note": "string|null",
  },
  "confidence": "number",
}
// transactions is ALWAYS an array; every key present.
// Reconcile vs the ACTUAL statement_schema.json before implementing (must match).
// trntype enum: [DEBIT, CREDIT, CHECK, DEPOSIT, WITHDRAWAL, FEE, INTEREST,
//   PAYMENT, TRANSFER, POS, ATM, OTHER] — mapped to OFX trntype via inferTrntype.
```

### Verbatim prompt (operator handoff)

The full new system + user prompt (role, core principles, 3-phase procedure,
13 hard rules, `<schema>`, worked example, output instruction) is stored in the
operator's `~/transaction-converter/INTEGRATION.md`. It targets the new schema
above; the app sends it as the system/user message for the Ollama + Anthropic
fallback once the schema migration is in place. The methodology is already live
(§9); only the field names + the new fields (`source_text`, top-level
`reconciliation`/`confidence`, `account.holder_name`) change at migration.

## 9. Implementation phases (after sign-off + schema)

1. Engine plumbing: `/api/chat` + `format` provider path, model selector, no
   system prompt for these models.
2. Per-page worker: split → loop → merge; `source_page` from page index.
3. Header-crop metadata read (page-1 top crop → OCR → account/institution/period).
4. Deterministic chain reconciliation + per-row validation routing to review.
5. Model-select UI + settings; docs/ADR; tests; gate.
