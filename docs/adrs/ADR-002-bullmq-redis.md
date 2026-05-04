# ADR-002 — BullMQ on Redis 7 for the extraction queue

## Status

Accepted.

## Context

PDF extraction is the long-pole pipeline step. A single statement can take 30 s
to several minutes (text-layer fast path) or much longer if GLM-OCR runs over
many scanned pages. We need a job system that survives API restarts, supports
retry with backoff, exposes per-job state to the UI, and lets us run multiple
worker processes in production. Cloud queues are off the table — the runtime
must be self-hosted (see the product invariants in `BuildPlan.md` §0).

## Decision

Use **BullMQ** on **Redis 7**. The standalone deployment ships its own Redis
container (`docker-compose.yml`); appliance mode reuses the shared Redis. The
extraction worker is defined in `apps/api/src/jobs/extraction.worker.ts` and
mounted from `apps/api/src/jobs/index.ts`. Queue definitions live in
`apps/api/src/jobs/queues.ts`.

**Idempotency rule:** every extraction job's job ID is derived from
`(source_pdf_hash, account_id)` so a duplicate enqueue collapses to a single
job. Re-uploading the same PDF for the same account never re-runs extraction
unless the operator explicitly re-queues from admin tooling. This pairs with
ADR-016 (determinism) — replaying a finished job produces byte-identical
artifacts.

## Consequences

- **Pro:** Mature, observable, retry-aware. UI can subscribe to job events for
  live status.
- **Pro:** Idempotency on `(hash, account)` makes retries safe by construction.
- **Pro:** Separating the worker from the API process is a one-flag change
  (`WORKER_INLINE=false`) once we hit scale.
- **Con:** Redis becomes a hard dependency at runtime, even for tiny installs.
  The standalone compose file ships it; appliance mode shares the family
  Redis. Operators running outside both modes must provision Redis themselves.
- **Con:** BullMQ requires a recent enough Redis (7.0+) for streams.

## References

- `apps/api/src/jobs/`
- BuildPlan.md §3 ADR-002, Phase 15.
