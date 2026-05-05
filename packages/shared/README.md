# @vibe-tx-converter/shared

Cross-cutting primitives shared by the API, the worker, and the
exporter packages. Has no runtime dependencies on `apps/` or other
`packages/` — anything in here must be free of Express, Drizzle, and
Vite.

## Purpose

- **Money-as-cents** helpers (ADR-017). All money in the codebase is
  `bigint` cents; this package owns the conversions, the formatter,
  and the safe arithmetic.
- **Calendar dates** as a tagged `YYYY-MM-DD` string — distinct from
  `Date` (which carries a timezone) and from timestamptz (used at the
  audit-log boundary, see ADR-018).
- **Account-type enum** matching the OFX 2.1.1 `ACCTTYPE` values.
- **ABA routing-number** validation and check-digit math.
- **Zod schemas** for company, account, and the LLM extraction result
  (`schemas.extraction.ExtractionResult`). Exported under the
  `schemas` namespace.
- **String formatting** helpers used across the UI.
- **`Result<T, E>`** type for fallible operations that should not
  throw.

## Public API

Re-exports from `src/index.ts`:

```ts
export * from './result.js';
export * from './money.js';
export * from './calendar-date.js';
export * from './constants.js';
export * from './account-types.js';
export * from './aba.js';
export * from './formatting.js';
export * as schemas from './schemas/index.js';
```

Notable named exports: `cents()`, `dollars()`, `formatUsd()`,
`sumCents()`, `parseCalendarDate()`, `validAba()`, `Result.ok()`,
`Result.err()`, `schemas.extraction.ExtractionResult`,
`schemas.extraction.Trntype`.

## How it's used

- `apps/api` imports `schemas.extraction.ExtractionResult` to validate
  the LLM JSON before persisting transactions.
- `apps/api` imports `cents()` and `formatUsd()` for API serialization.
- `packages/exporters` imports `Trntype`, the money helpers, and the
  account-type enum.
- `apps/web` imports `formatUsd()` and the formatting helpers.

## Testing

```
pnpm --filter @vibe-tx-converter/shared test
```

All tests are co-located with the source: `money.test.ts`,
`aba.test.ts`, `calendar-date.test.ts`, `result.test.ts`. No external
fixtures, no DB, no network.
