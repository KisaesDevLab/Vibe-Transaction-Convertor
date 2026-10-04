// Export service — gate, credit-card sign convention, NAME/MEMO mapping and
// filenames. Pure unit test: a tiny fake Db answers the three context
// queries (statement, account, transactions), so no Postgres is needed.

import { describe, expect, it } from 'vitest';

import type { Db } from '../db/client.js';
import { accounts, statements, transactions } from '../db/schema.js';
import type { Account, Statement, Transaction } from '../db/types.js';
import { renderExport, renderExportSlices, type ExportFormat } from './exports.js';

const STMT_ID = '00000000-0000-0000-0000-0000000000aa';
const ACCT_ID = '00000000-0000-0000-0000-0000000000bb';

const baseStmt = (over: Partial<Statement> = {}): Statement =>
  ({
    id: STMT_ID,
    accountId: ACCT_ID,
    periodStart: '2026-03-01',
    periodEnd: '2026-03-31',
    openingBalanceCents: 0n,
    closingBalanceCents: 0n,
    status: 'review',
    reconciliationStatus: 'verified',
    reviewHoldReason: null,
    reviewHoldAcknowledged: false,
    createdAt: new Date(Date.UTC(2026, 6, 9, 13, 45, 0)), // uploaded long after period end
    ...over,
  }) as Statement;

const baseAccount = (over: Partial<Account> = {}): Account =>
  ({
    id: ACCT_ID,
    financialInstitution: 'Test Bank',
    accountNumber: '000123456789',
    accountNumberLast4: '6789',
    accountType: 'CHECKING',
    routingNumber: '121000248',
    intuBid: '3000',
    intuOrg: 'Test Bank',
    intuUseridOverride: null,
    ...over,
  }) as Account;

let txSeq = 0;
const tx = (over: Partial<Transaction>): Transaction =>
  ({
    id: `tx-${(txSeq += 1)}`,
    statementId: STMT_ID,
    seqInDay: 0,
    postedDate: '2026-03-10',
    description: 'ROW',
    amountCents: 0n,
    runningBalanceCents: null,
    checkNumber: null,
    payee: null,
    trntype: 'DEBIT',
    fitid: `VTC-${String(txSeq).padStart(16, '0')}`,
    cleansedDescription: null,
    businessCategoryId: null,
    ...over,
  }) as Transaction;

// db.select().from(table).where(...)[.orderBy(...)] → rows for that table.
const fakeDb = (stmt: Statement, account: Account, txs: Transaction[]): Db => {
  const rowsFor = (table: unknown): unknown[] =>
    table === statements
      ? [stmt]
      : table === accounts
        ? [account]
        : table === transactions
          ? txs
          : [];
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = Promise.resolve(rowsFor(table));
          return Object.assign(rows, { orderBy: () => rows });
        },
      }),
    }),
  } as unknown as Db;
};

const text = async (db: Db, format: ExportFormat): Promise<string> =>
  (await renderExport(db, STMT_ID, format)).bytes.toString('utf8');

// ---------------------------------------------------------------------------
// Credit card: stored in statement sign (charge +, payment −, owed balance +).
// ---------------------------------------------------------------------------
const ccDb = (): Db =>
  fakeDb(
    baseStmt({ openingBalanceCents: 300_000n, closingBalanceCents: 262_783n }),
    baseAccount({
      accountType: 'CREDITCARD',
      routingNumber: null,
      intuBid: '10898',
      intuOrg: 'American Express',
    }),
    [
      tx({
        postedDate: '2026-03-04',
        description: 'WHOLE FOODS MARKET',
        amountCents: 12_783n, // charge
        runningBalanceCents: 312_783n,
        trntype: 'DEBIT',
      }),
      tx({
        postedDate: '2026-03-15',
        description: 'PAYMENT - THANK YOU',
        amountCents: -50_000n, // payment
        runningBalanceCents: 262_783n,
        trntype: 'PAYMENT',
      }),
    ],
  );

describe('renderExport — credit-card holder-perspective signs (OFX 3.2.9.2)', () => {
  it('QBO / QFX / OFX: charge negative, payment positive, owed balance negative', async () => {
    const db = ccDb();
    for (const fmt of ['qbo', 'qfx'] as const) {
      const out = await text(db, fmt);
      expect(out).toContain('<CCACCTFROM>');
      expect(out).toMatch(/<TRNTYPE>DEBIT\r\n<DTPOSTED>20260304\r\n<TRNAMT>-127\.83\r\n/);
      expect(out).toMatch(/<TRNTYPE>PAYMENT\r\n<DTPOSTED>20260315\r\n<TRNAMT>500\.00\r\n/);
      expect(out).toContain('<BALAMT>-2627.83');
    }
    const ofx = await text(db, 'ofx');
    expect(ofx).toContain('<TRNAMT>-127.83</TRNAMT>');
    expect(ofx).toContain('<TRNAMT>500.00</TRNAMT>');
    expect(ofx).toContain('<BALAMT>-2627.83</BALAMT>');
  });

  it('CSV templates use the same holder-perspective signs', async () => {
    const db = ccDb();
    const qbo3 = await text(db, 'csv-qbo3');
    expect(qbo3).toContain('03/04/2026,WHOLE FOODS MARKET,-127.83\r\n');
    expect(qbo3).toContain('03/15/2026,PAYMENT - THANK YOU,500.00\r\n');
    // 4-column: the charge is a Debit (right column), the payment a Credit.
    const qbo4 = await text(db, 'csv-qbo4');
    expect(qbo4).toContain('03/04/2026,WHOLE FOODS MARKET,,127.83\r\n');
    expect(qbo4).toContain('03/15/2026,PAYMENT - THANK YOU,500.00,\r\n');
    const xero = await text(db, 'csv-xero');
    expect(xero).toContain('03/04/2026,-127.83,WHOLE FOODS MARKET,');
    expect(xero).toContain('03/15/2026,500.00,PAYMENT - THANK YOU,');
    // Generic: amount AND running balance (owed → negative); TRNTYPE unchanged.
    const generic = await text(db, 'csv-generic');
    expect(generic).toContain('03/04/2026,WHOLE FOODS MARKET,-127.83,-3127.83,,,DEBIT,');
    expect(generic).toContain('03/15/2026,PAYMENT - THANK YOU,500.00,-2627.83,,,PAYMENT,');
  });

  it('bank accounts keep their stored signs', async () => {
    const db = fakeDb(
      baseStmt({ openingBalanceCents: 100_000n, closingBalanceCents: 92_579n }),
      baseAccount(),
      [tx({ description: 'GROCERY', amountCents: -7_421n, runningBalanceCents: 92_579n })],
    );
    expect(await text(db, 'qbo')).toContain('<TRNAMT>-74.21\r\n');
    expect(await text(db, 'qbo')).toContain('<BALAMT>925.79\r\n');
    expect(await text(db, 'csv-qbo3')).toContain('03/10/2026,GROCERY,-74.21\r\n');
    expect(await text(db, 'csv-generic')).toContain('03/10/2026,GROCERY,-74.21,925.79,');
  });
});

describe('renderExport — NAME / MEMO mapping (Phase 21 #10)', () => {
  it('a description longer than 32 chars keeps its full text in MEMO', async () => {
    const long = 'ACH DEBIT ACME INSURANCE COMPANY PREMIUM 2026-03';
    const db = fakeDb(baseStmt(), baseAccount(), [tx({ description: long, amountCents: -100n })]);
    const out = await text(db, 'qbo');
    expect(out).toContain(`<NAME>${long.slice(0, 32)}\r\n`);
    expect(out).toContain(`<MEMO>${long}\r\n`);
  });

  it('a short raw description emits NAME only', async () => {
    const db = fakeDb(baseStmt(), baseAccount(), [
      tx({ description: 'COFFEE', amountCents: -100n }),
    ]);
    const out = await text(db, 'qbo');
    expect(out).toContain('<NAME>COFFEE\r\n');
    expect(out).not.toContain('<MEMO>');
  });

  it('a check with a payee keeps CHECKNUM and the raw bank description in MEMO', async () => {
    const db = fakeDb(baseStmt(), baseAccount(), [
      tx({
        description: 'CHECK 1234',
        amountCents: -25_000n,
        checkNumber: '1234',
        payee: 'ACME Plumbing',
        trntype: 'CHECK',
      }),
    ]);
    const out = await text(db, 'qbo');
    expect(out).toContain('<CHECKNUM>1234\r\n');
    expect(out).toContain('<NAME>ACME Plumbing\r\n');
    expect(out).toContain('<MEMO>CHECK 1234\r\n');
  });
});

describe('renderExport — <DTASOF> is the period end, not the upload time', () => {
  it('stamps the balance with the statement period end', async () => {
    const db = fakeDb(baseStmt(), baseAccount(), [tx({ amountCents: 0n })]);
    const out = await text(db, 'qbo');
    expect(out).toContain('<DTASOF>20260331');
    expect(out).not.toContain('<DTASOF>20260709');
  });
});

describe('export gate', () => {
  const gated = (over: Partial<Statement>): Db =>
    fakeDb(baseStmt(over), baseAccount(), [tx({ amountCents: 0n })]);

  it.each(['uploaded', 'extracting', 'reconciling', 'awaiting-locale-confirmation', 'failed'])(
    'blocks a %s statement even with a stale verified reconciliation',
    async (status) => {
      const db = gated({ status: status as Statement['status'] });
      await expect(renderExport(db, STMT_ID, 'csv-qbo3')).rejects.toThrow(
        `export blocked — statement is ${status}, not ready for export`,
      );
      await expect(renderExportSlices(db, STMT_ID, 'qbo')).rejects.toThrow(/not ready for export/);
    },
  );

  it('allows review and exported statements', async () => {
    for (const status of ['review', 'exported'] as const) {
      const out = await renderExport(gated({ status }), STMT_ID, 'csv-qbo3');
      expect(out.format).toBe('csv-qbo3');
    }
  });

  it('blocks a discrepancy — there is no per-request override', async () => {
    const db = gated({ reconciliationStatus: 'discrepancy' });
    // A stray legacy `{ allowOverride: true }` argument changes nothing.
    const legacy = renderExport as unknown as (
      db: Db,
      id: string,
      f: ExportFormat,
      o: { allowOverride: boolean },
    ) => Promise<unknown>;
    await expect(legacy(db, STMT_ID, 'csv-qbo3', { allowOverride: true })).rejects.toThrow(
      /reconciliation discrepancy/,
    );
    await expect(renderExportSlices(db, STMT_ID, 'qfx')).rejects.toThrow(
      /reconciliation discrepancy/,
    );
  });

  it('blocks pending / failed reconciliation', async () => {
    for (const reconciliationStatus of ['pending', 'failed'] as const) {
      await expect(renderExport(gated({ reconciliationStatus }), STMT_ID, 'ofx')).rejects.toThrow(
        /not reconciled/,
      );
    }
  });

  it('allows a type-confirmed override (status overridden)', async () => {
    const out = await renderExport(gated({ reconciliationStatus: 'overridden' }), STMT_ID, 'ofx');
    expect(out.bytes.toString('utf8')).toContain('<!-- Reconciliation: overridden by user');
  });

  it('still enforces an unacknowledged review hold', async () => {
    const db = gated({ reviewHoldReason: 'low confidence rows' });
    await expect(renderExport(db, STMT_ID, 'csv-generic')).rejects.toThrow(/review hold/);
  });
});

describe('export filenames', () => {
  it('gives every CSV template its own filename (no zip-entry collisions)', async () => {
    const db = fakeDb(baseStmt(), baseAccount(), [tx({ amountCents: -100n })]);
    const names = await Promise.all(
      (['csv-qbo3', 'csv-qbo4', 'csv-xero', 'csv-generic'] as const).map(
        async (f) => (await renderExport(db, STMT_ID, f)).filename,
      ),
    );
    expect(names).toEqual([
      'Test-Bank_6789_2026-03-01_2026-03-31_qbo3.csv',
      'Test-Bank_6789_2026-03-01_2026-03-31_qbo4.csv',
      'Test-Bank_6789_2026-03-01_2026-03-31_xero.csv',
      'Test-Bank_6789_2026-03-01_2026-03-31_generic.csv',
    ]);
    const ofx = await renderExport(db, STMT_ID, 'ofx');
    expect(ofx.filename).toBe('Test-Bank_6789_2026-03-01_2026-03-31.ofx');
    expect(ofx.baseName).toBe('Test-Bank_6789_2026-03-01_2026-03-31');
  });
});
