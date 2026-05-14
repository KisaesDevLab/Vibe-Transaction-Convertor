-- Tracks whether a statement's source PDF has been removed from disk
-- (manual delete-PDF action, statement delete, or retention sweep).
-- The statement row + transactions stay so the operator can still
-- review / export the extracted data; only the original file is gone.
--
-- false on every existing row — nothing's been deleted yet.

ALTER TABLE vibetc.statements
  ADD COLUMN source_pdf_deleted boolean NOT NULL DEFAULT false;
