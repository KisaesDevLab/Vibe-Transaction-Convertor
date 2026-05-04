-- audit_log is append-only — enforced at the database (ADR-013).
-- Idempotent so re-runs are safe.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vibetc_app') THEN
    CREATE ROLE vibetc_app NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA vibetc TO vibetc_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA vibetc TO vibetc_app;
--> statement-breakpoint

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA vibetc TO vibetc_app;
--> statement-breakpoint

ALTER DEFAULT PRIVILEGES IN SCHEMA vibetc
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vibetc_app;
--> statement-breakpoint

ALTER DEFAULT PRIVILEGES IN SCHEMA vibetc
  GRANT USAGE, SELECT ON SEQUENCES TO vibetc_app;
--> statement-breakpoint

REVOKE UPDATE, DELETE ON vibetc.audit_log FROM vibetc_app;
