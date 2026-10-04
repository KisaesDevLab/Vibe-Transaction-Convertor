import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeFitid, normalizeDescription } from '@vibe-tx-converter/exporters';

import { closeDb, getDb, getPool } from '../db/client.js';
import { auditLog, statements, systemSettings, transactions } from '../db/schema.js';
import { enqueueExtraction, removeExtractionJob } from '../jobs/queues.js';
import { resolveCheckPayees } from '../services/check-resolver.js';
import { createApp } from '../server.js';

// The BullMQ helpers are stubbed so the queue-ordering paths can be exercised
// without a Redis: a test sets REDIS_URL only for the duration of the request.
vi.mock('../jobs/queues.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../jobs/queues.js')>();
  return {
    ...actual,
    enqueueExtraction: vi.fn(async () => undefined),
    removeExtractionJob: vi.fn(async () => false),
  };
});
// The check-payee pass needs the OCR/vision engines; stub its result.
vi.mock('../services/check-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/check-resolver.js')>();
  return { ...actual, resolveCheckPayees: vi.fn() };
});

const databaseUrl = process.env.DATABASE_URL;
const live = describe.skipIf(!databaseUrl);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsFolder = join(__dirname, '..', 'db', 'migrations');

const randomHash = (): string => randomBytes(32).toString('hex');

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

live('Statements routes (live Postgres)', () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-bytes-long-XXXX';
  }
  let agent: request.Agent;
  let csrfToken: string;
  let accountId: string;
  let companyId: string;
  let dataDir: string;

  const insertStatement = async (
    over: Partial<typeof statements.$inferInsert> = {},
  ): Promise<typeof statements.$inferSelect> => {
    const [row] = await getDb()
      .insert(statements)
      .values({
        accountId,
        sourcePdfHash: randomHash(),
        sourcePdfPath: join(dataDir, `${randomHash()}.pdf`),
        sourcePdfPages: 2,
        status: 'review',
        ...over,
      })
      .returning();
    return row!;
  };

  const insertTx = async (
    statementId: string,
    postedDate: string,
    description: string,
    amountCents: bigint,
    seqInDay = 0,
  ): Promise<typeof transactions.$inferSelect> => {
    const [row] = await getDb()
      .insert(transactions)
      .values({
        statementId,
        seqInDay,
        postedDate,
        description,
        normalizedDescription: normalizeDescription(description),
        amountCents,
        trntype: 'DEBIT',
        fitid: computeFitid({ postedDate, amountCents, description, seqInDay }),
        sourcePage: 1,
      })
      .returning();
    return row!;
  };

  const getStmt = async (id: string): Promise<typeof statements.$inferSelect> => {
    const rows = await getDb().select().from(statements).where(eq(statements.id, id));
    return rows[0]!;
  };

  const txsOf = (statementId: string) =>
    getDb().select().from(transactions).where(eq(transactions.statementId, statementId));

  const auditCount = async (entityId: string, action: string): Promise<number> => {
    const rows = await getDb()
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, entityId), eq(auditLog.action, action)));
    return rows.length;
  };

  const post = (path: string) => agent.post(path).set('x-csrf-token', csrfToken);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'vibetc-statements-test-'));
    process.env.DATA_DIR = dataDir;

    const pool = getPool();
    await pool.query('DROP SCHEMA IF EXISTS vibetc CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrate(getDb(), { migrationsFolder });

    const app = createApp();
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
    companyId = company.body.id;
    const account = await agent
      .post(`/api/companies/${companyId}/accounts`)
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
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.mocked(enqueueExtraction).mockClear();
    vi.mocked(removeExtractionJob).mockClear();
  });

  it('list / detail / progress omit the extracted text and PDF path', async () => {
    const s = await insertStatement({ extractedText: 'FULL OCR MARKDOWN' });
    const detail = await agent.get(`/api/statements/${s.id}`).expect(200);
    expect(detail.body.statement.id).toBe(s.id);
    expect(detail.body.statement.sourcePdfHash).toBe(s.sourcePdfHash);
    expect(detail.body.statement).not.toHaveProperty('extractedText');
    expect(detail.body.statement).not.toHaveProperty('sourcePdfPath');

    for (const query of [{ accountId }, { companyId }, {}]) {
      const list = await agent.get('/api/statements').query(query).expect(200);
      const row = (list.body as Array<Record<string, unknown>>).find((r) => r.id === s.id);
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty('extractedText');
      expect(row).not.toHaveProperty('sourcePdfPath');
    }

    const progress = await agent.get(`/api/statements/${s.id}/progress`).buffer(true).expect(200);
    const dataLine = progress.text.split('\n').find((l) => l.startsWith('data: '));
    const snapshot = JSON.parse(dataLine!.slice('data: '.length)) as Record<string, unknown>;
    expect(snapshot.id).toBe(s.id);
    expect(snapshot).not.toHaveProperty('extractedText');
    expect(snapshot).not.toHaveProperty('sourcePdfPath');

    // The dedicated endpoint still serves the text.
    const text = await agent.get(`/api/statements/${s.id}/extracted-text`).expect(200);
    expect(text.body.text).toBe('FULL OCR MARKDOWN');
  });

  it('detail carries the admin-tunable review confidence threshold', async () => {
    const s = await insertStatement();
    await getDb()
      .insert(systemSettings)
      .values({ key: 'review.confidence_threshold', valuePlaintext: '0.55', isSecret: false });
    const detail = await agent.get(`/api/statements/${s.id}`).expect(200);
    expect(detail.body.reviewConfidenceThreshold).toBe(0.55);
  });

  it('confirm-date-format is refused unless the statement awaits confirmation', async () => {
    const s = await insertStatement({ status: 'review', reconciliationStatus: 'verified' });
    await insertTx(s.id, '2026-01-05', 'HAND EDITED ROW', -500n);
    const res = await post(`/api/statements/${s.id}/confirm-date-format`).send({ format: 'DMY' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(await txsOf(s.id)).toHaveLength(1);
    expect((await getStmt(s.id)).status).toBe('review');
  });

  it('confirm-date-format wipes, resets reconciliation, and clears the old job before enqueueing', async () => {
    await withRedisUrl(async () => {
      const s = await insertStatement({
        status: 'awaiting-locale-confirmation',
        sourceDateFormat: 'AMBIGUOUS',
        reconciliationStatus: 'discrepancy',
        periodBoundsViolations: 2,
      });
      await insertTx(s.id, '2026-04-05', 'AMBIGUOUS ROW', -500n);

      // A job that can't be removed (still active) → 409, nothing touched.
      vi.mocked(removeExtractionJob).mockRejectedValueOnce(
        new Error('Job could not be removed because it is locked by another worker'),
      );
      const locked = await post(`/api/statements/${s.id}/confirm-date-format`).send({
        format: 'DMY',
      });
      expect(locked.status).toBe(409);
      expect(enqueueExtraction).not.toHaveBeenCalled();
      expect((await getStmt(s.id)).status).toBe('awaiting-locale-confirmation');
      expect(await txsOf(s.id)).toHaveLength(1);

      await post(`/api/statements/${s.id}/confirm-date-format`).send({ format: 'DMY' }).expect(200);
      const after = await getStmt(s.id);
      expect(after.status).toBe('uploaded');
      expect(after.sourceDateFormat).toBe('DMY');
      expect(after.sourceDateFormatUserConfirmed).toBe(true);
      expect(after.reconciliationStatus).toBe('pending');
      expect(after.periodBoundsViolations).toBe(0);
      expect(await txsOf(s.id)).toHaveLength(0);
      expect(removeExtractionJob).toHaveBeenLastCalledWith(s.id);
      expect(enqueueExtraction).toHaveBeenCalledTimes(1);
      const removedAt = vi.mocked(removeExtractionJob).mock.invocationCallOrder.at(-1)!;
      const enqueuedAt = vi.mocked(enqueueExtraction).mock.invocationCallOrder[0]!;
      expect(removedAt).toBeLessThan(enqueuedAt);
    });
  });

  it('re-extract refuses (409) while the job is still running — before wiping anything', async () => {
    await withRedisUrl(async () => {
      const s = await insertStatement({ status: 'review', reconciliationStatus: 'overridden' });
      await insertTx(s.id, '2026-01-05', 'KEEP ME', -500n);

      vi.mocked(removeExtractionJob).mockRejectedValueOnce(
        new Error('Job could not be removed because it is locked by another worker'),
      );
      const res = await post(`/api/statements/${s.id}/re-extract`).send({});
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/still running/);
      expect(await txsOf(s.id)).toHaveLength(1);
      expect((await getStmt(s.id)).status).toBe('review');
      expect(enqueueExtraction).not.toHaveBeenCalled();
      expect(await auditCount(s.id, 'statement.re-extract')).toBe(0);

      await post(`/api/statements/${s.id}/re-extract`).send({}).expect(200);
      const after = await getStmt(s.id);
      expect(after.status).toBe('uploaded');
      expect(after.reconciliationStatus).toBe('pending');
      expect(await txsOf(s.id)).toHaveLength(0);
      expect(enqueueExtraction).toHaveBeenCalledTimes(1);
    });
  });

  it('override-reconciliation requires a statement in review (or exported)', async () => {
    const reason = 'Reconciled by hand against the bank portal; the gap is a known fee.';
    const pending = await insertStatement({ status: 'uploaded' });
    const refused = await post(`/api/statements/${pending.id}/override-reconciliation`).send({
      reason,
    });
    expect(refused.status).toBe(409);
    expect((await getStmt(pending.id)).reconciliationStatus).toBe('pending');

    const reviewed = await insertStatement({
      status: 'review',
      reconciliationStatus: 'discrepancy',
    });
    await post(`/api/statements/${reviewed.id}/override-reconciliation`)
      .send({ reason })
      .expect(200);
    expect((await getStmt(reviewed.id)).reconciliationStatus).toBe('overridden');
  });

  it('cancel resets the reconciliation verdict along with the wiped rows', async () => {
    const s = await insertStatement({ status: 'extracting', reconciliationStatus: 'verified' });
    await insertTx(s.id, '2026-01-05', 'PARTIAL ROW', -500n);
    await post(`/api/statements/${s.id}/cancel`).send({}).expect(200);
    const after = await getStmt(s.id);
    expect(after.status).toBe('failed');
    expect(after.reconciliationStatus).toBe('pending');
    expect(await txsOf(s.id)).toHaveLength(0);
  });

  it('recompute-reconciliation reports an override instead of 404ing; 404 only when missing', async () => {
    const s = await insertStatement({
      status: 'review',
      reconciliationStatus: 'overridden',
      openingBalanceCents: 1000n,
      closingBalanceCents: 0n,
    });
    await insertTx(s.id, '2026-01-05', 'FEE', -500n);
    const res = await post(`/api/statements/${s.id}/recompute-reconciliation`).expect(200);
    expect(res.body).toEqual({ status: 'overridden', deltaCents: '-500', recomputed: false });
    expect((await getStmt(s.id)).reconciliationStatus).toBe('overridden');

    const noBalances = await insertStatement({ status: 'review' });
    const pendingRes = await post(
      `/api/statements/${noBalances.id}/recompute-reconciliation`,
    ).expect(200);
    expect(pendingRes.body.status).toBe('pending');

    await post('/api/statements/00000000-0000-4000-8000-000000000000/recompute-reconciliation')
      .send({})
      .expect(404);
  });

  it('PATCH moving a row onto a day holding a same-normalised row takes the next seq', async () => {
    const s = await insertStatement();
    const a = await insertTx(s.id, '2026-01-05', 'STARBUCKS #123', -500n, 0);
    const b = await insertTx(s.id, '2026-01-06', 'STARBUCKS #456', -500n, 0);
    const res = await agent
      .patch(`/api/statements/transactions/${b.id}`)
      .set('x-csrf-token', csrfToken)
      .send({ posted_date: '2026-01-05' })
      .expect(200);
    expect(res.body.postedDate).toBe('2026-01-05');
    expect(res.body.seqInDay).toBe(1);
    expect(res.body.fitid).toBe(
      computeFitid({
        postedDate: '2026-01-05',
        amountCents: -500n,
        description: 'STARBUCKS #456',
        seqInDay: 1,
      }),
    );
    expect(res.body.fitid).not.toBe(a.fitid);
  });

  it('a date edit and its undo restore the exported FITID (single and bulk PATCH)', async () => {
    // Two rows on one day: moving the seq-0 row away and back used to come
    // back as max+1 (seq 2) — a new FITID, so a re-export duplicated it.
    const s = await insertStatement();
    const a = await insertTx(s.id, '2026-03-10', 'COFFEE SHOP', -450n, 0);
    await insertTx(s.id, '2026-03-10', 'BOOK STORE', -1200n, 1);

    const patchDate = (postedDate: string) =>
      agent
        .patch(`/api/statements/transactions/${a.id}`)
        .set('x-csrf-token', csrfToken)
        .send({ posted_date: postedDate })
        .expect(200);
    const away = await patchDate('2026-03-11');
    expect(away.body.seqInDay).toBe(0); // free on the new day: kept
    const back = await patchDate('2026-03-10');
    expect(back.body.seqInDay).toBe(0);
    expect(back.body.fitid).toBe(a.fitid);

    const bulkDate = (postedDate: string) =>
      agent
        .patch(`/api/statements/${s.id}/transactions`)
        .set('x-csrf-token', csrfToken)
        .send({ edits: [{ id: a.id, patch: { posted_date: postedDate } }] })
        .expect(200);
    await bulkDate('2026-03-12');
    await bulkDate('2026-03-10');
    const after = (await txsOf(s.id)).find((r) => r.id === a.id)!;
    expect(after.postedDate).toBe('2026-03-10');
    expect(after.seqInDay).toBe(0);
    expect(after.fitid).toBe(a.fitid);
  });

  it('bulk PATCH gives rows moved onto one day distinct seqs, and is all-or-nothing', async () => {
    const s = await insertStatement();
    const a = await insertTx(s.id, '2026-02-01', 'SHELL OIL #1', -1000n, 0);
    const b = await insertTx(s.id, '2026-02-02', 'SHELL OIL #2', -1000n, 0);
    const c = await insertTx(s.id, '2026-02-03', 'SHELL OIL #3', -1000n, 0);
    const moved = await agent
      .patch(`/api/statements/${s.id}/transactions`)
      .set('x-csrf-token', csrfToken)
      .send({
        edits: [
          { id: b.id, patch: { posted_date: '2026-02-01' } },
          { id: c.id, patch: { posted_date: '2026-02-01' } },
        ],
      })
      .expect(200);
    expect(moved.body.results.map((r: { status: string }) => r.status)).toEqual([
      'updated',
      'updated',
    ]);
    const rows = await txsOf(s.id);
    const seqs = rows.filter((r) => r.postedDate === '2026-02-01').map((r) => r.seqInDay);
    expect(seqs.sort()).toEqual([0, 1, 2]);
    expect(new Set(rows.map((r) => r.fitid)).size).toBe(3);

    // A bad edit after a good one rolls the whole batch back (audit included).
    const bad = await agent
      .patch(`/api/statements/${s.id}/transactions`)
      .set('x-csrf-token', csrfToken)
      .send({
        edits: [
          { id: a.id, patch: { description: 'RENAMED' } },
          { id: b.id, patch: { amount_cents: 0 } },
        ],
      });
    expect(bad.status).toBe(400);
    const aAfter = (await txsOf(s.id)).find((r) => r.id === a.id)!;
    expect(aAfter.description).toBe('SHELL OIL #1');
    expect(await auditCount(a.id, 'transaction.update')).toBe(0);
  });

  it('DELETE keeps a source PDF another statement still uses; the last reference unlinks it', async () => {
    const hash = randomHash();
    const pdfPath = join(dataDir, `${hash}.pdf`);
    await writeFile(pdfPath, Buffer.from('%PDF-1.4\n% shared\n'));
    // A superseded split parent and its two children all read the same file.
    const parent = await insertStatement({
      sourcePdfHash: hash,
      sourcePdfPath: pdfPath,
      status: 'failed',
    });
    const child1 = await insertStatement({
      sourcePdfHash: hash,
      sourcePdfPath: pdfPath,
      pageRange: { start: 1, end: 1 },
    });
    const child2 = await insertStatement({
      sourcePdfHash: hash,
      sourcePdfPath: pdfPath,
      pageRange: { start: 2, end: 2 },
    });

    const del = await agent
      .delete(`/api/statements/${parent.id}`)
      .set('x-csrf-token', csrfToken)
      .expect(200);
    expect(del.body).toMatchObject({ sourcePdfRemoved: false, cascadedSiblings: 0 });
    await expect(stat(pdfPath)).resolves.toBeTruthy();
    expect((await getStmt(child1.id)).sourcePdfDeleted).toBe(false);
    expect((await getStmt(child2.id)).sourcePdfDeleted).toBe(false);

    await agent.delete(`/api/statements/${child1.id}`).set('x-csrf-token', csrfToken).expect(200);
    await expect(stat(pdfPath)).resolves.toBeTruthy();

    const last = await agent
      .delete(`/api/statements/${child2.id}`)
      .set('x-csrf-token', csrfToken)
      .expect(200);
    expect(last.body.sourcePdfRemoved).toBe(true);
    await expect(stat(pdfPath)).rejects.toThrow();
  });

  it('Delete-PDF flags only the statements sharing the removed file', async () => {
    const hash = randomHash();
    const sharedPath = join(dataDir, `shared-${hash}.pdf`);
    const ownCopyPath = join(dataDir, `own-${hash}.pdf`);
    await writeFile(sharedPath, Buffer.from('%PDF-1.4\n% shared\n'));
    await writeFile(ownCopyPath, Buffer.from('%PDF-1.4\n% own copy\n'));
    const target = await insertStatement({ sourcePdfHash: hash, sourcePdfPath: sharedPath });
    const sameFile = await insertStatement({
      sourcePdfHash: hash,
      sourcePdfPath: sharedPath,
      pageRange: { start: 1, end: 1 },
    });
    const ownCopy = await insertStatement({
      sourcePdfHash: hash,
      sourcePdfPath: ownCopyPath,
      pageRange: { start: 2, end: 2 },
    });

    const res = await post(`/api/statements/${target.id}/delete-pdf`).expect(200);
    expect(res.body).toMatchObject({ fileRemoved: true, cascadedSiblings: 1 });
    expect((await getStmt(target.id)).sourcePdfDeleted).toBe(true);
    expect((await getStmt(sameFile.id)).sourcePdfDeleted).toBe(true);
    expect((await getStmt(ownCopy.id)).sourcePdfDeleted).toBe(false);
    await expect(stat(sharedPath)).rejects.toThrow();
    await expect(stat(ownCopyPath)).resolves.toBeTruthy();

    // Idempotent: a second call changes nothing.
    const again = await post(`/api/statements/${target.id}/delete-pdf`).expect(200);
    expect(again.body).toMatchObject({
      fileRemoved: false,
      cascadedSiblings: 0,
      alreadyDeleted: true,
    });
    expect((await getStmt(ownCopy.id)).sourcePdfDeleted).toBe(false);
  });

  it('resolve-check-payees returns money as strings and audits the text-parse leg', async () => {
    const s = await insertStatement();
    vi.mocked(resolveCheckPayees).mockResolvedValueOnce({
      txCount: 3,
      candidateCount: 2,
      llmExtractedCount: 2,
      matchedCount: 1,
      updatedTxIds: ['tx-1'],
      skippedUserEditedCount: 1,
      unmatchedCheckNumbers: ['1042'],
      pageCount: 2,
      costMicros: 1234n,
      model: 'qwen2.5:32b-instruct',
      textProviderId: 'anthropic',
      textParseCalls: 2,
      textParseCostMicros: 1200n,
    });
    const res = await post(`/api/statements/${s.id}/resolve-check-payees`).expect(200);
    expect(res.body).toMatchObject({
      matchedCount: 1,
      costMicros: '1234',
      textParseCostMicros: '1200',
      textProviderId: 'anthropic',
      skippedUserEditedCount: 1,
    });
    const [audit] = await getDb()
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, s.id), eq(auditLog.action, 'statement.resolve-check-payees')),
      );
    expect(audit!.payload).toMatchObject({
      costMicros: '1234',
      textProvider: 'anthropic',
      textParseCalls: 2,
      textParseCostMicros: '1200',
      skippedUserEditedCount: 1,
      updatedTxIds: ['tx-1'],
    });
  });
});
