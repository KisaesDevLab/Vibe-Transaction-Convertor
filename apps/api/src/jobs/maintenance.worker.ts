import { Worker } from 'bullmq';
import { lt } from 'drizzle-orm';
import { rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { db } from '../db/client.js';
import { auditLog, sessions } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { cleanupExpiredExports } from '../services/exports.js';

import { QUEUE_MAINTENANCE, getJobConnection, maintenanceQueue } from './queues.js';

interface MaintenanceJobData {
  task: 'prune-sessions' | 'prune-audit' | 'clean-tmp' | 'expire-exports';
}

const pruneSessions = async (): Promise<{ deleted: number }> => {
  const rows = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id });
  return { deleted: rows.length };
};

// AUDIT_RETENTION_DAYS unset → keep forever (Phase 25 default).
const pruneAudit = async (): Promise<{ deleted: number; skipped?: true }> => {
  const days = Number.parseInt(process.env.AUDIT_RETENTION_DAYS ?? '', 10);
  if (!Number.isFinite(days) || days <= 0) return { deleted: 0, skipped: true };
  // Delete audit_log rows older than `days`. Drizzle blocks DELETE without
  // WHERE; the cutoff WHERE is satisfied here.
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(auditLog)
    .where(lt(auditLog.at, cutoff))
    .returning({ id: auditLog.id });
  return { deleted: result.length };
};

const cleanTmp = async (): Promise<{ removed: number; kept: number }> => {
  const dataDir = process.env.DATA_DIR ?? './data';
  const tmpDir = join(dataDir, 'tmp');
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  let removed = 0;
  let kept = 0;
  try {
    const entries = await readdir(tmpDir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(tmpDir, entry.name);
      try {
        const s = await stat(full);
        if (s.mtimeMs < cutoff) {
          await rm(full, { recursive: true, force: true });
          removed += 1;
        } else {
          kept += 1;
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // tmp dir doesn't exist
  }
  return { removed, kept };
};

const processMaintenance = async (data: MaintenanceJobData): Promise<unknown> => {
  switch (data.task) {
    case 'prune-sessions':
      return pruneSessions();
    case 'prune-audit':
      return pruneAudit();
    case 'clean-tmp':
      return cleanTmp();
    case 'expire-exports':
      return cleanupExpiredExports(db);
    default:
      throw new Error(`unknown maintenance task: ${(data as { task: string }).task}`);
  }
};

export const startMaintenanceWorker = (): Worker<MaintenanceJobData> => {
  // Schedule recurring jobs (idempotent via repeatable job IDs).
  void scheduleRecurring();
  return new Worker<MaintenanceJobData>(
    QUEUE_MAINTENANCE,
    async (job) => {
      const result = await processMaintenance(job.data);
      logger.info({ task: job.data.task, result }, 'maintenance job complete');
      // Audit-log without an actor (system event).
      await db.insert(auditLog).values({
        entityType: 'system',
        entityId: 'maintenance',
        action: `maintenance.${job.data.task}`,
        payload: result as Record<string, unknown>,
      });
    },
    { connection: getJobConnection() },
  );
};

const scheduleRecurring = async (): Promise<void> => {
  const q = maintenanceQueue();
  // Daily at 03:00 UTC.
  await q.add(
    'prune-sessions',
    { task: 'prune-sessions' },
    { repeat: { pattern: '0 3 * * *' }, removeOnComplete: 50 },
  );
  await q.add(
    'prune-audit',
    { task: 'prune-audit' },
    { repeat: { pattern: '15 3 * * *' }, removeOnComplete: 50 },
  );
  await q.add(
    'clean-tmp',
    { task: 'clean-tmp' },
    { repeat: { pattern: '*/30 * * * *' }, removeOnComplete: 50 },
  );
  // Phase 24 #21: nightly sweep of export files older than 30 days.
  await q.add(
    'expire-exports',
    { task: 'expire-exports' },
    { repeat: { pattern: '30 3 * * *' }, removeOnComplete: 50 },
  );
};
