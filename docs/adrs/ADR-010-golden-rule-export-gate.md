# ADR-010 — Golden Rule reconciliation gates exports by default

## Status

Accepted.

## Context

The "Golden Rule" of bank-statement reconciliation: **opening balance + sum
of transactions = closing balance**. If a statement we extract doesn't
satisfy that identity, at least one of the values is wrong — a missed
transaction, a misread amount, an off-by-one cents error, or a
miscategorized opening/closing balance. Letting an unbalanced statement
flow into QuickBooks creates downstream books-don't-tie problems that take
hours to track down. We need a hard gate, but operators sometimes have
real reasons to override (e.g., the bank's PDF itself doesn't tie because
of a mid-period adjustment that's documented elsewhere).

## Decision

**Export is blocked by default whenever the Golden Rule fails.** The
reconciler at `packages/reconciler/src/golden-rule.ts` runs after every
extraction and writes its result to `statements.reconciliation_status`:

- `verified` — equation holds within ±$0.00 (cents-exact). Exports are
  unblocked.
- `discrepancy` — equation fails. Exports are blocked at the API and
  greyed out in the UI.
- `overridden` — operator explicitly clicked "Export anyway" through a
  typed-confirmation modal that requires typing the literal string
  `EXPORT ANYWAY`. The override is recorded in `audit_log` with the actor,
  timestamp, statement ID, and the discrepancy delta in cents.
- `pending` — reconciliation has not run yet (statement still in the
  extracting/reconciling pipeline).
- `failed` — reconciler crashed; treated as `discrepancy` for export
  purposes.

The reconciler runs once after extraction and again every time the user
saves an edit in the review grid, so the badge stays in sync with edits.

## Consequences

- **Pro:** Books-don't-tie surprises caught at the source, not downstream.
- **Pro:** Audit trail of every override creates accountability.
- **Pro:** Cents-exact comparison is unambiguous — no fuzz to argue about.
- **Con:** Operators learn to type `EXPORT ANYWAY` if the gate is too
  strict. Mitigation: the typed-confirmation copy spells out what the
  discrepancy is and what dollars are at stake; the gate is a friction
  point, not a wall.

## References

- `packages/reconciler/src/golden-rule.ts`
- BuildPlan.md §3 ADR-010, Phases 16, 24.
