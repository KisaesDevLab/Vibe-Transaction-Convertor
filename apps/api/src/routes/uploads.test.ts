import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, getPool } from '../db/client.js';
import { auditLog, statements } from '../db/schema.js';
import { enqueueExtraction } from '../jobs/queues.js';
import { checkFreeSpace } from '../services/upload-storage.js';
import { createApp } from '../server.js';

// Enqueue is stubbed so the "which uploads get queued" rule is observable
// without a Redis; the free-space probe is stubbed per test (real by default).
vi.mock('../jobs/queues.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../jobs/queues.js')>();
  return { ...actual, enqueueExtraction: vi.fn(async () => undefined) };
});
vi.mock('../services/upload-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/upload-storage.js')>();
  return { ...actual, checkFreeSpace: vi.fn(actual.checkFreeSpace) };
});
// Page counting isn't under test here, and pdf-parse's bundled pdf.js 1.10
// intermittently rejects valid PDFs on newer Node runtimes ("bad XRef entry").
vi.mock('pdf-parse/lib/pdf-parse.js', () => ({
  default: vi.fn(async () => ({ numpages: 1 })),
}));

const databaseUrl = process.env.DATABASE_URL;
const live = describe.skipIf(!databaseUrl);

// Distinct content → distinct hash; the magic bytes are all the route checks
// before the (stubbed) page count.
const buildPdf = (text: string): Buffer => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`, 'latin1');

const withRedisUrl = async (fn: () => Promise<void>): Promise<void> => {
  const prev = process.env.REDIS_URL;
  process.env.REDIS_URL = prev ?? 'redis://127.0.0.1:1';
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prev;
  }
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsFolder = join(__dirname, '..', 'db', 'migrations');

live('Uploads — multipart, magic-byte gate, dedup (live Postgres)', () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-bytes-long-XXXX';
  }
  let app: ReturnType<typeof createApp>;
  let agent: request.Agent;
  let csrfToken: string;
  let accountId: string;
  let otherAccountId: string;
  let dataDir: string;

  const upload = (acct: string, pdf: Buffer, name = 'statement.pdf') =>
    agent
      .post(`/api/accounts/${acct}/uploads`)
      .set('x-csrf-token', csrfToken)
      .attach('files', pdf, name);

  beforeEach(() => {
    vi.mocked(enqueueExtraction).mockClear();
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'vibetc-uploads-test-'));
    process.env.DATA_DIR = dataDir;

    const pool = getPool();
    await pool.query('DROP SCHEMA IF EXISTS vibetc CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrate(getDb(), { migrationsFolder });

    app = createApp();
    agent = request.agent(app);
    csrfToken = (await agent.get('/api/auth/csrf').expect(200)).body.token;
    await agent
      .post('/api/auth/register')
      .set('x-csrf-token', csrfToken)
      .send({
        email: 'admin@example.com',
        password: 'correcthorsebatterystaple',
        displayName: 'Admin',
      })
      .expect(201);
    await agent
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'correcthorsebatterystaple' })
      .expect(200);
    const company = await agent
      .post('/api/companies')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'Acme LLC' })
      .expect(201);
    const account = await agent
      .post(`/api/companies/${company.body.id}/accounts`)
      .set('x-csrf-token', csrfToken)
      .send({
        nickname: 'Operating',
        financialInstitution: 'Wells Fargo',
        intuBid: '3000',
        intuOrg: 'Wells Fargo',
        accountType: 'CHECKING',
        accountNumber: '1234567890',
      })
      .expect(201);
    accountId = account.body.id;
    const other = await agent
      .post(`/api/companies/${company.body.id}/accounts`)
      .set('x-csrf-token', csrfToken)
      .send({
        nickname: 'Payroll',
        financialInstitution: 'Wells Fargo',
        intuBid: '3000',
        intuOrg: 'Wells Fargo',
        accountType: 'CHECKING',
        accountNumber: '9876543210',
      })
      .expect(201);
    otherAccountId = other.body.id;
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rejects non-PDF magic bytes per file (errors[]) but does not 500', async () => {
    const res = await agent
      .post(`/api/accounts/${accountId}/uploads`)
      .set('x-csrf-token', csrfToken)
      .attach('files', Buffer.from('not a pdf at all'), 'fake.pdf');
    expect(res.status).toBe(201);
    expect(res.body.statements).toEqual([]);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].error).toBe('not a PDF');
  });

  it('400 when no files are sent', async () => {
    const res = await agent
      .post(`/api/accounts/${accountId}/uploads`)
      .set('x-csrf-token', csrfToken);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
  });

  it('without auth → 401 or 403 (CSRF fires first for mutating requests)', async () => {
    const res = await request(app).post(`/api/accounts/${accountId}/uploads`);
    expect([401, 403]).toContain(res.status);
  });

  it('GET /api/uploads/:hash/raw rejects bad hash format with 400', async () => {
    const res = await agent.get('/api/uploads/not-a-hash/raw');
    expect(res.status).toBe(400);
  });

  it('GET /api/uploads/:hash/raw 404s when no statement matches', async () => {
    const sixtyFour = '0'.repeat(64);
    const res = await agent.get(`/api/uploads/${sixtyFour}/raw`);
    expect(res.status).toBe(404);
  });

  it('GET /api/uploads/:hash/raw serves a live sibling when another statement sharing the hash is deleted', async () => {
    const db = getDb();
    const hash = 'b'.repeat(64);
    const pdfPath = join(dataDir, 'sibling.pdf');
    await writeFile(pdfPath, Buffer.from('%PDF-1.4\n% sibling test\n'));
    // Two statements reference the same content-addressed PDF: one purged, one
    // live. Insert order is irrelevant — the handler must prefer the live one.
    // (Split slices of one PDF: only one un-split row per account+hash.)
    await db.insert(statements).values([
      {
        accountId,
        sourcePdfHash: hash,
        sourcePdfPath: pdfPath,
        sourcePdfPages: 2,
        status: 'review',
        sourcePdfDeleted: true,
        pageRange: { start: 1, end: 1 },
      },
      {
        accountId,
        sourcePdfHash: hash,
        sourcePdfPath: pdfPath,
        sourcePdfPages: 2,
        status: 'review',
        sourcePdfDeleted: false,
        pageRange: { start: 2, end: 2 },
      },
    ]);
    const ok = await agent.get(`/api/uploads/${hash}/raw`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toContain('application/pdf');

    // Once every referencing statement is purged, it's a clean 410 PDF_DELETED.
    await getPool().query(
      'UPDATE vibetc.statements SET source_pdf_deleted = true WHERE source_pdf_hash = $1',
      [hash],
    );
    const gone = await agent.get(`/api/uploads/${hash}/raw`);
    expect(gone.status).toBe(410);
    expect(gone.body.code).toBe('PDF_DELETED');
  });

  it('refuses uploads with 507 when DATA_DIR is below the free-space floor', async () => {
    vi.mocked(checkFreeSpace).mockResolvedValueOnce({ freeMb: 120, warn: true, refuse: true });
    const res = await upload(accountId, buildPdf('low disk'));
    expect(res.status).toBe(507);
    expect(res.body.message).toMatch(/only 120 MB free/);
  });

  it('dedupes against the uploading account only, and never re-queues a processed statement', async () => {
    await withRedisUrl(async () => {
      const pdf = buildPdf('dedupe per account');
      const first = await upload(accountId, pdf).expect(201);
      const firstStmt = first.body.statements[0];
      expect(firstStmt.deduplicated).toBe(false);
      expect(enqueueExtraction).toHaveBeenCalledTimes(1);

      // Same bytes, another account → its own statement.
      const other = await upload(otherAccountId, pdf).expect(201);
      expect(other.body.statements[0].deduplicated).toBe(false);
      expect(other.body.statements[0].statementId).not.toBe(firstStmt.statementId);

      // Still 'uploaded' (first enqueue may have been lost) → re-queued.
      vi.mocked(enqueueExtraction).mockClear();
      const again = await upload(accountId, pdf).expect(201);
      expect(again.body.statements[0]).toMatchObject({
        statementId: firstStmt.statementId,
        deduplicated: true,
      });
      expect(enqueueExtraction).toHaveBeenCalledTimes(1);

      // Once processed, a duplicate upload must not kick a fresh extraction.
      await getDb()
        .update(statements)
        .set({ status: 'review' })
        .where(eq(statements.id, firstStmt.statementId));
      vi.mocked(enqueueExtraction).mockClear();
      const dup = await upload(accountId, pdf).expect(201);
      expect(dup.body.statements[0]).toMatchObject({
        statementId: firstStmt.statementId,
        deduplicated: true,
        status: 'review',
      });
      expect(enqueueExtraction).not.toHaveBeenCalled();
    });
  });

  it('re-uploading a PDF whose stored file was deleted restores it', async () => {
    const pdf = buildPdf('restore after delete-pdf');
    const first = await upload(accountId, pdf).expect(201);
    const stmtId = first.body.statements[0].statementId as string;

    const del = await agent
      .post(`/api/statements/${stmtId}/delete-pdf`)
      .set('x-csrf-token', csrfToken)
      .expect(200);
    expect(del.body.fileRemoved).toBe(true);

    const again = await upload(accountId, pdf).expect(201);
    expect(again.body.statements[0]).toMatchObject({ statementId: stmtId, deduplicated: true });

    const [row] = await getDb().select().from(statements).where(eq(statements.id, stmtId));
    expect(row!.sourcePdfDeleted).toBe(false);
    await expect(stat(row!.sourcePdfPath)).resolves.toBeTruthy();
    const restored = await getDb()
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, stmtId), eq(auditLog.action, 'statement.restore-pdf')));
    expect(restored).toHaveLength(1);

    // The raw-PDF endpoint serves it again.
    const raw = await agent.get(`/api/uploads/${row!.sourcePdfHash}/raw`);
    expect(raw.status).toBe(200);
  });
});
