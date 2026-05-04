import { eq } from 'drizzle-orm';
import { db, pool } from './client.js';
import { systemSettings } from './schema.js';

async function main() {
  const existing = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, 'llm.provider'));

  if (existing.length === 0) {
    await db.insert(systemSettings).values({
      key: 'llm.provider',
      valuePlaintext: 'local',
      isSecret: false,
    });
  }

  // Real seeding (FIDIR, sample firm) lands in Phase 5 / dev fixtures.

  await pool.end();
  // eslint-disable-next-line no-console
  console.log('seed complete');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
