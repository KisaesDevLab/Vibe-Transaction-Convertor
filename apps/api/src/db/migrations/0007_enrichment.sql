-- Phase 33 — LLM-driven description cleansing + business-category
-- assignment. See ADR-021 and docs/extraction.md.
--
-- 1) New `business_categories` table — operator-editable closed list of
--    categories the LLM can pick from. Soft-delete via `archived` so
--    historical assignments stay valid even when a category is retired.
-- 2) Four new columns on `transactions`:
--    - `cleansed_description`     — LLM-normalized human-readable form.
--      <NAME> field at OFX/QFX/QBO export time when present; <MEMO>
--      preserves the raw `description`.
--    - `business_category_id`     — FK to business_categories (nullable,
--      ON DELETE SET NULL so a hard-delete of a category orphans the
--      assignment without losing the transaction row).
--    - `enrichment_user_edited`   — true once the user overrides either
--      cleansed_description or business_category_id in the review grid.
--      Re-running enrichment skips userEdited rows.
--    - `enrichment_run_at`        — last successful enrichment timestamp;
--      surfaces in the review UI so the operator knows whether the
--      cleansed/category fields are stale relative to the raw description.
-- 3) Seed 20 default categories (only when the table is empty so admin
--    edits survive a re-migration).
-- 4) Two `system_settings` toggles default-on. Operators flip them off
--    to hide the buttons on the review page.

CREATE TABLE IF NOT EXISTS vibetc.business_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  sort_order integer NOT NULL DEFAULT 100,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Case-insensitive uniqueness on name. Operators renaming "Office" to
-- "office" should hit the same conflict as a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS business_categories_name_lower_uq
  ON vibetc.business_categories (lower(name));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS business_categories_archived_sort_idx
  ON vibetc.business_categories (archived, sort_order, name);
--> statement-breakpoint

ALTER TABLE vibetc.transactions
  ADD COLUMN IF NOT EXISTS cleansed_description text;
--> statement-breakpoint

ALTER TABLE vibetc.transactions
  ADD COLUMN IF NOT EXISTS business_category_id uuid
  REFERENCES vibetc.business_categories(id) ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE vibetc.transactions
  ADD COLUMN IF NOT EXISTS enrichment_user_edited boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE vibetc.transactions
  ADD COLUMN IF NOT EXISTS enrichment_run_at timestamp with time zone;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS transactions_business_category_idx
  ON vibetc.transactions (business_category_id)
  WHERE business_category_id IS NOT NULL;
--> statement-breakpoint

-- Default category seed — IRS Schedule C-aligned, ordered for typical
-- bookkeeping flow (income first, common expenses, transfers/other last).
-- The WHERE NOT EXISTS guard keeps operator edits intact across
-- re-migrations: drop-and-recreate the schema and the seed runs again,
-- but a healthy DB never re-seeds.
INSERT INTO vibetc.business_categories (name, description, sort_order)
SELECT v.name, v.description, v.sort_order FROM (VALUES
  ('Income',                  'Revenue from sales, services, or operations.',                            10),
  ('Refund',                  'Refunds issued to customers or received from vendors.',                   20),
  ('Bank Fees',               'Bank service charges, wire fees, NSF fees.',                              30),
  ('Insurance',               'Business insurance premiums (liability, property, health).',              40),
  ('Office',                  'Office expenses: phone, internet, shared services, mailbox.',             50),
  ('Rent',                    'Lease or rent for business property.',                                    60),
  ('Repairs',                 'Repairs and maintenance on business property or equipment.',              70),
  ('Supplies',                'Consumable office or operational supplies.',                              80),
  ('Taxes',                   'Sales tax, payroll tax, business licenses, registrations.',               90),
  ('Utilities',               'Electricity, water, gas, waste services.',                               100),
  ('Advertising',             'Marketing, advertising, paid promotions.',                               110),
  ('Meals',                   'Business meals and entertainment.',                                      120),
  ('Travel',                  'Air, rail, hotel, mileage, rideshare for business travel.',              130),
  ('Professional Services',   'Legal, accounting, consulting, contracted labor (1099).',                140),
  ('Software & Subscriptions','Software licenses, SaaS, recurring digital subscriptions.',              150),
  ('Wages',                   'W-2 payroll, salaries, employee benefits.',                              160),
  ('Inventory',               'Cost of goods sold, raw materials, inventory purchases.',                170),
  ('Owner Draw',              'Owner distributions or capital draws.',                                  180),
  ('Transfer',                'Transfers between own accounts (not income/expense).',                   190),
  ('Other',                   'Catch-all when nothing else fits.',                                      200)
) AS v(name, description, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM vibetc.business_categories);
--> statement-breakpoint

-- Default both toggles ON. ON CONFLICT DO NOTHING so operators who have
-- already set these don't get overridden by a re-migration.
INSERT INTO vibetc.system_settings (key, value_plaintext, is_secret)
VALUES
  ('enrichment.cleanse_enabled',  'true', false),
  ('enrichment.category_enabled', 'true', false)
ON CONFLICT (key) DO NOTHING;
