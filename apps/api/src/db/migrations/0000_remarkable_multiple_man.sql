CREATE SCHEMA "vibetc";
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "vibetc"."account_type" AS ENUM('CHECKING', 'SAVINGS', 'MONEYMRKT', 'CREDITLINE', 'CREDITCARD');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "vibetc"."csv_template" AS ENUM('qbo3', 'qbo4', 'xero', 'generic');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "vibetc"."export_format" AS ENUM('csv-qbo3', 'csv-qbo4', 'csv-xero', 'csv-generic', 'ofx', 'qbo', 'qfx');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "vibetc"."extraction_method" AS ENUM('text', 'ocr', 'hybrid');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "vibetc"."llm_provider" AS ENUM('local', 'anthropic');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "vibetc"."reconciliation_status" AS ENUM('pending', 'verified', 'discrepancy', 'overridden', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "vibetc"."source_date_format" AS ENUM('MDY', 'DMY', 'YMD', 'TEXTUAL', 'AMBIGUOUS');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "vibetc"."statement_status" AS ENUM('uploaded', 'preprocessing', 'ocr', 'extracting', 'reconciling', 'awaiting-locale-confirmation', 'review', 'exported', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "vibetc"."trntype" AS ENUM('CREDIT', 'DEBIT', 'INT', 'DIV', 'FEE', 'SRVCHG', 'DEP', 'ATM', 'POS', 'XFER', 'CHECK', 'PAYMENT', 'CASH', 'DIRECTDEP', 'DIRECTDEBIT', 'REPEATPMT', 'HOLD', 'OTHER');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "vibetc"."user_role" AS ENUM('admin', 'staff');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vibetc"."accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"nickname" text NOT NULL,
	"financial_institution" text NOT NULL,
	"intu_bid" text NOT NULL,
	"intu_org" text NOT NULL,
	"account_type" "vibetc"."account_type" NOT NULL,
	"account_number" text NOT NULL,
	"account_number_last4" text GENERATED ALWAYS AS (right(account_number, 4)) STORED,
	"routing_number" text,
	"routing_number_aba_valid" boolean,
	"currency" text DEFAULT 'USD' NOT NULL,
	"default_csv_template" "vibetc"."csv_template" DEFAULT 'qbo3' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vibetc"."audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb,
	"correlation_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vibetc"."companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vibetc"."export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"statement_id" uuid NOT NULL,
	"format" "vibetc"."export_format" NOT NULL,
	"requested_by" uuid,
	"intu_bid_used" text,
	"file_path" text NOT NULL,
	"file_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vibetc"."fidir_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"intu_bid" text NOT NULL,
	"intu_org" text NOT NULL,
	"bank_name" text NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"url" text,
	"raw" jsonb NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vibetc"."sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vibetc"."statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"source_pdf_hash" text NOT NULL,
	"source_pdf_path" text NOT NULL,
	"source_pdf_pages" integer NOT NULL,
	"period_start" date,
	"period_end" date,
	"opening_balance_cents" bigint,
	"closing_balance_cents" bigint,
	"status" "vibetc"."statement_status" DEFAULT 'uploaded' NOT NULL,
	"reconciliation_status" "vibetc"."reconciliation_status" DEFAULT 'pending' NOT NULL,
	"ocr_engine_version" text,
	"llm_model_version" text,
	"extraction_method" "vibetc"."extraction_method",
	"source_date_format" "vibetc"."source_date_format",
	"source_date_format_confidence" real,
	"source_date_format_user_confirmed" boolean DEFAULT false NOT NULL,
	"period_bounds_violations" integer DEFAULT 0 NOT NULL,
	"llm_provider" "vibetc"."llm_provider",
	"llm_input_tokens" integer DEFAULT 0 NOT NULL,
	"llm_output_tokens" integer DEFAULT 0 NOT NULL,
	"llm_call_count" integer DEFAULT 0 NOT NULL,
	"llm_cost_micros" bigint DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vibetc"."system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value_plaintext" text,
	"value_encrypted" "bytea",
	"is_secret" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vibetc"."transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"statement_id" uuid NOT NULL,
	"seq_in_day" integer NOT NULL,
	"posted_date" date NOT NULL,
	"description" text NOT NULL,
	"normalized_description" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"running_balance_cents" bigint,
	"check_number" text,
	"trntype" "vibetc"."trntype" NOT NULL,
	"fitid" text NOT NULL,
	"source_page" integer NOT NULL,
	"source_bbox_json" jsonb,
	"confidence" real DEFAULT 1 NOT NULL,
	"user_edited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vibetc"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "vibetc"."user_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vibetc"."accounts" ADD CONSTRAINT "accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "vibetc"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vibetc"."export_jobs" ADD CONSTRAINT "export_jobs_statement_id_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "vibetc"."statements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vibetc"."export_jobs" ADD CONSTRAINT "export_jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "vibetc"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vibetc"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "vibetc"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vibetc"."statements" ADD CONSTRAINT "statements_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "vibetc"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vibetc"."system_settings" ADD CONSTRAINT "system_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "vibetc"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vibetc"."transactions" ADD CONSTRAINT "transactions_statement_id_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "vibetc"."statements"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_entity_idx" ON "vibetc"."audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_at_idx" ON "vibetc"."audit_log" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fidir_bid_country_uq" ON "vibetc"."fidir_entries" USING btree ("intu_bid","country");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "statements_account_hash_uq" ON "vibetc"."statements" USING btree ("account_id","source_pdf_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transactions_statement_fitid_uq" ON "vibetc"."transactions" USING btree ("statement_id","fitid");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transactions_near_duplicate_uq" ON "vibetc"."transactions" USING btree ("statement_id","posted_date","amount_cents","normalized_description","seq_in_day");