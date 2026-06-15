import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const vibetc = pgSchema('vibetc');

// ----- enums -----

export const userRole = vibetc.enum('user_role', ['admin', 'staff']);

export const accountType = vibetc.enum('account_type', [
  'CHECKING',
  'SAVINGS',
  'MONEYMRKT',
  'CREDITLINE',
  'CREDITCARD',
]);

export const csvTemplate = vibetc.enum('csv_template', ['qbo3', 'qbo4', 'xero', 'generic']);

export const statementStatus = vibetc.enum('statement_status', [
  'uploaded',
  'preprocessing',
  'ocr',
  'extracting',
  'reconciling',
  'awaiting-locale-confirmation',
  'review',
  'exported',
  'failed',
]);

export const reconciliationStatus = vibetc.enum('reconciliation_status', [
  'pending',
  'verified',
  'discrepancy',
  'overridden',
  'failed',
]);

export const extractionMethod = vibetc.enum('extraction_method', ['text', 'ocr', 'hybrid']);

// Per-statement override for the PDF processing order. Resolves against
// the global `pdf.processing.strategy` system_settings row at extraction
// time; NULL means "use the firm default".
//   - auto               : text-layer if present, OCR if not. No retry.
//   - force-text         : always use the text layer. Fail if absent.
//   - force-ocr          : always run GLM-OCR, even with a text layer.
//   - auto-ocr-fallback  : text-layer first; re-run extraction with OCR
//                          when the LLM stack rejects the text-layer
//                          input (HTTP / malformed / empty-txs /
//                          discrepancy).
//   - auto-text-fallback : OCR first; re-run extraction with the text
//                          layer when the LLM stack rejects the OCR
//                          input. Mirror of auto-ocr-fallback; useful
//                          when the embedded text layer is unreliable.
export const pdfProcessingStrategy = vibetc.enum('pdf_processing_strategy', [
  'auto',
  'force-text',
  'force-ocr',
  'auto-ocr-fallback',
  'auto-text-fallback',
]);

export const sourceDateFormat = vibetc.enum('source_date_format', [
  'MDY',
  'DMY',
  'YMD',
  'TEXTUAL',
  'AMBIGUOUS',
]);

export const llmProvider = vibetc.enum('llm_provider', ['local', 'anthropic']);

export const trntype = vibetc.enum('trntype', [
  'CREDIT',
  'DEBIT',
  'INT',
  'DIV',
  'FEE',
  'SRVCHG',
  'DEP',
  'ATM',
  'POS',
  'XFER',
  'CHECK',
  'PAYMENT',
  'CASH',
  'DIRECTDEP',
  'DIRECTDEBIT',
  'REPEATPMT',
  'HOLD',
  'OTHER',
]);

export const exportFormat = vibetc.enum('export_format', [
  'csv-qbo3',
  'csv-qbo4',
  'csv-xero',
  'csv-generic',
  'ofx',
  'qbo',
  'qfx',
]);

// ----- bytea custom type for encrypted secrets -----

const bytea = customType<{ data: Buffer; default: false }>({
  dataType: () => 'bytea',
});

// Phase 14 #6/#7: page_range int4range carries the half-open page slice
// for a per-account statement when one PDF was split into multiple
// statements. Stored as Postgres int4range; rendered as '[3,7)' for
// pages 3-6. NULL means "the whole PDF" (no split was applied).
export interface PageRange {
  start: number; // 1-based, inclusive
  end: number; // 1-based, inclusive
}

const int4range = customType<{ data: PageRange | null; driverData: string; default: false }>({
  dataType: () => 'int4range',
  toDriver: (value) => {
    if (value === null || value === undefined) return '';
    // Use the canonical inclusive-lower / exclusive-upper representation
    // to match how Postgres stores ranges internally.
    return `[${value.start},${value.end + 1})`;
  },
  fromDriver: (raw) => {
    if (typeof raw !== 'string' || raw.length === 0 || raw === 'empty') return null;
    // Postgres normalizes ranges to '[lower,upper)'.
    const m = /^[[(](\d+),(\d+)[\])]$/.exec(raw);
    if (!m) return null;
    const lowerInclusive = raw.startsWith('[');
    const upperInclusive = raw.endsWith(']');
    const lo = Number.parseInt(m[1]!, 10);
    const hi = Number.parseInt(m[2]!, 10);
    return {
      start: lowerInclusive ? lo : lo + 1,
      end: upperInclusive ? hi : hi - 1,
    };
  },
});

// ----- tables -----

export const users = vibetc.table('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  role: userRole('role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Per-user, per-feature access overrides. A missing row means the
// feature is ENABLED (default-on) for that user — only explicit denials
// (and re-enables) are stored. feature_key is validated against the
// app-side registry (lib/feature-registry.ts), not a DB enum, so adding
// a feature needs no migration. updated_by/updated_at give the audit a
// "who/when" beyond the append-only audit_log row.
export const userFeatureAccess = vibetc.table(
  'user_feature_access',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    featureKey: text('feature_key').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.featureKey] }),
  }),
);

export const sessions = vibetc.table('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const companies = vibetc.table('companies', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const accounts = vibetc.table(
  'accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    nickname: text('nickname').notNull(),
    financialInstitution: text('financial_institution').notNull(),
    intuBid: text('intu_bid').notNull(),
    intuOrg: text('intu_org').notNull(),
    accountType: accountType('account_type').notNull(),
    accountNumber: text('account_number').notNull(),
    accountNumberLast4: text('account_number_last4').generatedAlwaysAs(
      sql`right(account_number, 4)`,
    ),
    routingNumber: text('routing_number'),
    routingNumberAbaValid: boolean('routing_number_aba_valid'),
    // Phase 23 item 17: optional admin override of the synthetic
    // INTU.USERID emitted in QFX exports. NULL → derive from account.id.
    intuUseridOverride: text('intu_userid_override'),
    currency: text('currency').notNull().default('USD'),
    defaultCsvTemplate: csvTemplate('default_csv_template').notNull().default('qbo3'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    usdOnly: check('accounts_currency_usd_only', sql`${t.currency} = 'USD'`),
    creditCardNoRouting: check(
      'accounts_credit_card_no_routing',
      sql`(${t.accountType} <> 'CREDITCARD') OR (${t.routingNumber} IS NULL)`,
    ),
  }),
);

export const statements = vibetc.table(
  'statements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    sourcePdfHash: text('source_pdf_hash').notNull(),
    sourcePdfPath: text('source_pdf_path').notNull(),
    // Flips true when the file at sourcePdfPath is intentionally removed
    // (admin Delete-PDF, statement delete, or retention sweep). The row
    // and its transactions stay; only the bytes on disk are gone. The
    // statement.delete-pdf audit row carries the "why".
    sourcePdfDeleted: boolean('source_pdf_deleted').notNull().default(false),
    sourcePdfPages: integer('source_pdf_pages').notNull(),
    periodStart: date('period_start'),
    periodEnd: date('period_end'),
    openingBalanceCents: bigint('opening_balance_cents', { mode: 'bigint' }),
    closingBalanceCents: bigint('closing_balance_cents', { mode: 'bigint' }),
    status: statementStatus('status').notNull().default('uploaded'),
    reconciliationStatus: reconciliationStatus('reconciliation_status')
      .notNull()
      .default('pending'),
    ocrEngineVersion: text('ocr_engine_version'),
    llmModelVersion: text('llm_model_version'),
    extractionMethod: extractionMethod('extraction_method'),
    sourceDateFormat: sourceDateFormat('source_date_format'),
    sourceDateFormatConfidence: real('source_date_format_confidence'),
    sourceDateFormatUserConfirmed: boolean('source_date_format_user_confirmed')
      .notNull()
      .default(false),
    periodBoundsViolations: integer('period_bounds_violations').notNull().default(0),
    llmProvider: llmProvider('llm_provider'),
    llmInputTokens: integer('llm_input_tokens').notNull().default(0),
    llmOutputTokens: integer('llm_output_tokens').notNull().default(0),
    llmCallCount: integer('llm_call_count').notNull().default(0),
    llmCostMicros: bigint('llm_cost_micros', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    errorMessage: text('error_message'),
    detectedSplits: jsonb('detected_splits'),
    multiAccountAcknowledged: boolean('multi_account_acknowledged').notNull().default(false),
    // Phase 14 #6/#7: when a PDF was split per detected account, this
    // captures the page range for this slice. NULL means "the whole PDF".
    pageRange: int4range('page_range'),
    // Per-upload override of the firm-wide PDF processing strategy.
    // NULL = use the firm default from system_settings.
    processingStrategyOverride: pdfProcessingStrategy('processing_strategy_override'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Drizzle doesn't yet model NULLS NOT DISTINCT or partial-on-NOT-NULL
    // indexes. The migration 0006 below replaces this naive index with a
    // partial unique index that includes page_range and treats NULLs as
    // equal — see migrations/0006_page_range_split.sql.
    uniqueByAccountAndHash: uniqueIndex('statements_account_hash_uq').on(
      t.accountId,
      t.sourcePdfHash,
    ),
  }),
);

export const businessCategories = vibetc.table(
  'business_categories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(100),
    archived: boolean('archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Case-insensitive uniqueness on name. Created in migration 0007;
    // we keep it declared on the Drizzle side so generated diffs match.
    nameLowerUq: uniqueIndex('business_categories_name_lower_uq').on(sql`lower(${t.name})`),
    archivedSortIdx: index('business_categories_archived_sort_idx').on(
      t.archived,
      t.sortOrder,
      t.name,
    ),
  }),
);

export const transactions = vibetc.table(
  'transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => statements.id, { onDelete: 'cascade' }),
    seqInDay: integer('seq_in_day').notNull(),
    postedDate: date('posted_date').notNull(),
    description: text('description').notNull(),
    normalizedDescription: text('normalized_description').notNull(),
    amountCents: bigint('amount_cents', { mode: 'bigint' }).notNull(),
    runningBalanceCents: bigint('running_balance_cents', { mode: 'bigint' }),
    checkNumber: text('check_number'),
    trntype: trntype('trntype').notNull(),
    fitid: text('fitid').notNull(),
    sourcePage: integer('source_page').notNull(),
    sourceBboxJson: jsonb('source_bbox_json'),
    confidence: real('confidence').notNull().default(1),
    userEdited: boolean('user_edited').notNull().default(false),
    // Phase 33 — LLM enrichment. cleansedDescription is the normalized
    // human-readable form that ships in <NAME> at OFX/QFX/QBO export
    // time; raw `description` is preserved in <MEMO>.
    cleansedDescription: text('cleansed_description'),
    businessCategoryId: uuid('business_category_id').references(() => businessCategories.id, {
      onDelete: 'set null',
    }),
    enrichmentUserEdited: boolean('enrichment_user_edited').notNull().default(false),
    enrichmentRunAt: timestamp('enrichment_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqueByStatementAndFitid: uniqueIndex('transactions_statement_fitid_uq').on(
      t.statementId,
      t.fitid,
    ),
    nearDuplicateGuard: uniqueIndex('transactions_near_duplicate_uq').on(
      t.statementId,
      t.postedDate,
      t.amountCents,
      t.normalizedDescription,
      t.seqInDay,
    ),
    amountNonZero: check('transactions_amount_nonzero', sql`${t.amountCents} <> 0`),
    businessCategoryIdx: index('transactions_business_category_idx').on(t.businessCategoryId),
  }),
);

export const fidirEntries = vibetc.table(
  'fidir_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    intuBid: text('intu_bid').notNull(),
    intuOrg: text('intu_org').notNull(),
    bankName: text('bank_name').notNull(),
    country: text('country').notNull().default('US'),
    url: text('url'),
    raw: jsonb('raw').notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }).defaultNow().notNull(),
  },
  // The GIN trgm index on bank_name is created in a separate migration
  // (0001_extensions.sql) after pg_trgm is installed.
  (t) => ({
    uniqueByBidAndCountry: uniqueIndex('fidir_bid_country_uq').on(t.intuBid, t.country),
  }),
);

export const exportJobs = vibetc.table('export_jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  statementId: uuid('statement_id')
    .notNull()
    .references(() => statements.id, { onDelete: 'cascade' }),
  format: exportFormat('format').notNull(),
  requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
  intuBidUsed: text('intu_bid_used'),
  filePath: text('file_path').notNull(),
  fileBytes: integer('file_bytes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const auditLog = vibetc.table(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
    actorUserId: uuid('actor_user_id'),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action').notNull(),
    payload: jsonb('payload'),
    correlationId: text('correlation_id'),
  },
  (t) => ({
    entityIndex: index('audit_log_entity_idx').on(t.entityType, t.entityId),
    atIndex: index('audit_log_at_idx').on(t.at),
  }),
);

export const systemSettings = vibetc.table(
  'system_settings',
  {
    key: text('key').primaryKey(),
    valuePlaintext: text('value_plaintext'),
    valueEncrypted: bytea('value_encrypted'),
    isSecret: boolean('is_secret').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => ({
    secretXorPlaintext: check(
      'system_settings_secret_xor_plaintext',
      sql`(${t.isSecret} = true AND ${t.valuePlaintext} IS NULL AND ${t.valueEncrypted} IS NOT NULL)
          OR (${t.isSecret} = false AND ${t.valueEncrypted} IS NULL)`,
    ),
  }),
);
