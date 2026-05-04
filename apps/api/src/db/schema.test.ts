import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from './schema.js';

const databaseUrl = process.env.DATABASE_URL;
const live = describe.skipIf(!databaseUrl);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsFolder = join(__dirname, 'migrations');

live('schema smoke (live Postgres)', () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });
    await pool.query('DROP SCHEMA IF EXISTS vibetc CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrate(db, { migrationsFolder });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it('inserts a user, company, account, and system_settings row', async () => {
    const [user] = await db
      .insert(schema.users)
      .values({
        email: 'admin@example.com',
        passwordHash: 'argon2id$placeholder',
        displayName: 'Admin',
        role: 'admin',
      })
      .returning();

    const [company] = await db.insert(schema.companies).values({ name: 'Acme LLC' }).returning();

    const [account] = await db
      .insert(schema.accounts)
      .values({
        companyId: company!.id,
        nickname: 'Operating',
        financialInstitution: 'Chase',
        intuBid: '10898',
        intuOrg: 'Chase',
        accountType: 'CHECKING',
        accountNumber: '1234567890',
      })
      .returning();

    expect(account!.accountNumberLast4).toBe('7890');
    expect(account!.currency).toBe('USD');

    await db.insert(schema.systemSettings).values({
      key: 'llm.provider',
      valuePlaintext: 'local',
      isSecret: false,
    });

    const settings = await db
      .select()
      .from(schema.systemSettings)
      .where(eq(schema.systemSettings.key, 'llm.provider'));
    expect(settings[0]?.valuePlaintext).toBe('local');
    expect(user).toBeDefined();
  });

  it('rejects malformed system_settings rows (secret xor plaintext)', async () => {
    await expect(
      db.insert(schema.systemSettings).values({
        key: 'broken.row',
        valuePlaintext: 'oops',
        valueEncrypted: Buffer.from([0x00]),
        isSecret: false,
      }),
    ).rejects.toThrow();
  });

  it('rejects routing_number on a CREDITCARD account', async () => {
    const [company] = await db.insert(schema.companies).values({ name: 'CC Holdings' }).returning();
    await expect(
      db.insert(schema.accounts).values({
        companyId: company!.id,
        nickname: 'Card',
        financialInstitution: 'Chase',
        intuBid: '10898',
        intuOrg: 'Chase',
        accountType: 'CREDITCARD',
        accountNumber: '4111111111111111',
        routingNumber: '021000021',
      }),
    ).rejects.toThrow();
  });
});
