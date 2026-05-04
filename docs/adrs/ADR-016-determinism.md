# ADR-016 — Deterministic pipeline end-to-end

## Status

Accepted.

## Context

Re-importing a corrected statement should not double-book anything. A
re-export of an unchanged statement should produce the same bytes a
month later. Two operators running the same pipeline against the same
inputs should get the same outputs. Without explicit determinism, we
silently invite drift: re-extraction yields different normalized
descriptions; FITIDs change because seq indices reshuffle; OFX
serialization reorders elements based on map iteration; cost ledgers
double-count because retried jobs were not idempotent.

## Decision

The pipeline is **deterministic end-to-end**:

- **Same PDF → same FITIDs** by construction (ADR-005).
- **Same FITIDs → same export bytes**, modulo `<DTSERVER>`. The OFX
  writers serialize elements in a fixed canonical order. The CSV writers
  emit rows in `(posted_date, seq_in_day)` order with stable column
  ordering. The QBO/QFX writers stamp `<DTSERVER>` from a deterministic
  source (the operator-supplied "as-of" timestamp or `statements.created_at`)
  so a re-export at a different wall-clock produces identical bytes.
- **Idempotent extraction jobs** keyed on `(source_pdf_hash, account_id)`
  (ADR-002). Re-enqueueing collapses to the existing job.
- **Cached LLM extraction** — when the JSON Schema has not changed and
  the OCR output for a given page hash has not changed, the extractor
  returns the cached extraction rather than calling the LLM again.
- **Database constants** — UUIDs, timestamps, and other "now"-flavored
  values are passed in explicitly when needed for determinism (e.g., the
  exporter's `now` is an injectable parameter, not `Date.now()`).

## Consequences

- **Pro:** Re-imports are safe by default — no double-booking from a
  re-extracted statement.
- **Pro:** Golden-master tests on exporter output are stable across
  runs and across machines.
- **Pro:** Cost ledgers are correct in the face of retries.
- **Con:** Code that needs randomness or wall-clock time has to thread
  it as a dependency. Mitigation: a small `clock.ts` and `random.ts` in
  `packages/shared` provide injectable defaults.
- **Con:** Snapshot tests are strict; cosmetic refactors of the writers
  may need snapshot updates. We accept this as an explicit signal.

## References

- BuildPlan.md §3 ADR-016, Phases 17, 21-23, 27.
