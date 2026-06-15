-- Per-user feature access control.
--
-- Adds a sparse override table: a (user_id, feature_key) row exists only
-- when an admin has explicitly set a non-default state. Absence of a row
-- means the feature is ENABLED for that user (default-on / opt-out
-- model), so existing users keep full access on rollout and new features
-- need no backfill.
--
-- feature_key is intentionally free text validated against the app-side
-- registry (apps/api/src/lib/feature-registry.ts) rather than a DB enum,
-- so adding/removing a feature is a code change, not a migration.
--
-- updated_by/updated_at capture who last changed each grant (the
-- append-only audit_log carries the full history); ON DELETE SET NULL so
-- removing the editing admin doesn't cascade-delete grants.

CREATE TABLE IF NOT EXISTS vibetc.user_feature_access (
  user_id     uuid NOT NULL REFERENCES vibetc.users(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamp with time zone NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES vibetc.users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, feature_key)
);
