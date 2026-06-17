-- Vibe Shield vision path: per-page document classification + the
-- 'unknown'-page review hold. `page_classifications` stores the ordered
-- vs-page-classifications array (one document type per page, in page
-- order). `review_hold_reason` is set when any page classified 'unknown'
-- (Shield applied fail-closed maximal redaction, so real data may have
-- been clipped); `review_hold_acknowledged` gates export until the
-- operator confirms — mirroring multi_account_acknowledged. All NULL/false
-- for the text/markdown path and pre-v1.13.0 gateways.

ALTER TABLE vibetc.statements
  ADD COLUMN page_classifications jsonb,
  ADD COLUMN review_hold_reason text,
  ADD COLUMN review_hold_acknowledged boolean NOT NULL DEFAULT false;
