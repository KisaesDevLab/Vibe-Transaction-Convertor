-- Per-upload PDF processing strategy. Combines:
--   A. force-OCR toggle (force-ocr / force-text)
--   B. text-layer-with-OCR-fallback (auto-ocr-fallback)
--   C. per-upload override (processing_strategy_override column)
--
-- The firm-wide default lives in system_settings under the key
-- `pdf.processing.strategy` (no DDL needed for that — KV row).
-- Existing rows on `statements` get NULL, which resolves to the firm
-- default at extraction time — no behavior change on upgrade.

CREATE TYPE vibetc.pdf_processing_strategy AS ENUM (
  'auto',
  'force-text',
  'force-ocr',
  'auto-ocr-fallback'
);
--> statement-breakpoint

ALTER TABLE vibetc.statements
  ADD COLUMN processing_strategy_override vibetc.pdf_processing_strategy;
