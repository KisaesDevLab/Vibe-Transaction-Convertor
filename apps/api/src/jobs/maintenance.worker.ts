import { Worker } from 'bullmq';
import { lt, sql } from 'drizzle-orm';
import { rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { db } from '../db/client.js';
import { auditLog, sessions } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { cleanupExpiredBackups } from '../services/backup.js';
import { cleanupExpiredExports } from '../services/exports.js';
import { runRetentionSweep } from '../services/pdf-retention.js';

import { QUEUE_MAINTENANCE, getJobConnection, maintenanceQueue } from './queues.js';

interface MaintenanceJobData {
  task:
    | 'prune-sessions'
    | 'prune-audit'
    | 'clean-tmp'
    | 'expire-exports'
    | 'expire-backups'
    | 'purge-pdfs';
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
  // WHERE; the cutoff WHERE is satisfied here. The audit_log triggers
  // (ADR-013) reject DELETE unless the caller opts in for the current
  // transaction via the GUC below — SET LOCAL never escapes the
  // transaction so the opt-in is scoped to this prune.
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL "vibetc.audit_log_allow_prune" = 'on'`);
    return tx.delete(auditLog).where(lt(auditLog.at, cutoff)).returning({ id: auditLog.id });
  });
  return { deleted: result.length };
};

const cleanTmp = async (): Promise<{ removed: number; kept: number; tmpUploads: number }> => {
  const dataDir = process.env.DATA_DIR ?? './data';
  const tmpDir = join(dataDir, 'tmp');
  const tmpCutoff = Date.now() - 6 * 60 * 60 * 1000;
  let removed = 0;
  let kept = 0;
  try {
    const entries = await readdir(tmpDir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(tmpDir, entry.name);
      try {
        const s = await stat(full);
        if (s.mtimeMs < tmpCutoff) {
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

  // Phase 9 #21: orphaned <hash>.tmp files under uploads/ are
  // mid-rename casualties (writer crashed before atomic rename). Sweep
  // anything older than 1 hour so disk doesn't slowly fill.
  const uploadsDir = join(dataDir, 'uploads');
  const oneHour = Date.now() - 60 * 60 * 1000;
  let tmpUploads = 0;
  const sweep = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await sweep(full);
        continue;
      }
      if (!entry.name.endsWith('.tmp')) continue;
      try {
        const s = await stat(full);
        if (s.mtimeMs < oneHour) {
          await rm(full, { force: true });
          tmpUploads += 1;
        }
      } catch {
        // ignore
      }
    }
  };
  await sweep(uploadsDir);

  return { removed, kept, tmpUploads };
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
    case 'expire-backups':
      return cleanupExpiredBackups();
    case 'purge-pdfs':
      // Reads pdf.retention.days from system_settings each tick so an
      // admin can dial retention up/down without a worker restart.
      // Returns skipped='disabled' when the setting is unset, which the
      // audit log surfaces so operators see why nothing happened.
      return runRetentionSweep(db, null);
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
  // Phase 26 #21: nightly sweep of backups older than retention.
  await q.add(
    'expire-backups',
    { task: 'expire-backups' },
    { repeat: { pattern: '45 3 * * *' }, removeOnComplete: 50 },
  );
  // PDF retention sweep — runs daily after the other 03:xx housekeeping.
  // Reads pdf.retention.days from system_settings; no-op when unset.
  await q.add(
    'purge-pdfs',
    { task: 'purge-pdfs' },
    { repeat: { pattern: '0 4 * * *' }, removeOnComplete: 50 },
  );
};
