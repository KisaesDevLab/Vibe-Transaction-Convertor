-- Reclassify `verified` statements that carry out-of-period rows.
--
-- BuildPlan Phase 16 #2: `verified` is a conjunction — the balances tie to
-- the cent AND every transaction falls inside the statement period. Before
-- that was enforced, a balance-perfect statement with
-- period_bounds_violations > 0 (e.g. a consistent MDY/DMY misread moves rows
-- across the period banner without changing the sum) was persisted as
-- `verified` and still passes the export gate. Downgrade those rows to
-- `discrepancy` so export is gated until the operator fixes the dates or
-- explicitly overrides, and append one audit_log row per reclassified
-- statement in the same statement (ADR-013: audit_log is INSERT-only;
-- actor_user_id NULL = system migration). `overridden` rows are untouched —
-- the operator already acknowledged them.
--
-- Idempotent: a reclassified row no longer matches the WHERE clause, so a
-- re-run updates nothing and writes no audit rows.

WITH changed AS (
  UPDATE vibetc.statements
     SET reconciliation_status = 'discrepancy',
         updated_at = now()
   WHERE reconciliation_status = 'verified'
     AND period_bounds_violations > 0
  RETURNING id, period_bounds_violations
)
INSERT INTO vibetc.audit_log (actor_user_id, entity_type, entity_id, action, payload)
SELECT NULL::uuid,
       'statement',
       id::text,
       'statement.reconciliation-reclassified',
       jsonb_build_object(
         'from', 'verified',
         'to', 'discrepancy',
         'periodBoundsViolations', period_bounds_violations,
         'reason', 'verified requires zero out-of-period rows (BuildPlan Phase 16 #2)'
       )
  FROM changed;
