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

import { UnrecoverableError } from 'bullmq';
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
let mockAiMode: 'direct' | 'router' = 'direct';
let behaviors: Record<ProviderId, Behavior>;
let mockRasterPath = '';
let mockRasterCount = 1;
let buildCalls: ProviderId[] = [];
// Stage-1 OCR transcription text, per page (by call index). Carries a unique
// marker so the stage-2 extract Behavior can recognize OCR-derived markdown.
// For multi-account tests, set distinct per-page account numbers here.
let ocrPageTexts: string[] = ['OCR_STAGE1_MARKER'];
let ocrCallIndex = 0;
// Runs at the start of every stage-1 OCR call (e.g. to land a /cancel mid-call
// and then fail it). null = no-op.
let ocrHook: (() => Promise<void>) | null = null;
// When set, replaces the VibeOCR client call (e.g. a 503 outage). null = the
// real client, which fails fast while VIBE_OCR_URL is unset → GLM-OCR fallback.
let mockVibeOcrFile: (() => Promise<never>) | null = null;
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

// Unrepairable discrepancy (opening 100000, one +5000 tx, closing 200000 →
// delta 95000): no sign-flip or drop closes it, and a repair re-read returns
// the same data.
const DISCREPANT = withOverrides({
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
});

// Balance-perfect, but GROCERY is dated one day after the period end:
// `verified` needs zero out-of-period rows (Phase 16 #2), so this is a
// period-only discrepancy (delta 0, 1 violation).
const PERIOD_ONLY = withOverrides({
  transactions: [
    {
      posted_date: '2026-03-08',
      description: 'PAYROLL DEPOSIT',
      amount_cents: 5_000,
      source_page: 1,
      confidence: 0.99,
    },
    {
      posted_date: '2026-04-01',
      description: 'GROCERY STORE',
      amount_cents: 5_000,
      source_page: 1,
      confidence: 0.99,
    },
  ],
});

// Same result shape as ok(), with a non-zero (Anthropic-style) cost.
const paid = (data: unknown, costMicros: bigint): AnyResult => ({
  ...ok(data, 'claude-sonnet-4-6'),
  telemetry: { ...telemetry('claude-sonnet-4-6'), costMicros },
});

// Stub provider whose extract() is driven by the per-test `behaviors`.
const stubProvider = (id: ProviderId) => {
  buildCalls.push(id);
  return {
    id,
    health: async () => ({ ok: true }),
    extract: (markdown: string, opts: { images?: unknown[] } = {}) => behaviors[id](markdown, opts),
    // Stage-1 OCR (local only): returns the configured per-page text. The
    // worker calls this once per page, then feeds the joined markdown to
    // extract() above.
    ocrToMarkdown: async () => {
      if (ocrHook) await ocrHook();
      const text = ocrPageTexts[Math.min(ocrCallIndex, ocrPageTexts.length - 1)] ?? 'OCR';
      ocrCallIndex += 1;
      return { markdown: text, telemetry: telemetry() };
    },
  };
};

vi.mock('../services/llm-provider.js', async (orig) => {
  const actual = await orig<typeof import('../services/llm-provider.js')>();
  return {
    ...actual, // keep the REAL providerOrderFor so fallback ordering is real
    resolveProviderPolicy: vi.fn(async () => mockPolicy),
    resolveAiMode: vi.fn(async () => mockAiMode),
    buildProviderForId: vi.fn(async (_db: unknown, id: ProviderId) => stubProvider(id)),
    // Extraction attempts build through the per-process variant (matrix knobs).
    buildProviderForProcessId: vi.fn(async (_db: unknown, _proc: unknown, id: ProviderId) =>
      stubProvider(id),
    ),
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
    // The fake rasters live in the test's dataDir, not a per-call temp dir —
    // the real cleanup must never touch it.
    removeRasterDir: vi.fn(async () => undefined),
    vibeOcrFile: vi.fn((...args: Parameters<typeof actual.vibeOcrFile>) =>
      mockVibeOcrFile ? mockVibeOcrFile() : actual.vibeOcrFile(...args),
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
    mockAiMode = 'direct';
    behaviors = {
      local: async () => ok(BALANCED),
      anthropic: async () => ok(BALANCED, 'claude-sonnet-4-6'),
    };
    buildCalls = [];
    mockRasterCount = 1;
    ocrPageTexts = ['OCR_STAGE1_MARKER'];
    ocrCallIndex = 0;
    ocrHook = null;
    mockVibeOcrFile = null;
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
    // The operator-confirmed format persists — not the model's AMBIGUOUS — so
    // the next re-extract doesn't halt for confirmation again.
    expect(stmt.sourceDateFormat).toBe('MDY');
    expect(stmt.sourceDateFormatConfidence).toBe(1);
    expect(stmt.sourceDateFormatUserConfirmed).toBe(true);
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
    // Two-stage: stage 1 OCRs to markdown locally, stage 2 extracts from it.
    // Assert the markdown handed to extract came from the OCR transcription.
    let extractMd = '';
    behaviors.local = async (md) => {
      extractMd = md;
      return ok(BALANCED);
    };

    await run();
    const stmt = await getStmt();
    expect(extractMd).toContain('OCR_STAGE1_MARKER');
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
    behaviors.local = async (md) => {
      if (md.includes('OCR_STAGE1_MARKER')) return ok(BALANCED); // OCR retry succeeds
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
    behaviors.local = async (md) => {
      if (md.includes('OCR_STAGE1_MARKER')) throw new Error('local gateway HTTP 500'); // OCR rejects
      return ok(BALANCED); // text-layer retry succeeds
    };

    await run();
    const stmt = await getStmt();
    expect(stmt.status).toBe('review');
    expect(stmt.extractionMethod).toBe('hybrid');
    expect(await getTxs()).toHaveLength(2);
  });

  // 12 — missing period bounds degrade to a held review, never a hard failure
  // (the statement row's period is nullable; the operator verifies it).
  it('degrades an extraction missing period bounds to a held review', async () => {
    behaviors.local = async () => ok(withOverrides({ period: { start: null, end: null } }));
    await run();
    const stmt = await getStmt();
    expect(stmt.status).toBe('review');
    expect(stmt.periodStart).toBeNull();
    expect(stmt.reviewHoldReason).toMatch(/period/i);
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

  // 18b — scanned multi-account: distinct account numbers across the OCR'd page
  // text persist detectedSplits for the split UI. Two-stage runs the SAME
  // text-based detector (detectMultiAccount) on the stage-1 transcription.
  it('detects a scanned multi-account PDF from the OCR page text', async () => {
    await getDb()
      .update(statements)
      .set({ processingStrategyOverride: 'force-ocr' })
      .where(eq(statements.id, stmtId));
    mockRasterCount = 4; // 4 rasterized pages
    // Pages 0–1 → account 1111, pages 2–3 → account 2222 (per-page OCR text).
    ocrPageTexts = [
      'Account number: 1111\nPAYROLL DEPOSIT 5000',
      'Account number: 1111\nGROCERY 5000',
      'Account number: 2222\nDEPOSIT 5000',
      'Account number: 2222\nFEE 5000',
    ];
    behaviors.local = async () => ok(BALANCED);

    await run();
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

  // 22 — an empty fallback result never replaces a primary that produced rows.
  it("keeps the primary's rows when the fallback returns no transactions", async () => {
    mockPolicy = 'local-first';
    // Primary: 1 row, unrepairable discrepancy → falls back. Fallback: empty-txs.
    behaviors.local = async () => ok(DISCREPANT);
    behaviors.anthropic = async () => ok(withOverrides({ transactions: [] }), 'claude-sonnet-4-6');

    await run();
    const stmt = await getStmt();
    expect(stmt.status).toBe('review');
    expect(stmt.llmProvider).toBe('local');
    expect(stmt.reconciliationStatus).toBe('discrepancy');
    expect(await getTxs()).toHaveLength(1);
  });

  // 23 — a cancel that lands during the primary attempt stops the run before the
  // secondary (possibly Anthropic egress) starts; the cancel verdict stands.
  it('does not start the fallback provider once the statement was cancelled', async () => {
    mockPolicy = 'local-first';
    let anthropicCalled = false;
    behaviors.local = async () => {
      await getDb()
        .update(statements)
        .set({ status: 'failed', errorMessage: 'cancelled by operator' })
        .where(eq(statements.id, stmtId));
      throw new Error('local gateway HTTP 500');
    };
    behaviors.anthropic = async () => {
      anthropicCalled = true;
      return ok(BALANCED, 'claude-sonnet-4-6');
    };

    await expect(run()).rejects.toMatchObject({ name: 'CancelledError' });
    expect(anthropicCalled).toBe(false);
    const stmt = await getStmt();
    expect(stmt.status).toBe('failed');
    expect(stmt.errorMessage).toBe('cancelled by operator');
    expect(await getTxs()).toHaveLength(0);
    const fb = await getDb()
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'statement.extraction-fallback'), eq(auditLog.entityId, stmtId)),
      );
    expect(fb).toHaveLength(0);
  });

  // 24 — router mode: the router owns failover, so the worker makes no second
  // attempt and writes no (false) local→anthropic fallback audit row.
  it('makes no worker-side provider fallback in router mode', async () => {
    mockPolicy = 'local-first';
    mockAiMode = 'router';
    let anthropicCalled = false;
    behaviors.local = async () => {
      throw new Error('Vibe AI Router: upstream unavailable (HTTP 502)');
    };
    behaviors.anthropic = async () => {
      anthropicCalled = true;
      return ok(BALANCED, 'claude-sonnet-4-6');
    };

    await expect(run()).rejects.toThrow(/502/);
    expect(anthropicCalled).toBe(false);
    expect(buildCalls).toEqual(['local']);
    const fb = await getDb()
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'statement.extraction-fallback'), eq(auditLog.entityId, stmtId)),
      );
    expect(fb).toHaveLength(0);
  });

  // 25 — llm_cost_micros is the Anthropic monthly-cap ledger: every attempt's
  // spend (incl. a rejected paid attempt) is ADDED, and a re-extract accumulates.
  it("adds every attempt's spend to the cost ledger and accumulates across runs", async () => {
    mockPolicy = 'anthropic-first';
    // Anthropic: unrepairable discrepancy (extract + LLM repair re-read, 1000
    // micros each) → rejected; local then verifies and is chosen.
    behaviors.anthropic = async () => paid(DISCREPANT, 1_000n);
    behaviors.local = async () => ok(BALANCED);

    await run();
    let stmt = await getStmt();
    expect(stmt.llmProvider).toBe('local');
    expect(stmt.llmCostMicros).toBe(2_000n);

    // Re-extract (as the route does: wipe rows, reset status) — spend adds up.
    await getDb().delete(transactions).where(eq(transactions.statementId, stmtId));
    await getDb().update(statements).set({ status: 'uploaded' }).where(eq(statements.id, stmtId));
    await run();
    stmt = await getStmt();
    expect(stmt.status).toBe('review');
    expect(stmt.llmCostMicros).toBe(4_000n);
  });

  // 26 — a deterministic failure is surfaced as permanent, which the BullMQ
  // wrapper turns into an UnrecoverableError (no retries).
  it('fails permanently on force-text when the PDF has no text layer', async () => {
    const { PermanentExtractionError, errorForBullmq } = await import('./extraction.worker.js');
    const blank = await PDFDocument.create();
    blank.addPage([612, 792]);
    pdfPath = join(dataDir, 'blank.pdf');
    await writeFile(pdfPath, Buffer.from(await blank.save()));
    await getDb()
      .update(statements)
      .set({ sourcePdfPath: pdfPath, processingStrategyOverride: 'force-text' })
      .where(eq(statements.id, stmtId));

    const err = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PermanentExtractionError);
    expect(errorForBullmq(err)).toBeInstanceOf(UnrecoverableError);
  });

  const auditRows = async (action: string) =>
    getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.entityId, stmtId)));

  // 27 — a period-only discrepancy (balance ties, a row out of period) is kept
  // for the operator: no fallback provider (Anthropic egress) may replace it.
  it('keeps a period-only discrepancy without starting the fallback provider', async () => {
    mockPolicy = 'local-first';
    let anthropicCalled = false;
    behaviors.local = async () => ok(PERIOD_ONLY);
    behaviors.anthropic = async () => {
      anthropicCalled = true;
      return ok(BALANCED, 'claude-sonnet-4-6');
    };

    await run();
    expect(anthropicCalled).toBe(false);
    expect(buildCalls).toEqual(['local']);
    const stmt = await getStmt();
    expect(stmt.status).toBe('review');
    expect(stmt.llmProvider).toBe('local');
    expect(stmt.reconciliationStatus).toBe('discrepancy'); // export stays gated
    expect(stmt.periodBoundsViolations).toBe(1);
    expect(await getTxs()).toHaveLength(2);
    expect(await auditRows('statement.extraction-fallback')).toHaveLength(0);
  });

  // 28 — …nor a re-OCR under auto-ocr-fallback.
  it('does not fall back to OCR for a period-only discrepancy (auto-ocr-fallback)', async () => {
    await getDb()
      .update(statements)
      .set({ processingStrategyOverride: 'auto-ocr-fallback' })
      .where(eq(statements.id, stmtId));
    behaviors.local = async (md) =>
      md.includes('OCR_STAGE1_MARKER') ? ok(BALANCED) : ok(PERIOD_ONLY);

    await run();
    expect(ocrCallIndex).toBe(0); // OCR never ran
    const stmt = await getStmt();
    expect(stmt.extractionMethod).toBe('text');
    expect(stmt.reconciliationStatus).toBe('discrepancy');
    expect(stmt.periodBoundsViolations).toBe(1);
    expect(await auditRows('statement.input-fallback')).toHaveLength(0);
  });

  // 29 — …nor a text-layer retry under auto-text-fallback.
  it('does not fall back to the text layer for a period-only discrepancy (auto-text-fallback)', async () => {
    await getDb()
      .update(statements)
      .set({ processingStrategyOverride: 'auto-text-fallback' })
      .where(eq(statements.id, stmtId));
    let textLayerCalled = false;
    behaviors.local = async (md) => {
      if (md.includes('OCR_STAGE1_MARKER')) return ok(PERIOD_ONLY);
      textLayerCalled = true;
      return ok(BALANCED);
    };

    await run();
    expect(textLayerCalled).toBe(false);
    const stmt = await getStmt();
    expect(stmt.extractionMethod).toBe('ocr');
    expect(stmt.reconciliationStatus).toBe('discrepancy');
    expect(await auditRows('statement.input-fallback')).toHaveLength(0);
  });

  const INTEREST_AFTER_PERIOD = {
    posted_date: '2026-04-01', // legitimately dated after the period end
    description: 'INTEREST PAYMENT',
    amount_cents: 100,
    source_page: 1,
    confidence: 0.99,
  };

  // 30 — a heuristic repair that closes the balance is applied even though a
  // legitimately out-of-period row keeps the statement a (period-only)
  // discrepancy; it stays gated and held for review.
  it('applies a balance-closing heuristic repair despite an out-of-period row', async () => {
    const grocery = BALANCED.transactions[1];
    // PAYROLL +5000, GROCERY +5000 double-captured (exact twin), INTEREST +100
    // after the period. Closing 110100: the twin puts the sum 5000 over
    // (delta -5000); dropping it ties the balance, the interest row stays.
    behaviors.local = async () =>
      ok(
        withOverrides({
          balances: { opening_cents: 100_000, closing_cents: 110_100 },
          transactions: [BALANCED.transactions[0], grocery, grocery, INTEREST_AFTER_PERIOD],
        }),
      );

    await run();
    const stmt = await getStmt();
    expect(stmt.reconciliationStatus).toBe('discrepancy');
    expect(stmt.periodBoundsViolations).toBe(1);
    expect(stmt.reviewHoldReason).toMatch(/Auto-repair applied/);
    const txs = await getTxs();
    expect(txs).toHaveLength(3);
    expect(txs.filter((t) => t.description === 'GROCERY STORE')).toHaveLength(1);
  });

  // 31 — same for the LLM re-read repair.
  it('applies a balance-closing LLM repair despite an out-of-period row', async () => {
    // First read misreads GROCERY as 4000 (delta +1000 — no sign-flip or drop
    // closes it); the repair re-read gets 5000. INTEREST is out of period in both.
    let calls = 0;
    behaviors.local = async () => {
      calls += 1;
      return ok(
        withOverrides({
          balances: { opening_cents: 100_000, closing_cents: 110_100 },
          transactions: [
            BALANCED.transactions[0],
            { ...BALANCED.transactions[1], amount_cents: calls === 1 ? 4_000 : 5_000 },
            INTEREST_AFTER_PERIOD,
          ],
        }),
      );
    };

    await run();
    expect(calls).toBe(2);
    const stmt = await getStmt();
    expect(stmt.reconciliationStatus).toBe('discrepancy');
    expect(stmt.periodBoundsViolations).toBe(1);
    expect(stmt.llmCallCount).toBe(2);
    const grocery = (await getTxs()).find((t) => t.description === 'GROCERY STORE');
    expect(grocery?.amountCents).toBe(5_000n);
  });

  // 32 — two real same-day same-amount rows print different running balances,
  // so the drop-duplicate repair must not treat the later one as an OCR twin.
  it('never drops a same-day same-amount row whose running balance differs', async () => {
    const coffee = {
      posted_date: '2026-03-10',
      description: 'COFFEE SHOP',
      amount_cents: -500,
      source_page: 1,
      confidence: 0.99,
    };
    // Statement is short a +$5 refund (delta +500): without the running
    // balances the later coffee looks like a double-capture and dropping it
    // would "verify" a wrong statement.
    behaviors.local = async () =>
      ok(
        withOverrides({
          balances: { opening_cents: 100_000, closing_cents: 104_500 },
          transactions: [
            { ...BALANCED.transactions[0], running_balance_cents: 105_000 },
            { ...coffee, running_balance_cents: 104_500 },
            { ...coffee, running_balance_cents: 104_000 },
          ],
        }),
      );

    await run();
    const stmt = await getStmt();
    expect(stmt.reconciliationStatus).toBe('discrepancy');
    expect(stmt.reviewHoldReason).toBeNull(); // no auto-repair
    expect((await getTxs()).filter((t) => t.description === 'COFFEE SHOP')).toHaveLength(2);
  });

  const jobData = () => ({
    statementId: stmtId,
    accountId,
    sourcePdfHash: 'a'.repeat(64),
    sourcePdfPath: pdfPath,
  });

  // 33 — /cancel lands while the LLM call is in flight and the call then fails
  // transiently: the cancel verdict stands, and the job is not retried (a retry's
  // unconditional job-start write would revive the statement).
  it('keeps the cancel verdict when an in-flight call then fails transiently', async () => {
    const { finalizeJobFailure } = await import('./extraction.worker.js');
    behaviors.local = async () => {
      await getDb()
        .update(statements)
        .set({ status: 'failed', errorMessage: 'cancelled by operator' })
        .where(eq(statements.id, stmtId));
      throw new Error('local gateway POST /v1/chat/completions timed out after 120000 ms');
    };

    const err = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ name: 'CancelledError' });
    // The BullMQ wrapper then writes nothing and does not rethrow.
    expect(await finalizeJobFailure(jobData(), err, 'job-c1')).toBe('cancelled');
    const stmt = await getStmt();
    expect(stmt.status).toBe('failed');
    expect(stmt.errorMessage).toBe('cancelled by operator');
    expect(await auditRows('statement.extraction-failed')).toHaveLength(0);
  });

  // 34 — same when the error escapes a phase directly (a split during OCR).
  it('treats an OCR error after a mid-run split as a cancel', async () => {
    await getDb()
      .update(statements)
      .set({ processingStrategyOverride: 'force-ocr' })
      .where(eq(statements.id, stmtId));
    ocrHook = async () => {
      await getDb()
        .update(statements)
        .set({ status: 'failed', errorMessage: 'superseded by 2-way split' })
        .where(eq(statements.id, stmtId));
      throw new Error('GLM-OCR POST /v1/chat/completions timed out');
    };

    await expect(run()).rejects.toMatchObject({ name: 'CancelledError' });
    const stmt = await getStmt();
    expect(stmt.status).toBe('failed');
    expect(stmt.errorMessage).toBe('superseded by 2-way split');
    expect(await auditRows('statement.extraction-failed')).toHaveLength(0);
  });

  // 35 — finalizeJobFailure's own guard: a row already failed (cancel landed
  // after the worker's re-check) or deleted keeps that verdict → 'cancelled'.
  it('finalizeJobFailure never overwrites a cancelled or deleted statement', async () => {
    const { finalizeJobFailure } = await import('./extraction.worker.js');
    await getDb()
      .update(statements)
      .set({ status: 'failed', errorMessage: 'cancelled by operator' })
      .where(eq(statements.id, stmtId));
    expect(await finalizeJobFailure(jobData(), new Error('local gateway HTTP 503'), 'job-c2')).toBe(
      'cancelled',
    );
    expect((await getStmt()).errorMessage).toBe('cancelled by operator');

    await getDb().delete(statements).where(eq(statements.id, stmtId));
    expect(await finalizeJobFailure(jobData(), new Error('local gateway HTTP 503'), 'job-c3')).toBe(
      'cancelled',
    );
  });

  // 36 — GLM-OCR standing in for a failed VibeOCR (no page cap) must not turn
  // a recoverable outage into a permanent "split it" failure.
  it('keeps the OCR page cap retryable when GLM-OCR only stands in for a failed VibeOCR', async () => {
    const { PermanentExtractionError, errorForBullmq } = await import('./extraction.worker.js');
    await getDb()
      .update(statements)
      .set({ processingStrategyOverride: 'force-ocr' })
      .where(eq(statements.id, stmtId));
    await getDb().insert(systemSettings).values({
      key: 'ocr.vibe.url',
      valuePlaintext: 'http://vibe-ocr.test:8099',
      isSecret: false,
    });
    mockVibeOcrFile = async () => {
      throw new Error('VibeOCR POST http://vibe-ocr.test:8099/ocr → HTTP 503');
    };
    mockRasterCount = 101; // over the 100-page GLM-OCR cap

    const err = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentExtractionError);
    expect((err as Error).message).toMatch(/^VibeOCR failed: .*HTTP 503.*101 pages/);
    expect(errorForBullmq(err)).toBe(err); // retried, not UnrecoverableError
    expect(ocrCallIndex).toBe(0); // no page was sent to GLM-OCR
  });

  // 37 — with GLM-OCR as the configured engine (or VibeOCR not configured at
  // all) the cap is deterministic → permanent, no retries.
  it('makes the OCR page cap permanent when GLM-OCR is the engine', async () => {
    const { PermanentExtractionError, errorForBullmq } = await import('./extraction.worker.js');
    await getDb()
      .update(statements)
      .set({ processingStrategyOverride: 'force-ocr' })
      .where(eq(statements.id, stmtId));
    mockRasterCount = 101;

    // VibeOCR not configured (VIBE_OCR_URL unset): GLM-OCR is the de facto engine.
    let err = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PermanentExtractionError);

    // GLM-OCR explicitly configured.
    await getDb()
      .insert(systemSettings)
      .values({ key: 'ocr.engine', valuePlaintext: 'glm', isSecret: false });
    err = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PermanentExtractionError);
    expect(errorForBullmq(err)).toBeInstanceOf(UnrecoverableError);
  });
});
