-- Store the extracted text (local OCR transcription or text-layer markdown)
-- per statement so operators can view exactly what fed extraction, for
-- troubleshooting + documentation. Latest extraction only (re-extract
-- overwrites); the per-step audit rows keep the historical copies. NULL for
-- statements extracted before this column existed.

ALTER TABLE vibetc.statements
  ADD COLUMN extracted_text text,
  ADD COLUMN extracted_text_source text;
