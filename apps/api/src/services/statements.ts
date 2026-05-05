import { and, eq } from 'drizzle-orm';
import { createReadStream } from 'node:fs';

import type { Db } from '../db/client.js';
import { statements } from '../db/schema.js';
import type { Statement, User } from '../db/types.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { writeAudit } from './audit.js';

export interface UploadIngestInput {
  accountId: string;
  hash: string;
  storedPath: string;
  filename: string;
  bytes: number;
  pages: number;
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
  const existing = await db
    .select()
    .from(statements)
    .where(
      and(eq(statements.accountId, input.accountId), eq(statements.sourcePdfHash, input.hash)),
    );
  if (existing[0]) {
    return { statement: existing[0], deduplicated: true };
  }

  const [created] = await db
    .insert(statements)
    .values({
      accountId: input.accountId,
      sourcePdfHash: input.hash,
      sourcePdfPath: input.storedPath,
      sourcePdfPages: input.pages,
      status: 'uploaded',
    })
    .returning();
  if (!created) throw new Error('statement insert returned no row');

  await writeAudit(db, {
    actorUserId: actor.id,
    entityType: 'statement',
    entityId: created.id,
    action: 'statement.upload',
    payload: { hash: input.hash, filename: input.filename, bytes: input.bytes, pages: input.pages },
  });

  return { statement: created, deduplicated: false };
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
