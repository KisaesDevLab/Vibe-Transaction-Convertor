# ADR-018 — Dates as `DATE`, audit timestamps as `TIMESTAMPTZ`

## Status

Accepted.

## Context

Bank statements report transaction "posted dates" in calendar-day
granularity. Encoding them as `TIMESTAMPTZ` invites timezone bugs:
midnight in a server's timezone is not midnight in the user's, leading
to off-by-one displays and false-positive period-bounds violations.
Conversely, audit/system timestamps need timezone-aware ordering across
deployments.

## Decision

Two distinct date types are used, and they don't mix:

- **`DATE`** — `transactions.posted_date`, `statements.period_start`,
  `statements.period_end`. These are calendar dates. Comparisons and
  ordering use Postgres date arithmetic. Display formatters convert to
  `MM/DD/YYYY` (en-US, ADR-014) without timezone reasoning.
- **`TIMESTAMPTZ`** — `*.created_at`, `*.updated_at`, `audit_log.at`,
  `sessions.expires_at`. These are absolute moments. The DB stores in
  UTC; clients render in their locale.

The TypeScript layer mirrors this:

- A `CalendarDate` helper in `packages/shared` wraps `'YYYY-MM-DD'`
  strings as a branded type. It never carries a timezone.
- Wall-clock `Date` is reserved for `TIMESTAMPTZ` columns.

Conversions between the two go through explicit helpers (`startOfDayInTz`,
`endOfDayInTz`) so timezone assumptions are localized and reviewable.

## Consequences

- **Pro:** Period-bounds checks are unambiguous — no timezone math.
- **Pro:** Audit log ordering survives container migrations between
  regions.
- **Pro:** Display formatting is straightforward; en-US is hardcoded
  for v1 (ADR-014).
- **Con:** Code that wants to "subtract a day" from a `CalendarDate`
  must use the helper, not Date arithmetic. We treat that as a feature.

## References

- `apps/api/src/db/schema.ts`
- `packages/shared/src/calendar-date.ts` (lands in Phase 2)
- BuildPlan.md §3 ADR-018, Phase 3.
