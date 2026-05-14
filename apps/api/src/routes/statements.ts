import { Router } from 'express';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { unlink } from 'node:fs/promises';

import { db } from '../db/client.js';
import { accounts, exportJobs, statements, transactions } from '../db/schema.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { deletePdfForStatement } from '../services/pdf-retention.js';
import { isPdfProcessingStrategy } from '../services/pdf-strategy.js';
import { logger } from '../lib/logger.js';
import { requireAdmin } from '../middleware/auth.js';
import { writeAudit } from '../services/audit.js';
import {
  CategoriesEmptyError,
  EnrichmentDisabledError,
  MonthlyCapReachedError,
  enrichStatement,
} from '../services/enrichment.js';
import {
  CheckResolveUnavailableError,
  NoCheckTransactionsError,
  resolveCheckPayees,
} from '../services/check-resolver.js';
import { overrideReconciliation } from '../services/exports.js';
import { recomputeReconciliation } from '../services/reconciliation.js';
import { computeFitid, inferTrntype, normalizeDescription } from '@vibe-tx-converter/exporters';
import { findSuspectRows } from '@vibe-tx-converter/reconciler';
import { businessCategories } from '../db/schema.js';
import { schemas } from '@vibe-tx-converter/shared';
const { ENRICHMENT_CLEANSED_MAX_LENGTH } = schemas.enrichment;
import { enqueueExtraction, removeExtractionJob } from '../jobs/queues.js';

const serializeBigint = <T extends Record<string, unknown>>(row: T): T => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'bigint' ? v.toString() : v;
  }
  return out as T;
};

// Re-extract accepts an optional `strategy` body field. 'default' (or
// the literal string 'null'/'') maps to a NULL override so the worker
// falls through to the firm-wide default; a recognised enum value
// updates the override; anything else is rejected so the operator
// notices the typo. Pulled out of the route handler so the parsing is
// testable on its own.
type ResolvedReExtractStrategy =
  | 'auto'
  | 'force-text'
  | 'force-ocr'
  | 'auto-ocr-fallback'
  | 'auto-text-fallback'
  | null;
type StrategyParseResult = { ok: true; value: ResolvedReExtractStrategy } | { ok: false };
const normaliseStrategy = (raw: unknown): StrategyParseResult => {
  if (typeof raw !== 'string') return { ok: false };
  if (raw === 'default' || raw === 'null' || raw === '') return { ok: true, value: null };
  if (isPdfProcessingStrategy(raw)) return { ok: true, value: raw };
  return { ok: false };
};

export const statementsRouter = (): Router => {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const accountId = req.query.accountId ? String(req.query.accountId) : undefined;
      const companyId = req.query.companyId ? String(req.query.companyId) : undefined;
      // accountId is the narrower filter, so when both are present we
      // honour accountId and skip the company join — same row set, less
      // work. companyId requires a join through `accounts` since
      // statements has no direct company FK.
      if (accountId) {
        const rows = await db
          .select()
          .from(statements)
          .where(eq(statements.accountId, accountId))
          .orderBy(statements.createdAt);
        res.json(rows.map((r) => serializeBigint(r)));
        return;
      }
      if (companyId) {
        const joined = await db
          .select({ stmt: statements })
          .from(statements)
          .innerJoin(accounts, eq(accounts.id, statements.accountId))
          .where(eq(accounts.companyId, companyId))
          .orderBy(statements.createdAt);
        res.json(joined.map((r) => serializeBigint(r.stmt)));
        return;
      }
      const rows = await db.select().from(statements).orderBy(statements.createdAt);
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

      // Phase 18 #25: per-row running-balance suspects. Only meaningful
      // when the statement actually printed running balances (otherwise
      // findSuspectRows returns []), so the UI just hides the badges.
      const suspectByTxId: Record<string, string> = {};
      if (stmt.openingBalanceCents !== null) {
        const suspects = findSuspectRows(
          stmt.openingBalanceCents,
          txs.map((t) => ({
            amountCents: t.amountCents,
            runningBalanceCents: t.runningBalanceCents,
          })),
        );
        for (const s of suspects) {
          const tx = txs[s.index];
          if (tx) suspectByTxId[tx.id] = s.deltaCents.toString();
        }
      }

      // Phase 33 — resolve business_category_id → name in a single
      // batch fetch so the review grid can render the cell without a
      // second round-trip per row. Archived categories still resolve so
      // historical assignments stay visible.
      const categoryIds = [
        ...new Set(
          txs.map((t) => t.businessCategoryId).filter((v): v is string => typeof v === 'string'),
        ),
      ];
      const categoryRows =
        categoryIds.length > 0
          ? await db
              .select({ id: businessCategories.id, name: businessCategories.name })
              .from(businessCategories)
              .where(inArray(businessCategories.id, categoryIds))
          : [];
      const categoryNameById = new Map(categoryRows.map((r) => [r.id, r.name]));

      res.json({
        statement: serializeBigint(stmt),
        transactions: txs.map((t) => ({
          ...serializeBigint(t),
          businessCategoryName: t.businessCategoryId
            ? (categoryNameById.get(t.businessCategoryId) ?? null)
            : null,
          // null when the row reconciles cleanly; otherwise the cents
          // delta against the running balance the LLM wrote.
          runningBalanceDeltaCents: suspectByTxId[t.id] ?? null,
        })),
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
        // Phase 33 — operator overrides for the LLM enrichment fields.
        // Either set to a non-null value flips enrichmentUserEdited so a
        // subsequent batch enrich() doesn't clobber the manual choice.
        cleansedDescription?: string | null;
        businessCategoryId?: string | null;
        enrichmentUserEdited?: boolean;
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
      // cleansed_description: string | null. Empty string ('') is treated
      // as "clear it"; any other string trims and truncates to the schema
      // max so an over-eager UI can't paste a 4KB blurb in.
      if ('cleansed_description' in body) {
        const raw = body.cleansed_description;
        if (raw === null) {
          if (tx.cleansedDescription !== null) next.cleansedDescription = null;
        } else if (typeof raw === 'string') {
          const trimmed = raw.trim().slice(0, ENRICHMENT_CLEANSED_MAX_LENGTH);
          const newVal = trimmed.length === 0 ? null : trimmed;
          if (newVal !== tx.cleansedDescription) next.cleansedDescription = newVal;
        } else {
          throw new ValidationError('cleansed_description must be a string or null');
        }
      }
      if ('business_category_id' in body) {
        const raw = body.business_category_id;
        if (raw === null) {
          if (tx.businessCategoryId !== null) next.businessCategoryId = null;
        } else if (typeof raw === 'string') {
          // Validate the FK before letting the DB throw a constraint
          // error — clearer message + we can confirm the category isn't
          // archived (the picker hides those, but a stale tab might
          // submit one anyway).
          const catRows = await db
            .select()
            .from(businessCategories)
            .where(eq(businessCategories.id, raw));
          const cat = catRows[0];
          if (!cat) throw new ValidationError(`business_category_id not found: ${raw}`);
          if (cat.archived) {
            throw new ValidationError(`business_category_id is archived: ${cat.name}`);
          }
          if (raw !== tx.businessCategoryId) next.businessCategoryId = raw;
        } else {
          throw new ValidationError('business_category_id must be a uuid string or null');
        }
      }
      // Either enrichment-field change marks the row as user-edited so
      // a later "Cleanse"/"Assign categories" click skips it.
      if (next.cleansedDescription !== undefined || next.businessCategoryId !== undefined) {
        next.enrichmentUserEdited = true;
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

  // Phase 18 #15: bulk PATCH. Reviewers commonly fix 5–20 rows at once
  // (TRNTYPE re-mapping, date corrections after locale confirm). Looping
  // per-row through PATCH /transactions/:id costs N round trips; this
  // does it in one. Recomputes reconciliation once at the end.
  // Body shape: { edits: [{ id, patch: { description?, amount_cents?, trntype?, posted_date? } }] }
  router.patch('/:id/transactions', async (req, res, next) => {
    try {
      const statementId = String(req.params.id);
      const body = req.body ?? {};
      const edits = Array.isArray(body.edits) ? body.edits : null;
      if (!edits || edits.length === 0) {
        throw new ValidationError('edits[] is required and must be non-empty');
      }
      if (edits.length > 500) {
        throw new ValidationError('bulk PATCH accepts at most 500 edits at a time');
      }
      // Load all referenced rows up-front so we can validate and short-
      // circuit no-ops without a round trip per row.
      const ids = edits.map((e: unknown) => String((e as { id?: string }).id ?? ''));
      if (ids.some((id: string) => id.length === 0)) {
        throw new ValidationError('every edit needs an id');
      }
      const existing = await db
        .select()
        .from(transactions)
        .where(eq(transactions.statementId, statementId));
      const byId = new Map(existing.map((t) => [t.id, t]));

      const results: Array<{ id: string; status: 'updated' | 'noop' | 'not-found' }> = [];
      let anyChanged = false;

      for (const edit of edits) {
        const id = String((edit as { id?: string }).id ?? '');
        const patchInput = (edit as { patch?: Record<string, unknown> }).patch ?? {};
        const tx = byId.get(id);
        if (!tx) {
          results.push({ id, status: 'not-found' });
          continue;
        }
        const next: {
          description?: string;
          normalizedDescription?: string;
          amountCents?: bigint;
          trntype?: string;
          postedDate?: string;
        } = {};
        if (typeof patchInput.description === 'string') {
          const d = patchInput.description.trim();
          if (d !== tx.description) {
            next.description = d;
            next.normalizedDescription = normalizeDescription(d);
          }
        }
        if (
          typeof patchInput.amount_cents === 'number' ||
          typeof patchInput.amount_cents === 'string'
        ) {
          const amt = BigInt(patchInput.amount_cents as string | number);
          if (amt === 0n) {
            throw new ValidationError(`amount must be non-zero (row ${id})`);
          }
          if (amt !== tx.amountCents) next.amountCents = amt;
        }
        if (typeof patchInput.trntype === 'string' && patchInput.trntype !== tx.trntype) {
          next.trntype = patchInput.trntype;
        }
        if (typeof patchInput.posted_date === 'string') {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(patchInput.posted_date)) {
            throw new ValidationError(`posted_date must be YYYY-MM-DD (row ${id})`);
          }
          if (patchInput.posted_date !== tx.postedDate) next.postedDate = patchInput.posted_date;
        }
        if (Object.keys(next).length === 0) {
          results.push({ id, status: 'noop' });
          continue;
        }
        const updateSet: Record<string, unknown> = {
          userEdited: true,
          updatedAt: sql`now()`,
          ...next,
        };
        const recomputeFitid =
          next.description !== undefined ||
          next.amountCents !== undefined ||
          next.postedDate !== undefined;
        if (recomputeFitid) {
          updateSet.fitid = computeFitid({
            postedDate: next.postedDate ?? tx.postedDate,
            amountCents: next.amountCents ?? tx.amountCents,
            description: next.description ?? tx.description,
            seqInDay: tx.seqInDay,
          });
        }
        await db.update(transactions).set(updateSet).where(eq(transactions.id, id));
        await writeAudit(db, {
          actorUserId: req.user!.id,
          entityType: 'transaction',
          entityId: id,
          action: 'transaction.update',
          payload: {
            ...next,
            amountCents: next.amountCents?.toString(),
            bulk: true,
          } as Record<string, unknown>,
        });
        results.push({ id, status: 'updated' });
        anyChanged = true;
      }

      if (anyChanged) await recomputeReconciliation(db, statementId);
      res.json({ results });
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

      // Remove any in-flight extraction for the parent up front so the
      // worker bails at the next phase boundary instead of charging
      // through and re-flipping the parent to `review` post-split. The
      // worker's checkCancelled detects any `failed` status and bails.
      try {
        await removeExtractionJob(id);
      } catch (err) {
        logger.warn({ err, stmtId: id }, 'failed to remove parent extraction job during split');
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
            // Inherit the parent's processing strategy. If the operator
            // picked force-ocr at upload because they knew the scan was
            // multi-account, the children need the same decision —
            // otherwise they fall back to firm default and re-detect.
            processingStrategyOverride: parent.processingStrategyOverride,
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

  // Phase 33 — operator-triggered LLM enrichment. Runs the cleansing
  // and/or business-category-assignment steps over every transaction in
  // the statement. Both transforms can be requested in the same call;
  // each requires its own admin toggle to be on. User-edited rows are
  // skipped so a click never overwrites manual review work.
  router.post('/:id/enrich', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const body = req.body ?? {};
      const cleanse = body.cleanse === true;
      const categorize = body.categorize === true;
      if (!cleanse && !categorize) {
        throw new ValidationError('at least one of cleanse / categorize must be true');
      }
      const stmtRows = await db.select().from(statements).where(eq(statements.id, id));
      if (!stmtRows[0]) throw new NotFoundError(`statement ${id}`);
      try {
        const result = await enrichStatement(db, id, {
          cleanse,
          categorize,
          actorUserId: req.user!.id,
        });
        res.json({
          ...result,
          costMicros: result.costMicros.toString(),
        });
      } catch (err) {
        if (err instanceof EnrichmentDisabledError) {
          throw new ForbiddenError(err.message);
        }
        if (err instanceof CategoriesEmptyError) {
          throw new ValidationError(err.message);
        }
        if (err instanceof MonthlyCapReachedError) {
          throw new ForbiddenError(err.message);
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  // Operator-triggered "resolve check payees" pass. Rasterizes the
  // source PDF pages and asks an Anthropic vision model to read any
  // cancelled-check images, matching each to a transaction by
  // check_number and writing a friendlier `cleansedDescription`
  // ("Check #1234 → JOHN DOE"). Requires the Anthropic provider —
  // the local Qwen3-8B can't see images. Audit row records the model
  // used and the per-call cost.
  router.post('/:id/resolve-check-payees', requireAdmin, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      try {
        const result = await resolveCheckPayees(db, id);
        await writeAudit(db, {
          actorUserId: req.user!.id,
          entityType: 'statement',
          entityId: id,
          action: 'statement.resolve-check-payees',
          payload: {
            txCount: result.txCount,
            candidateCount: result.candidateCount,
            llmExtractedCount: result.llmExtractedCount,
            matchedCount: result.matchedCount,
            unmatchedCheckNumbers: result.unmatchedCheckNumbers,
            pageCount: result.pageCount,
            costMicros: result.costMicros.toString(),
            model: result.model,
          },
        });
        res.json({ ...result, costMicros: result.costMicros.toString() });
      } catch (err) {
        if (err instanceof CheckResolveUnavailableError) {
          throw new ForbiddenError(err.message);
        }
        if (err instanceof NoCheckTransactionsError) {
          throw new ValidationError(err.message);
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  // Admin: re-enqueue extraction. Useful when the source PDF was
  // re-uploaded or the LLM provider changed. Idempotent at the queue
  // level by virtue of the (account_id, source_pdf_hash) job ID.
  //
  // Optional body: { strategy?: PdfProcessingStrategy | 'default' }
  //   - omitted / 'default' → keep the statement's existing processing
  //     strategy override (or NULL → firm default).
  //   - one of the enum values → update the override on this statement
  //     before re-enqueueing so the worker uses the chosen strategy.
  router.post('/:id/re-extract', requireAdmin, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const rows = await db.select().from(statements).where(eq(statements.id, id));
      const stmt = rows[0];
      if (!stmt) throw new NotFoundError(`statement ${id}`);
      if (stmt.sourcePdfDeleted) {
        throw new ValidationError(
          'source PDF has been removed for this statement — re-upload to enable re-extraction',
        );
      }
      if (!process.env.REDIS_URL) {
        throw new ForbiddenError('REDIS_URL not configured — extraction queue unavailable');
      }
      // Parse the optional strategy override. 'default' (or absent)
      // means "leave the override column alone"; an explicit value
      // means update it so the worker reads the new strategy.
      const requestedStrategy = (req.body as { strategy?: unknown } | undefined)?.strategy;
      let strategyUpdate: { processingStrategyOverride: ResolvedReExtractStrategy } | null = null;
      if (requestedStrategy !== undefined && requestedStrategy !== null) {
        const parsed = normaliseStrategy(requestedStrategy);
        if (!parsed.ok) {
          throw new ValidationError(
            'strategy must be one of: default, auto, force-text, force-ocr, auto-ocr-fallback, auto-text-fallback',
          );
        }
        strategyUpdate = { processingStrategyOverride: parsed.value };
      }
      // Wipe prior transactions so the new run isn't deduped against the
      // old FITIDs. Keep the source PDF.
      await db.delete(transactions).where(eq(transactions.statementId, id));
      await db
        .update(statements)
        .set({
          status: 'uploaded',
          errorMessage: null,
          updatedAt: sql`now()`,
          ...(strategyUpdate ?? {}),
        })
        .where(eq(statements.id, id));
      // BullMQ's add() is idempotent on jobId; the prior completed job
      // would silently swallow this enqueue. Remove first.
      await removeExtractionJob(id);
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
        ...(strategyUpdate
          ? {
              payload: {
                processingStrategyOverride: strategyUpdate.processingStrategyOverride,
                previousOverride: stmt.processingStrategyOverride ?? null,
              },
            }
          : {}),
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
          removedFromQueue = await removeExtractionJob(id);
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

  // Admin: delete a stuck statement so the operator can re-upload the
  // same PDF cleanly. Allowed at any point in the statement lifecycle:
  // in-flight worker activity bails cooperatively at the next phase
  // boundary (the worker's checkCancelled treats a missing statement
  // row as a cancellation signal), the queued BullMQ job is removed
  // up front, and any partial transactions/export rows cascade off
  // the statement row delete.
  //
  // Cascade: transactions and export_jobs FK with ON DELETE CASCADE
  // (schema.ts), so the statements row delete drops both. audit_log
  // has no FK (entity_id is plain text per ADR-013) so the trail
  // survives — including the delete row this route writes.
  //
  // Disk: rendered export files are unlinked best-effort before the row
  // delete (the FK cascade only drops DB rows, not files). The source
  // Admin: delete just the source PDF and keep the statement +
  // transactions. Used when the firm wants to free disk / satisfy a
  // retention policy without losing the extracted data. Cascades the
  // sourcePdfDeleted flag to every sibling statement sharing the same
  // hash so the UI on those rows shows "PDF gone" instead of pointing
  // at a missing file. Idempotent: a second call on an already-
  // deleted PDF is a no-op (returns fileRemoved=false).
  router.post('/:id/delete-pdf', requireAdmin, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const rows = await db.select().from(statements).where(eq(statements.id, id));
      const stmt = rows[0];
      if (!stmt) throw new NotFoundError(`statement ${id}`);
      const result = await deletePdfForStatement(db, id, stmt);
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'statement',
        entityId: id,
        action: 'statement.delete-pdf',
        payload: {
          sourcePdfHash: stmt.sourcePdfHash,
          fileRemoved: result.fileRemoved,
          cascadedSiblings: result.cascadedSiblings,
          alreadyDeleted: stmt.sourcePdfDeleted,
        },
      });
      res.json({ ok: true, ...result, alreadyDeleted: stmt.sourcePdfDeleted });
    } catch (err) {
      next(err);
    }
  });

  // PDF is unlinked only if no other statement still references the
  // same content hash (hash is shared across re-uploads to multiple
  // accounts and across split children).
  router.delete('/:id', requireAdmin, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const rows = await db.select().from(statements).where(eq(statements.id, id));
      const stmt = rows[0];
      if (!stmt) throw new NotFoundError(`statement ${id}`);

      const txCountRows = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(transactions)
        .where(eq(transactions.statementId, id));
      const txCount = txCountRows[0]?.c ?? 0;

      const jobs = await db
        .select({ id: exportJobs.id, filePath: exportJobs.filePath })
        .from(exportJobs)
        .where(eq(exportJobs.statementId, id));
      let exportFilesRemoved = 0;
      for (const j of jobs) {
        if (j.filePath === '<pending>' || j.filePath === '<expired>') continue;
        try {
          await unlink(j.filePath);
          exportFilesRemoved += 1;
        } catch {
          // Already gone — fine. The DB row is dropped by cascade.
        }
      }

      // Also remove any stale BullMQ job key for this statement so a
      // future statement that happens to be assigned the same UUID
      // (extraordinarily unlikely, but) doesn't collide on the
      // jobId-idempotency check.
      try {
        await removeExtractionJob(id);
      } catch (err) {
        logger.warn({ err, stmtId: id }, 'failed to remove queued extraction job during delete');
      }

      await db.delete(statements).where(eq(statements.id, id));

      // Source PDF: always unlink the file (unless it's already gone, or
      // already marked deleted on this row). Different statements can
      // share the same source_pdf_hash via dedupe / split children — we
      // cascade the source_pdf_deleted flag onto those siblings so they
      // surface as "PDF gone" in the UI rather than carrying a stale
      // path to a missing file.
      let sourcePdfRemoved = false;
      if (!stmt.sourcePdfDeleted) {
        try {
          await unlink(stmt.sourcePdfPath);
          sourcePdfRemoved = true;
        } catch {
          // Already gone or missing — non-fatal.
        }
      }
      const cascadedRows = await db
        .update(statements)
        .set({ sourcePdfDeleted: true, updatedAt: sql`now()` })
        .where(
          and(
            eq(statements.sourcePdfHash, stmt.sourcePdfHash),
            ne(statements.id, id),
            eq(statements.sourcePdfDeleted, false),
          ),
        )
        .returning({ id: statements.id });
      const cascadedSiblings = cascadedRows.length;

      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'statement',
        entityId: id,
        action: 'statement.delete',
        payload: {
          accountId: stmt.accountId,
          previousStatus: stmt.status,
          sourcePdfHash: stmt.sourcePdfHash,
          txCount,
          exportFilesRemoved,
          sourcePdfRemoved,
          cascadedSiblings,
        },
      });

      res.json({ ok: true, txCount, exportFilesRemoved, sourcePdfRemoved, cascadedSiblings });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
