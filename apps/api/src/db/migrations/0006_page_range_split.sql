-- Phase 14 — multi-account split: per-account-segment statement rows.
--
-- Adds statements.page_range int4range. When NULL the row represents a
-- whole-PDF extraction; when set, it represents a single account slice
-- of a multi-account PDF (Phase 14 #6/#7/#8).
--
-- The existing unique index `(account_id, source_pdf_hash)` is now too
-- strict — splitting one PDF must produce N statements with the SAME
-- (account_id, hash) but different page_ranges. We replace it with a
-- partial unique index that treats NULL page_range as a singleton sentinel.

ALTER TABLE vibetc.statements
  ADD COLUMN IF NOT EXISTS page_range int4range;

DROP INDEX IF EXISTS vibetc.statements_account_hash_uq;

-- One un-split row per (account, hash). Splitting a PDF means deleting
-- (or superseding) this row first, then inserting N rows with page_range
-- set. The split-rows index below covers those.
CREATE UNIQUE INDEX statements_account_hash_unsplit_uq
  ON vibetc.statements (account_id, source_pdf_hash)
  WHERE page_range IS NULL;

-- Multiple split rows can share (account, hash) so long as the
-- page_ranges don't overlap.  EXCLUDE USING gist enforces no overlap;
-- needs btree_gist for the equality piece on the uuid + text columns.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE vibetc.statements
  ADD CONSTRAINT statements_split_no_overlap
  EXCLUDE USING gist (
    account_id WITH =,
    source_pdf_hash WITH =,
    page_range WITH &&
  )
  WHERE (page_range IS NOT NULL);
