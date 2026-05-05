import { db } from './db/client.js';
import { startWorkers } from './jobs/index.js';
import { runBootChecks } from './lib/boot-checks.js';
import { logger } from './lib/logger.js';
import { seedFidirIfEmpty } from './services/fidir-seeder.js';
import { createApp } from './server.js';

const port = Number.parseInt(process.env.PORT ?? '4000', 10);

const main = async (): Promise<void> => {
  runBootChecks();
  try {
    await seedFidirIfEmpty(db);
  } catch (err) {
    logger.warn({ err }, 'fidir bootstrap seed failed; continuing');
  }
  startWorkers();
  const app = createApp();
  app.listen(port, () => {
    logger.info({ port }, 'api listening');
  });
};

main().catch((err) => {
  logger.fatal({ err }, 'boot failed');
  process.exit(1);
});
