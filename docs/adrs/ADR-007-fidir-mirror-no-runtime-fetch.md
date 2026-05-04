# ADR-007 — FIDIR is mirrored, never fetched at runtime

## Status

Accepted.

## Context

Intuit publishes a `fidir.txt` directory listing every financial institution
ID (`INTU.BID`) recognized by QuickBooks. We need this data for the Bank
Picker so operators can stamp accurate `<FI><ORG>` and `<FI><FID>` blocks on
exported QBO/QFX files. Two reasonable strategies exist:

1. **Live-fetch** the FIDIR at boot or on cache miss.
2. **Mirror** a copy in the repo and re-import on an explicit admin action.

The product invariant in `BuildPlan.md` §0 forbids outbound network calls at
runtime by default. SOC 2 reviewers, on-prem operators with restricted
egress, and air-gapped appliance installs all demand option 2.

## Decision

**Vendor a copy of the US FIDIR at `data/fidir/fidir-us.txt`.** The file's
provenance — exact URL, fetch timestamp, mirroring policy — is documented at
`data/fidir/README.md`. The application never fetches FIDIR at runtime. Two
import paths exist:

- **First-boot** — if `fidir_entries` is empty, the seeder reads the
  vendored file and imports.
- **Operator refresh** — `just fidir:refresh` re-imports from the vendored
  file. The operator manually replaces `data/fidir/fidir-us.txt` with a new
  download on a cadence they control (default suggested cadence: quarterly).

`/api/health/ready` does not depend on FIDIR network reachability; only on
the local table being non-empty.

A hardcoded fallback entry (`INTU.BID=3000`, Wells Fargo) is always present
so the Bank Picker has a "use a generic BID" option even if FIDIR import
fails. See ADR-012 for how the fallback is surfaced.

## Consequences

- **Pro:** Zero runtime network surface — full air-gap support.
- **Pro:** Reproducible builds: same FIDIR commit = same Bank Picker results.
- **Con:** FIDIR data ages between refreshes. Mitigation: the admin UI
  surfaces `fidir_last_refreshed_at` so operators see staleness.
- **Con:** The vendored file inflates the repo. We accept the cost; the file
  is plain text and compresses well.

## References

- `data/fidir/`
- `packages/fidir/src/`
- BuildPlan.md §3 ADR-007, Phase 5.
