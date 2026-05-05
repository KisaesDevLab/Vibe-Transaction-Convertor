import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';

import { db } from '../db/client.js';
import { statements, transactions } from '../db/schema.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { requireAdmin } from '../middleware/auth.js';
import { writeAudit } from '../services/audit.js';
import { overrideReconciliation } from '../services/exports.js';
import { recomputeReconciliation } from '../services/reconciliation.js';
import { computeFitid, inferTrntype, normalizeDescription } from '@vibe-tx-converter/exporters';
import { enqueueExtraction, extractionQueue } from '../jobs/queues.js';

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

      // Compute the would-be next state then short-circuit if nothing
      // actually changed. Idempotent PATCHes should be a no-op — they must
      // not write audit_log rows or bump updatedAt. Phase 18 item 12.
      const next: {
        description?: string;
        normalizedDescription?: string;
        amountCents?: bigint;
        trntype?: string;
        postedDate?: string;
      } = {};
      if (typeof body.description === 'string') {
        const d = body.description.trim();
        if (d !== tx.description) {
          next.description = d;
          next.normalizedDescription = normalizeDescription(d);
        }
      }
      if (typeof body.amount_cents === 'number' || typeof body.amount_cents === 'string') {
        const amt = BigInt(body.amount_cents);
        if (amt === 0n) throw new ValidationError('amount must be non-zero');
        if (amt !== tx.amountCents) next.amountCents = amt;
      }
      if (typeof body.trntype === 'string' && body.trntype !== tx.trntype) {
        next.trntype = body.trntype;
      }
      if (typeof body.posted_date === 'string') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.posted_date)) {
          throw new ValidationError('posted_date must be YYYY-MM-DD');
        }
        if (body.posted_date !== tx.postedDate) next.postedDate = body.posted_date;
      }
      const hasChange = Object.keys(next).length > 0;
      if (!hasChange) {
        res.json(serializeBigint(tx));
        return;
      }

      const patch: Record<string, unknown> = {
        userEdited: true,
        updatedAt: sql`now()`,
        ...next,
      };
      const recomputeFitid =
        next.description !== undefined ||
        next.amountCents !== undefined ||
        next.postedDate !== undefined;
      if (recomputeFitid) {
        patch.fitid = computeFitid({
          postedDate: next.postedDate ?? tx.postedDate,
          amountCents: next.amountCents ?? tx.amountCents,
          description: next.description ?? tx.description,
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
        payload: { ...next, amountCents: next.amountCents?.toString() } as Record<string, unknown>,
      });
      // Phase 16 #16: a manual edit may flip a discrepancy → verified.
      await recomputeReconciliation(db, tx.statementId);
      res.json(serializeBigint(updated!));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/override-reconciliation', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const reason = String(req.body?.reason ?? '').trim();
      // Phase 16 #17: forensic-grade audit trail demands a real
      // explanation. 30 chars filters out one-word "ok" overrides.
      if (reason.length < 30) {
        throw new ValidationError(
          'reason must be at least 30 characters — describe what you reconciled and why',
        );
      }
      await overrideReconciliation(db, req.user!, id, reason);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Admin: insert a manual transaction. Used for rescue when the LLM
  // missed a row that's clearly on the statement. Phase 18 item 11.
  router.post('/:id/transactions', requireAdmin, async (req, res, next) => {
    try {
      const statementId = String(req.params.id);
      const body = req.body ?? {};
      const postedDate = String(body.posted_date ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(postedDate)) {
        throw new ValidationError('posted_date must be YYYY-MM-DD');
      }
      const description = String(body.description ?? '').trim();
      if (description.length === 0) throw new ValidationError('description is required');
      if (typeof body.amount_cents !== 'number' && typeof body.amount_cents !== 'string') {
        throw new ValidationError('amount_cents is required');
      }
      const amountCents = BigInt(body.amount_cents);
      if (amountCents === 0n) throw new ValidationError('amount must be non-zero');

      const sourcePage = Number.parseInt(String(body.source_page ?? '1'), 10) || 1;

      // Determine seq_in_day for the new row — find the max existing
      // seq for this date and add 1.
      const existing = await db
        .select()
        .from(transactions)
        .where(eq(transactions.statementId, statementId));
      const seqInDay =
        existing
          .filter((t) => t.postedDate === postedDate)
          .reduce((m, t) => Math.max(m, t.seqInDay), -1) + 1;

      const fitid = computeFitid({ postedDate, amountCents, description, seqInDay });
      const trntype =
        typeof body.trntype === 'string'
          ? body.trntype
          : inferTrntype({ description, amountCents });

      const [created] = await db
        .insert(transactions)
        .values({
          statementId,
          seqInDay,
          postedDate,
          description,
          normalizedDescription: normalizeDescription(description),
          amountCents,
          runningBalanceCents: null,
          checkNumber: typeof body.check_number === 'string' ? body.check_number : null,
          trntype: trntype as never,
          fitid,
          sourcePage,
          sourceBboxJson: null,
          confidence: 1,
          userEdited: true,
        })
        .returning();
      if (!created) throw new Error('insert returned no row');
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'transaction',
        entityId: created.id,
        action: 'transaction.admin-insert',
        payload: { statementId, postedDate, amountCents: amountCents.toString() },
      });
      // Phase 16 #16: adding a missing row may flip a discrepancy.
      await recomputeReconciliation(db, statementId);
      res.status(201).json(serializeBigint(created));
    } catch (err) {
      next(err);
    }
  });

  // Admin: delete a transaction. Triggers a reconciliation recompute so
  // the review page reflects the new sum without a manual refresh.
  router.delete('/transactions/:txId', requireAdmin, async (req, res, next) => {
    try {
      const txId = String(req.params.txId);
      const rows = await db.select().from(transactions).where(eq(transactions.id, txId));
      const tx = rows[0];
      if (!tx) throw new NotFoundError(`transaction ${txId}`);
      await db.delete(transactions).where(eq(transactions.id, txId));
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'transaction',
        entityId: txId,
        action: 'transaction.admin-delete',
        payload: { statementId: tx.statementId, fitid: tx.fitid },
      });
      await recomputeReconciliation(db, tx.statementId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Phase 16 #15: explicit recompute endpoint. Useful after bulk edits
  // or when the reviewer wants to confirm the live reconciler state.
  router.post('/:id/recompute-reconciliation', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const result = await recomputeReconciliation(db, id);
      if (!result) throw new NotFoundError(`statement ${id}`);
      res.json({ status: result.status, deltaCents: result.deltaCents.toString() });
    } catch (err) {
      next(err);
    }
  });

  // Split a detected multi-account PDF into N per-account statements.
  // Each split entry carries the operator-chosen accountId and the page
  // range (1-based, inclusive). The parent statement's transactions are
  // wiped and it is marked as a "split host" via multi_account_acknowledged
  // so the UI stops pestering. Each child is created with the same source
  // PDF hash but distinct page_range, then enqueued for re-extraction.
  // Phase 14 #6/#7/#8/#10.
  router.post('/:id/split', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const body = req.body ?? {};
      const splits = Array.isArray(body.splits) ? body.splits : [];
      if (splits.length < 2) {
        throw new ValidationError('splits must contain at least 2 entries');
      }
      const parentRows = await db.select().from(statements).where(eq(statements.id, id));
      const parent = parentRows[0];
      if (!parent) throw new NotFoundError(`statement ${id}`);

      const parsed: Array<{ accountId: string; pageStart: number; pageEnd: number }> = [];
      for (const s of splits) {
        const accountId = String((s as { accountId?: string }).accountId ?? '');
        const pageStart = Number.parseInt(
          String((s as { pageStart?: number }).pageStart ?? ''),
          10,
        );
        const pageEnd = Number.parseInt(String((s as { pageEnd?: number }).pageEnd ?? ''), 10);
        if (!accountId || !Number.isFinite(pageStart) || !Number.isFinite(pageEnd)) {
          throw new ValidationError('each split needs accountId, pageStart, pageEnd');
        }
        if (pageStart < 1 || pageEnd < pageStart) {
          throw new ValidationError(`invalid page range for split: ${pageStart}-${pageEnd}`);
        }
        if (pageEnd > parent.sourcePdfPages) {
          throw new ValidationError(
            `pageEnd ${pageEnd} exceeds source PDF page count ${parent.sourcePdfPages}`,
          );
        }
        parsed.push({ accountId, pageStart, pageEnd });
      }

      // Wipe parent's transactions so the parent row is purely an audit
      // marker; its FITIDs would all be wrong post-split anyway. The
      // delete-with-zero-rows case is a no-op (drizzle still requires
      // a WHERE — `transactions.statementId = id` satisfies it).
      await db.delete(transactions).where(eq(transactions.statementId, id));

      // Mark the parent as superseded — keep the row for audit, but flag
      // it so the UI doesn't re-pester to acknowledge / split.
      await db
        .update(statements)
        .set({
          status: 'failed',
          errorMessage: `superseded by ${parsed.length}-way split`,
          multiAccountAcknowledged: true,
          updatedAt: sql`now()`,
        })
        .where(eq(statements.id, id));

      // Create children (one per split). Each gets re-enqueued.
      const created: Array<{ id: string; accountId: string; pageRange: string }> = [];
      for (const split of parsed) {
        const [child] = await db
          .insert(statements)
          .values({
            accountId: split.accountId,
            sourcePdfHash: parent.sourcePdfHash,
            sourcePdfPath: parent.sourcePdfPath,
            sourcePdfPages: parent.sourcePdfPages,
            status: 'uploaded',
            pageRange: { start: split.pageStart, end: split.pageEnd },
          })
          .returning({ id: statements.id });
        if (!child) throw new Error('insert returned no row');
        created.push({
          id: child.id,
          accountId: split.accountId,
          pageRange: `[${split.pageStart},${split.pageEnd}]`,
        });
        if (process.env.REDIS_URL) {
          await enqueueExtraction({
            statementId: child.id,
            accountId: split.accountId,
            sourcePdfHash: parent.sourcePdfHash,
            sourcePdfPath: parent.sourcePdfPath,
          });
        }
      }

      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'statement',
        entityId: id,
        action: 'statement.split',
        payload: { children: created, splitCount: created.length },
      });
      res.json({ ok: true, children: created });
    } catch (err) {
      next(err);
    }
  });

  // Acknowledge a detected multi-account PDF: clears the warning so the
  // review page stops nagging. Phase 14.
  router.post('/:id/acknowledge-multi-account', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const rows = await db.select().from(statements).where(eq(statements.id, id));
      const stmt = rows[0];
      if (!stmt) throw new NotFoundError(`statement ${id}`);
      await db
        .update(statements)
        .set({ multiAccountAcknowledged: true, updatedAt: sql`now()` })
        .where(eq(statements.id, id));
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'statement',
        entityId: id,
        action: 'statement.acknowledge-multi-account',
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Confirm an ambiguous source date format. Marks the statement with
  // the user's choice and re-enqueues extraction so the LLM uses the
  // hint. Phase 18 item 6a/6b.
  router.post('/:id/confirm-date-format', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const format = String(req.body?.format ?? '');
      if (!['MDY', 'DMY', 'YMD'].includes(format)) {
        throw new ValidationError("format must be 'MDY' | 'DMY' | 'YMD'");
      }
      const rows = await db.select().from(statements).where(eq(statements.id, id));
      const stmt = rows[0];
      if (!stmt) throw new NotFoundError(`statement ${id}`);
      await db
        .update(statements)
        .set({
          sourceDateFormat: format as 'MDY' | 'DMY' | 'YMD',
          sourceDateFormatUserConfirmed: true,
          status: 'uploaded',
          errorMessage: null,
          updatedAt: sql`now()`,
        })
        .where(eq(statements.id, id));
      // Wipe prior transactions so the re-run isn't deduped against
      // the old (potentially mis-dated) FITIDs.
      await db.delete(transactions).where(eq(transactions.statementId, id));
      if (process.env.REDIS_URL) {
        await enqueueExtraction({
          statementId: id,
          accountId: stmt.accountId,
          sourcePdfHash: stmt.sourcePdfHash,
          sourcePdfPath: stmt.sourcePdfPath,
        });
      }
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'statement',
        entityId: id,
        action: 'statement.confirm-date-format',
        payload: { format },
      });
      res.json({ ok: true, format });
    } catch (err) {
      next(err);
    }
  });

  // Admin: re-enqueue extraction. Useful when the source PDF was
  // re-uploaded or the LLM provider changed. Idempotent at the queue
  // level by virtue of the (account_id, source_pdf_hash) job ID.
  router.post('/:id/re-extract', requireAdmin, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const rows = await db.select().from(statements).where(eq(statements.id, id));
      const stmt = rows[0];
      if (!stmt) throw new NotFoundError(`statement ${id}`);
      if (!process.env.REDIS_URL) {
        throw new ForbiddenError('REDIS_URL not configured — extraction queue unavailable');
      }
      // Wipe prior transactions so the new run isn't deduped against the
      // old FITIDs. Keep the source PDF.
      await db.delete(transactions).where(eq(transactions.statementId, id));
      await db
        .update(statements)
        .set({ status: 'uploaded', errorMessage: null, updatedAt: sql`now()` })
        .where(eq(statements.id, id));
      await enqueueExtraction({
        statementId: id,
        accountId: stmt.accountId,
        sourcePdfHash: stmt.sourcePdfHash,
        sourcePdfPath: stmt.sourcePdfPath,
      });
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'statement',
        entityId: id,
        action: 'statement.re-extract',
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Phase 15 #7: SSE progress stream. Browser opens this and receives a
  // status snapshot every 1.5s until the statement reaches a terminal
  // state (review / exported / failed / awaiting-locale-confirmation),
  // then closes. Cheaper than long-polling on the front-end while still
  // staying on the existing connection — no websocket plumbing needed.
  router.get('/:id/progress', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      res.flushHeaders?.();

      const TERMINAL = new Set(['review', 'exported', 'failed', 'awaiting-locale-confirmation']);
      // Bound the stream so a stuck statement doesn't have us polling
      // Postgres every 1.5s forever. 30 minutes is plenty for the
      // worst-case OCR + LLM extraction; clients reconnect after that.
      const MAX_DURATION_MS = 30 * 60_000;
      const startedAt = Date.now();
      let lastSerialized = '';
      let cancelled = false;
      req.on('close', () => {
        cancelled = true;
      });

      // Emit a heartbeat comment up front so proxies (Caddy, Nginx)
      // don't kill the connection before the first data event.
      res.write(`: heartbeat\n\n`);

      while (!cancelled && Date.now() - startedAt < MAX_DURATION_MS) {
        const rows = await db.select().from(statements).where(eq(statements.id, id));
        const row = rows[0];
        if (!row) {
          res.write(`event: error\ndata: ${JSON.stringify({ message: 'not found' })}\n\n`);
          break;
        }
        const snapshot = serializeBigint(row);
        const serialized = JSON.stringify(snapshot);
        if (serialized !== lastSerialized) {
          res.write(`data: ${serialized}\n\n`);
          lastSerialized = serialized;
        } else {
          // Same status snapshot — emit a comment-only heartbeat so
          // proxies don't kill the idle connection during slow phases.
          res.write(`: heartbeat\n\n`);
        }
        if (TERMINAL.has(row.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      if (Date.now() - startedAt >= MAX_DURATION_MS) {
        res.write(
          `event: timeout\ndata: ${JSON.stringify({ message: 'progress stream timed out — reconnect to resume' })}\n\n`,
        );
      }
      res.end();
    } catch (err) {
      next(err);
    }
  });

  // Phase 15 #17: cancel an in-flight extraction. Removes the job from
  // BullMQ; the worker checks for cancellation between phases. Marks
  // the statement as failed with a cancel-specific message.
  router.post('/:id/cancel', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const rows = await db.select().from(statements).where(eq(statements.id, id));
      const stmt = rows[0];
      if (!stmt) throw new NotFoundError(`statement ${id}`);
      if (stmt.status === 'review' || stmt.status === 'exported' || stmt.status === 'failed') {
        throw new ValidationError(`cannot cancel a ${stmt.status} statement`);
      }
      let removedFromQueue = false;
      if (process.env.REDIS_URL) {
        try {
          const job = await extractionQueue().getJob(`extract:${id}`);
          if (job) {
            await job.remove();
            removedFromQueue = true;
          }
        } catch {
          // job already finished or not present; falling through to
          // the DB-state mutation is still the right call.
        }
      }
      // Phase 15 #17: wipe any transactions the worker already inserted
      // before the cancel — leaving them around would surface as
      // "partial extraction" garbage tied to a failed statement and
      // confuse the review UI. Worker also polls statements.status at
      // each phase boundary to bail cooperatively (see worker code).
      await db.delete(transactions).where(eq(transactions.statementId, id));
      await db
        .update(statements)
        .set({
          status: 'failed',
          errorMessage: 'cancelled by operator',
          updatedAt: sql`now()`,
        })
        .where(eq(statements.id, id));
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'statement',
        entityId: id,
        action: 'statement.cancel',
        payload: { removedFromQueue },
      });
      res.json({ ok: true, removedFromQueue });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
