import { Queue } from 'bullmq';
import Redis from 'ioredis';

import { logger } from '../lib/logger.js';

let _connection: Redis | undefined;

export const getJobConnection = (): Redis => {
  if (_connection) return _connection;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL not set; BullMQ requires Redis');
  _connection = new Redis(url, { maxRetriesPerRequest: null });
  _connection.on('error', (err) => logger.warn({ err }, 'redis error (jobs)'));
  return _connection;
};

// BullMQ refuses queue names containing ':' since v5.x — use hyphens.
export const QUEUE_EXTRACTION = 'vibetc-extraction';
export const QUEUE_MAINTENANCE = 'vibetc-maintenance';

export interface ExtractionJobData {
  statementId: string;
  accountId: string;
  sourcePdfHash: string;
  sourcePdfPath: string;
}

let _extractionQueue: Queue<ExtractionJobData> | undefined;
export const extractionQueue = (): Queue<ExtractionJobData> => {
  if (_extractionQueue) return _extractionQueue;
  _extractionQueue = new Queue<ExtractionJobData>(QUEUE_EXTRACTION, {
    connection: getJobConnection(),
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 200,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
    },
  });
  return _extractionQueue;
};

let _maintenanceQueue: Queue | undefined;
export const maintenanceQueue = (): Queue => {
  if (_maintenanceQueue) return _maintenanceQueue;
  _maintenanceQueue = new Queue(QUEUE_MAINTENANCE, {
    connection: getJobConnection(),
    defaultJobOptions: { removeOnComplete: 50, removeOnFail: 100 },
  });
  return _maintenanceQueue;
};

// Job ID derived from the statement ID so concurrent enqueues for the
// same statement collapse (debounces double-click on the first upload),
// and so the cancel + re-extract routes can find the job by statement
// ID without a separate index. Each split child of a multi-account PDF
// already has its own UUID, so they get distinct slots.
//
// BullMQ 5.76+ rejects custom job IDs containing ":". Use a hyphen
// separator instead.
const extractionJobId = (statementId: string): string => `extract-${statementId}`;

// BullMQ's Queue.add is idempotent on jobId — a second add() with the
// same ID silently returns the existing job *in any state*, including
// completed/failed. With removeOnComplete:100 the original successful
// job stays in Redis indefinitely, so a naive re-add after completion
// no-ops and the worker never sees the re-run. Callers that explicitly
// want a fresh run (re-extract route) must removeExtractionJob first.
export const enqueueExtraction = async (data: ExtractionJobData): Promise<void> => {
  await extractionQueue().add('extract', data, { jobId: extractionJobId(data.statementId) });
};

// Remove the queued/active/completed/failed job for a statement, if any.
// Safe to call when no job exists (returns false). Used by /cancel to
// stop an in-flight job and by /re-extract to clear the prior run so
// the next enqueue actually schedules.
export const removeExtractionJob = async (statementId: string): Promise<boolean> => {
  const job = await extractionQueue().getJob(extractionJobId(statementId));
  if (!job) return false;
  await job.remove();
  return true;
};

export const closeQueues = async (): Promise<void> => {
  if (_extractionQueue) await _extractionQueue.close();
  if (_maintenanceQueue) await _maintenanceQueue.close();
  if (_connection) {
    _connection.disconnect();
    _connection = undefined;
  }
  _extractionQueue = undefined;
  _maintenanceQueue = undefined;
};
