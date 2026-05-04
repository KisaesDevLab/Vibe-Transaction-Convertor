# ADR-006 — TRNTYPE inference: rules first, LLM as tiebreaker

## Status

Accepted.

## Context

OFX requires every transaction to declare a `<TRNTYPE>` — one of `CREDIT`,
`DEBIT`, `INT`, `DIV`, `FEE`, `SRVCHG`, `DEP`, `ATM`, `POS`, `XFER`, `CHECK`,
`PAYMENT`, `CASH`, `DIRECTDEP`, `DIRECTDEBIT`, `REPEATPMT`, `HOLD`, `OTHER`.
Statement PDFs do not encode TRNTYPE directly; we have to infer it from the
description. Asking the LLM for TRNTYPE on every row is wasteful (95% of cases
are obvious from the description) and slows extraction. Hand-rolling rules
covers the obvious cases cheaply.

## Decision

TRNTYPE inference is a **two-stage pipeline**:

1. **Rule-based pass** — regex patterns over `normalized_description` plus
   sign of `amount_cents` resolve clear cases (`POS`, `ATM`, `CHECK`,
   `DIRECTDEP`, `DIRECTDEBIT`, `XFER`, `FEE`, `INT`, `SRVCHG`, etc.). Rules
   live in `packages/exporters/src/trntype-rules.ts` as an ordered list; the
   first match wins.
2. **LLM tiebreaker** — when no rule fires, the extractor's LLM call is asked
   to suggest a TRNTYPE for the row and the suggestion is folded into the
   extraction result. This is essentially free since the LLM is already
   running over the same text.
3. **User override** — every row in the review grid (Phase 18) carries a
   TRNTYPE picker. User edits set `transactions.user_edited = true` and
   never get auto-overwritten on re-extraction.

Default fallback when nothing matches and no LLM suggestion arrives:
`OTHER` for descriptions, `CREDIT`/`DEBIT` based on amount sign for
balance-affecting rows.

## Consequences

- **Pro:** Most rows resolve without an LLM round-trip in the inference path.
- **Pro:** Rules are unit-testable and reviewable as a flat list.
- **Pro:** Per-row override empowers operators in the long tail.
- **Con:** Rules need maintenance as banks change merchant naming
  conventions. Mitigation: rules are data, not code paths — adding a regex
  is a one-line PR.
- **Con:** `OTHER` shows up more than ideal in the long tail; the review UI
  surfaces these prominently so users can correct them before export.

## References

- `packages/exporters/src/trntype-rules.ts`
- BuildPlan.md §3 ADR-006, Phase 17.
