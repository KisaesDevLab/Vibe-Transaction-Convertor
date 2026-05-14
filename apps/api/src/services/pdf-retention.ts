// PDF lifecycle helpers. Centralises the "unlink the file + cascade the
// source_pdf_deleted flag across every statement that referenced its
// hash" logic so the standalone Delete-PDF endpoint, the cascade inside
// statement-delete, and the retention sweep all behave identically.
//
// Why a single helper: getting the cascade wrong (e.g. only flipping
// the flag on the targeted row) leaves sibling rows pointing at a
// vanished file — the PDF viewer 404s and re-extract dies opaquely.

import { and, eq, lt, sql } from 'drizzle-orm';
import { unlink } from 'node:fs/promises';

import type { Db } from '../db/client.js';
import { statements } from '../db/schema.js';

import { readSettingPlain, upsertSetting } from './system-settings.js';

const RETENTION_DAYS_KEY = 'pdf.retention.days';
const LAST_SWEEP_KEY = 'pdf.retention.last_sweep_at';

export interface PdfDeleteResult {
  // Whether the file at sourcePdfPath was successfully unlinked. False
  // when the file was already gone (best-effort delete) or when the
  // statement was already marked deleted on entry.
  fileRemoved: boolean;
  // Sibling statements (same source_pdf_hash, different id) whose flag
  // was flipped to true in this call. Zero when no siblings exist or
  // when they were all already marked deleted.
  cascadedSiblings: number;
}

// Unlink the file and mark every statement that referenced its hash
// (including the row identified by `targetId`) as source_pdf_deleted.
// Idempotent: re-running on an already-deleted row is a no-op that
// returns fileRemoved=false and cascadedSiblings=0.
export const deletePdfForStatement = async (
  db: Db,
  targetId: string,
  stmt: {
    sourcePdfPath: string;
    sourcePdfHash: string;
    sourcePdfDeleted: boolean;
  },
): Promise<PdfDeleteResult> => {
  let fileRemoved = false;
  if (!stmt.sourcePdfDeleted) {
    try {
      await unlink(stmt.sourcePdfPath);
      fileRemoved = true;
    } catch {
      // Already gone / missing — non-fatal. Still flip the flag below
      // so the UI stops promising the operator a viewable PDF.
    }
  }
  // Update *every* row sharing the hash (including the target) so the
  // call is single-statement and the cascade can't half-apply. The
  // `eq(sourcePdfDeleted, false)` guard makes the count meaningful
  // (only rows that actually changed are returned).
  const flipped = await db
    .update(statements)
    .set({ sourcePdfDeleted: true, updatedAt: sql`now()` })
    .where(
      and(eq(statements.sourcePdfHash, stmt.sourcePdfHash), eq(statements.sourcePdfDeleted, false)),
    )
    .returning({ id: statements.id });
  // Siblings = flipped rows minus the target row (the target counts as
  // 1 of N flips when it wasn't already marked).
  const cascadedSiblings = Math.max(
    0,
    flipped.length - (flipped.some((r) => r.id === targetId) ? 1 : 0),
  );
  return { fileRemoved, cascadedSiblings };
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

const recordLastSweepAt = async (db: Db, actorUserId: string | null): Promise<void> => {
  await upsertSetting(db, LAST_SWEEP_KEY, new Date().toISOString(), actorUserId ?? 'system');
};

export interface RetentionSweepResult {
  ranAt: string;
  retentionDays: number | null;
  // Statements considered = rows older than cutoff with PDF still on
  // disk. Files removed counts successful unlinks.
  candidates: number;
  filesRemoved: number;
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
  // One row per unique (hash, path) so we don't try to unlink the same
  // file twice. Picking MIN(id) per hash is arbitrary — the file is
  // shared; any row's path works.
  const candidates = await db
    .select({
      id: statements.id,
      sourcePdfHash: statements.sourcePdfHash,
      sourcePdfPath: statements.sourcePdfPath,
      sourcePdfDeleted: statements.sourcePdfDeleted,
    })
    .from(statements)
    .where(and(lt(statements.createdAt, cutoff), eq(statements.sourcePdfDeleted, false)));

  // Deduplicate by hash — pick the first occurrence; the helper will
  // cascade the flag to the rest. Avoids double-unlink + redundant SQL.
  const seenHashes = new Set<string>();
  const byHash: typeof candidates = [];
  for (const c of candidates) {
    if (seenHashes.has(c.sourcePdfHash)) continue;
    seenHashes.add(c.sourcePdfHash);
    byHash.push(c);
  }

  let filesRemoved = 0;
  let rowsFlipped = 0;
  for (const c of byHash) {
    const r = await deletePdfForStatement(db, c.id, c);
    if (r.fileRemoved) filesRemoved += 1;
    // Each call flips this row + N siblings. Count both.
    rowsFlipped += 1 + r.cascadedSiblings;
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
