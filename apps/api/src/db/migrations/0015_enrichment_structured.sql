-- Structured cleanse outputs (ADR / Phase 33 follow-up). The enrichment
-- cleanse pass now returns the underlying merchant/person behind a payment
-- processor, the processor itself, a richer transaction type, an abstain flag,
-- and a confidence band — persisted alongside cleansed_description. All NULL for
-- rows cleansed before this column existed or never enriched.

ALTER TABLE vibetc.transactions
  ADD COLUMN enrichment_merchant_name text,
  ADD COLUMN enrichment_processor text,
  ADD COLUMN enrichment_transaction_type text,
  ADD COLUMN enrichment_is_opaque boolean,
  ADD COLUMN enrichment_confidence text;
