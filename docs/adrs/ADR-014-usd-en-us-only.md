# ADR-014 — USD-only, en-US (MDY) output, period-bounds defense in depth

## Status

Accepted.

## Context

Locale and currency are everywhere in this codebase: PDF date parsing,
amount parsing, OFX `<CURDEF>`, CSV templates, UI date pickers, balance
formatting. Doing locale right requires investing in a layered i18n
strategy. v1 ships to a US-only audience using QuickBooks Desktop / QBO /
Quicken / Xero — all of whom in their en-US configuration expect USD
amounts and MDY dates on imports. Trying to ship multi-currency or
multi-locale at v1 would more than double the schema, exporter, and
testing surface.

## Decision

**v1 is USD-only at every layer and en-US (MDY) on every output.**
Concretely:

- `accounts.currency` is constrained to `'USD'` via a CHECK constraint.
  Future locale/currency support adds the column constraint as part of
  v2.
- All exporters emit dates in MDY (`MM/DD/YYYY`) and amounts in en-US
  conventions.
- Source PDFs are accepted in any unambiguous date format — MDY, DMY,
  YMD, or textual ("Jan 5, 2026"). The LLM detects the source format
  during extraction and normalizes internally to ISO 8601
  (`YYYY-MM-DD`).
- When the source is **genuinely ambiguous** (every day in the period is
  ≤ 12, no textual disambiguators), the statement halts in
  `awaiting-locale-confirmation` until the user picks the format.
- **Period-bounds enforcement** runs as defense in depth: the reconciler
  counts transactions whose `posted_date` falls outside
  `[period_start, period_end]` and stores the count in
  `statements.period_bounds_violations`. A nonzero count surfaces a
  warning even when Golden Rule passes, catching silent date-format
  mis-detection.

## Consequences

- **Pro:** Massive scope reduction at v1. Single currency, single
  output locale, fewer export-template variants.
- **Pro:** Period-bounds check is a cheap independent signal that catches
  a class of silent-failure bugs.
- **Con:** Customers outside the US must wait for v2.
- **Con:** Edge-case detection (ambiguous dates) requires a stop-the-world
  status that operators have to resolve. Mitigation: the
  awaiting-locale-confirmation page is a single-click affordance.

## References

- BuildPlan.md §3 ADR-014, Phases 12, 16.
- `apps/api/src/db/schema.ts` — `accounts.currency`, `statements.source_date_format`,
  `statements.period_bounds_violations`.
