import { describe, expect, it } from 'vitest';
import { findSuspectRows, reconcileGoldenRule, repairPass } from './golden-rule.js';

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

  // BuildPlan Phase 16 #2 / #4a: verified ⇔ difference == 0 AND no
  // period-bounds violations.
  it('balance-perfect but period-violated is still a discrepancy', () => {
    const r = reconcileGoldenRule({
      openingBalanceCents: 100_000n,
      closingBalanceCents: 110_000n,
      transactions: [{ amountCents: 5_000n }, { amountCents: 5_000n }],
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      transactionDates: ['2026-03-15', '2026-04-01'], // one day after period end
    });
    expect(r.status).toBe('discrepancy');
    expect(r.deltaCents).toBe(0n);
    expect(r.periodBoundsViolations).toBe(1);
    expect(r.message).toBe('1 transaction(s) dated outside 2026-03-01..2026-03-31');
  });

  it('flags a row dated one day before the period start', () => {
    const r = reconcileGoldenRule({
      openingBalanceCents: 0n,
      closingBalanceCents: -500n,
      transactions: [{ amountCents: -500n }],
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      transactionDates: ['2026-02-28'],
    });
    expect(r.status).toBe('discrepancy');
    expect(r.periodBoundsViolations).toBe(1);
  });

  it('verified when balances tie and every row is inside the period (bounds inclusive)', () => {
    const r = reconcileGoldenRule({
      openingBalanceCents: 0n,
      closingBalanceCents: 300n,
      transactions: [{ amountCents: 100n }, { amountCents: 200n }],
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      transactionDates: ['2026-03-01', '2026-03-31'],
    });
    expect(r.status).toBe('verified');
    expect(r.periodBoundsViolations).toBe(0);
    expect(r.message).toBeUndefined();
  });

  it('keeps the balance message when both the balance and the period are off', () => {
    const r = reconcileGoldenRule({
      openingBalanceCents: 0n,
      closingBalanceCents: 301n,
      transactions: [{ amountCents: 300n }],
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      transactionDates: ['2026-04-02'],
    });
    expect(r.status).toBe('discrepancy');
    expect(r.deltaCents).toBe(1n);
    expect(r.periodBoundsViolations).toBe(1);
    expect(r.message).toMatch(/^discrepancy of 1 cents/);
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
    expect(result?.transactions).toHaveLength(2);
    expect(result?.transactions[1]?.amountCents).toBe(-50n);
    expect(result?.fixDescription).toBe('flip-sign on row 1 (B)');
  });

  it('refuses an ambiguous sign flip (two rows qualify)', () => {
    // Either +$125 check could be the mis-signed one — don't guess.
    const txs = [
      { amountCents: 12_500n, description: 'CHECK 101', postedDate: '2026-03-03' },
      { amountCents: 12_500n, description: 'CHECK 102', postedDate: '2026-03-09' },
    ];
    expect(repairPass(txs, -25_000n)).toBeNull();
  });

  it('drops the later copy of an exact duplicate row', () => {
    const txs = [
      { amountCents: 5n, description: 'COFFEE', postedDate: '2026-03-02' },
      { amountCents: 7n, description: 'ACME DEPOSIT', postedDate: '2026-03-04' },
      // OCR double-captured the same line (case/whitespace noise only).
      { amountCents: 7n, description: '  acme deposit ', postedDate: '2026-03-04' },
    ];
    // delta = -7 means we have an extra +7 row
    const result = repairPass(txs, -7n);
    expect(result).not.toBeNull();
    expect(result?.transactions).toHaveLength(2);
    expect(result?.transactions.map((t) => t.description)).toEqual(['COFFEE', 'ACME DEPOSIT']);
    expect(result?.fixDescription).toMatch(/^drop duplicate row 2 .*twin of row 1/);
  });

  it('never drops a row that has no exact twin (missing deposit ≠ phantom withdrawal)', () => {
    // Statement is short a +$500 deposit (delta +50000). The only -$500 row is
    // a legitimate transfer; dropping it would "verify" a wrong statement.
    const txs = [
      { amountCents: -50_000n, description: 'TRANSFER TO SAVINGS', postedDate: '2026-03-05' },
      { amountCents: -1_234n, description: 'GROCERY', postedDate: '2026-03-06' },
    ];
    expect(repairPass(txs, 50_000n)).toBeNull();
  });

  it('does not treat same-amount rows with different descriptions or dates as duplicates', () => {
    const differentDesc = [
      { amountCents: 7n, description: 'ACME DEPOSIT' },
      { amountCents: 7n, description: 'OTHER DEPOSIT' },
    ];
    expect(repairPass(differentDesc, -7n)).toBeNull();
    const differentDate = [
      { amountCents: 7n, description: 'ACME DEPOSIT', postedDate: '2026-03-04' },
      { amountCents: 7n, description: 'ACME DEPOSIT', postedDate: '2026-03-05' },
    ];
    expect(repairPass(differentDate, -7n)).toBeNull();
  });

  it('never drops a same-day same-merchant same-amount row whose running balance differs', () => {
    // Two real $7 coffees on the same day: the statement prints a distinct
    // running balance after each, so neither is an OCR double-capture. The
    // statement is short a +$7 refund (delta +7); dropping a coffee would
    // "verify" a wrong statement.
    const txs = [
      {
        amountCents: -7n,
        description: 'COFFEE',
        postedDate: '2026-03-04',
        runningBalanceCents: 993n,
      },
      {
        amountCents: -7n,
        description: 'COFFEE',
        postedDate: '2026-03-04',
        runningBalanceCents: 986n,
      },
    ];
    expect(repairPass(txs, 7n)).toBeNull();
  });

  it('still drops an exact twin that repeats the same running balance', () => {
    const txs = [
      {
        amountCents: -7n,
        description: 'COFFEE',
        postedDate: '2026-03-04',
        runningBalanceCents: 993n,
      },
      {
        amountCents: -7n,
        description: 'COFFEE',
        postedDate: '2026-03-04',
        runningBalanceCents: 993n,
      },
    ];
    const result = repairPass(txs, 7n);
    expect(result?.transactions).toHaveLength(1);
    expect(result?.fixDescription).toMatch(/^drop duplicate row 1 .*twin of row 0/);
  });

  it('ignores the running balance when only one of the twins carries it', () => {
    const txs = [
      {
        amountCents: -7n,
        description: 'COFFEE',
        postedDate: '2026-03-04',
        runningBalanceCents: 993n,
      },
      {
        amountCents: -7n,
        description: 'COFFEE',
        postedDate: '2026-03-04',
        runningBalanceCents: null,
      },
    ];
    expect(repairPass(txs, 7n)?.transactions).toHaveLength(1);
  });

  it('refuses to drop when two different duplicated lines share the amount', () => {
    const txs = [
      { amountCents: 7n, description: 'A', postedDate: '2026-03-04' },
      { amountCents: 7n, description: 'A', postedDate: '2026-03-04' },
      { amountCents: 7n, description: 'B', postedDate: '2026-03-05' },
      { amountCents: 7n, description: 'B', postedDate: '2026-03-05' },
    ];
    expect(repairPass(txs, -7n)).toBeNull();
  });

  it('refuses when a sign flip and a duplicate drop would both close the delta', () => {
    // delta -1000: flipping the lone +500 OR dropping the duplicated +1000
    // would each tie the balance — ambiguous.
    const txs = [
      { amountCents: 500n, description: 'REFUND' },
      { amountCents: 1_000n, description: 'DEP' },
      { amountCents: 1_000n, description: 'DEP' },
    ];
    expect(repairPass(txs, -1_000n)).toBeNull();
  });

  it('returns null when delta is zero', () => {
    expect(repairPass([{ amountCents: 5n }], 0n)).toBeNull();
  });

  it('returns null when no rule applies', () => {
    const txs = [{ amountCents: 5n }, { amountCents: 7n }];
    expect(repairPass(txs, 999n)).toBeNull();
  });
});

describe('findSuspectRows', () => {
  it('returns no suspects when running balances chain correctly', () => {
    const out = findSuspectRows(100_000n, [
      { amountCents: -5_000n, runningBalanceCents: 95_000n },
      { amountCents: 10_000n, runningBalanceCents: 105_000n },
      { amountCents: -1_000n, runningBalanceCents: 104_000n },
    ]);
    expect(out).toEqual([]);
  });

  it('flags exactly the row whose running balance is off', () => {
    const out = findSuspectRows(100_000n, [
      { amountCents: -5_000n, runningBalanceCents: 95_000n },
      { amountCents: 10_000n, runningBalanceCents: 105_007n }, // off by 7
      { amountCents: -1_000n, runningBalanceCents: 104_007n },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.index).toBe(1);
    expect(out[0]?.deltaCents).toBe(7n);
  });

  it('skips rows that omit running balance entirely', () => {
    const out = findSuspectRows(100_000n, [
      { amountCents: -5_000n },
      { amountCents: 10_000n, runningBalanceCents: 105_000n },
    ]);
    // First row has no running balance to check; second matches.
    expect(out).toEqual([]);
  });
});
