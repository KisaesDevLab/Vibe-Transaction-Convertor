-- Adds the `auto-text-fallback` value to the pdf_processing_strategy
-- enum. Mirror of `auto-ocr-fallback`: starts with GLM-OCR and falls
-- back to text-layer extraction when the LLM stack rejects the OCR
-- output (HTTP error, malformed response, empty transactions, or
-- reconciliation discrepancy). Useful when an operator wants OCR to
-- be the primary path — e.g. a known-scanned scanner that produces a
-- bogus text layer the prior `auto` would have wrongly preferred.

ALTER TYPE vibetc.pdf_processing_strategy ADD VALUE IF NOT EXISTS 'auto-text-fallback';
