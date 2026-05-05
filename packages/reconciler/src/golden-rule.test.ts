import { describe, expect, it } from 'vitest';
import { reconcileGoldenRule, repairPass } from './golden-rule.js';

describe('reconcileGoldenRule', () => {
  it('verified when balances tie', () => {
    const r = reconcileGoldenRule({
      openingBalanceCents: 100_000n,
      closingBalanceCents: 110_000n,
      transactions: [{ amountCents: 5_000n }, { amountCents: 5_000n }],
    });
    expect(r.status).toBe('verified');
    expect(r.deltaCents).toBe(0n);
  });

  it('discrepancy when balances do not tie', () => {
    const r = reconcileGoldenRule({
      openingBalanceCents: 100_000n,
      closingBalanceCents: 110_001n,
      transactions: [{ amountCents: 10_000n }],
    });
    expect(r.status).toBe('discrepancy');
    expect(r.deltaCents).toBe(1n);
  });

  it('counts period-bounds violations as defense in depth', () => {
    const r = reconcileGoldenRule({
      openingBalanceCents: 0n,
      closingBalanceCents: 0n,
      transactions: [],
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      transactionDates: ['2026-02-28', '2026-03-15', '2026-04-02'],
    });
    expect(r.periodBoundsViolations).toBe(2);
  });
});

describe('repairPass', () => {
  it('flips a single sign error', () => {
    const txs = [
      { amountCents: -100n, description: 'A' },
      { amountCents: 50n, description: 'B' },
    ];
    // expected closing = open + sum, but suppose B should have been -50
    // delta = closing - expected_using_+50 = -100, flipping +50 to -50 closes it
    const result = repairPass(txs, -100n);
    expect(result).not.toBeNull();
    expect(result?.transactions[1]?.amountCents).toBe(-50n);
  });

  it('drops a duplicate row', () => {
    const txs = [{ amountCents: 5n }, { amountCents: 7n }];
    // delta = -7 means we have an extra +7 row
    const result = repairPass(txs, -7n);
    expect(result?.transactions).toHaveLength(1);
    expect(result?.transactions[0]?.amountCents).toBe(5n);
  });

  it('returns null when no rule applies', () => {
    const txs = [{ amountCents: 5n }, { amountCents: 7n }];
    expect(repairPass(txs, 999n)).toBeNull();
  });
});
