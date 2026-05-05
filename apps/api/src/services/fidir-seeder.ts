import { eq, sql } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFidir, type FidirEntry } from '@vibe-tx-converter/fidir';
import {
  FALLBACK_INTU_BID,
  FALLBACK_INTU_ORG,
  FALLBACK_BANK_NAME,
} from '@vibe-tx-converter/shared';

import type { Db } from '../db/client.js';
import { fidirEntries, systemSettings } from '../db/schema.js';
import { logger } from '../lib/logger.js';

const MIN_ENTRIES = 100;
const FIDIR_LAST_REFRESHED_KEY = 'fidir.last_refreshed_at';

export const resolveFidirPath = (): string => {
  if (process.env.FIDIR_PATH) return process.env.FIDIR_PATH;
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // From apps/api/src/services → ../../../../data/fidir/fidir-us.txt
  return join(__dirname, '..', '..', '..', '..', 'data', 'fidir', 'fidir-us.txt');
};

const ensureFallback = (entries: FidirEntry[]): FidirEntry[] => {
  if (entries.some((e) => e.intuBid === FALLBACK_INTU_BID)) return entries;
  return [
    ...entries,
    {
      intuBid: FALLBACK_INTU_BID,
      intuOrg: FALLBACK_INTU_ORG,
      bankName: FALLBACK_BANK_NAME,
      country: 'US',
      raw: {},
    },
  ];
};

export interface SeedResult {
  filePath: string;
  imported: number;
  skipped: number;
}

export const seedFidir = async (db: Db, filePath?: string): Promise<SeedResult> => {
  const path = filePath ?? resolveFidirPath();
  const raw = await readFile(path, 'utf8');
  const parsed = parseFidir(raw, {
    onWarning: (msg, line) => logger.warn({ msg, line }, 'fidir parser warning'),
  });
  if (parsed.length < MIN_ENTRIES) {
    throw new Error(
      `FIDIR import refused: ${parsed.length} entries < ${MIN_ENTRIES}-record floor (truncated file?)`,
    );
  }
  const entries = ensureFallback(parsed);

  let imported = 0;
  let skipped = 0;
  for (const e of entries) {
    if (!/^\d+$/.test(e.intuBid)) {
      logger.warn({ bid: e.intuBid }, 'fidir entry has non-digit BID; importing anyway');
    }
    try {
      await db
        .insert(fidirEntries)
        .values({
          intuBid: e.intuBid,
          intuOrg: e.intuOrg,
          bankName: e.bankName,
          country: e.country,
          ...(e.url ? { url: e.url } : {}),
          raw: e.raw,
        })
        .onConflictDoUpdate({
          target: [fidirEntries.intuBid, fidirEntries.country],
          set: {
            intuOrg: e.intuOrg,
            bankName: e.bankName,
            ...(e.url ? { url: e.url } : { url: null }),
            raw: e.raw,
            importedAt: sql`now()`,
          },
        });
      imported += 1;
    } catch (err) {
      logger.warn({ err, bid: e.intuBid }, 'fidir row failed to upsert');
      skipped += 1;
    }
  }

  await db
    .insert(systemSettings)
    .values({
      key: FIDIR_LAST_REFRESHED_KEY,
      valuePlaintext: new Date().toISOString(),
      isSecret: false,
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { valuePlaintext: new Date().toISOString(), updatedAt: sql`now()` },
    });

  logger.info({ imported, skipped, path }, 'fidir import complete');
  return { filePath: path, imported, skipped };
};

export const seedFidirIfEmpty = async (db: Db): Promise<void> => {
  const existing = await db.select({ id: fidirEntries.id }).from(fidirEntries).limit(1);
  if (existing.length > 0) return;
  await seedFidir(db);
};

export const getFidirStatus = async (
  db: Db,
): Promise<{ entriesCount: number; lastRefreshedAt: string | null }> => {
  const countRows = await db.select({ count: sql<number>`count(*)::int` }).from(fidirEntries);
  const setting = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, FIDIR_LAST_REFRESHED_KEY));
  return {
    entriesCount: Number(countRows[0]?.count ?? 0),
    lastRefreshedAt: setting[0]?.valuePlaintext ?? null,
  };
};
