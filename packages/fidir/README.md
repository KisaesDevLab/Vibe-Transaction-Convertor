# @vibe-tx-converter/fidir

Parser, types, and in-memory search helpers for the Intuit FIDIR
(Financial Institution Directory) text format. The vendored mirror
lives at `data/fidir/fidir-us.txt` (ADR-007) — this package never
fetches anything at runtime.

## Purpose

- Parse the line-oriented `KEY=value` records (`INTU.BID`, `INTU.ORG`,
  `BANK_NAME`, `URL`, …) into typed `FidirEntry` objects.
- Provide a small in-memory search used in tests and dev. Production
  search runs against Postgres `pg_trgm` in
  `apps/api/src/routes/fidir.ts`.

## Public API

```ts
export * from './types.js'; // FidirEntry
export * from './parser.js'; // parseFidir(input, opts) → FidirEntry[]
export * from './search.js'; // searchFidir(entries, query) → FidirEntry[]
```

`FidirEntry`:

```ts
{
  intuBid: string;          // 9-digit (or shorter) Intuit BID
  intuOrg: string;          // organization slug
  bankName: string;
  country: 'US';
  url?: string;
  raw: Record<string, string>;
}
```

`parseFidir(input, opts?)`:

- Splits on blank lines, trims trailing `\r`.
- Records missing any of `INTU.BID`, `INTU.ORG`, `BANK_NAME` are
  skipped with a warning callback (`opts.onWarning`).
- Unknown keys are preserved under `raw` so format extensions don't
  lose data.

`searchFidir(entries, query)`:

- Exact-BID match takes priority.
- Otherwise case-insensitive substring on `bankName`.
- Returns `[]` for empty queries (no fuzzy fallback).

## How it's used

- `apps/api/src/scripts/db-fidir-seed.ts` shells the parser and writes
  to `vibetc.fidir_entries`.
- `apps/api/src/routes/fidir.ts` exposes search via pg_trgm + ILIKE
  for the bank picker; the in-memory `searchFidir` is used by tests
  and CLI tools only.
- The seeder refuses imports with fewer than 100 records as a
  defensive cap (per `BuildPlan.md` Phase 5).

Per `PROGRESS.md`, the current vendored file is a 127-bank stub, not
the full Intuit publication. Refresh by replacing the file and running
`just fidir-refresh`.

## Testing

```
pnpm --filter @vibe-tx-converter/fidir test
```

Unit tests cover the parser's edge cases (`parser.test.ts`) including
malformed records, embedded blank lines, and CRLF normalization.
