-- audit_log append-only hardening (ADR-013): also block TRUNCATE.
--
-- 0002 installed statement-level BEFORE UPDATE/DELETE triggers, but
-- TRUNCATE fires neither, and in a standalone deploy the runtime role owns
-- the table (so the REVOKE in 0002 does not constrain it) — a single
-- `TRUNCATE vibetc.audit_log` would silently erase the whole trail. A
-- BEFORE TRUNCATE trigger closes the gap. The operator escape hatch is the
-- same as for pruning: SET LOCAL vibetc.audit_log_allow_prune = 'on' in the
-- transaction. audit_log has no foreign keys, so TRUNCATE ... CASCADE on
-- other tables never reaches it.
--
-- The trigger function is re-created so the message names the blocked
-- operation (TG_OP) instead of always saying UPDATE/DELETE.
--
-- Idempotent so re-runs are safe.

CREATE OR REPLACE FUNCTION vibetc.audit_log_block_modify() RETURNS trigger AS $$
BEGIN
  IF current_setting('vibetc.audit_log_allow_prune', true) = 'on' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only (ADR-013); % not permitted without setting vibetc.audit_log_allow_prune=''on''', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_log_no_truncate ON vibetc.audit_log;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON vibetc.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION vibetc.audit_log_block_modify();
