// Check-payee resolver — local-vision matching + payee writes. Mocks the
// local provider (completeWithImages) and rasterizePdf so no poppler/Ollama is
// needed; asserts number matching, the amount tiebreak for reused numbers, and
// that the payee lands on transactions.payee. Live-Postgres only.

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, getPool } from '../db/client.js';
import { accounts, companies, statements, transactions, users } from '../db/schema.js';
import { resolveCheckPayees } from './check-resolver.js';

const databaseUrl = process.env.DATABASE_URL;
const live = describe.skipIf(!databaseUrl);

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(__dirname, '..', 'db', 'migrations');

type MockCheck = {
  check_number: string;
  payee: string | null;
  amount_cents?: number | null;
};

// Per-test: the checks[] the mocked models "read", and the provider id
// the resolver asked for (so we can assert it never reaches for Anthropic).
let mockChecks: MockCheck[] = [];
// What the vision fallback reads; null → same as mockChecks.
let mockVisionChecks: MockCheck[] | null = null;
let requestedProviderId = '';
let fakePngPath = '';
// GLM-OCR transcription the mock "reads" off the check images, per call
// (0-based). '' triggers the vision fallback for that batch and the rest
// (ADR-025); throwing simulates GLM-OCR being down.
let mockGlm: (call: number) => string = () => 'Pay to the order of ...';
let glmCalls = 0;
// Vision fallback (completeWithImages) calls; flip visionThrows to simulate
// qwen3-vl not being pulled.
let visionCalls = 0;
let visionThrows = false;
let textCostMicros = 0n;
// Rasterizer mock: pages returned, options it was called with, and the page
// lists handed to removeRasterDir.
let mockPageCount = 1;
let rasterizeOpts: unknown;
let removedRasters: unknown[] = [];

vi.mock('./llm-provider.js', () => ({
  buildProviderForId: vi.fn(async (_db: unknown, id: string) => {
    requestedProviderId = id;
    const telemetry = { inputTokens: 1, outputTokens: 1, ms: 1, model: 'm', costMicros: 0n };
    const resultFor = (checks: MockCheck[]) => ({
      data: { checks },
      rawJson: JSON.stringify({ checks }),
      telemetry,
    });
    return {
      id,
      health: async () => ({ ok: true }),
      // PRIMARY: GLM-OCR transcribe → text-parse.
      ocrImagesToText: async () => {
        const text = mockGlm(glmCalls);
        glmCalls += 1;
        return { text, ms: 1, model: 'GLM-OCR' };
      },
      complete: async () => {
        const r = resultFor(mockChecks);
        return {
          ...r,
          telemetry: { ...telemetry, model: 'qwen2.5:32b-instruct', costMicros: textCostMicros },
        };
      },
      // FALLBACK: vision model reads the images directly.
      completeWithImages: async () => {
        visionCalls += 1;
        if (visionThrows) throw new Error('model "qwen3-vl:30b" not found');
        const r = resultFor(mockVisionChecks ?? mockChecks);
        return { ...r, telemetry: { ...telemetry, model: 'qwen3-vl:30b' } };
      },
    };
  }),
}));

vi.mock('@vibe-tx-converter/extractor', async (orig) => {
  const actual = await orig<typeof import('@vibe-tx-converter/extractor')>();
  return {
    ...actual,
    // Fake pages (the resolver readFile()s pngPath); batchPageImages + the
    // prompts/schema stay real (≤3 pages per batch).
    rasterizePdf: vi.fn(async (_path: string, opts: unknown) => {
      rasterizeOpts = opts;
      return Array.from({ length: mockPageCount }, (_, i) => ({
        index: i,
        path: fakePngPath,
        pngPath: fakePngPath,
        mediaType: 'image/png' as const,
        width: 0,
        height: 0,
      }));
    }),
    removeRasterDir: vi.fn(async (pages: unknown) => {
      removedRasters.push(pages);
    }),
  };
});

live('resolveCheckPayees (live Postgres, mocked local vision)', () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-bytes-long-XXXX';
  }
  let dataDir: string;
  let stmtId: string;

  const seedTx = async (
    over: Partial<typeof transactions.$inferInsert> & { checkNumber?: string | null },
    seq: number,
  ) => {
    await getDb()
      .insert(transactions)
      .values({
        statementId: stmtId,
        seqInDay: seq,
        postedDate: '2026-03-08',
        description: over.description ?? 'CHECK',
        normalizedDescription: 'check',
        amountCents: over.amountCents ?? -100n,
        trntype: 'CHECK',
        fitid: `VTC-${seq}${'0'.repeat(15)}`,
        sourcePage: 1,
        confidence: 1,
        ...over,
      });
  };

  const txRows = () =>
    getDb().select().from(transactions).where(eq(transactions.statementId, stmtId));

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'vibetc-checkres-'));
    process.env.DATA_DIR = dataDir;
    fakePngPath = join(dataDir, 'page.png');
    await writeFile(fakePngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG-ish bytes
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
    mockChecks = [];
    mockVisionChecks = null;
    requestedProviderId = '';
    mockGlm = () => 'Pay to the order of ...';
    glmCalls = 0;
    visionCalls = 0;
    visionThrows = false;
    textCostMicros = 0n;
    mockPageCount = 1;
    rasterizeOpts = undefined;
    removedRasters = [];
    await getPool().query(
      'TRUNCATE TABLE vibetc.transactions, vibetc.statements, vibetc.accounts, vibetc.companies, vibetc.users RESTART IDENTITY CASCADE',
    );
    const db = getDb();
    await db
      .insert(users)
      .values({ email: 'q@q.q', passwordHash: 'x', displayName: 'q', role: 'admin' });
    const [c] = await db.insert(companies).values({ name: 'C' }).returning();
    const [a] = await db
      .insert(accounts)
      .values({
        companyId: c!.id,
        nickname: 'op',
        financialInstitution: 'WF',
        intuBid: '3000',
        intuOrg: 'WF',
        accountType: 'CHECKING',
        accountNumber: '1234567890',
      })
      .returning();
    const pdfPath = join(dataDir, 'stmt.pdf');
    await writeFile(pdfPath, Buffer.from('%PDF-1.4 test'));
    const [s] = await db
      .insert(statements)
      .values({
        accountId: a!.id,
        sourcePdfHash: 'a'.repeat(64),
        sourcePdfPath: pdfPath,
        sourcePdfPages: 1,
        status: 'review',
      })
      .returning();
    stmtId = s!.id;
  });

  it('uses the LOCAL provider (never Anthropic) and writes the matched payee', async () => {
    await seedTx({ checkNumber: '1234', description: 'CHECK 1234', amountCents: -250_00n }, 0);
    mockChecks = [{ check_number: '1234', payee: 'ACME Plumbing LLC', amount_cents: 25000 }];

    const res = await resolveCheckPayees(getDb(), stmtId);

    expect(requestedProviderId).toBe('local');
    expect(res.matchedCount).toBe(1);
    const rows = await txRows();
    expect(rows[0]?.payee).toBe('ACME Plumbing LLC');
    expect(res.updatedTxIds).toEqual([rows[0]!.id]);
    // cleansedDescription is left to enrichment (not clobbered).
    expect(rows[0]?.cleansedDescription).toBeNull();
    // Primary GLM-OCR transcribe→text-parse path succeeded — no vision fallback.
    expect(visionCalls).toBe(0);
    // Text-parse leg reported for the audit trail.
    expect(res.textProviderId).toBe('local');
    expect(res.textParseCalls).toBe(1);
    expect(res.textParseCostMicros).toBe(0n);
    expect(res.skippedUserEditedCount).toBe(0);
    // Whole PDF (no page_range) → no page restriction.
    expect(rasterizeOpts).toEqual({ dpi: 300 });
  });

  it('falls back to the vision model when GLM-OCR returns no text (ADR-025)', async () => {
    await seedTx({ checkNumber: '1234', description: 'CHECK 1234', amountCents: -250_00n }, 0);
    mockGlm = () => ''; // GLM-OCR transcribed nothing → vision fallback
    mockChecks = [{ check_number: '1234', payee: 'Fallback Vendor', amount_cents: 25000 }];

    const res = await resolveCheckPayees(getDb(), stmtId);

    expect(visionCalls).toBe(1);
    expect(res.model).toBe('qwen3-vl:30b');
    expect(res.matchedCount).toBe(1);
    // No text-parse call was made.
    expect(res.textProviderId).toBeNull();
    expect(res.textParseCalls).toBe(0);
    const rows = await txRows();
    expect(rows[0]?.payee).toBe('Fallback Vendor');
  });

  it('re-reads only the batches GLM-OCR could not handle and keeps earlier payees', async () => {
    // 4 pages → 2 batches (3 + 1). Batch 1 parses on the primary path; GLM-OCR
    // dies on batch 2, so only batch 2 goes to the vision model.
    mockPageCount = 4;
    await seedTx({ checkNumber: '1234', description: 'CHECK 1234', amountCents: -250_00n }, 0);
    await seedTx({ checkNumber: '5678', description: 'CHECK 5678', amountCents: -75_00n }, 1);
    mockGlm = (call) => {
      if (call > 0) throw new Error('GLM-OCR unreachable');
      return 'Pay to the order of ACME';
    };
    mockChecks = [{ check_number: '1234', payee: 'ACME Plumbing LLC', amount_cents: 25000 }];
    mockVisionChecks = [{ check_number: '5678', payee: 'Late Page Vendor', amount_cents: 7500 }];
    textCostMicros = 1_234n;

    const res = await resolveCheckPayees(getDb(), stmtId);

    expect(visionCalls).toBe(1);
    expect(res.matchedCount).toBe(2);
    expect(res.llmExtractedCount).toBe(2);
    expect(res.model).toBe('GLM-OCR+qwen2.5:32b-instruct + qwen3-vl:30b');
    // Accumulated text-parse spend is kept (and lands on the statement ledger).
    expect(res.costMicros).toBe(1_234n);
    expect(res.textParseCostMicros).toBe(1_234n);
    const rows = await txRows();
    expect(rows.find((r) => r.checkNumber === '1234')?.payee).toBe('ACME Plumbing LLC');
    expect(rows.find((r) => r.checkNumber === '5678')?.payee).toBe('Late Page Vendor');
    const [stmt] = await getDb().select().from(statements).where(eq(statements.id, stmtId));
    expect(stmt?.llmCostMicros).toBe(1_234n);
  });

  it('keeps primary payees when the vision fallback is unavailable', async () => {
    mockPageCount = 4;
    await seedTx({ checkNumber: '1234', description: 'CHECK 1234', amountCents: -250_00n }, 0);
    mockGlm = (call) => (call > 0 ? '' : 'Pay to the order of ACME');
    mockChecks = [{ check_number: '1234', payee: 'ACME Plumbing LLC', amount_cents: 25000 }];
    visionThrows = true; // qwen3-vl not pulled

    const res = await resolveCheckPayees(getDb(), stmtId);

    expect(visionCalls).toBe(1); // tried batch 2 only
    expect(res.matchedCount).toBe(1);
    expect(res.model).toBe('GLM-OCR+qwen2.5:32b-instruct');
    const rows = await txRows();
    expect(rows[0]?.payee).toBe('ACME Plumbing LLC');
  });

  it('disambiguates a reused check number by amount (tiebreak)', async () => {
    await seedTx({ checkNumber: '500', description: 'CHECK 500', amountCents: -100_00n }, 0);
    await seedTx({ checkNumber: '500', description: 'CHECK 500', amountCents: -300_00n }, 1);
    mockChecks = [{ check_number: '500', payee: 'Big Vendor', amount_cents: 30000 }];

    const res = await resolveCheckPayees(getDb(), stmtId);
    expect(res.matchedCount).toBe(1);
    const rows = await txRows();
    const big = rows.find((r) => r.amountCents === -300_00n);
    const small = rows.find((r) => r.amountCents === -100_00n);
    expect(big?.payee).toBe('Big Vendor'); // amount matched the $300 check
    expect(small?.payee).toBeNull();
  });

  it('does not let a sole candidate be claimed by a check with a different amount', async () => {
    await seedTx({ checkNumber: '1234', description: 'CHECK 1234', amountCents: -250_00n }, 0);
    await seedTx({ checkNumber: '2000', description: 'CHECK 2000', amountCents: -40_00n }, 1);
    mockChecks = [
      // Another account's check 1234 (shared PDF) — amount disagrees.
      { check_number: '1234', payee: 'Other Account Payee', amount_cents: 99_900 },
      // No amount on the check → a sole candidate is still accepted.
      { check_number: '2000', payee: 'No Amount Co', amount_cents: null },
    ];

    const res = await resolveCheckPayees(getDb(), stmtId);

    expect(res.matchedCount).toBe(1);
    expect(res.unmatchedCheckNumbers).toEqual(['1234']);
    const rows = await txRows();
    expect(rows.find((r) => r.checkNumber === '1234')?.payee).toBeNull();
    expect(rows.find((r) => r.checkNumber === '2000')?.payee).toBe('No Amount Co');
  });

  it('never overwrites a payee the operator edited', async () => {
    await seedTx(
      {
        checkNumber: '1234',
        description: 'CHECK 1234',
        amountCents: -250_00n,
        payee: 'Operator Fixed Co',
        userEdited: true,
      },
      0,
    );
    // User-edited (e.g. amount fix) but no payee yet → still filled.
    await seedTx(
      { checkNumber: '2000', description: 'CHECK 2000', amountCents: -40_00n, userEdited: true },
      1,
    );
    mockChecks = [
      { check_number: '1234', payee: 'OCR Misread Co', amount_cents: 25000 },
      { check_number: '2000', payee: 'Filled Co', amount_cents: 4000 },
    ];

    const res = await resolveCheckPayees(getDb(), stmtId);

    expect(res.matchedCount).toBe(1);
    expect(res.skippedUserEditedCount).toBe(1);
    const rows = await txRows();
    const edited = rows.find((r) => r.checkNumber === '1234');
    const filled = rows.find((r) => r.checkNumber === '2000');
    expect(edited?.payee).toBe('Operator Fixed Co');
    expect(filled?.payee).toBe('Filled Co');
    expect(res.updatedTxIds).toEqual([filled!.id]);
  });

  it("renders only a split statement's own page range and removes the page images", async () => {
    await getDb()
      .update(statements)
      .set({ pageRange: { start: 3, end: 4 } })
      .where(eq(statements.id, stmtId));
    await seedTx({ checkNumber: '1234', description: 'CHECK 1234', amountCents: -250_00n }, 0);
    mockPageCount = 2;
    mockChecks = [{ check_number: '1234', payee: 'ACME Plumbing LLC', amount_cents: 25000 }];

    const res = await resolveCheckPayees(getDb(), stmtId);

    expect(rasterizeOpts).toEqual({ dpi: 300, firstPage: 3, lastPage: 4 });
    expect(res.pageCount).toBe(2);
    // Cancelled-check page images are removed once read into memory.
    expect(removedRasters).toHaveLength(1);
    expect(removedRasters[0]).toHaveLength(2);
  });

  it('removes the page images even when the page cap rejects the statement', async () => {
    await seedTx({ checkNumber: '1234', description: 'CHECK 1234', amountCents: -250_00n }, 0);
    mockPageCount = 61;

    await expect(resolveCheckPayees(getDb(), stmtId)).rejects.toThrow(/exceeding the cap/);
    expect(removedRasters).toHaveLength(1);
  });

  it('reports check numbers the model saw but no transaction has', async () => {
    await seedTx({ checkNumber: '1234', description: 'CHECK 1234', amountCents: -250_00n }, 0);
    mockChecks = [
      { check_number: '1234', payee: 'Matched Co', amount_cents: 25000 },
      { check_number: '9999', payee: 'Ghost Co', amount_cents: 10000 },
    ];

    const res = await resolveCheckPayees(getDb(), stmtId);
    expect(res.matchedCount).toBe(1);
    expect(res.unmatchedCheckNumbers).toContain('9999');
  });

  it('throws when the statement has no check-numbered transactions', async () => {
    await seedTx({ checkNumber: null, description: 'POS COFFEE', amountCents: -5_00n }, 0);
    await expect(resolveCheckPayees(getDb(), stmtId)).rejects.toThrow(
      /no transactions with a check number/,
    );
  });
});
