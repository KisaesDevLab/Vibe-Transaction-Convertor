-- Business-rule CHECK constraints. Drizzle 0.33's check() callback isn't
-- emitting these in 0.24.2's generator, so we declare them here.

ALTER TABLE vibetc.accounts
  ADD CONSTRAINT accounts_currency_usd_only
  CHECK (currency = 'USD');
--> statement-breakpoint

ALTER TABLE vibetc.accounts
  ADD CONSTRAINT accounts_credit_card_no_routing
  CHECK (account_type <> 'CREDITCARD' OR routing_number IS NULL);
--> statement-breakpoint

ALTER TABLE vibetc.transactions
  ADD CONSTRAINT transactions_amount_nonzero
  CHECK (amount_cents <> 0);
--> statement-breakpoint

ALTER TABLE vibetc.system_settings
  ADD CONSTRAINT system_settings_secret_xor_plaintext
  CHECK (
    (is_secret = true  AND value_plaintext IS NULL     AND value_encrypted IS NOT NULL)
    OR
    (is_secret = false AND value_encrypted IS NULL)
  );
