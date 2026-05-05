import { db } from './db/client.js';
import { startWorkers } from './jobs/index.js';
import { logger } from './lib/logger.js';
import { seedFidirIfEmpty } from './services/fidir-seeder.js';
import { createApp } from './server.js';

const port = Number.parseInt(process.env.PORT ?? '4000', 10);

const main = async (): Promise<void> => {
  if (process.env.DATABASE_URL) {
    try {
      await seedFidirIfEmpty(db);
    } catch (err) {
      logger.warn({ err }, 'fidir bootstrap seed failed; continuing');
    }
  } else {
    logger.warn('DATABASE_URL not set; skipping FIDIR bootstrap seed');
  }
  startWorkers();
  const app = createApp();
  app.listen(port, () => {
    logger.info({ port }, 'api listening');
  });
};

void main();
