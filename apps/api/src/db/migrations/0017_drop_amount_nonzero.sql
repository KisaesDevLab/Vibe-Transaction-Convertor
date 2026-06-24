-- Allow zero-amount transactions. The extractor coerces an unreadable
-- amount_cents to 0 and KEEPS the row (flagged for review) rather than failing
-- the entire statement — the operator would rather see "a transaction with a
-- missing amount" than lose the whole extraction. amount_cents stays NOT NULL.

ALTER TABLE vibetc.transactions
  DROP CONSTRAINT IF EXISTS transactions_amount_nonzero;
