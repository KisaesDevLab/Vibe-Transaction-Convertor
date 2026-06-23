// Phase 28 #4: standalone worker entry point. Starts the BullMQ
// extraction + maintenance workers without spinning up the Express
// app. Used by the dedicated `worker` container in docker-compose so
// the API stays request-only under load.
//
// The boot checks (SESSION_SECRET, DATABASE_URL, REDIS_URL) still run
// here so the worker container fails fast on misconfiguration.

import { logger } from '../lib/logger.js';
import { runBootChecks } from '../lib/boot-checks.js';
import { startExtractionWorker } from './extraction.worker.js';
import { startMaintenanceWorker } from './maintenance.worker.js';
import { closeQueues } from './queues.js';

const main = async (): Promise<void> => {
  runBootChecks();
  if (!process.env.REDIS_URL) {
    logger.fatal('REDIS_URL must be set for the worker container');
    process.exit(1);
  }
  const ext = await startExtractionWorker();
  const maint = startMaintenanceWorker();
  logger.info('worker container ready: extraction + maintenance');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down worker');
    await Promise.allSettled([ext.close(), maint.close()]);
    await closeQueues();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
};

void main();
