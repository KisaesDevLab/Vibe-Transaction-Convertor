import { describe, expect, it } from 'vitest';

import { analyzeDelta, firstChainBreak, type DiscrepancyTx } from './discrepancy';

const tx = (amountCents: bigint, extra: Partial<DiscrepancyTx> = {}): DiscrepancyTx => ({
  amountCents,
  description: 'X',
  postedDate: '2026-04-01',
  ...extra,
});

describe('analyzeDelta', () => {
  it('returns nothing when balanced', () => {
    expect(analyzeDelta(0n, [tx(100n)])).toEqual([]);
  });

  it('flags a single row whose amount equals the delta (missing/dup)', () => {
    const txs = [tx(1000n), tx(-250n, { description: 'ATM' })];
    const hints = analyzeDelta(-250n, txs);
    expect(hints.some((h) => h.kind === 'missing-or-dup' && h.rows[0] === 2)).toBe(true);
  });

  it('flags a sign flip (delta = 2× a row)', () => {
    // A −500 row read as +500 makes the net 1000 too high → delta = -1000.
    const txs = [tx(2000n), tx(500n, { description: 'FEE' })];
    const hints = analyzeDelta(-1000n, txs);
    expect(hints.some((h) => h.kind === 'sign-flip' && h.rows[0] === 2)).toBe(true);
  });

  it('flags a decimal misread (delta = 9× a row → read 10× too small)', () => {
    // True 1715.00 read as 171.50 (a=17150 cents) → short by 9× = 154350.
    const txs = [tx(17150n, { description: 'DEP' })];
    const hints = analyzeDelta(154350n, txs);
    expect(hints.some((h) => h.kind === 'decimal-shift' && h.rows[0] === 1)).toBe(true);
  });

  it('flags a two-row sum when no single row matches', () => {
    const txs = [tx(300n), tx(700n), tx(50n)];
    const hints = analyzeDelta(1000n, txs); // 300 + 700
    expect(
      hints.some((h) => h.kind === 'pair-sum' && h.rows.includes(1) && h.rows.includes(2)),
    ).toBe(true);
  });
});

describe('firstChainBreak', () => {
  it('returns the first row whose printed running balance diverges', () => {
    const txs = [
      tx(100n, { runningBalanceDeltaCents: 0n }),
      tx(-40n, { runningBalanceDeltaCents: 0n }),
      tx(25n, { runningBalanceDeltaCents: 500n, description: 'OFF' }),
      tx(10n, { runningBalanceDeltaCents: 500n }),
    ];
    expect(firstChainBreak(txs)).toMatchObject({ row: 3, deltaCents: 500n });
  });

  it('returns null when no running balances are present', () => {
    expect(firstChainBreak([tx(100n), tx(-40n)])).toBeNull();
  });

  it('returns null when the chain is intact', () => {
    expect(firstChainBreak([tx(100n, { runningBalanceDeltaCents: 0n })])).toBeNull();
  });
});
