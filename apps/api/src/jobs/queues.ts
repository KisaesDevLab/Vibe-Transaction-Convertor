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

// Idempotent enqueue: jobId derived from (sourcePdfHash, accountId).
export const enqueueExtraction = async (data: ExtractionJobData): Promise<void> => {
  const id = `extract:${data.accountId}:${data.sourcePdfHash}`;
  await extractionQueue().add('extract', data, { jobId: id });
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
