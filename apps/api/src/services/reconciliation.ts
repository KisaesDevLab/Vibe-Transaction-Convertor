// Re-runs the Golden Rule against a statement's current persisted
// transactions and updates `statements.reconciliation_status` and
// `statements.period_bounds_violations`. Called from the PATCH/POST/DELETE
// transaction routes so manual corrections flip discrepancy → verified
// automatically (Phase 16 item 16) — `verified` requires both a tied
// balance and zero out-of-period rows (Phase 16 item 2). The
// 'overridden' state is sticky — it intentionally does NOT downgrade
// to 'verified' here, because the audit trail already captured the
// human acknowledgement and we don't want a subsequent edit to silently
// erase it. Its period-bounds count is still refreshed (a date edit
// changes it, and the statements list filters on it), and the function
// still returns null for it ("status not recomputed").

import { eq, sql } from 'drizzle-orm';

import { reconcileGoldenRule } from '@vibe-tx-converter/reconciler';

import type { Db } from '../db/client.js';
import { statements, transactions } from '../db/schema.js';

export const recomputeReconciliation = async (
  db: Db,
  statementId: string,
): Promise<{ status: string; deltaCents: bigint } | null> => {
  const stmtRows = await db.select().from(statements).where(eq(statements.id, statementId));
  const stmt = stmtRows[0];
  if (!stmt) return null;
  if (stmt.openingBalanceCents === null || stmt.closingBalanceCents === null) return null;

  const txs = await db
    .select()
    .from(transactions)
    .where(eq(transactions.statementId, statementId))
    .orderBy(transactions.postedDate, transactions.seqInDay);

  const result = reconcileGoldenRule({
    openingBalanceCents: stmt.openingBalanceCents,
    closingBalanceCents: stmt.closingBalanceCents,
    transactions: txs.map((t) => ({
      amountCents: t.amountCents,
      runningBalanceCents: t.runningBalanceCents,
    })),
    periodStart: stmt.periodStart,
    periodEnd: stmt.periodEnd,
    transactionDates: txs.map((t) => t.postedDate),
  });

  // Don't downgrade an explicit override — but keep its stored period-bounds
  // count current. Returns null (status not recomputed), as callers expect.
  if (stmt.reconciliationStatus === 'overridden') {
    if (result.periodBoundsViolations !== stmt.periodBoundsViolations) {
      await db
        .update(statements)
        .set({ periodBoundsViolations: result.periodBoundsViolations, updatedAt: sql`now()` })
        .where(eq(statements.id, statementId));
    }
    return null;
  }

  const nextStatus =
    result.status === 'verified'
      ? 'verified'
      : result.status === 'discrepancy'
        ? 'discrepancy'
        : 'failed';
  // Persist the refreshed period-bounds count alongside the status (Phase 16
  // #2b) — an edited posted_date can change the count without changing the
  // status, and the statements list filters on the stored count.
  if (
    nextStatus !== stmt.reconciliationStatus ||
    result.periodBoundsViolations !== stmt.periodBoundsViolations
  ) {
    await db
      .update(statements)
      .set({
        reconciliationStatus: nextStatus,
        periodBoundsViolations: result.periodBoundsViolations,
        updatedAt: sql`now()`,
      })
      .where(eq(statements.id, statementId));
  }
  return { status: nextStatus, deltaCents: result.deltaCents };
};
