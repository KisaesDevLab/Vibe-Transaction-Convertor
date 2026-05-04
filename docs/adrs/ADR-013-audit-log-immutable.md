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

The `audit_log` table is **append-only**, enforced **at the PostgreSQL
permission level**:

- The application connects as a role (e.g., `vibetc_app`) that is granted
  `INSERT, SELECT` on `vibetc.audit_log` and **explicitly revoked**
  `UPDATE` and `DELETE`.
- A dedicated migration revokes those rights immediately after the table
  is created (see Phase 3, item 16). Future schema changes that need to
  alter the table use a migration role with elevated privileges; the
  application never holds those.
- The table has no `updated_at` column — once written, rows are
  immutable. Corrections take the form of a _new_ audit row that
  references the original.
- Retention is governed by `AUDIT_RETENTION_DAYS`. When unset, rows are
  kept forever; pruning is a separate scheduled job (Phase 25) that uses
  a privileged role.

## Consequences

- **Pro:** Application bugs and SQL-injection exploits cannot rewrite
  history.
- **Pro:** "Who did what when" queries are trustworthy.
- **Pro:** Aligns with SOC 2 / common audit expectations.
- **Con:** Write performance is bounded by single-table append; we
  partition by month if volume justifies it later.
- **Con:** Schema changes require a privileged migration. Acceptable —
  schema changes are infrequent and reviewed.

## References

- `apps/api/src/db/schema.ts` (`auditLog` table)
- `apps/api/src/db/migrations/0000_init.sql`
- BuildPlan.md §3 ADR-013, Phase 3 item 16, Phase 25.
