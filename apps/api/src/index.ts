import { db } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { startWorkers } from './jobs/index.js';
import { runBootChecks } from './lib/boot-checks.js';
import { logger } from './lib/logger.js';
import { seedFidirIfEmpty } from './services/fidir-seeder.js';
import { createApp } from './server.js';

const port = Number.parseInt(process.env.PORT ?? '4000', 10);

// MIGRATIONS_AUTO=true → apply drizzle migrations on container start.
// The Vibe-Appliance enable flow relies on this for first-boot schema
// creation (no separate explicit-migrate step on enable; that path is
// reserved for update.sh, which has the rollback safety net of a
// pre-update DB dump). Default off so standalone deploys keep running
// migrations out-of-band via `pnpm db:migrate`.
const migrationsAuto = (): boolean => {
  const v = process.env.MIGRATIONS_AUTO;
  return v === '1' || v?.toLowerCase() === 'true';
};

const main = async (): Promise<void> => {
  runBootChecks();
  if (migrationsAuto()) {
    logger.info('MIGRATIONS_AUTO=true; applying pending migrations');
    await runMigrations(db);
    logger.info('migrations applied');
  }
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
