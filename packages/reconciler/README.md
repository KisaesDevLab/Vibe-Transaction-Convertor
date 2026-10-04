# @vibe-tx-converter/reconciler

The Golden Rule reconciler (ADR-010). Pure function — no I/O, no DB.
Given an opening balance, a closing balance, and a transaction list,
it answers: do these tie, exactly, in cents?

## Purpose

- Cents-exact verification that
  `opening + sum(transactions.amount_cents) == closing`. Anything
  else is a `discrepancy` and blocks export by default (operator can
  override via the typed-confirm modal).
- **Period-bounds defense-in-depth**: when `periodStart` /
  `periodEnd` / `transactionDates` are passed, count rows whose
  posted_date falls outside the banner. A consistent MDY-vs-DMY
  misdetection on day > 12 dates trips this even if the balance
  arithmetic happens to land — see `BuildPlan.md` Phase 16 #2a/#4b.
- **Suspect-row detection**: walks the running-balance column,
  flagging rows where the LLM's emitted `running_balance` disagrees
  with prior-row + amount. Used both by the LLM repair-pass prompt
  (give the model a precise hint) and by the review UI (per-row
  "off by $X" badge).
- **Heuristic repair candidates**: small set of corrections that often
  resolve a single-row error without an LLM round-trip — a sign flip
  only when exactly one row's flip closes the gap, and a drop only of an
  exact duplicate row (same amount, description and date). Anything
  ambiguous returns no candidate; the worker puts any applied
  heuristic repair behind a review hold.
- **Verified gate**: `verified` requires the balance to tie AND zero
  out-of-period rows (BuildPlan Phase 16 #2).

## Public API

```ts
export * from './golden-rule.js';
```

Notable exports:

- `reconcileGoldenRule(input): ReconcileResult` — the gate.
- `findSuspectRows(opening, txs): SuspectRow[]` — running-balance
  audit.
- `RepairCandidate` and the heuristic repair helpers used by the
  worker before falling through to the LLM repair pass.

`ReconcileResult.status` is one of `'verified' | 'discrepancy' |
'failed'`. The result also carries `expectedClosingCents`,
`actualClosingCents`, `deltaCents`, and `periodBoundsViolations` (a
count surfaced on the statement row for the statements list filter).

## How it's used

- `apps/api/src/jobs/extraction.worker.ts` invokes the reconciler
  between LLM extraction and transaction persistence. Result drives
  `statements.reconciliation_status`.
- `apps/api/src/routes/statements.ts` re-runs the reconciler on every
  `PATCH` of a transaction so an edit can flip a row from
  `discrepancy` to `verified`.
- The LLM repair pass (`packages/extractor/src/prompts/extract.ts →
repairPromptFor`) uses the reconciler's `deltaCents` and suspect
  indices verbatim in the second-pass prompt.

## Testing

```
pnpm --filter @vibe-tx-converter/reconciler test
```

Unit tests in `golden-rule.test.ts` cover: balanced statements,
$0.01 / $1.00 deltas, sign-flipped rows, missing rows, and the
period-bounds branch (rows before/after, all inside, balance-perfect-
but-period-violated still produces `discrepancy`).
