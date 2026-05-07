-- audit_log is append-only — enforced at the database (ADR-013).
--
-- Two layers of enforcement:
--   1) BEFORE UPDATE/DELETE triggers that RAISE EXCEPTION for any
--      caller that has not set `vibetc.audit_log_allow_prune = 'on'`
--      in the current transaction. The trigger fires for every
--      connecting role including the schema owner — so application
--      bugs and SQL injection can't rewrite history regardless of how
--      the runtime connects.
--   2) Best-effort GRANT/REVOKE on a separate `vibetc_app` role for
--      deployments that operate the runtime as a less-privileged role.
--      Skipped silently when the migrating role lacks CREATEROLE — the
--      Vibe-Appliance pattern provisions per-app roles without it,
--      and the trigger above is the real enforcement anyway.
--
-- Idempotent so re-runs are safe.

CREATE OR REPLACE FUNCTION vibetc.audit_log_block_modify() RETURNS trigger AS $$
BEGIN
  IF current_setting('vibetc.audit_log_allow_prune', true) = 'on' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only (ADR-013); UPDATE/DELETE not permitted without setting vibetc.audit_log_allow_prune=''on''';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_log_no_update ON vibetc.audit_log;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON vibetc.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION vibetc.audit_log_block_modify();
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_log_no_delete ON vibetc.audit_log;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON vibetc.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION vibetc.audit_log_block_modify();
--> statement-breakpoint

DO $$
DECLARE
  has_role boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vibetc_app') INTO has_role;
  IF NOT has_role THEN
    BEGIN
      CREATE ROLE vibetc_app NOLOGIN;
      has_role := true;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'skipping vibetc_app role provisioning (current_user=% lacks CREATEROLE); audit_log immutability enforced via trigger.', current_user;
    END;
  END IF;

  IF has_role THEN
    EXECUTE 'GRANT USAGE ON SCHEMA vibetc TO vibetc_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA vibetc TO vibetc_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA vibetc TO vibetc_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA vibetc GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vibetc_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA vibetc GRANT USAGE, SELECT ON SEQUENCES TO vibetc_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON vibetc.audit_log FROM vibetc_app';
  END IF;
END $$;
