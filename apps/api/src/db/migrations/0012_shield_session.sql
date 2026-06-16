-- Vibe Shield integration: per-conversion session id on each statement.
--
-- Opened at upload under the cpa-converter-output policy. The OCR
-- (Claude-vision via Shield) and extraction calls quote this session so
-- their PII tokens land in one vault; the export path materializes those
-- tokens back to cleartext against it. NULL on statements created before
-- this integration and whenever Shield is unconfigured.

ALTER TABLE vibetc.statements
  ADD COLUMN shield_session_id text;
