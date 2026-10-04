import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { createReadStream } from 'node:fs';

import type { Db } from '../db/client.js';
import { statements } from '../db/schema.js';
import type { Statement, User } from '../db/types.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { writeAudit } from './audit.js';

import type { PdfProcessingStrategy } from './pdf-strategy.js';

export interface UploadIngestInput {
  accountId: string;
  hash: string;
  storedPath: string;
  filename: string;
  bytes: number;
  pages: number;
  // Per-upload override of the firm-wide PDF processing strategy.
  // null falls back to the firm default at extraction time.
  processingStrategyOverride?: PdfProcessingStrategy | null;
}

export interface UploadIngestResult {
  statement: Statement;
  deduplicated: boolean;
}

export const ingestUpload = async (
  db: Db,
  actor: User,
  input: UploadIngestInput,
): Promise<UploadIngestResult> => {
  // ON CONFLICT DO NOTHING + RETURNING closes the race window where two
  // parallel uploads of the same hash for the same account both pass a
  // pre-INSERT SELECT and then collide on the unique index.
  //
  // Migration 0006 replaced the plain unique index with a partial one
  // (`statements_account_hash_unsplit_uq` ... WHERE page_range IS NULL)
  // so multiple post-split rows can share (account, hash) with disjoint
  // page_range. The conflict target therefore needs the same predicate
  // — Postgres won't match a partial index without it.
  const inserted = await db
    .insert(statements)
    .values({
      accountId: input.accountId,
      sourcePdfHash: input.hash,
      sourcePdfPath: input.storedPath,
      sourcePdfPages: input.pages,
      status: 'uploaded',
      processingStrategyOverride: input.processingStrategyOverride ?? null,
    })
    .onConflictDoNothing({
      target: [statements.accountId, statements.sourcePdfHash],
      where: sql`page_range IS NULL`,
    })
    .returning();

  if (inserted[0]) {
    await writeAudit(db, {
      actorUserId: actor.id,
      entityType: 'statement',
      entityId: inserted[0].id,
      action: 'statement.upload',
      payload: {
        hash: input.hash,
        filename: input.filename,
        bytes: input.bytes,
        pages: input.pages,
      },
    });
    return { statement: inserted[0], deduplicated: false };
  }

  // Conflict path: another writer (or a re-upload) already created it.
  // Match the partial unique index (page_range IS NULL) so split-child
  // rows that happen to share (account, hash) are ignored — only the
  // original whole-PDF row counts as a duplicate.
  const existing = await db
    .select()
    .from(statements)
    .where(
      and(
        eq(statements.accountId, input.accountId),
        eq(statements.sourcePdfHash, input.hash),
        isNull(statements.pageRange),
      ),
    );
  const row = existing[0];
  if (!row) throw new Error('statement insert lost the race AND row not found');
  if (row.sourcePdfDeleted) {
    // The caller has just stored these bytes again — the existing statement
    // gets its PDF back instead of staying flagged "PDF gone".
    await restoreDeletedSourcePdf(db, actor, input.hash, input.storedPath);
    return {
      statement: { ...row, sourcePdfPath: input.storedPath, sourcePdfDeleted: false },
      deduplicated: true,
    };
  }
  return { statement: row, deduplicated: true };
};

// Re-uploading a PDF whose stored file was deleted (admin Delete-PDF or the
// retention sweep) is the documented way to get it back ("re-upload to enable
// re-extraction"). Point every statement of that content that lost its file at
// the freshly stored copy and clear the flag, audit-logged per statement.
// Returns the ids of the restored statements.
export const restoreDeletedSourcePdf = async (
  db: Db,
  actor: User,
  hash: string,
  storedPath: string,
): Promise<string[]> => {
  const restored = await db
    .update(statements)
    .set({ sourcePdfPath: storedPath, sourcePdfDeleted: false, updatedAt: sql`now()` })
    .where(and(eq(statements.sourcePdfHash, hash), eq(statements.sourcePdfDeleted, true)))
    .returning({ id: statements.id });
  for (const r of restored) {
    await writeAudit(db, {
      actorUserId: actor.id,
      entityType: 'statement',
      entityId: r.id,
      action: 'statement.restore-pdf',
      payload: { hash },
    });
  }
  return restored.map((r) => r.id);
};

// Oldest statement with this content hash, any account. Deterministic.
export const findByHash = async (db: Db, hash: string): Promise<Statement | null> => {
  const rows = await db
    .select()
    .from(statements)
    .where(eq(statements.sourcePdfHash, hash))
    .orderBy(asc(statements.createdAt), asc(statements.id))
    .limit(1);
  return rows[0] ?? null;
};

// The statement an upload of this content to `accountId` deduplicates to:
// the account's whole-PDF (un-split) row when there is one, else its oldest
// split slice of that PDF. Null when the account has never had it.
export const findByAccountAndHash = async (
  db: Db,
  accountId: string,
  hash: string,
): Promise<Statement | null> => {
  const rows = await db
    .select()
    .from(statements)
    .where(and(eq(statements.accountId, accountId), eq(statements.sourcePdfHash, hash)))
    .orderBy(desc(isNull(statements.pageRange)), asc(statements.createdAt), asc(statements.id))
    .limit(1);
  return rows[0] ?? null;
};

export const recentByAccount = async (
  db: Db,
  accountId: string,
  limit = 10,
): Promise<Statement[]> => {
  return db
    .select()
    .from(statements)
    .where(eq(statements.accountId, accountId))
    .orderBy(statements.createdAt)
    .limit(limit);
};

export const streamSourcePdf = (path: string): ReturnType<typeof createReadStream> => {
  return createReadStream(path);
};

export const getStatementOrThrow = async (db: Db, id: string): Promise<Statement> => {
  const rows = await db.select().from(statements).where(eq(statements.id, id));
  const row = rows[0];
  if (!row) throw new NotFoundError(`statement ${id} not found`);
  return row;
};

export const ensureStatementOnAccount = async (
  db: Db,
  accountId: string,
  statementId: string,
): Promise<Statement> => {
  const stmt = await getStatementOrThrow(db, statementId);
  if (stmt.accountId !== accountId) {
    throw new ConflictError('statement does not belong to this account');
  }
  return stmt;
};
