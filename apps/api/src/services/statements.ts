import { and, eq, isNull, sql } from 'drizzle-orm';
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
  if (!existing[0]) throw new Error('statement insert lost the race AND row not found');
  return { statement: existing[0], deduplicated: true };
};

export const findByHash = async (db: Db, hash: string): Promise<Statement | null> => {
  const rows = await db.select().from(statements).where(eq(statements.sourcePdfHash, hash));
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
