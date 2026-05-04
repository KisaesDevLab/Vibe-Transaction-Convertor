# ADR-009 — Multi-account PDFs auto-split, user confirms before extraction

## Status

Accepted.

## Context

Many institutions deliver "household statements" — a single PDF containing,
e.g., a checking account, a savings account, and a credit card under one
customer. If we extract those as one statement, transactions get
co-mingled, balance reconciliation fails, and the user has no clean way to
separate them. Equally, splitting a statement automatically and silently
risks misattributing transactions when the heuristic fails.

## Decision

Multi-account PDFs are **detected and split before extraction proceeds**,
gated by user confirmation:

1. **Detection** — `packages/extractor/src/multi-account-detector.ts` scans
   the OCR'd / text-layer pages for account-number changes (regex over
   masked accounts like `••••1234`, `XXXXXXXXXX1234`, `Account Number:
1234567`). When two or more distinct masked numbers appear, the PDF is
   flagged as multi-account.
2. **UI confirmation** — the upload flow presents the operator with a "We
   detected N accounts in this PDF — confirm or correct the split before
   extraction begins" modal. Operators can accept the auto-split, drag
   page boundaries, or merge proposed splits.
3. **Extraction** — runs once per confirmed slice. Each slice becomes its
   own `statements` row tied to the appropriate `accounts` row.

Unsplit / single-account PDFs flow through directly without a confirmation
step. The detector is biased toward false positives; we'd rather ask the
user once than mis-extract silently.

## Consequences

- **Pro:** Each `statement` is tied to exactly one account and one balance
  range — Golden Rule reconciliation works cleanly.
- **Pro:** The user is the source of truth for ambiguous splits.
- **Con:** Adds a UI step before extraction begins for ~5-10% of uploads.
- **Con:** Detection misses (false negatives) silently extract as a single
  statement. Mitigation: the reconciler (Phase 16) will fail to balance,
  surfacing the issue at the review step.

## References

- `packages/extractor/src/multi-account-detector.ts`
- BuildPlan.md §3 ADR-009, Phase 14.
