import { eq, inArray, sql } from 'drizzle-orm';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { FALLBACK_INTU_BID } from '@vibe-tx-converter/shared';
import {
  renderCsv,
  renderOfxXml,
  renderQbo,
  renderQfx,
  resolveBankId,
  type BankIdSource,
  type CsvTemplate,
  type Stmt,
} from '@vibe-tx-converter/exporters';

import type { Db } from '../db/client.js';
import {
  accounts,
  businessCategories,
  exportJobs,
  statements,
  transactions,
} from '../db/schema.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import type { Account, Statement, Transaction, User } from '../db/types.js';
import { writeAudit } from './audit.js';

// Filenames flow through Content-Disposition headers, which Node's
// http module rejects for any byte > 0x7E (ERR_INVALID_CHAR). Bank/FI
// names from the FIDIR mirror can carry curly quotes, en/em-dashes,
// or accented letters, so strip non-ASCII and a few other header- /
// filesystem-hostile chars at filename construction time.
const sanitizeFilenamePart = (s: string): string =>
  s
    .normalize('NFKD')

    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[\\/:*?"<>|\r\n]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '') || 'export';

const buildExportBaseName = (account: Account, stmt: Statement): string => {
  const last4 = account.accountNumberLast4 ?? account.accountNumber.slice(-4);
  return [
    sanitizeFilenamePart(account.financialInstitution),
    sanitizeFilenamePart(last4),
    sanitizeFilenamePart(stmt.periodStart ?? 'unknown'),
    sanitizeFilenamePart(stmt.periodEnd ?? 'unknown'),
  ].join('_');
};

// Phase 24 #7/#21: export bytes are persisted under
// $DATA_DIR/exports/{statementId}/{exportJobId}.{ext} so re-downloads
// don't re-render and the maintenance worker can sweep stale files
// after 30 days. The directory is created on demand.
export const exportFilePath = (
  statementId: string,
  jobId: string,
  format: ExportFormat,
): string => {
  const dataDir = process.env.DATA_DIR ?? './data';
  const ext = format.startsWith('csv-') ? 'csv' : format;
  return join(dataDir, 'exports', statementId, `${jobId}.${ext}`);
};

export type ExportFormat =
  | 'csv-qbo3'
  | 'csv-qbo4'
  | 'csv-xero'
  | 'csv-generic'
  | 'ofx'
  | 'qbo'
  | 'qfx';

const fetchStatementContext = async (
  db: Db,
  statementId: string,
): Promise<{ stmt: Statement; account: Account; txs: Transaction[] }> => {
  const stmtRows = await db.select().from(statements).where(eq(statements.id, statementId));
  const stmt = stmtRows[0];
  if (!stmt) throw new NotFoundError(`statement ${statementId}`);
  const acctRows = await db.select().from(accounts).where(eq(accounts.id, stmt.accountId));
  const account = acctRows[0];
  if (!account) throw new NotFoundError(`account ${stmt.accountId}`);
  const txs = await db
    .select()
    .from(transactions)
    .where(eq(transactions.statementId, statementId))
    .orderBy(transactions.postedDate, transactions.seqInDay);
  // Descriptions are stored in cleartext (local OCR, no Shield tokens), so
  // there is nothing to materialize before rendering the export file.
  return { stmt, account, txs };
};

interface BuildOfxResult {
  stmt: Stmt;
  bankIdSource: BankIdSource;
}

// Phase 33 — fetch a name-by-id map for any business categories
// referenced by `txs`. Empty when no transaction has a category. Kept
// out of fetchStatementContext so non-CSV exports (OFX/QBO/QFX, which
// don't carry category in the wire format) skip the round-trip.
const fetchCategoryNamesFor = async (db: Db, txs: Transaction[]): Promise<Map<string, string>> => {
  const ids = [
    ...new Set(
      txs.map((t) => t.businessCategoryId).filter((v): v is string => typeof v === 'string'),
    ),
  ];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: businessCategories.id, name: businessCategories.name })
    .from(businessCategories)
    .where(inArray(businessCategories.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
};

// Credit-card statements are STORED in statement sign (extractor SYSTEM_PROMPT
// "Credit-card (INVERTED)"): charges positive, payments/refunds negative, an
// owed closing balance positive — that is what the Golden Rule reconciles.
// Every export, though, speaks from the account HOLDER's perspective (OFX spec
// 3.2.9.2; QuickBooks / Quicken / Xero imports): purchases negative, payments
// positive, an owed balance negative. Flip at export time only — stored
// amounts and FITIDs (ADR-005, hashed from the stored sign) never change.
const holderSign = (account: Account): bigint => (account.accountType === 'CREDITCARD' ? -1n : 1n);

const buildOfxStmt = (stmt: Statement, account: Account, txs: Transaction[]): BuildOfxResult => {
  if (stmt.openingBalanceCents === null || stmt.closingBalanceCents === null) {
    throw new ConflictError('statement has no opening/closing balance — cannot build OFX');
  }
  if (!stmt.periodStart || !stmt.periodEnd) {
    throw new ConflictError('statement has no period bounds — cannot build OFX');
  }
  const sgn = holderSign(account);
  // Phase 22 item 19/21: resolve BANKID via the canonical fallback ladder.
  const { bankId, source: bankIdSource } = resolveBankId(account.routingNumber, account.intuBid);
  const ofxStmt: Stmt = {
    bankAccountInfo: {
      bankId,
      accountId: account.accountNumber,
      accountType: account.accountType,
      intuBid: account.intuBid || FALLBACK_INTU_BID,
      intuOrg: account.intuOrg,
      // Phase 23 #2/#3: emit INTU.USERID in QFX. The override field is
      // verbatim if set, otherwise we derive from account.id so re-exports
      // are byte-stable across runs.
      ...(account.intuUseridOverride ? { intuUserid: account.intuUseridOverride } : {}),
      intuUseridSeed: account.id,
    },
    transactions: txs.map((t) => {
      // Phase 33 — when the LLM has produced a cleansed description
      // and it actually differs from the raw bank string, promote
      // cleansed to <NAME> and tuck the raw original into <MEMO> so
      // QuickBooks shows the human-readable form but operators can
      // audit-trace to the bank's exact wording.
      const useCleansed =
        typeof t.cleansedDescription === 'string' &&
        t.cleansedDescription.length > 0 &&
        t.cleansedDescription !== t.description;
      // A check payee (read from the cancelled-check image) is the most
      // accurate <NAME> for a check row — prefer it over the cleansed/raw
      // description; the raw bank string still goes to <MEMO> for audit.
      const usePayee = typeof t.payee === 'string' && t.payee.length > 0;
      const name = usePayee ? t.payee! : useCleansed ? t.cleansedDescription! : t.description;
      const out: Stmt['transactions'][number] = {
        trntype: t.trntype,
        postedDate: t.postedDate,
        amountCents: sgn * t.amountCents,
        fitid: t.fitid,
        name,
      };
      if (t.checkNumber) out.checkNumber = t.checkNumber;
      // <MEMO> carries the full raw description whenever <NAME> doesn't: when
      // a payee / cleansed name replaced it, or when it is longer than NAME's
      // 32-char limit and would otherwise lose its tail (Phase 21 #10).
      if (usePayee || useCleansed || t.description.length > 32) out.memo = t.description;
      return out;
    }),
    ledgerBalanceCents: sgn * stmt.closingBalanceCents,
    startDate: stmt.periodStart,
    endDate: stmt.periodEnd,
    asOf: stmt.createdAt,
    currency: 'USD',
  };
  return { stmt: ofxStmt, bankIdSource };
};

// Review hold: a LIVE gate. The extraction worker sets `reviewHoldReason`
// whenever any row is below the review-confidence threshold (OCR-error safety
// net), so this fires for low-confidence statements and blocks export until the
// operator acknowledges via the statements route. There is no override
// bypass — acknowledgement is the only way through.
const assertNotHeldForReview = (stmt: Statement): void => {
  if (stmt.reviewHoldReason && !stmt.reviewHoldAcknowledged) {
    throw new ConflictError(`export blocked by review hold — ${stmt.reviewHoldReason}`);
  }
};

// The ONE export gate, shared by renderExport and renderExportSlices so the
// single-file, split and bundle paths can't drift apart. In order:
//   1. Lifecycle — only a statement whose extraction finished (`review`) or
//      that was already exported has a trustworthy transaction set. Re-extract,
//      date-format confirmation, split and failed runs wipe or replace the
//      transactions but can leave a stale reconciliation status behind, so the
//      reconciliation check alone would export an empty or stale file.
//   2. Golden Rule — DENY by default (ADR-010). Only `verified`, or
//      `overridden` (the typed-confirmation, audit-logged
//      POST /override-reconciliation flow — Phase 16 #17), passes. There is no
//      per-request override: `discrepancy`, `pending`, `failed` and null are
//      all blocked, so a new code path that leaves a statement un-reconciled
//      can't silently export.
//   3. Review hold (above).
const assertExportable = (stmt: Statement): void => {
  if (stmt.status !== 'review' && stmt.status !== 'exported') {
    throw new ConflictError(`export blocked — statement is ${stmt.status}, not ready for export`);
  }
  const status = stmt.reconciliationStatus;
  if (status !== 'verified' && status !== 'overridden') {
    if (status === 'discrepancy') {
      throw new ConflictError(
        'reconciliation discrepancy — resolve it or override the reconciliation before exporting',
      );
    }
    throw new ConflictError(
      `export blocked — statement is not reconciled (status: ${status ?? 'pending'})`,
    );
  }
  assertNotHeldForReview(stmt);
};

export interface RenderedExport {
  format: ExportFormat;
  contentType: string;
  filename: string;
  // Account + period stem shared by every format of this statement (no
  // template, part or extension) — names the split / bundle zips.
  baseName: string;
  bytes: Buffer;
  intuBidUsed?: string;
  bankIdSource?: BankIdSource;
}

export const renderExport = async (
  db: Db,
  statementId: string,
  format: ExportFormat,
): Promise<RenderedExport> => {
  const { stmt, account, txs } = await fetchStatementContext(db, statementId);
  assertExportable(stmt);

  const baseName = buildExportBaseName(account, stmt);

  const overridden = stmt.reconciliationStatus === 'overridden';
  const overrideNote = overridden
    ? `overridden by user — exported at ${new Date().toISOString()}`
    : undefined;

  if (format.startsWith('csv-')) {
    const tmpl = format.slice(4) as CsvTemplate;
    // Generic CSV is the only template that carries the enrichment
    // columns; QBO 3-col / 4-col / Xero have fixed column shapes that
    // downstream tools rely on. Skip the category fetch when not needed.
    const categoryNamesById =
      tmpl === 'generic' ? await fetchCategoryNamesFor(db, txs) : new Map<string, string>();
    // Holder-perspective signs for every template (see holderSign): a CC
    // charge lands negative / in the Debit column, a payment positive / in
    // the Credit column, an owed running balance negative. The generic CSV
    // is the documented QuickBooks Online import path (docs/qbo-import.md),
    // so it follows the same convention.
    const sgn = holderSign(account);
    const csv = renderCsv(
      tmpl,
      txs.map((t) => ({
        postedDate: t.postedDate,
        description: t.description,
        amountCents: sgn * t.amountCents,
        runningBalanceCents: t.runningBalanceCents === null ? null : sgn * t.runningBalanceCents,
        trntype: t.trntype,
        fitid: t.fitid,
        ...(t.checkNumber ? { checkNumber: t.checkNumber } : {}),
        // Check payee feeds the Xero Payee column and the generic Payee column.
        ...(t.payee ? { payee: t.payee } : {}),
        ...(tmpl === 'generic' && t.cleansedDescription
          ? { cleansedDescription: t.cleansedDescription }
          : {}),
        ...(tmpl === 'generic' && t.businessCategoryId
          ? { category: categoryNamesById.get(t.businessCategoryId) ?? '' }
          : {}),
      })),
      overridden && tmpl === 'generic'
        ? { headerComment: `Generated by vibetc — reconciliation overridden` }
        : {},
    );
    return {
      format,
      contentType: 'text/csv; charset=utf-8',
      // The template is part of the name (Phase 20 #11) — four CSV templates
      // share one base name, and the bundle zip would otherwise keep only
      // the last of four same-named entries.
      filename: `${baseName}_${tmpl}.csv`,
      baseName,
      bytes: Buffer.from(csv, 'utf8'),
    };
  }

  const { stmt: ast, bankIdSource } = buildOfxStmt(stmt, account, txs);
  if (format === 'ofx') {
    return {
      format,
      contentType: 'application/x-ofx',
      filename: `${baseName}.ofx`,
      baseName,
      bytes: Buffer.from(renderOfxXml(ast, overrideNote ? { overrideNote } : {}), 'utf8'),
      bankIdSource,
    };
  }
  if (format === 'qbo') {
    return {
      format,
      contentType: 'application/vnd.intu.qbo',
      filename: `${baseName}.qbo`,
      baseName,
      bytes: Buffer.from(renderQbo(ast), 'utf8'),
      intuBidUsed: ast.bankAccountInfo.intuBid ?? FALLBACK_INTU_BID,
      bankIdSource,
    };
  }
  if (format === 'qfx') {
    return {
      format,
      contentType: 'application/vnd.intu.qfx',
      filename: `${baseName}.qfx`,
      baseName,
      bytes: Buffer.from(renderQfx(ast), 'utf8'),
      intuBidUsed: ast.bankAccountInfo.intuBid ?? FALLBACK_INTU_BID,
      bankIdSource,
    };
  }
  throw new Error(`unknown export format: ${format as string}`);
};

// QBO importer in QuickBooks Desktop chokes on files > ~350 KB; for safety
// we slice into 200-transaction chunks and let the caller bundle them.
// Phase 22 item 9.
const QBO_SPLIT_THRESHOLD = 200;

export const renderExportSlices = async (
  db: Db,
  statementId: string,
  format: ExportFormat,
): Promise<RenderedExport[]> => {
  if (format !== 'qbo' && format !== 'qfx') {
    return [await renderExport(db, statementId, format)];
  }
  const { stmt, account, txs } = await fetchStatementContext(db, statementId);
  assertExportable(stmt);
  if (txs.length <= QBO_SPLIT_THRESHOLD) {
    return [await renderExport(db, statementId, format)];
  }
  const baseName = buildExportBaseName(account, stmt);
  const slices: RenderedExport[] = [];
  for (let i = 0; i < txs.length; i += QBO_SPLIT_THRESHOLD) {
    const chunkTxs = txs.slice(i, i + QBO_SPLIT_THRESHOLD);
    const part = Math.floor(i / QBO_SPLIT_THRESHOLD) + 1;
    const { stmt: ast, bankIdSource } = buildOfxStmt(stmt, account, chunkTxs);
    const ext = format === 'qbo' ? 'qbo' : 'qfx';
    slices.push({
      format,
      contentType: format === 'qbo' ? 'application/vnd.intu.qbo' : 'application/vnd.intu.qfx',
      filename: `${baseName}_part${part}.${ext}`,
      baseName,
      bytes: Buffer.from(format === 'qbo' ? renderQbo(ast) : renderQfx(ast), 'utf8'),
      intuBidUsed: ast.bankAccountInfo.intuBid ?? FALLBACK_INTU_BID,
      bankIdSource,
    });
  }
  return slices;
};

export const recordExportJob = async (
  db: Db,
  actor: User,
  statementId: string,
  result: RenderedExport,
): Promise<{ id: string; filePath: string }> => {
  // Insert the export_jobs row first to obtain the job UUID, then write
  // the bytes under that UUID's path. We tolerate a write failure by
  // rolling back the row — leaving an export_jobs entry pointing at a
  // non-existent file would surface as a confusing 404 in the UI.
  const [row] = await db
    .insert(exportJobs)
    .values({
      statementId,
      format: result.format,
      requestedBy: actor.id,
      intuBidUsed: result.intuBidUsed ?? null,
      filePath: '<pending>',
      fileBytes: result.bytes.length,
    })
    .returning({ id: exportJobs.id });
  if (!row) throw new Error('export_jobs insert returned no row');
  const path = exportFilePath(statementId, row.id, result.format);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, result.bytes);
  } catch (err) {
    await db.delete(exportJobs).where(eq(exportJobs.id, row.id));
    throw err;
  }
  await db.update(exportJobs).set({ filePath: path }).where(eq(exportJobs.id, row.id));
  await writeAudit(db, {
    actorUserId: actor.id,
    entityType: 'statement',
    entityId: statementId,
    action: 'statement.export',
    payload: { format: result.format, bytes: result.bytes.length, exportJobId: row.id },
  });
  return { id: row.id, filePath: path };
};

// Phase 24 #21: 30-day cleanup. Called from the maintenance worker.
// Returns the count of files removed. Rows are kept so the audit log
// stays intact; the file_path is replaced with '<expired>'.
export const cleanupExpiredExports = async (
  db: Db,
  retentionDays = 30,
): Promise<{ removed: number }> => {
  const cutoff = sql`now() - (${retentionDays} || ' days')::interval`;
  const stale = await db
    .select({ id: exportJobs.id, filePath: exportJobs.filePath })
    .from(exportJobs)
    .where(
      sql`${exportJobs.createdAt} < ${cutoff} AND ${exportJobs.filePath} NOT IN ('<expired>', '<pending>')`,
    );
  let removed = 0;
  for (const job of stale) {
    try {
      await unlink(job.filePath);
      removed += 1;
    } catch {
      // already gone
    }
    await db.update(exportJobs).set({ filePath: '<expired>' }).where(eq(exportJobs.id, job.id));
  }
  return { removed };
};

export const overrideReconciliation = async (
  db: Db,
  actor: User,
  statementId: string,
  reason: string,
): Promise<void> => {
  await db
    .update(statements)
    .set({ reconciliationStatus: 'overridden', updatedAt: sql`now()` })
    .where(eq(statements.id, statementId));
  await writeAudit(db, {
    actorUserId: actor.id,
    entityType: 'statement',
    entityId: statementId,
    action: 'statement.reconciliation-override',
    payload: { reason },
  });
};
