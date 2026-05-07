# ADR-013 — `audit_log` is append-only, enforced at the database

## Status

Accepted.

## Context

The audit log records every state-changing action in the system: user
logins, account edits, statement uploads, override of the Golden Rule
gate, LLM provider switches, FIDIR refreshes, and so on. Its value is
proportional to its trustworthiness — if a compromised application
process can edit or delete audit rows, the log is a story rather than
evidence. SOC 2 reviewers, internal-control auditors, and any "who
exported this file?" forensic question depend on the log being
tamper-evident at the layer the application cannot bypass.

## Decision

The `audit_log` table is **append-only**, enforced at two layers of the
PostgreSQL stack:

1. **Trigger-based reject (primary).** A pair of `BEFORE UPDATE` /
   `BEFORE DELETE` statement-level triggers calls
   `vibetc.audit_log_block_modify()`, which `RAISE EXCEPTION`s unless the
   transaction has set `vibetc.audit_log_allow_prune = 'on'`. The trigger
   fires for every connecting role including the schema owner — so
   application bugs and SQL injection can't rewrite history regardless
   of how the runtime connects. The retention-prune job (Phase 25) opts
   in via `SET LOCAL`, which is scoped to its own transaction and never
   leaks to ordinary writes.
2. **Role-based grants (defense in depth).** Best-effort `GRANT/REVOKE`
   on a separate `vibetc_app` role for deployments that operate the
   runtime as a less-privileged role. The migration is wrapped in an
   `EXCEPTION WHEN insufficient_privilege` so the role provisioning is
   skipped silently when the migrating role lacks `CREATEROLE` — the
   Vibe-Appliance pattern provisions per-app Postgres roles without
   `CREATEROLE`, and the trigger above remains the real enforcement
   there.

The table has no `updated_at` column — once written, rows are immutable.
Corrections take the form of a _new_ audit row that references the
original.

Retention is governed by `AUDIT_RETENTION_DAYS`. When unset, rows are
kept forever; pruning is a separate scheduled job (Phase 25) that opts
in to the trigger via `SET LOCAL "vibetc.audit_log_allow_prune" = 'on'`
inside its transaction.

## Consequences

- **Pro:** Application bugs and SQL-injection exploits cannot rewrite
  history. The trigger-level guard works even when the runtime connects
  as the schema owner (the appliance pattern).
- **Pro:** Works on least-privilege Postgres deployments — no
  `CREATEROLE` requirement on the migrating role.
- **Pro:** "Who did what when" queries are trustworthy.
- **Pro:** Aligns with SOC 2 / common audit expectations.
- **Con:** Write performance is bounded by single-table append; we
  partition by month if volume justifies it later.
- **Con:** The retention-prune job must remember to `SET LOCAL` the GUC.
  Lives in one place (`apps/api/src/jobs/maintenance.worker.ts`) and is
  documented inline.

## References

- `apps/api/src/db/schema.ts` (`auditLog` table)
- `apps/api/src/db/migrations/0000_init.sql`
- BuildPlan.md §3 ADR-013, Phase 3 item 16, Phase 25.
