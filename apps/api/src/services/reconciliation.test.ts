// recomputeReconciliation — persists the refreshed status AND the
// period-bounds count (Phase 16 #2 / #2b). Pure unit test against a tiny fake
// Db (select → rows, update → captured), so no Postgres is needed.

import { describe, expect, it } from 'vitest';

import type { Db } from '../db/client.js';
import { statements, transactions } from '../db/schema.js';
import type { Statement, Transaction } from '../db/types.js';
import { recomputeReconciliation } from './reconciliation.js';

const STMT_ID = '00000000-0000-0000-0000-0000000000aa';

const stmt = (over: Partial<Statement> = {}): Statement =>
  ({
    id: STMT_ID,
    periodStart: '2026-03-01',
    periodEnd: '2026-03-31',
    openingBalanceCents: 100_000n,
    closingBalanceCents: 110_000n,
    reconciliationStatus: 'verified',
    periodBoundsViolations: 0,
    ...over,
  }) as Statement;

const tx = (postedDate: string, amountCents: bigint): Transaction =>
  ({ postedDate, amountCents, runningBalanceCents: null }) as Transaction;

const fakeDb = (
  s: Statement,
  txs: Transaction[],
): { db: Db; updates: Array<Record<string, unknown>> } => {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = Promise.resolve(
            table === statements ? [s] : table === transactions ? txs : [],
          );
          return Object.assign(rows, { orderBy: () => rows });
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updates.push(values);
          return Promise.resolve();
        },
      }),
    }),
  } as unknown as Db;
  return { db, updates };
};

describe('recomputeReconciliation', () => {
  it('balance-perfect but an out-of-period row → discrepancy, count persisted', async () => {
    const { db, updates } = fakeDb(stmt(), [tx('2026-03-10', 5_000n), tx('2026-04-01', 5_000n)]);
    const result = await recomputeReconciliation(db, STMT_ID);
    expect(result).toEqual({ status: 'discrepancy', deltaCents: 0n });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      reconciliationStatus: 'discrepancy',
      periodBoundsViolations: 1,
    });
  });

  it('persists a changed count even when the status does not change', async () => {
    // Already a discrepancy with 1 violation; an edit moves a second row out.
    const { db, updates } = fakeDb(
      stmt({ reconciliationStatus: 'discrepancy', periodBoundsViolations: 1 }),
      [tx('2026-02-27', 5_000n), tx('2026-04-01', 5_000n)],
    );
    await recomputeReconciliation(db, STMT_ID);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      reconciliationStatus: 'discrepancy',
      periodBoundsViolations: 2,
    });
  });

  it('flips back to verified and clears the count once dates are fixed', async () => {
    const { db, updates } = fakeDb(
      stmt({ reconciliationStatus: 'discrepancy', periodBoundsViolations: 1 }),
      [tx('2026-03-10', 5_000n), tx('2026-03-31', 5_000n)],
    );
    expect(await recomputeReconciliation(db, STMT_ID)).toEqual({
      status: 'verified',
      deltaCents: 0n,
    });
    expect(updates[0]).toMatchObject({
      reconciliationStatus: 'verified',
      periodBoundsViolations: 0,
    });
  });

  it('skips the write when neither status nor count changed', async () => {
    const { db, updates } = fakeDb(stmt(), [tx('2026-03-10', 5_000n), tx('2026-03-11', 5_000n)]);
    await recomputeReconciliation(db, STMT_ID);
    expect(updates).toHaveLength(0);
  });

  it('never downgrades an overridden statement but refreshes its period-bounds count', async () => {
    const { db, updates } = fakeDb(stmt({ reconciliationStatus: 'overridden' }), [
      tx('2026-04-01', 1n),
    ]);
    expect(await recomputeReconciliation(db, STMT_ID)).toBeNull();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ periodBoundsViolations: 1 });
    expect(updates[0]).not.toHaveProperty('reconciliationStatus');
  });

  it('skips the write on an overridden statement whose count is unchanged', async () => {
    const { db, updates } = fakeDb(
      stmt({ reconciliationStatus: 'overridden', periodBoundsViolations: 1 }),
      [tx('2026-04-01', 1n)],
    );
    expect(await recomputeReconciliation(db, STMT_ID)).toBeNull();
    expect(updates).toHaveLength(0);
  });
});
