// Aggressive orchestration matrix for processExtraction — covers the error
// and method branches the basic worker test doesn't: provider fallback,
// AMBIGUOUS-date halt + override, empty transactions, unrepairable
// discrepancy, the force-ocr (local vision) path, both-providers-fail,
// cooperative cancellation mid-run, and the Anthropic monthly-cap block.
//
// Seams: vi.mock('../services/llm-provider.js') keeps the REAL providerOrderFor
// (so fallback ordering is exercised) but injects a configurable policy + stub
// providers whose extract() is driven by per-test `behaviors`. rasterizePdf is
// mocked (no poppler on CI) so the vision path runs without a real scan.
// Live-Postgres only.

import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, getPool } from '../db/client.js';
import { renderExport } from '../services/exports.js';
import {
  accounts,
  auditLog,
  companies,
  statements,
  systemSettings,
  transactions,
  users,
} from '../db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
const live = describe.skipIf(!databaseUrl);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsFolder = join(__dirname, '..', 'db', 'migrations');

type ProviderId = 'local' | 'anthropic';
type AnyResult = {
  data: unknown;
  rawJson: string;
  telemetry: {
    inputTokens: number;
    outputTokens: number;
    ms: number;
    model: string;
    costMicros: bigint;
  };
};
type Behavior = (markdown: string, opts: { images?: unknown[] }) => Promise<AnyResult>;

// ---- module-level test config the hoisted vi.mock closures read ----
let mockPolicy: 'local-only' | 'anthropic-only' | 'local-first' | 'anthropic-first' = 'local-only';
let behaviors: Record<ProviderId, Behavior>;
let mockRasterPath = '';
let mockRasterCount = 1;
let buildCalls: ProviderId[] = [];
// Spy for the auto check-payee trigger (the resolver itself is unit-tested in
// check-resolver.test.ts; here we only assert the worker's gate).
const resolveCheckPayeesSpy = vi.fn(async () => ({
  txCount: 1,
  candidateCount: 1,
  llmExtractedCount: 1,
  matchedCount: 1,
  unmatchedCheckNumbers: [] as string[],
  pageCount: 1,
  costMicros: 0n,
  model: 'qwen2.5vl:7b',
}));

const telemetry = (model = 'qwen3.5:35b-a3b') => ({
  inputTokens: 5,
  outputTokens: 7,
  ms: 1,
  model,
  costMicros: 0n,
});
const ok = (data: unknown, model?: string): AnyResult => ({
  data,
  rawJson: JSON.stringify(data),
  telemetry: telemetry(model),
});

// Balanced two-transaction statement (opening 100000 + 5000 + 5000 = 110000).
const BALANCED = {
  account: { masked_number: null, type_hint: null },
  institution: { name: 'Acme Bank', intu_org_hint: null },
  period: { start: '2026-03-01', end: '2026-03-31' },
  balances: { opening_cents: 100_000, closing_cents: 110_000 },
  source_date_format: { format: 'MDY' as const, confidence: 0.9 },
  transactions: [
    {
      posted_date: '2026-03-08',
      description: 'PAYROLL DEPOSIT',
      amount_cents: 5_000,
      source_page: 1,
      confidence: 0.99,
    },
    {
      posted_date: '2026-03-12',
      description: 'GROCERY STORE',
      amount_cents: 5_000,
      source_page: 1,
      confidence: 0.99,
    },
  ],
};

const withOverrides = (over: Record<string, unknown>): unknown => ({ ...BALANCED, ...over });

vi.mock('../services/llm-provider.js', async (orig) => {
  const actual = await orig<typeof import('../services/llm-provider.js')>();
  return {
    ...actual, // keep the REAL providerOrderFor so fallback ordering is real
    resolveProviderPolicy: vi.fn(async () => mockPolicy),
    buildProviderForId: vi.fn(async (_db: unknown, id: ProviderId) => {
      buildCalls.push(id);
      return {
        id,
        health: async () => ({ ok: true }),
        extract: (markdown: string, opts: { images?: unknown[] } = {}) =>
          behaviors[id](markdown, opts),
      };
    }),
  };
});

vi.mock('../services/check-resolver.js', () => ({
  resolveCheckPayees: (...args: unknown[]) => resolveCheckPayeesSpy(...(args as [])),
}));

vi.mock('@vibe-tx-converter/extractor', async (orig) => {
  const actual = await orig<typeof import('@vibe-tx-converter/extractor')>();
  return {
    ...actual,
    // No poppler in CI — hand back `mockRasterCount` fake page images (all
    // pointing at one tiny on-disk file the worker readFile()s).
    rasterizePdf: vi.fn(async () =>
      Array.from({ length: mockRasterCount }, (_unused, i) => ({
        index: i,
        path: mockRasterPath,
        mediaType: 'image/jpeg' as const,
        width: 0,
        height: 0,
      })),
    ),
  };
});

const buildDigitalPdf = async (lines: string[]): Promise<Buffer> => buildMultiPagePdf([lines]);

const buildMultiPagePdf = async (pages: string[][]): Promise<Buffer> => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    let y = 720;
    for (const line of lines) {
      page.drawText(line, { x: 50, y, size: 11, font });
      y -= 16;
    }
  }
  return Buffer.from(await doc.save());
};

live('processExtraction — methods + error matrix (live Postgres)', () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-bytes-long-XXXX';
  }
  let dataDir: string;
  let stmtId: string;
  let accountId: string;
  let pdfPath: string;

  const run = async (): Promise<void> => {
    const { processExtraction } = await import('./extraction.worker.js');
    await processExtraction({
      statementId: stmtId,
      accountId,
      sourcePdfHash: 'a'.repeat(64),
      sourcePdfPath: pdfPath,
    });
  };
  const getStmt = async () =>
    (await getDb().select().from(statements).where(eq(statements.id, stmtId)))[0]!;
  const getTxs = async () =>
    getDb().select().from(transactions).where(eq(transactions.statementId, stmtId));

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'vibetc-methods-'));
    process.env.DATA_DIR = dataDir;
    const pool = getPool();
    await pool.query('DROP SCHEMA IF EXISTS vibetc CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrate(getDb(), { migrationsFolder });
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    mockPolicy = 'local-only';
    behaviors = {
      local: async () => ok(BALANCED),
      anthropic: async () => ok(BALANCED, 'claude-sonnet-4-6'),
    };
    buildCalls = [];
    mockRasterCount = 1;
    resolveCheckPayeesSpy.mockClear();
    mockRasterPath = join(dataDir, 'fake-page.jpg');
    await writeFile(mockRasterPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // minimal JPEG-ish bytes

    const db = getDb();
    // audit_log is append-only (no DELETE/TRUNCATE grant); leave it and scope
    // audit assertions by entityId (a fresh UUID per test) instead.
    await getPool().query(
      'TRUNCATE TABLE vibetc.transactions, vibetc.statements, vibetc.accounts, vibetc.companies, vibetc.users, vibetc.system_settings RESTART IDENTITY CASCADE',
    );
    await db
      .insert(users)
      .values({ email: 'q@q.q', passwordHash: 'argon2id$x', displayName: 'q', role: 'admin' });
    const [c] = await db.insert(companies).values({ name: 'C' }).returning();
    const [a] = await db
      .insert(accounts)
      .values({
        companyId: c!.id,
        nickname: 'op',
        financialInstitution: 'Wells Fargo',
        intuBid: '3000',
        intuOrg: 'Wells Fargo',
        accountType: 'CHECKING',
        accountNumber: '1234567890',
      })
      .returning();
    accountId = a!.id;

    const pdfBytes = await buildDigitalPdf([
      'STATEMENT OF ACCOUNT — Wells Fargo Operating Account',
      'Period 2026-03-01 through 2026-03-31',
      '2026-03-08 PAYROLL DEPOSIT credit fifty dollars',
      '2026-03-12 GROCERY STORE purchase fifty dollars',
      'Account ending in 7890 — page 1 of 1',
    ]);
    pdfPath = join(dataDir, 'test.pdf');
    await writeFile(pdfPath, pdfBytes);
    const [s] = await db
      .insert(statements)
      .values({
        accountId,
        sourcePdfHash: 'a'.repeat(64),
        sourcePdfPath: pdfPath,
        sourcePdfPages: 1,
        status: 'uploaded',
      })
      .returning();
    stmtId = s!.id;
  });

  // 1 — provider fallback: local-first, local throws (http) → anthropic wins.
  it('falls back to the secondary provider when the primary throws', async () => {
    mockPolicy = 'local-first';
    behaviors.local = async () => {
      throw new Error('local gateway HTTP 500');
    };
    behaviors.anthropic = async () => ok(BALANCED, 'claude-sonnet-4-6');

    await run();
    const stmt = await getStmt();
    expect(stmt.status).toBe('review');
    expect(stmt.llmProvider).toBe('anthropic');
    expect(buildCalls).toEqual(['local', 'anthropic']);
    expect(await getTxs()).toHaveLength(2);

    const fb = await getDb()
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'statement.extraction-fallback'), eq(auditLog.entityId, stmtId)),
      );
    expect(fb.length).toBeGreaterThanOrEqual(1);
  });

  // 2 — AMBIGUOUS date format halts for operator confirmation.
  it('halts at awaiting-locale-confirmation on an AMBIGUOUS date format', async () => {
    behaviors.local = async () =>
      ok(withOverrides({ source_date_format: { format: 'AMBIGUOUS', confidence: 0.4 } }));

    await run();
    const stmt = await getStmt();
    expect(stmt.status).toBe('awaiting-locale-confirmation');
    expect(stmt.sourceDateFormat).toBe('AMBIGUOUS');
    expect(await getTxs()).toHaveLength(0);
  });

  // 3 — operator date-format override bypasses the AMBIGUOUS halt.
  it('proceeds past AMBIGUOUS when the operator already confirmed a format', async () => {
    await getDb()
      .update(statements)
      .set({ sourceDateFormatUserConfirmed: true, sourceDateFormat: 'MDY' })
      .where(eq(statements.id, stmtId));
    // Even if the model still reports AMBIGUOUS, the override gate proceeds.
    behaviors.local = async () =>
      ok(withOverrides({ source_date_format: { format: 'AMBIGUOUS', confidence: 0.4 } }));

    await run();
    const stmt = await getStmt();
    expect(stmt.status).toBe('review');
    expect(await getTxs()).toHaveLength(2);
  });

  // 4 — empty transactions: not a hard failure; lands in review with 0 rows.
  it('handles an empty-transactions extraction (no rows, review status)', async () => {
    behaviors.local = async () =>
      ok(
        withOverrides({
          balances: { opening_cents: 100_000, closing_cents: 100_000 },
          transactions: [],
        }),
      );

    await run();
    const stmt = await getStmt();
    expect(stmt.status).toBe('review');
    expect(stmt.reconciliationStatus).toBe('verified'); // no movement, balances tie
    expect(await getTxs()).toHaveLength(0);
  });

  // 5 — unrepairable discrepancy persists with reconciliationStatus=discrepancy.
  it('persists a discrepancy that neither LLM nor heuristic repair can fix', async () => {
    // opening 100000, one +5000 tx, closing 200000 → delta 95000; no sign-flip
    // (delta+2*5000≠0) or drop (delta+5000≠0) closes it, and the mock repair
    // re-extract returns the same data.
    behaviors.local = async () =>
      ok(
        withOverrides({
          balances: { opening_cents: 100_000, closing_cents: 200_000 },
          transactions: [
            {
              posted_date: '2026-03-08',
              description: 'PAYROLL DEPOSIT',
              amount_cents: 5_000,
              source_page: 1,
              confidence: 0.99,
            },
          ],
        }),
      );

    await run();
    const stmt = await getStmt();
    expect(stmt.status).toBe('review');
    expect(stmt.reconciliationStatus).toBe('discrepancy');
    expect(await getTxs()).toHaveLength(1);
  });

  // 6 — force-ocr drives the local vision path (rasterize mocked).
  it('runs the local vision/OCR path under the force-ocr strategy', async () => {
    await getDb()
      .update(statements)
      .set({ processingStrategyOverride: 'force-ocr' })
      .where(eq(statements.id, stmtId));
    // The vision call receives images; assert the worker actually routed there.
    let sawImages = false;
    behaviors.local = async (_md, opts) => {
      sawImages = Array.isArray(opts.images) && opts.images.length > 0;
      return ok(BALANCED);
    };

    await run();
    const stmt = await getStmt();
    expect(sawImages).toBe(true);
    expect(stmt.status).toBe('review');
    expect(stmt.extractionMethod).toBe('ocr');
    expect(stmt.llmProvider).toBe('local');
    expect(await getTxs()).toHaveLength(2);
  });

  // 7 — both providers fail → processExtraction rethrows (worker marks failed).
  it('throws when every provider fails with an http/malformed rejection', async () => {
    mockPolicy = 'local-first';
    behaviors.local = async () => {
      throw new Error('local gateway HTTP 503');
    };
    behaviors.anthropic = async () => {
      throw new Error('anthropic HTTP 529');
    };
    await expect(run()).rejects.toThrow();
    const stmt = await getStmt();
    expect(stmt.status).not.toBe('review');
  });

  // 8 — cooperative cancellation: a concurrent /cancel flips status mid-run.
  it('aborts with CancelledError when the statement is cancelled mid-extraction', async () => {
    behaviors.local = async () => {
      // Simulate the /cancel route landing while the LLM call is in flight.
      await getDb()
        .update(statements)
        .set({ status: 'failed', errorMessage: 'cancelled by operator' })
        .where(eq(statements.id, stmtId));
      return ok(BALANCED);
    };
    await expect(run()).rejects.toMatchObject({ name: 'CancelledError' });
    const stmt = await getStmt();
    expect(stmt.status).toBe('failed');
    expect(await getTxs()).toHaveLength(0);
  });

  // 9 — Anthropic monthly spend cap blocks the call before it is made.
  it('blocks extraction when the Anthropic monthly cap is reached', async () => {
    mockPolicy = 'anthropic-only';
    // Cap $0.01; an existing statement this month already spent $0.02.
    await getDb()
      .insert(systemSettings)
      .values({ key: 'llm.anthropic.monthly_cap_usd', valuePlaintext: '0.01', isSecret: false });
    await getDb()
      .insert(statements)
      .values({
        accountId,
        sourcePdfHash: 'b'.repeat(64),
        sourcePdfPath: pdfPath,
        sourcePdfPages: 1,
        status: 'review',
        llmCostMicros: 20_000n,
      });
    let anthropicCalled = false;
    behaviors.anthropic = async () => {
      anthropicCalled = true;
      return ok(BALANCED, 'claude-sonnet-4-6');
    };

    await expect(run()).rejects.toThrow(/cap/i);
    expect(anthropicCalled).toBe(false);
  });

  // 10 — auto-ocr-fallback: text-layer rejects → retry via local OCR → hybrid.
  it('falls back from text-layer to OCR under auto-ocr-fallback', async () => {
    await getDb()
      .update(statements)
      .set({ processingStrategyOverride: 'auto-ocr-fallback' })
      .where(eq(statements.id, stmtId));
    behaviors.local = async (_md, opts) => {
      if (opts.images && opts.images.length > 0) return ok(BALANCED); // OCR retry succeeds
      throw new Error('local gateway HTTP 500'); // text-layer attempt rejects
    };

    await run();
    const stmt = await getStmt();
    expect(stmt.status).toBe('review');
    expect(stmt.extractionMethod).toBe('hybrid');
    expect(await getTxs()).toHaveLength(2);
    const fb = await getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'statement.input-fallback'), eq(auditLog.entityId, stmtId)));
    expect(fb.length).toBeGreaterThanOrEqual(1);
  });

  // 11 — auto-text-fallback: OCR rejects → retry via the text layer → hybrid.
  it('falls back from OCR to text-layer under auto-text-fallback', async () => {
    await getDb()
      .update(statements)
      .set({ processingStrategyOverride: 'auto-text-fallback' })
      .where(eq(statements.id, stmtId));
    behaviors.local = async (_md, opts) => {
      if (opts.images && opts.images.length > 0) throw new Error('local gateway HTTP 500'); // OCR rejects
      return ok(BALANCED); // text-layer retry succeeds
    };

    await run();
    const stmt = await getStmt();
    expect(stmt.status).toBe('review');
    expect(stmt.extractionMethod).toBe('hybrid');
    expect(await getTxs()).toHaveLength(2);
  });

  // 12 — defensive guard: an extraction missing period bounds is rejected.
  it('throws on an extraction outcome missing period bounds', async () => {
    behaviors.local = async () => ok(withOverrides({ period: { start: null, end: null } }));
    await expect(run()).rejects.toThrow(/period bounds/i);
  });

  // 13 — OCR-error safety net: low-confidence rows hold the statement for
  // review (even when the Golden Rule reconciliation verifies).
  it('flags low-confidence rows for review (reviewHoldReason set)', async () => {
    const prev = process.env.VIBETC_REVIEW_CONFIDENCE_THRESHOLD;
    process.env.VIBETC_REVIEW_CONFIDENCE_THRESHOLD = '0.7';
    behaviors.local = async () =>
      ok(
        withOverrides({
          transactions: [
            {
              posted_date: '2026-03-08',
              description: 'PAYROLL DEPOSIT',
              amount_cents: 5_000,
              source_page: 1,
              confidence: 0.5,
            },
            {
              posted_date: '2026-03-12',
              description: 'GROCERY STORE',
              amount_cents: 5_000,
              source_page: 1,
              confidence: 0.55,
            },
          ],
        }),
      );
    try {
      await run();
    } finally {
      if (prev === undefined) delete process.env.VIBETC_REVIEW_CONFIDENCE_THRESHOLD;
      else process.env.VIBETC_REVIEW_CONFIDENCE_THRESHOLD = prev;
    }
    const stmt = await getStmt();
    expect(stmt.status).toBe('review');
    expect(stmt.reconciliationStatus).toBe('verified'); // balances still tie
    expect(stmt.reviewHoldReason).toMatch(/low confidence/i);
    expect(stmt.reviewHoldAcknowledged).toBe(false);
  });

  // 14 — high-confidence extraction is NOT held.
  it('does not hold a high-confidence extraction', async () => {
    behaviors.local = async () => ok(BALANCED); // confidence 0.99
    await run();
    const stmt = await getStmt();
    expect(stmt.status).toBe('review');
    expect(stmt.reviewHoldReason).toBeNull();
  });

  // 15 — multi-account PDF: detected splits are persisted for the split UI.
  it('detects a multi-account PDF and persists detectedSplits', async () => {
    // Pages must be text-dense enough to route 'text' (avgCharsPerPage > 100),
    // since multi-account detection runs on the text-layer path.
    const multiPdf = await buildMultiPagePdf([
      [
        'WELLS FARGO — PERSONAL CHECKING ACCOUNT STATEMENT',
        'Account number 1234560001 — statement period 2026-03-01 through 2026-03-31',
        'Beginning balance reported as one thousand dollars on the first of the month',
        '2026-03-08 PAYROLL DEPOSIT direct deposit credit of fifty dollars posted',
        '2026-03-09 ONLINE TRANSFER to savings withdrawal of twenty five dollars',
        'Ending balance reported on the final business day of the period above',
      ],
      [
        'WELLS FARGO — PERSONAL SAVINGS ACCOUNT STATEMENT',
        'Account number 9876540002 — statement period 2026-03-01 through 2026-03-31',
        'Beginning balance reported as five hundred dollars on the first of the month',
        '2026-03-12 GROCERY STORE point of sale purchase debit of fifty dollars',
        '2026-03-20 INTEREST PAYMENT credit of one dollar and twelve cents posted',
        'Ending balance reported on the final business day of the period above',
      ],
    ]);
    pdfPath = join(dataDir, 'multi.pdf');
    await writeFile(pdfPath, multiPdf);
    await getDb()
      .update(statements)
      .set({ sourcePdfPath: pdfPath, sourcePdfPages: 2 })
      .where(eq(statements.id, stmtId));

    await run();
    const stmt = await getStmt();
    const splits = stmt.detectedSplits as { multiAccount?: boolean; uniqueLast4?: string[] } | null;
    expect(splits?.multiAccount).toBe(true);
    expect(splits?.uniqueLast4).toEqual(expect.arrayContaining(['0001', '0002']));
  });

  // 16 — BullMQ wrapper: a non-cancelled failure marks the statement failed.
  it('finalizeJobFailure marks the statement failed with a user message', async () => {
    const { finalizeJobFailure } = await import('./extraction.worker.js');
    const verdict = await finalizeJobFailure(
      { statementId: stmtId, accountId, sourcePdfHash: 'a'.repeat(64), sourcePdfPath: pdfPath },
      new Error('Ollama unreachable'),
      'job-1',
    );
    expect(verdict).toBe('failed');
    const stmt = await getStmt();
    expect(stmt.status).toBe('failed');
    expect(stmt.errorMessage).toMatch(/Ollama unreachable/);
  });

  // 17 — BullMQ wrapper: a CancelledError keeps the existing /cancel verdict.
  it('finalizeJobFailure leaves a cancelled statement untouched', async () => {
    const { finalizeJobFailure, CancelledError } = await import('./extraction.worker.js');
    await getDb()
      .update(statements)
      .set({ status: 'failed', errorMessage: 'cancelled by operator' })
      .where(eq(statements.id, stmtId));
    const verdict = await finalizeJobFailure(
      { statementId: stmtId, accountId, sourcePdfHash: 'a'.repeat(64), sourcePdfPath: pdfPath },
      new CancelledError(),
      'job-2',
    );
    expect(verdict).toBe('cancelled');
    const stmt = await getStmt();
    expect(stmt.errorMessage).toBe('cancelled by operator'); // not overwritten
  });

  // 18b — scanned multi-account: distinct account numbers across vision
  // batches persist detectedSplits for the split UI (the OCR-path analogue of
  // the text-path detection).
  it('detects a scanned multi-account PDF from per-batch account numbers', async () => {
    await getDb()
      .update(statements)
      .set({ processingStrategyOverride: 'force-ocr' })
      .where(eq(statements.id, stmtId));
    mockRasterCount = 4; // 4 rasterized pages
    const prevBytes = process.env.VIBETC_OCR_IMAGE_BATCH_BYTES;
    process.env.VIBETC_OCR_IMAGE_BATCH_BYTES = '1'; // force one page per batch
    let batchIdx = 0;
    behaviors.local = async (_md, opts) => {
      // Pages 0–1 → account 1111, pages 2–3 → account 2222.
      const last4 = batchIdx < 2 ? '1111' : '2222';
      batchIdx += 1;
      void opts;
      return ok(withOverrides({ account: { masked_number: `****${last4}`, type_hint: null } }));
    };
    try {
      await run();
    } finally {
      if (prevBytes === undefined) delete process.env.VIBETC_OCR_IMAGE_BATCH_BYTES;
      else process.env.VIBETC_OCR_IMAGE_BATCH_BYTES = prevBytes;
    }
    const stmt = await getStmt();
    expect(stmt.extractionMethod).toBe('ocr');
    const splits = stmt.detectedSplits as { multiAccount?: boolean; uniqueLast4?: string[] } | null;
    expect(splits?.multiAccount).toBe(true);
    expect(splits?.uniqueLast4).toEqual(expect.arrayContaining(['1111', '2222']));
  });

  // 18 — full loop: a low-confidence hold BLOCKS export until acknowledged.
  it('blocks export of a held statement and allows it after acknowledgement', async () => {
    const prev = process.env.VIBETC_REVIEW_CONFIDENCE_THRESHOLD;
    process.env.VIBETC_REVIEW_CONFIDENCE_THRESHOLD = '0.7';
    behaviors.local = async () =>
      ok(
        withOverrides({
          transactions: [
            {
              posted_date: '2026-03-08',
              description: 'PAYROLL DEPOSIT',
              amount_cents: 5_000,
              source_page: 1,
              confidence: 0.4,
            },
            {
              posted_date: '2026-03-12',
              description: 'GROCERY STORE',
              amount_cents: 5_000,
              source_page: 1,
              confidence: 0.9,
            },
          ],
        }),
      );
    try {
      await run();
    } finally {
      if (prev === undefined) delete process.env.VIBETC_REVIEW_CONFIDENCE_THRESHOLD;
      else process.env.VIBETC_REVIEW_CONFIDENCE_THRESHOLD = prev;
    }
    const db = getDb();
    expect((await getStmt()).reviewHoldReason).toMatch(/low confidence/i);

    // Export is refused while the hold is unacknowledged.
    await expect(renderExport(db, stmtId, 'csv-generic')).rejects.toThrow(/review hold/i);

    // Operator acknowledges → export proceeds.
    await db
      .update(statements)
      .set({ reviewHoldAcknowledged: true })
      .where(eq(statements.id, stmtId));
    const rendered = await renderExport(db, stmtId, 'csv-generic');
    expect(rendered).toBeTruthy();
  });

  // 19 — auto check-payee trigger fires for check rows that have no payee.
  it('auto-runs check-payee resolution when a check row lacks a payee', async () => {
    behaviors.local = async () =>
      ok(
        withOverrides({
          balances: { opening_cents: 100_000, closing_cents: 95_000 },
          transactions: [
            {
              posted_date: '2026-03-08',
              description: 'CHECK 1234',
              amount_cents: -5_000,
              source_page: 1,
              confidence: 0.99,
              check_number: '1234',
            },
          ],
        }),
      );
    await run();
    expect(resolveCheckPayeesSpy).toHaveBeenCalledTimes(1);
    expect(resolveCheckPayeesSpy.mock.calls[0]?.[1]).toBe(stmtId);
  });

  // 20 — no check rows → no auto trigger.
  it('does not auto-run check-payee resolution without check rows', async () => {
    behaviors.local = async () => ok(BALANCED); // no check_number on any row
    await run();
    expect(resolveCheckPayeesSpy).not.toHaveBeenCalled();
  });

  // 21 — VIBETC_CHECK_PAYEE_AUTO=false disables the auto trigger.
  it('respects VIBETC_CHECK_PAYEE_AUTO=false', async () => {
    const prev = process.env.VIBETC_CHECK_PAYEE_AUTO;
    process.env.VIBETC_CHECK_PAYEE_AUTO = 'false';
    behaviors.local = async () =>
      ok(
        withOverrides({
          balances: { opening_cents: 100_000, closing_cents: 95_000 },
          transactions: [
            {
              posted_date: '2026-03-08',
              description: 'CHECK 1234',
              amount_cents: -5_000,
              source_page: 1,
              confidence: 0.99,
              check_number: '1234',
            },
          ],
        }),
      );
    try {
      await run();
    } finally {
      if (prev === undefined) delete process.env.VIBETC_CHECK_PAYEE_AUTO;
      else process.env.VIBETC_CHECK_PAYEE_AUTO = prev;
    }
    expect(resolveCheckPayeesSpy).not.toHaveBeenCalled();
  });
});
