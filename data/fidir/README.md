# FIDIR mirror

This directory holds a vendored copy of Intuit's Financial Institution
Directory (FIDIR) used by the Bank Picker. **The application never fetches
this file at runtime** (ADR-007). Refresh policy: quarterly, manually, by
the operator.

## Files

- `fidir-us.txt` — line-oriented `KEY=value` records, one record per
  blank-line-separated block. Recognized keys: `INTU.BID`, `INTU.ORG`,
  `BANK_NAME`, `URL`. The format is not Intuit's authoritative format;
  it's the parser-friendly form this product imports. See **Refresh
  procedure** below for converting.

## Status

The **vendored file in this commit is a starter set of major US banks**
sufficient to run the Bank Picker, FIDIR routes, and tests against
representative institutions. **It is not the full Intuit FIDIR** —
operators must replace it with the full directory before production use.

The seeder will refuse to import a file with fewer than 100 records (a
defensive cap that catches accidentally-truncated commits).

## Refresh procedure

Source URL: <https://www.intuit.com/qbn/qboe/fidir.txt> (subject to
Intuit changing the path; check QBN release notes if it 404s).

1. Download the latest `fidir.txt` to a local working directory.
2. Convert to the parser-friendly format (see `scripts/convert-fidir.ts`,
   to be added in a future phase if Intuit's format diverges).
3. Replace `data/fidir/fidir-us.txt` with the converted file.
4. Update **fetched-at** below.
5. Run `just fidir:refresh` to re-import.

## Fetched at

This starter set was synthesized on 2026-05-04. It is not a copy of any
particular Intuit publication. See QUESTIONS.md Q-002 for the open
question about format authority.
