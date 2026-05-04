# ADR-005 — FITID derivation formula

## Status

Accepted.

## Context

QuickBooks, Quicken, Xero, and similar tools deduplicate imported transactions
by FITID. If we emit a fresh random FITID per export, re-importing a corrected
statement creates duplicates. If we derive FITID from `(date, amount,
description)` alone, two same-day same-amount transactions (e.g., two $4.50
coffees on the same Tuesday) collide and the second is silently dropped. The
existing `fitid` column must be deterministic across re-imports of the same
PDF and unique within a statement.

## Decision

```
FITID = "VTC-" + sha1(date | amount | normalized_desc | seq_index_in_day).slice(0, 16)
```

Total length: 4 + 16 = **20 characters**, which fits inside the OFX `<FITID>`
255-char limit with room to spare and stays compact in CSV exports.

- `date` is the ISO 8601 posted date (`YYYY-MM-DD`).
- `amount` is the signed integer cents (e.g., `-450` for a $4.50 debit).
- `normalized_desc` is the lower-cased description with whitespace collapsed
  and merchant-noise tokens stripped (rules in `packages/exporters/src/trntype-rules.ts`).
- `seq_index_in_day` is the 0-based ordinal of this transaction within its
  date inside the same statement, computed by the reconciler. The DB column
  `transactions.seq_in_day` persists this value.

Worked example: two $4.50 coffees on 2026-03-05 produce
`VTC-<sha1("2026-03-05|-450|starbucks|0")>` and
`VTC-<sha1("2026-03-05|-450|starbucks|1")>` — distinct under the seq
disambiguator, identical on every re-import of the same source PDF.

## Consequences

- **Pro:** Stable across re-imports — supports ADR-016 determinism.
- **Pro:** Disambiguates same-day-same-amount transactions cleanly without
  requiring access to source-of-truth bank IDs (which we don't have).
- **Con:** Edits that change the normalized description shift the FITID.
  This is desired: a corrected description means it is logically a different
  transaction in the user's books.
- **Con:** Reorganizing transactions within a day (rare) reshuffles seq
  indices. We compute seq in a deterministic way (sort by source line, then
  amount) so reorders happen only when the source PDF itself is re-OCR'd
  differently — which is itself a meaningful change worth re-importing.

## References

- `packages/exporters/src/fitid.ts`
- `packages/exporters/src/trntype-rules.ts`
- BuildPlan.md §3 ADR-005, Phase 17.
