# Extraction reference

Reference for engineers and reviewers covering the extraction pipeline:
the LLM prompt, the TRNTYPE inference rules, the FITID derivation, the
locale-confirmation gate, and the LLM repair pass.

The pipeline runs inside a BullMQ worker (Phase 15) and is implemented
across `packages/extractor/` and `packages/exporters/`.

## Pipeline at a glance

```
PDF → preprocess (text-layer probe + raster routing)
    → GLM-OCR (over HTTP, ADR-003)
    → markdown cleanup + token-budget truncation
    → LLM extraction (LocalGatewayProvider | AnthropicProvider)
    → JSON-Schema-validated ExtractionResult
    → locale-confirmation gate (Phase 15 #4a/#4b)
    → reconciler + period-bounds check (Phase 16)
    → optional repair pass (Phase 16 #6, one shot)
    → TRNTYPE inference + FITID derivation (Phase 17)
    → persist; statement enters `review` (or `awaiting-locale-confirmation`)
```

## Markdown cleanup pass

Before the prompt is built, OCR / text-layer markdown is run through
`cleanupMarkdown()` in `packages/extractor/src/prompts/extract.ts`.
Strips repeating page-headers/footers (`Page \d+ of \d+`,
disclosure boilerplate) and collapses runs of blank lines so the
token budget is spent on transactions.

## Token budget

`prepareMarkdown()` in `packages/extractor/src/llm-client.ts`:

- Reserves `4000` tokens for system prompt + completion overhead.
- Allowed input = `LLM_MAX_PROMPT_TOKENS - 4000`, default `24000 -
4000 = 20000`.
- Token estimate is a rough chars/4 heuristic.
- When the cleaned markdown exceeds the budget, the **tail** is
  truncated. Opening balance and the early period are higher priority
  than the trailing footer.
- Truncation is reported in telemetry so the operator can see when it
  fires.

`LLM_MAX_PROMPT_TOKENS` is the env var; lower it for cheaper providers.

## Prompt structure

System prompt (`SYSTEM_PROMPT` in `prompts/extract.ts`) is a small set
of hard rules, verbatim:

1. Amounts are signed integer cents; debits negative, credits positive;
   credit-card statements flip the sign convention.
2. Dates are ISO 8601; the model detects the source format and
   normalizes. Genuinely ambiguous statements get
   `source_date_format = "AMBIGUOUS"`.
3. Do not invent transactions; skip headers, subtotals, footers.
4. `running_balance_cents` is optional.
5. `opening + sum(amounts)` MUST equal `closing`. If it doesn't,
   include `notes`.
6. `source_page` is the 1-based page where the row appears.
7. `trntype` is set only when the description clearly indicates one;
   otherwise omit and let `inferTrntype` decide.
8. `confidence` ∈ [0, 1] reflects the model's certainty per row.

User prompt is assembled per-call by `userPromptFor()` and contains the
cleaned markdown framed with `=== STATEMENT MARKDOWN ===` markers. When
the operator has confirmed a date format (locale gate), an explicit
override line is injected:

> Operator override: interpret every date in the markdown using the
> **MDY** format. Set source_date_format to "MDY" with confidence 1.0.

## Exemplars

In-context exemplars live in `packages/extractor/src/exemplars.ts` and
are sanitized — no real account numbers, no real PII. They are sent to
the local provider only; the Anthropic provider gets a smaller subset
to keep token cost down.

The spec calls for **10** exemplars (Phase 12 #8). The codebase now
ships 10 labelled exemplars in `exemplars.ts`. `PROGRESS.md` still
flags Phase 12 as partial because the schema is flat (the spec calls
for a nested institution / account / period / balances / transactions
shape) — until that refactor lands the exemplars validate against the
flat schema only.

## Locale confirmation gate (Phase 15 #4a / #4b)

After the LLM extraction is persisted, the worker branches on
`source_date_format.format`:

- `MDY`, `DMY`, `YMD`, `TEXTUAL` → proceed to the reconciler. The
  detected format is stored for display but the user is not blocked.
- `AMBIGUOUS` → set `status='awaiting-locale-confirmation'`, halt the
  job successfully (no error), emit a `statement.locale_confirmation_required`
  audit event. Transactions, balances, and period bounds are still
  persisted so the user can see the partial extraction. Exports are
  blocked.

`POST /api/statements/:id/confirm-date-format` (body `{ format:
'MDY'|'DMY' }`) wipes the prior derived transactions, enqueues a fresh
extraction job with `dateFormatOverride` set, and on completion sets
`source_date_format_user_confirmed=true` on the statement row.
Subsequent runs reuse the override unless the user picks again.

The review UI surfaces the LLM's own `source_date_format.evidence` and
`sample` strings verbatim in the confirmation banner — the user picks
between MDY and DMY with both interpretations visible.

## LLM repair pass (Phase 16 #6)

If the reconciler returns `discrepancy` (either balance mismatch or
period-bounds violations), `repairPromptFor()` builds a second-pass
prompt containing:

- The original OCR markdown.
- The attempted transaction list as a table, with suspect rows
  flagged.
- The signed `delta_cents = closing - (opening + sum(amounts))`.
- Opening and closing balances.

The LLM re-emits the full transaction list under the same JSON Schema.
The reconciler runs again. If still not verified, the statement
settles in `discrepancy` and the user fixes manually. Repair is
**capped at one pass** — there is no recursion. The original and
repaired extractions are both persisted as audit-log entries for diff
inspection.

## TRNTYPE inference rules

`packages/exporters/src/trntype-rules.ts → inferTrntypeWithReason()`.
First match wins. The verbatim rule order:

1. **`checkNumber` present** → `CHECK` (reason `rule:check-number`).
2. **LLM hint provided** and a known enum value → use it (reason
   `llm-hint`).
3. **Description regex pass.** Each rule below tested in order against
   the normalized description. First match wins.
   - `interest|int paid|int earned|interest credit` → `INT`
   - `dividend|div paid` → `DIV`
   - `service charge|maintenance fee|monthly fee` → `SRVCHG`
   - `\bfee\b|overdraft fee|nsf fee` → `FEE`
   - `atm withdrawal|atm w\/d|withdrawal at machine|atm cash` → `ATM`
   - `direct deposit|payroll|adp|paychex|gusto|salary deposit` →
     `DIRECTDEP`
   - `ach debit|preauthorized debit|direct debit` → `DIRECTDEBIT`
   - `transfer|xfer|to acct|from acct|tfr to|tfr from` → `XFER`
   - `pos purchase|debit card purchase|visa purchase` → `POS`
   - `online payment|bill pay|web pay|epay` → `PAYMENT`
   - `wire (in|received)` → `XFER`
   - `wire (out|sent)` → `XFER`
   - `deposit` → `DEP` (after the more specific deposit-like rules
     above have run)
   - `cash withdrawal|cash out` → `CASH`
4. **Sign fallback.**
   - On a **credit card**: `amountCents > 0` → `DEBIT` (charge);
     `amountCents <= 0` → `PAYMENT`.
   - Otherwise: `amountCents >= 0` → `CREDIT`; `< 0` → `DEBIT`.

`getTrntypeReason()` returns the rule id (`rule:atm`, `llm-hint`,
`sign-fallback:cc-positive`, etc.) and is shown in the review-grid
tooltip so operators can see why a row got its TRNTYPE.

`normalizeDescription()` lower-cases the description, collapses
whitespace, strips `#1234` / `*5678` merchant suffixes, drops long
numeric tokens (terminal IDs ≥ 6 digits), and trims punctuation. The
same normalization is used for the FITID hash input.

## FITID derivation (ADR-005)

`packages/exporters/src/fitid.ts → computeFitid()`:

```
FITID = "VTC-" + sha1(`${posted_date}|${amount_cents}|${normalized_desc}|${seq_in_day}`).slice(0, 16)
```

Total length: `4 + 16 = 20` characters. Inputs:

- `posted_date` — ISO 8601 (`YYYY-MM-DD`).
- `amount_cents` — signed integer cents, formatted as `BigInt.toString()`.
- `normalized_desc` — output of `normalizeDescription()`.
- `seq_in_day` — 0-based ordinal of this transaction within its
  posted-date inside the same statement.

`assignSeqInDay()` deterministically orders rows sharing a date by
`(sourceLine, amount_cents, description)` so re-extraction produces
stable seqs. This satisfies ADR-016 determinism: the same PDF in →
the same FITIDs out → the same export bytes (modulo `<DTSERVER>`).

Editing TRNTYPE does **not** change the FITID — `trntype` is not part
of the hash input. Editing the description **does** change it (ADR-005:
a corrected description is logically a different transaction).

## Supported exemplars (today)

Ten exemplars in `packages/extractor/src/exemplars.ts`:

- `chase-business-checking`
- `wells-fargo-savings`
- `amex-credit-card`
- `simple-checking`
- `bofa-checking`
- `capital-one-credit-card`
- `discover-credit-card`
- `citi-credit-card`
- `us-bank-checking`
- `pnc-business-checking`

Each is sanitized (no real PII / account numbers) and round-tripped
through the Zod extraction schema in tests.
