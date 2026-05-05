import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';

import { db } from '../db/client.js';
import { statements, transactions } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { writeAudit } from '../services/audit.js';
import { overrideReconciliation } from '../services/exports.js';
import { computeFitid } from '@vibe-tx-converter/exporters';

const serializeBigint = <T extends Record<string, unknown>>(row: T): T => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'bigint' ? v.toString() : v;
  }
  return out as T;
};

export const statementsRouter = (): Router => {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const accountId = req.query.accountId ? String(req.query.accountId) : undefined;
      const where = accountId ? eq(statements.accountId, accountId) : undefined;
      const rows = await (where
        ? db.select().from(statements).where(where).orderBy(statements.createdAt)
        : db.select().from(statements).orderBy(statements.createdAt));
      res.json(rows.map((r) => serializeBigint(r)));
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const stmtRows = await db.select().from(statements).where(eq(statements.id, id));
      const stmt = stmtRows[0];
      if (!stmt) throw new NotFoundError(`statement ${id}`);
      const txs = await db
        .select()
        .from(transactions)
        .where(eq(transactions.statementId, id))
        .orderBy(transactions.postedDate, transactions.seqInDay);
      res.json({
        statement: serializeBigint(stmt),
        transactions: txs.map((t) => serializeBigint(t)),
      });
    } catch (err) {
      next(err);
    }
  });

  // Patch a single transaction (description, amount, trntype). FITID is
  // recomputed from the new fields per ADR-005.
  router.patch('/transactions/:txId', async (req, res, next) => {
    try {
      const txId = String(req.params.txId);
      const body = req.body ?? {};
      const rows = await db.select().from(transactions).where(eq(transactions.id, txId));
      const tx = rows[0];
      if (!tx) throw new NotFoundError(`transaction ${txId}`);
      const patch: Record<string, unknown> = {
        userEdited: true,
        updatedAt: sql`now()`,
      };
      let recomputeFitid = false;
      if (typeof body.description === 'string') {
        patch.description = body.description.trim();
        patch.normalizedDescription = body.description.trim().toLowerCase();
        recomputeFitid = true;
      }
      if (typeof body.amount_cents === 'number' || typeof body.amount_cents === 'string') {
        const amt = BigInt(body.amount_cents);
        if (amt === 0n) throw new ValidationError('amount must be non-zero');
        patch.amountCents = amt;
        recomputeFitid = true;
      }
      if (typeof body.trntype === 'string') patch.trntype = body.trntype;
      if (typeof body.posted_date === 'string') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.posted_date)) {
          throw new ValidationError('posted_date must be YYYY-MM-DD');
        }
        patch.postedDate = body.posted_date;
        recomputeFitid = true;
      }
      if (recomputeFitid) {
        patch.fitid = computeFitid({
          postedDate: (patch.postedDate as string) ?? tx.postedDate,
          amountCents: (patch.amountCents as bigint) ?? tx.amountCents,
          description: (patch.description as string) ?? tx.description,
          seqInDay: tx.seqInDay,
        });
      }
      const [updated] = await db
        .update(transactions)
        .set(patch)
        .where(eq(transactions.id, txId))
        .returning();
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'transaction',
        entityId: txId,
        action: 'transaction.update',
        payload: body as Record<string, unknown>,
      });
      res.json(serializeBigint(updated!));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/override-reconciliation', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const reason = String(req.body?.reason ?? '').trim();
      if (reason.length < 5) throw new ValidationError('reason must be at least 5 characters');
      await overrideReconciliation(db, req.user!, id, reason);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
