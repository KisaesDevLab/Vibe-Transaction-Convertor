import { eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { systemSettings } from '../db/schema.js';

export interface SystemSettingRow {
  valuePlaintext: string | null;
  valueEncrypted: Buffer | null;
}

export const readSetting = async (db: Db, key: string): Promise<SystemSettingRow | null> => {
  const rows = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
  const row = rows[0];
  if (!row) return null;
  return {
    valuePlaintext: row.valuePlaintext,
    valueEncrypted: row.valueEncrypted as Buffer | null,
  };
};

export const readSettingPlain = async (db: Db, key: string): Promise<string | null> => {
  const row = await readSetting(db, key);
  return row?.valuePlaintext ?? null;
};

// `null` deletes the row; non-null upserts the plaintext value. Encrypted
// values have their own write path (lib/secrets.ts → wrapSecret) and
// shouldn't go through here.
export const upsertSetting = async (
  db: Db,
  key: string,
  value: string | null,
  actorUserId: string,
): Promise<void> => {
  if (value === null) {
    await db.delete(systemSettings).where(eq(systemSettings.key, key));
    return;
  }
  await db
    .insert(systemSettings)
    .values({ key, valuePlaintext: value, isSecret: false })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { valuePlaintext: value, updatedAt: sql`now()`, updatedByUserId: actorUserId },
    });
};
