import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb, getDb, getPool } from '../db/client.js';
import { accounts, companies, statements, systemSettings } from '../db/schema.js';

import { getLastSweepAt, runRetentionSweep } from './pdf-retention.js';
import { upsertSetting } from './system-settings.js';

const databaseUrl = process.env.DATABASE_URL;
const live = describe.skipIf(!databaseUrl);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsFolder = join(__dirname, '..', 'db', 'migrations');

const DAY_MS = 24 * 60 * 60 * 1000;

live('PDF retention sweep (live Postgres)', () => {
  let dataDir: string;
  let accountId: string;

  // `storedAt` backdates the file's mtime: the sweep leaves a file written
  // within the retention window alone, whatever its statements' age.
  const pdfFile = async (name: string, storedAt?: Date): Promise<string> => {
    const p = join(dataDir, name);
    await writeFile(p, Buffer.from(`%PDF-1.4\n% ${name}\n`));
    if (storedAt) await utimes(p, storedAt, storedAt);
    return p;
  };

  const insertStatement = async (
    over: Partial<typeof statements.$inferInsert> & { sourcePdfPath: string },
  ): Promise<string> => {
    const [row] = await getDb()
      .insert(statements)
      .values({
        accountId,
        sourcePdfHash: randomBytes(32).toString('hex'),
        sourcePdfPages: 2,
        status: 'review',
        ...over,
      })
      .returning({ id: statements.id });
    return row!.id;
  };

  const flagOf = async (id: string): Promise<boolean> => {
    const rows = await getDb()
      .select({ deleted: statements.sourcePdfDeleted })
      .from(statements)
      .where(eq(statements.id, id));
    return rows[0]!.deleted;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'vibetc-retention-test-'));
    const pool = getPool();
    await pool.query('DROP SCHEMA IF EXISTS vibetc CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrate(getDb(), { migrationsFolder });

    const [company] = await getDb()
      .insert(companies)
      .values({ name: 'Retention Co' })
      .returning({ id: companies.id });
    const [account] = await getDb()
      .insert(accounts)
      .values({
        companyId: company!.id,
        nickname: 'Operating',
        financialInstitution: 'Test Bank',
        intuBid: '3000',
        intuOrg: 'Test Bank',
        accountType: 'CHECKING',
        accountNumber: '1234567890',
      })
      .returning({ id: accounts.id });
    accountId = account!.id;
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('purges per stored file and flags only statements whose file went', async () => {
    // System write (no user): must not trip the uuid FK on updated_by_user_id.
    await upsertSetting(getDb(), 'pdf.retention.days', '1', null);
    const old = new Date(Date.now() - 10 * DAY_MS);

    // A file still used by a recent statement (split slice) survives.
    const sharedPath = await pdfFile('shared.pdf', old);
    const sharedHash = randomBytes(32).toString('hex');
    const oldShared = await insertStatement({
      sourcePdfHash: sharedHash,
      sourcePdfPath: sharedPath,
      createdAt: old,
    });
    const newShared = await insertStatement({
      sourcePdfHash: sharedHash,
      sourcePdfPath: sharedPath,
      pageRange: { start: 1, end: 1 },
    });

    // A file only old statements use is purged.
    const lonePath = await pdfFile('lone.pdf', old);
    const oldLone = await insertStatement({ sourcePdfPath: lonePath, createdAt: old });

    // Same content, stored twice (two upload months): the old copy goes, the
    // recent statement keeps its own copy and stays unflagged.
    const hash = randomBytes(32).toString('hex');
    const oldCopyPath = await pdfFile('old-copy.pdf', old);
    const newCopyPath = await pdfFile('new-copy.pdf');
    const oldCopy = await insertStatement({
      sourcePdfHash: hash,
      sourcePdfPath: oldCopyPath,
      createdAt: old,
    });
    const newCopy = await insertStatement({
      sourcePdfHash: hash,
      sourcePdfPath: newCopyPath,
      pageRange: { start: 1, end: 1 },
    });

    const result = await runRetentionSweep(getDb(), null);
    expect(result).toMatchObject({
      retentionDays: 1,
      candidates: 3,
      filesRemoved: 2,
      rowsFlipped: 2,
      skipped: null,
    });

    await expect(stat(sharedPath)).resolves.toBeTruthy();
    expect(await flagOf(oldShared)).toBe(false);
    expect(await flagOf(newShared)).toBe(false);

    await expect(stat(lonePath)).rejects.toThrow();
    expect(await flagOf(oldLone)).toBe(true);

    await expect(stat(oldCopyPath)).rejects.toThrow();
    expect(await flagOf(oldCopy)).toBe(true);
    await expect(stat(newCopyPath)).resolves.toBeTruthy();
    expect(await flagOf(newCopy)).toBe(false);
  });

  it('keeps a re-uploaded copy and any file an in-flight extraction reads', async () => {
    await upsertSetting(getDb(), 'pdf.retention.days', '1', null);
    const old = new Date(Date.now() - 10 * DAY_MS);

    // A purged PDF re-uploaded today: restoreDeletedSourcePdf re-points the
    // ORIGINAL (old) statement at the freshly stored file and clears its flag.
    const restoredPath = await pdfFile('restored.pdf');
    const restored = await insertStatement({ sourcePdfPath: restoredPath, createdAt: old });

    // An old statement being (re-)extracted right now.
    const inFlightPath = await pdfFile('in-flight.pdf', old);
    const inFlight = await insertStatement({
      sourcePdfPath: inFlightPath,
      createdAt: old,
      status: 'extracting',
    });

    // One file, two old statements: one finished, one still queued.
    const sharedPath = await pdfFile('shared-in-flight.pdf', old);
    const sharedHash = randomBytes(32).toString('hex');
    const done = await insertStatement({
      sourcePdfHash: sharedHash,
      sourcePdfPath: sharedPath,
      createdAt: old,
    });
    const queued = await insertStatement({
      sourcePdfHash: sharedHash,
      sourcePdfPath: sharedPath,
      createdAt: old,
      status: 'uploaded',
      pageRange: { start: 1, end: 1 },
    });

    // Control: an old, settled statement on an old file still goes.
    const expiredPath = await pdfFile('expired.pdf', old);
    const expired = await insertStatement({ sourcePdfPath: expiredPath, createdAt: old });

    const result = await runRetentionSweep(getDb(), null);
    expect(result).toMatchObject({ filesRemoved: 1, rowsFlipped: 1, skipped: null });

    await expect(stat(expiredPath)).rejects.toThrow();
    expect(await flagOf(expired)).toBe(true);

    await expect(stat(restoredPath)).resolves.toBeTruthy();
    expect(await flagOf(restored)).toBe(false);
    await expect(stat(inFlightPath)).resolves.toBeTruthy();
    expect(await flagOf(inFlight)).toBe(false);
    await expect(stat(sharedPath)).resolves.toBeTruthy();
    expect(await flagOf(done)).toBe(false);
    expect(await flagOf(queued)).toBe(false);
  });

  it('records the cron (system) run without a user id, repeatedly', async () => {
    await runRetentionSweep(getDb(), null);
    await runRetentionSweep(getDb(), null); // second write takes the ON CONFLICT path
    expect(await getLastSweepAt(getDb())).not.toBeNull();
    const rows = await getDb()
      .select({ by: systemSettings.updatedByUserId })
      .from(systemSettings)
      .where(eq(systemSettings.key, 'pdf.retention.last_sweep_at'));
    expect(rows[0]!.by).toBeNull();
  });
});
