// PDF lifecycle helpers for the admin Delete-PDF endpoint and the retention
// sweep (statement delete has its own reference check in routes/statements).
//
// Everything here works per stored FILE, not per content hash. storePdf files
// PDFs under uploads/yyyy/mm/<hash>.pdf, so statements with the same hash do
// not necessarily share a file: split children (and a same-month upload of the
// identical PDF to another account) share the parent's path, while a re-upload
// in a later month gets its own copy. A file is unlinked only when it is meant
// to go, and source_pdf_deleted is flipped only on the statements whose file
// was actually removed — never on a statement whose own copy is still on disk
// (its viewer and re-extract would be disabled for nothing, and the file would
// never be purged).

import { and, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { stat, unlink } from 'node:fs/promises';

import type { Db } from '../db/client.js';
import { statements } from '../db/schema.js';
import { InternalError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

import { readSettingPlain, upsertSetting } from './system-settings.js';

const RETENTION_DAYS_KEY = 'pdf.retention.days';
const LAST_SWEEP_KEY = 'pdf.retention.last_sweep_at';

// Statuses in which an extraction is queued or running and will read the
// source PDF. The sweep never pulls a file out from under one.
const IN_FLIGHT_STATUSES: Array<(typeof statements.$inferSelect)['status']> = [
  'uploaded',
  'preprocessing',
  'ocr',
  'extracting',
  'reconciling',
];

export interface PdfDeleteResult {
  // Whether the file at sourcePdfPath was unlinked by this call. False when
  // it was already missing on disk, or when the statement was already marked
  // deleted on entry.
  fileRemoved: boolean;
  // Other statements sharing the same stored file (same sourcePdfPath) whose
  // flag was flipped in this call. Statements holding their own copy of the
  // same content are left alone.
  cascadedSiblings: number;
}

type UnlinkOutcome = 'removed' | 'missing' | 'failed';

// 'missing' (ENOENT) counts as gone; any other error means the file is still
// on disk and nothing may be flagged.
const unlinkStoredPdf = async (path: string): Promise<UnlinkOutcome> => {
  try {
    await unlink(path);
    return 'removed';
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return 'missing';
    logger.warn({ err }, 'could not unlink source PDF');
    return 'failed';
  }
};

// Whether the file at `path` was written at or after `since` (by mtime). A
// missing or unreadable file is not "recent": unlinkStoredPdf then reports it
// missing (flag it) or failed (leave it for the next sweep).
const storedSince = async (path: string, since: Date): Promise<boolean> => {
  try {
    return (await stat(path)).mtimeMs >= since.getTime();
  } catch {
    return false;
  }
};

// Flag every not-yet-flagged statement that points at `path`. Returns the
// flipped statement ids.
const flagStatementsUsingPath = async (db: Db, path: string): Promise<string[]> => {
  const flipped = await db
    .update(statements)
    .set({ sourcePdfDeleted: true, updatedAt: sql`now()` })
    .where(and(eq(statements.sourcePdfPath, path), eq(statements.sourcePdfDeleted, false)))
    .returning({ id: statements.id });
  return flipped.map((r) => r.id);
};

// Admin Delete-PDF: unlink the targeted statement's file and flag every
// statement that uses that same file. Idempotent: an already-deleted row is a
// no-op (fileRemoved=false, cascadedSiblings=0) — its old path may by now hold
// a newer upload of the same content, which must keep its file.
export const deletePdfForStatement = async (
  db: Db,
  targetId: string,
  stmt: {
    sourcePdfPath: string;
    sourcePdfHash: string;
    sourcePdfDeleted: boolean;
  },
): Promise<PdfDeleteResult> => {
  if (stmt.sourcePdfDeleted) return { fileRemoved: false, cascadedSiblings: 0 };
  const outcome = await unlinkStoredPdf(stmt.sourcePdfPath);
  if (outcome === 'failed') {
    // Still on disk: flagging it would tell the operator the PDF is gone.
    throw new InternalError(
      'could not remove the source PDF from disk — nothing was changed; try again',
    );
  }
  // An already-missing file is still flagged so the UI stops promising a
  // viewable PDF.
  const flipped = await flagStatementsUsingPath(db, stmt.sourcePdfPath);
  return {
    fileRemoved: outcome === 'removed',
    cascadedSiblings: flipped.filter((id) => id !== targetId).length,
  };
};

// Retention setting: integer ≥ 1 (days). null / 0 / NaN → disabled.
export const getRetentionDays = async (db: Db): Promise<number | null> => {
  const v = await readSettingPlain(db, RETENTION_DAYS_KEY);
  if (v === null || v === undefined) return null;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
};

export const setRetentionDays = async (
  db: Db,
  days: number | null,
  actorUserId: string,
): Promise<void> => {
  await upsertSetting(db, RETENTION_DAYS_KEY, days === null ? '' : String(days), actorUserId);
};

export const getLastSweepAt = async (db: Db): Promise<string | null> => {
  const v = await readSettingPlain(db, LAST_SWEEP_KEY);
  return v ?? null;
};

// actorUserId null = the nightly cron (system write; updated_by_user_id stays
// NULL — it's a uuid FK, so no sentinel string).
const recordLastSweepAt = async (db: Db, actorUserId: string | null): Promise<void> => {
  await upsertSetting(db, LAST_SWEEP_KEY, new Date().toISOString(), actorUserId);
};

export interface RetentionSweepResult {
  ranAt: string;
  retentionDays: number | null;
  // Statements past the retention window whose PDF was still on disk.
  candidates: number;
  // Files actually unlinked by this run.
  filesRemoved: number;
  // Statements flagged source_pdf_deleted by this run.
  rowsFlipped: number;
  // When retention is disabled, we return immediately without scanning.
  skipped: 'disabled' | null;
}

// Sweep PDFs older than the configured retention. Safe to invoke from
// the daily cron or the admin "Run now" button. actorUserId is null
// when fired by the cron (audit shows actor=system).
export const runRetentionSweep = async (
  db: Db,
  actorUserId: string | null,
): Promise<RetentionSweepResult> => {
  const ranAt = new Date().toISOString();
  const days = await getRetentionDays(db);
  if (days === null) {
    return {
      ranAt,
      retentionDays: null,
      candidates: 0,
      filesRemoved: 0,
      rowsFlipped: 0,
      skipped: 'disabled',
    };
  }
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const candidates = await db
    .select({ sourcePdfPath: statements.sourcePdfPath })
    .from(statements)
    .where(and(lt(statements.createdAt, cutoff), eq(statements.sourcePdfDeleted, false)));

  // A file is purged only once EVERY statement still using it is past the
  // window — a recent split child or same-month re-upload keeps it alive —
  // and none of them is mid-extraction (e.g. the re-extract a re-upload
  // enabled is reading it).
  const inUse = await db
    .selectDistinct({ sourcePdfPath: statements.sourcePdfPath })
    .from(statements)
    .where(
      and(
        eq(statements.sourcePdfDeleted, false),
        or(gte(statements.createdAt, cutoff), inArray(statements.status, IN_FLIGHT_STATUSES)),
      ),
    );
  const pathsInUse = new Set(inUse.map((r) => r.sourcePdfPath));

  let filesRemoved = 0;
  let rowsFlipped = 0;
  // One pass per stored file (several statements can share one).
  for (const path of new Set(candidates.map((c) => c.sourcePdfPath))) {
    if (pathsInUse.has(path)) continue;
    // A file stored within the window is not past retention, however old its
    // statements are: re-uploading a purged PDF restores it onto the ORIGINAL
    // rows (restoreDeletedSourcePdf keeps their createdAt), and without this
    // the next nightly run would delete the fresh copy again.
    if (await storedSince(path, cutoff)) continue;
    const outcome = await unlinkStoredPdf(path);
    // Still on disk — leave its statements unflagged; the next sweep retries.
    if (outcome === 'failed') continue;
    if (outcome === 'removed') filesRemoved += 1;
    rowsFlipped += (await flagStatementsUsingPath(db, path)).length;
  }

  await recordLastSweepAt(db, actorUserId);
  return {
    ranAt,
    retentionDays: days,
    candidates: candidates.length,
    filesRemoved,
    rowsFlipped,
    skipped: null,
  };
};
