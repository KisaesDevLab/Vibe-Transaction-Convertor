-- Check payee. Read from the cancelled-check image during vision
-- extraction ("Pay to the order of" line) and preferred over
-- cleansed_description for the OFX <NAME> field on check rows. NULL for
-- non-check rows, rows extracted before this column existed, and rows
-- where no payee was visible.

ALTER TABLE vibetc.transactions
  ADD COLUMN payee text;
