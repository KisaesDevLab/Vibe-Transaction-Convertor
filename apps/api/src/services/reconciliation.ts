// Re-runs the Golden Rule against a statement's current persisted
// transactions and updates `statements.reconciliation_status`. Called
// from the PATCH/POST/DELETE transaction routes so manual corrections
// flip discrepancy → verified automatically (Phase 16 item 16). The
// 'overridden' state is sticky — it intentionally does NOT downgrade
// to 'verified' here, because the audit trail already captured the
// human acknowledgement and we don't want a subsequent edit to silently
// erase it.

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
  // Don't downgrade an explicit override.
  if (stmt.reconciliationStatus === 'overridden') return null;

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

  const nextStatus =
    result.status === 'verified'
      ? 'verified'
      : result.status === 'discrepancy'
        ? 'discrepancy'
        : 'failed';
  if (nextStatus !== stmt.reconciliationStatus) {
    await db
      .update(statements)
      .set({ reconciliationStatus: nextStatus, updatedAt: sql`now()` })
      .where(eq(statements.id, statementId));
  }
  return { status: nextStatus, deltaCents: result.deltaCents };
};
