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

// Per-test: the checks[] the mocked vision model "reads", and the provider id
// the resolver asked for (so we can assert it never reaches for Anthropic).
let mockChecks: Array<{
  check_number: string;
  payee: string | null;
  amount_cents?: number | null;
}> = [];
let requestedProviderId = '';
let fakePngPath = '';

vi.mock('./llm-provider.js', () => ({
  buildProviderForId: vi.fn(async (_db: unknown, id: string) => {
    requestedProviderId = id;
    return {
      id,
      health: async () => ({ ok: true }),
      completeWithImages: async () => ({
        data: { checks: mockChecks },
        rawJson: JSON.stringify({ checks: mockChecks }),
        telemetry: {
          inputTokens: 1,
          outputTokens: 1,
          ms: 1,
          model: 'qwen2.5vl:7b',
          costMicros: 0n,
        },
      }),
    };
  }),
}));

vi.mock('@vibe-tx-converter/extractor', async (orig) => {
  const actual = await orig<typeof import('@vibe-tx-converter/extractor')>();
  return {
    ...actual,
    // One fake page (the resolver readFile()s pngPath); batchPageImages + the
    // prompts/schema stay real.
    rasterizePdf: vi.fn(async () => [
      {
        index: 0,
        path: fakePngPath,
        pngPath: fakePngPath,
        mediaType: 'image/png' as const,
        width: 0,
        height: 0,
      },
    ]),
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
    requestedProviderId = '';
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
    const rows = await getDb()
      .select()
      .from(transactions)
      .where(eq(transactions.statementId, stmtId));
    expect(rows[0]?.payee).toBe('ACME Plumbing LLC');
    // cleansedDescription is left to enrichment (not clobbered).
    expect(rows[0]?.cleansedDescription).toBeNull();
  });

  it('disambiguates a reused check number by amount (tiebreak)', async () => {
    await seedTx({ checkNumber: '500', description: 'CHECK 500', amountCents: -100_00n }, 0);
    await seedTx({ checkNumber: '500', description: 'CHECK 500', amountCents: -300_00n }, 1);
    mockChecks = [{ check_number: '500', payee: 'Big Vendor', amount_cents: 30000 }];

    const res = await resolveCheckPayees(getDb(), stmtId);
    expect(res.matchedCount).toBe(1);
    const rows = await getDb()
      .select()
      .from(transactions)
      .where(eq(transactions.statementId, stmtId));
    const big = rows.find((r) => r.amountCents === -300_00n);
    const small = rows.find((r) => r.amountCents === -100_00n);
    expect(big?.payee).toBe('Big Vendor'); // amount matched the $300 check
    expect(small?.payee).toBeNull();
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
