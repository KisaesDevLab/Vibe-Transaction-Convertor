// Live-Redis-only test for queues.ts. The bug we're guarding against:
// BullMQ's Queue.add is idempotent on jobId, so a naive re-extract
// after a completed run silently returned the existing completed job
// without scheduling a re-run. removeExtractionJob clears the prior
// job so the next enqueue actually schedules.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeQueues, enqueueExtraction, extractionQueue, removeExtractionJob } from './queues.js';

const redisUrl = process.env.REDIS_URL;
const live = describe.skipIf(!redisUrl);

const sample = {
  statementId: 'queues-test-statement-id',
  accountId: 'acc-1',
  sourcePdfHash: 'deadbeef',
  sourcePdfPath: '/tmp/x.pdf',
};

live('extraction queue idempotency', () => {
  beforeEach(async () => {
    await removeExtractionJob(sample.statementId);
  });

  afterAll(async () => {
    await removeExtractionJob(sample.statementId);
    await closeQueues();
  });

  it('removeExtractionJob returns false when no prior job exists', async () => {
    expect(await removeExtractionJob(sample.statementId)).toBe(false);
  });

  it('enqueueExtraction is a no-op when a prior job exists (collapses double-clicks)', async () => {
    await enqueueExtraction(sample);
    const first = await extractionQueue().getJob(`extract-${sample.statementId}`);
    expect(first).toBeTruthy();
    const firstTs = first!.timestamp;

    await enqueueExtraction(sample);
    const second = await extractionQueue().getJob(`extract-${sample.statementId}`);
    expect(second!.timestamp).toBe(firstTs);
  });

  it('removeExtractionJob + enqueueExtraction schedules a fresh job', async () => {
    await enqueueExtraction(sample);
    const first = await extractionQueue().getJob(`extract-${sample.statementId}`);
    const firstTs = first!.timestamp;

    expect(await removeExtractionJob(sample.statementId)).toBe(true);
    // BullMQ's getJob() resolves to undefined (not null) for a missing job.
    expect(await extractionQueue().getJob(`extract-${sample.statementId}`)).toBeFalsy();

    // Force a measurable timestamp delta — BullMQ uses ms precision.
    await new Promise((r) => setTimeout(r, 5));

    await enqueueExtraction(sample);
    const fresh = await extractionQueue().getJob(`extract-${sample.statementId}`);
    expect(fresh).toBeTruthy();
    expect(fresh!.timestamp).toBeGreaterThan(firstTs);
  });
});
