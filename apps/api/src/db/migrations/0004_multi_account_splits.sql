-- Phase 14: persist detected multi-account splits so the UI can offer a
-- confirmation flow instead of silently extracting as a single statement.

ALTER TABLE vibetc.statements
  ADD COLUMN IF NOT EXISTS detected_splits jsonb;
--> statement-breakpoint

ALTER TABLE vibetc.statements
  ADD COLUMN IF NOT EXISTS multi_account_acknowledged boolean NOT NULL DEFAULT false;
