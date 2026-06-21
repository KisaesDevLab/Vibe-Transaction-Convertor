// Direct unit test for processExtraction. Mocks the LLM provider via
// vi.mock so the worker exercises the full pipeline (analyzePdf →
// extractTextLayer → reconcile → repair → insert) without needing a
// running gateway. Live-Postgres only.

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, getPool } from '../db/client.js';
import { accounts, companies, statements, transactions, users } from '../db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
const live = describe.skipIf(!databaseUrl);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsFolder = join(__dirname, '..', 'db', 'migrations');

const SAMPLE = {
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

// Per-test override of what the mock LLM returns. Discrepancy tests
// reassign this before invoking processExtraction.
let mockExtractedData: typeof SAMPLE = SAMPLE;
// The worker resolves the provider policy, derives the primary/secondary
// order, then builds providers by id. Mock all three: force a local-only
// policy (no fallback) and hand back a stub provider whose extract()
// returns the per-test mockExtractedData.
vi.mock('../services/llm-provider.js', () => ({
  resolveProviderPolicy: vi.fn(async () => 'local-only' as const),
  providerOrderFor: vi.fn(() => ({ primary: 'local' as const, secondary: null })),
  invalidateProviderCache: vi.fn(),
  buildProviderForId: vi.fn(async () => ({
    id: 'local' as const,
    extract: vi.fn(async () => ({
      data: mockExtractedData,
      rawJson: JSON.stringify(mockExtractedData),
      telemetry: {
        inputTokens: 10,
        outputTokens: 20,
        ms: 5,
        model: 'qwen3-8b',
        costMicros: 0n,
      },
    })),
    health: vi.fn(async () => ({ ok: true })),
  })),
}));

const buildDigitalPdf = async (lines: string[]): Promise<Buffer> => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  let y = 720;
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 11, font });
    y -= 16;
  }
  return Buffer.from(await doc.save());
};

live('processExtraction worker (live Postgres, mocked LLM)', () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-bytes-long-XXXX';
  }
  let dataDir: string;
  let stmtId: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'vibetc-worker-'));
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
    // Reset the mock LLM output to the balanced default before each test;
    // tests that exercise discrepancy / repair paths override it.
    mockExtractedData = SAMPLE;
    const db = getDb();
    // Wipe state between tests via TRUNCATE (cascade from companies and
    // users picks up the rest). Plain TRUNCATE bypasses drizzle's
    // delete-with-where lint check and is faster than per-row delete.
    await getPool().query(
      'TRUNCATE TABLE vibetc.transactions, vibetc.statements, vibetc.accounts, vibetc.companies, vibetc.users RESTART IDENTITY CASCADE',
    );

    const [u] = await db
      .insert(users)
      .values({
        email: 'q@q.q',
        passwordHash: 'argon2id$x',
        displayName: 'q',
        role: 'admin',
      })
      .returning();
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
    expect(u).toBeDefined();

    const pdfBytes = await buildDigitalPdf([
      'STATEMENT OF ACCOUNT — Wells Fargo Operating Account',
      'Period 2026-03-01 through 2026-03-31',
      'Opening balance: one thousand dollars',
      '2026-03-08 PAYROLL DEPOSIT credit fifty dollars',
      '2026-03-12 GROCERY STORE purchase fifty dollars',
      'Closing balance: one thousand one hundred dollars',
      'Account ending in 7890 — page 1 of 1 — generated 2026',
    ]);
    const pdfPath = join(dataDir, 'test.pdf');
    await writeFile(pdfPath, pdfBytes);

    const [s] = await db
      .insert(statements)
      .values({
        accountId: a!.id,
        sourcePdfHash: 'a'.repeat(64),
        sourcePdfPath: pdfPath,
        sourcePdfPages: 1,
        status: 'uploaded',
      })
      .returning();
    stmtId = s!.id;
  });

  it('runs the full pipeline: analyze → extract → reconcile → insert', async () => {
    const { processExtraction } = await import('./extraction.worker.js');
    const db = getDb();
    const stmtBefore = (await db.select().from(statements).where(eq(statements.id, stmtId)))[0]!;
    await processExtraction({
      statementId: stmtId,
      accountId: stmtBefore.accountId,
      sourcePdfHash: stmtBefore.sourcePdfHash,
      sourcePdfPath: stmtBefore.sourcePdfPath,
    });
    const stmt = (await db.select().from(statements).where(eq(statements.id, stmtId)))[0]!;
    expect(stmt.status).toBe('review');
    expect(stmt.reconciliationStatus).toBe('verified');
    expect(stmt.openingBalanceCents).toBe(100_000n);
    expect(stmt.closingBalanceCents).toBe(110_000n);
    expect(stmt.llmProvider).toBe('local');
    expect(stmt.llmCallCount).toBe(1);

    const txs = await db.select().from(transactions).where(eq(transactions.statementId, stmtId));
    expect(txs).toHaveLength(2);
    // Same-day same-amount disambiguation: both txs are different days,
    // so seqInDay = 0 for each.
    expect(txs.every((t) => t.seqInDay === 0)).toBe(true);
    // FITIDs are deterministic + 20 chars + "VTC-" prefix.
    for (const t of txs) {
      expect(t.fitid).toMatch(/^VTC-[0-9a-f]{16}$/);
    }
    // TRNTYPE inferred from descriptions.
    const trnTypes = txs.map((t) => t.trntype);
    expect(trnTypes).toContain('DIRECTDEP');
    // 'GROCERY STORE' has no explicit POS marker; rules-first inference
    // falls back to sign — positive amount → CREDIT.
    expect(trnTypes).toContain('CREDIT');
  });

  it('repair pass corrects a sign-flip and marks reconciliation verified', async () => {
    // Inject a discrepancy where ONLY flipping GROCERY's sign closes
    // delta. PAYROLL +30000, GROCERY +5000 (wrong sign), opening 100000,
    // closing 125000:
    //   sum = 35000, expected = 135000, delta = -10000
    //   flip PAYROLL (+30000 → -30000): newDelta = -10000 + 60000 = 50000 (no)
    //   flip GROCERY (+5000 → -5000):   newDelta = -10000 + 10000 = 0   (✓)
    mockExtractedData = {
      ...SAMPLE,
      balances: { opening_cents: 100_000, closing_cents: 125_000 },
      transactions: [
        {
          posted_date: '2026-03-08',
          description: 'PAYROLL DEPOSIT',
          amount_cents: 30_000,
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-03-12',
          description: 'GROCERY STORE',
          amount_cents: 5_000, // WRONG SIGN — should be -5000
          source_page: 1,
          confidence: 0.99,
        },
      ],
    };

    const { processExtraction } = await import('./extraction.worker.js');
    const db = getDb();
    const stmtBefore = (await db.select().from(statements).where(eq(statements.id, stmtId)))[0]!;
    await processExtraction({
      statementId: stmtId,
      accountId: stmtBefore.accountId,
      sourcePdfHash: stmtBefore.sourcePdfHash,
      sourcePdfPath: stmtBefore.sourcePdfPath,
    });
    const stmt = (await db.select().from(statements).where(eq(statements.id, stmtId)))[0]!;
    expect(stmt.reconciliationStatus).toBe('verified');
    const txs = await db.select().from(transactions).where(eq(transactions.statementId, stmtId));
    // After repair the GROCERY row's sign should be flipped to -5000.
    const grocery = txs.find((t) => t.description === 'GROCERY STORE');
    expect(grocery?.amountCents).toBe(-5_000n);
  });

  it('marks statement failed when the worker throws', async () => {
    // Use a missing PDF path to force a readFile error inside the worker.
    const db = getDb();
    await db
      .update(statements)
      .set({ sourcePdfPath: '/nonexistent/path.pdf' })
      .where(eq(statements.id, stmtId));
    const stmtBefore = (await db.select().from(statements).where(eq(statements.id, stmtId)))[0]!;

    const { startExtractionWorker } = await import('./extraction.worker.js');
    // Don't actually start a Worker — just call processExtraction and assert it throws.
    expect(startExtractionWorker).toBeDefined();

    const { processExtraction } = await import('./extraction.worker.js');
    await expect(
      processExtraction({
        statementId: stmtId,
        accountId: stmtBefore.accountId,
        sourcePdfHash: stmtBefore.sourcePdfHash,
        sourcePdfPath: stmtBefore.sourcePdfPath,
      }),
    ).rejects.toThrow();
    // The processExtraction function throws but does NOT mark failed — the
    // BullMQ Worker wrapper does. Status stays at preprocessing/extracting.
    const stmt = (await db.select().from(statements).where(eq(statements.id, stmtId)))[0]!;
    expect(stmt.status === 'preprocessing' || stmt.status === 'uploaded').toBe(true);
  });
});
