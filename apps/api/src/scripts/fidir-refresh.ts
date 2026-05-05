import { closeDb, getDb } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { seedFidir } from '../services/fidir-seeder.js';

const main = async (): Promise<void> => {
  const result = await seedFidir(getDb());
  logger.info(result, 'FIDIR refresh complete');
  await closeDb();
};

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
