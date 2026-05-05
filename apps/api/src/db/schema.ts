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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqueByAccountAndHash: uniqueIndex('statements_account_hash_uq').on(
      t.accountId,
      t.sourcePdfHash,
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
