-- Single sign-on via Vibe Auth (ADR-027).
--
-- 1) The @kisaesdevlab/vibe-auth client tables (package sql/auth_identities.sql),
--    placed in the vibetc schema. user_id is TEXT as the package ships it, so
--    there is no FK to users; unlinking is the package's job.
-- 2) OIDC identity on the session row, so back-channel logout can end the
--    sessions an IdP session created (by sid, then issuer+subject) and
--    RP-initiated logout can send id_token_hint. The ID token is stored
--    AES-GCM-wrapped (lib/secrets.ts), base64.
-- 3) users.disabled_at: the package can deactivate an account (break-glass
--    "ensure" re-activates one). NULL = active. loadSession and password
--    login both refuse a disabled user.
--
-- Idempotent so re-runs are safe.

CREATE TABLE IF NOT EXISTS vibetc.auth_identities (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL,
  issuer          text NOT NULL,
  subject         text NOT NULL,
  email           text,
  email_verified  boolean NOT NULL DEFAULT false,
  last_login_at   timestamp with time zone,
  created_at      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT auth_identities_issuer_subject_uq UNIQUE (issuer, subject)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_identities_user_id_idx ON vibetc.auth_identities (user_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS vibetc.auth_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS vibetc.auth_revocations (
  subject_key    text PRIMARY KEY,
  revoked_at     timestamp with time zone NOT NULL DEFAULT now(),
  revoked_until  timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_revocations_until_idx ON vibetc.auth_revocations (revoked_until);
--> statement-breakpoint

ALTER TABLE vibetc.sessions
  ADD COLUMN IF NOT EXISTS oidc_issuer text,
  ADD COLUMN IF NOT EXISTS oidc_subject text,
  ADD COLUMN IF NOT EXISTS oidc_sid text,
  ADD COLUMN IF NOT EXISTS oidc_id_token text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_oidc_sid_idx ON vibetc.sessions (oidc_sid)
  WHERE oidc_sid IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_oidc_identity_idx ON vibetc.sessions (oidc_issuer, oidc_subject)
  WHERE oidc_subject IS NOT NULL;
--> statement-breakpoint

ALTER TABLE vibetc.users
  ADD COLUMN IF NOT EXISTS disabled_at timestamp with time zone;
