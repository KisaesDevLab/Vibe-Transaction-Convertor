# ADR-012 — Per-account default INTU.BID and Bank Picker

## Status

Accepted.

## Context

QBO and QFX exports must carry an `<INTU.BID>` (and for QBO, an
`<INTU.ORG>`) inside the SONRS block. QuickBooks uses the BID to match the
imported file to a known financial institution; if it doesn't recognize
the BID, the import is rejected or routes to a generic catch-all FI.
Asking the operator to look up the BID at every export is onerous, and
guessing per-export from the financial institution name is error-prone
because banks have multiple BIDs (different lines of business, sometimes
different regions).

## Decision

Each `accounts` row carries a **default `intu_bid` and `intu_org`** stamped
at account-creation time via the **Bank Picker** UI:

- The Bank Picker is a debounced combobox over `/api/fidir/search`,
  reading from the FIDIR mirror (ADR-007).
- Selection writes `accounts.intu_bid` and `accounts.intu_org` and never
  prompts again — every export from this account uses these values
  unchanged.
- A **fallback option** (`intu_bid='3000'`, Wells Fargo) is always
  available and surfaced as an explicit "Bank not listed?" link with a
  tooltip explaining the trade-off. The fallback exists because some
  small institutions are not in FIDIR; using the Wells Fargo BID is the
  industry workaround that QuickBooks accepts (it just labels the imported
  account as "Wells Fargo").
- Users may switch the per-account BID later via the account edit form.
  Historical exports retain the BID that was used at export time
  (recorded in `export_jobs.intu_bid_used`).

## Consequences

- **Pro:** Single point of truth per account; exports are deterministic.
- **Pro:** FIDIR drift is bounded — even when Intuit retires a BID, every
  account still has a stable answer until an operator updates it.
- **Pro:** Audit log captures BID changes alongside other account edits.
- **Con:** Operator can pick the wrong BID at create time and ship bad
  exports until corrected. Mitigation: account creation surfaces a "Test
  export stamp" button that previews the SONRS block.

## References

- `packages/fidir/src/`
- `apps/web/src/components/BankPickerCombobox.tsx`
- `packages/shared/src/constants.ts` (`FALLBACK_INTU_BID = '3000'`)
- BuildPlan.md §3 ADR-012, Phases 5, 8.
