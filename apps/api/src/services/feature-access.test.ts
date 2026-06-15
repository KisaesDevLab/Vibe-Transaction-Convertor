// Live-Postgres tests for the per-user feature-access service: default-on
// semantics, toggle round-trip + audit, and the last-admin lockout guard.
// Skipped unless DATABASE_URL is set (same gate as the other live tests).

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb, getDb, getPool } from '../db/client.js';
import { auditLog, users } from '../db/schema.js';
import { ConflictError } from '../lib/errors.js';
import { ACCESS_CONTROL_FEATURE } from '../lib/feature-registry.js';
import { getFeatureAccessMatrix, loadFeatureAccess, setFeatureAccess } from './feature-access.js';

const databaseUrl = process.env.DATABASE_URL;
const live = describe.skipIf(!databaseUrl);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsFolder = join(__dirname, '..', 'db', 'migrations');

let seq = 0;
const mkUser = async (role: 'admin' | 'staff') => {
  seq += 1;
  const db = getDb();
  const [u] = await db
    .insert(users)
    .values({
      email: `fa-${role}-${seq}@example.com`,
      passwordHash: 'x',
      displayName: `FA ${role} ${seq}`,
      role,
    })
    .returning();
  return u!;
};

live('feature-access service (live Postgres)', () => {
  beforeAll(async () => {
    const pool = getPool();
    await pool.query('DROP SCHEMA IF EXISTS vibetc CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrate(getDb(), { migrationsFolder });
  }, 60_000);

  afterAll(async () => {
    await closeDb();
  });

  it('a user with no override rows has every feature enabled', async () => {
    const u = await mkUser('staff');
    const access = await loadFeatureAccess(getDb(), u.id);
    expect(Object.values(access).every((v) => v === true)).toBe(true);
    expect(access.exports).toBe(true);
  });

  it('disabling then re-enabling a feature round-trips and writes audit rows', async () => {
    const db = getDb();
    const actor = await mkUser('admin');
    const target = await mkUser('staff');

    await setFeatureAccess(db, {
      actorUserId: actor.id,
      targetUserId: target.id,
      featureKey: 'exports',
      enabled: false,
    });
    let access = await loadFeatureAccess(db, target.id);
    expect(access.exports).toBe(false);
    expect(access.companies).toBe(true);

    await setFeatureAccess(db, {
      actorUserId: actor.id,
      targetUserId: target.id,
      featureKey: 'exports',
      enabled: true,
    });
    access = await loadFeatureAccess(db, target.id);
    expect(access.exports).toBe(true);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'feature_access'), eq(auditLog.entityId, target.id)));
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('feature_access.disable');
    expect(actions).toContain('feature_access.enable');
  });

  it('matrix reflects overrides and defaults', async () => {
    const db = getDb();
    const actor = await mkUser('admin');
    const target = await mkUser('staff');
    await setFeatureAccess(db, {
      actorUserId: actor.id,
      targetUserId: target.id,
      featureKey: 'enrich',
      enabled: false,
    });
    const matrix = await getFeatureAccessMatrix(db);
    const row = matrix.find((m) => m.id === target.id);
    expect(row?.features.enrich).toBe(false);
    expect(row?.features.statements).toBe(true);
  });

  it('refuses to remove Access Management from the last admin holding it', async () => {
    const db = getDb();
    // There may be admins from earlier cases; disable the feature for all
    // but one so we can drive the guard deterministically.
    const admins = (await getFeatureAccessMatrix(db)).filter((m) => m.role === 'admin');
    expect(admins.length).toBeGreaterThan(0);
    const keep = admins[0]!;
    for (const a of admins.slice(1)) {
      await setFeatureAccess(db, {
        actorUserId: keep.id,
        targetUserId: a.id,
        featureKey: ACCESS_CONTROL_FEATURE,
        enabled: false,
      });
    }

    // Now `keep` is the only admin with Access Management — removing it
    // must be refused.
    await expect(
      setFeatureAccess(db, {
        actorUserId: keep.id,
        targetUserId: keep.id,
        featureKey: ACCESS_CONTROL_FEATURE,
        enabled: false,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // Adding a second admin that still holds it makes removal allowed.
    const second = await mkUser('admin');
    await expect(
      setFeatureAccess(db, {
        actorUserId: keep.id,
        targetUserId: second.id,
        featureKey: ACCESS_CONTROL_FEATURE,
        enabled: false,
      }),
    ).resolves.toBeUndefined();
  });
});
