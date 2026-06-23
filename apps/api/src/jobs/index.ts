import { logger } from '../lib/logger.js';
import { startExtractionWorker } from './extraction.worker.js';
import { startMaintenanceWorker } from './maintenance.worker.js';

let started = false;

export const startWorkers = (): void => {
  if (started) return;
  if (!process.env.REDIS_URL) {
    logger.warn('REDIS_URL not set — workers disabled');
    return;
  }
  if (process.env.WORKER_INLINE === 'false') {
    logger.info('WORKER_INLINE=false — workers run in a separate process');
    return;
  }
  // startExtractionWorker resolves its lock duration from the DB, so it's async;
  // fire-and-forget here (inline mode) — it logs its own startup errors.
  void startExtractionWorker();
  startMaintenanceWorker();
  started = true;
  logger.info('inline workers started: extraction + maintenance');
};
