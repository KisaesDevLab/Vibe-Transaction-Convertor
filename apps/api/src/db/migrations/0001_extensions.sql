-- Extensions and indexes that depend on them.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS fidir_bank_name_trgm_idx
  ON vibetc.fidir_entries
  USING gin (bank_name gin_trgm_ops);
