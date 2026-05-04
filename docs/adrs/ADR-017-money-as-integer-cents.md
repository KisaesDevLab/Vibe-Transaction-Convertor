# ADR-017 — All money is integer cents

## Status

Accepted.

## Context

Storing money as floating-point numbers is a lifetime supply of
silent off-by-one-cent bugs. JavaScript doubles cannot represent
$0.10 + $0.20 exactly. Postgres `NUMERIC` is exact but introduces
arithmetic and comparison friction. The product needs to add tens of
thousands of transactions reliably, compare against bank-reported
balances cents-exactly (the Golden Rule, ADR-010), and never round
silently.

## Decision

All money is stored as **integer cents** in the database, typed as
`BIGINT` for headroom, and represented as **signed `bigint`** in
internal APIs:

- `transactions.amount_cents` — signed `BIGINT`.
- `transactions.running_balance_cents` — signed `BIGINT`, nullable.
- `statements.opening_balance_cents`, `closing_balance_cents` — signed
  `BIGINT`.
- `statements.llm_cost_micros` — signed `BIGINT` storing micro-USD
  (e.g., $0.001234 → `1234`) for fine-grained cost accounting.
- The shared `Money` helpers live at `packages/shared/src/money.ts`:
  `cents(n)`, `dollars(cents)`, `addCents(a, b)`, `sumCents(...)`,
  `formatUsd(cents)`. **Decimal-as-string is used only at API
  boundaries and inside exporter output**; internal code never sees a
  decimal `string` or `number`.
- The CSV/OFX/QBO/QFX writers convert from cents to `"123.45"` strings
  using a single helper that always writes two decimal places, never
  trailing-zeros-stripped, never with a thousands separator.

## Consequences

- **Pro:** Sums and equalities are exact. Golden Rule comparisons
  reduce to `a === b` of `bigint` values.
- **Pro:** Postgres BIGINT is fast and indexable.
- **Con:** TypeScript `bigint` needs explicit serialization (it is not
  JSON-safe). The API layer wraps `bigint` to string at the boundary.
- **Con:** Mixing `bigint` and `number` triggers TypeScript errors —
  exactly the friction we want; the alternative is silent precision
  loss.

## References

- `packages/shared/src/money.ts`
- BuildPlan.md §3 ADR-017, Phase 2 item 23.
