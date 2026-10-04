import { describe, expect, it } from 'vitest';
import { assignSeqInDay, computeFitid } from './fitid.js';
import { getTrntypeReason, inferTrntype, normalizeDescription } from './trntype-rules.js';

describe('computeFitid', () => {
  it('produces a 20-char "VTC-" prefixed FITID', () => {
    const id = computeFitid({
      postedDate: '2026-03-05',
      amountCents: -450,
      description: 'STARBUCKS #1234',
      seqInDay: 0,
    });
    expect(id.startsWith('VTC-')).toBe(true);
    expect(id).toHaveLength(20);
  });

  it('is stable across sessions when derived from materialized cleartext (ADR-022 #4)', () => {
    // Same statement re-uploaded → Shield assigns DIFFERENT session tokens
    // for the same payee, but the materialized cleartext is identical, so
    // the FITID must match (idempotent re-import). The worker derives FITID
    // from the materialized cleartext for exactly this reason.
    const base = { postedDate: '2026-03-05', amountCents: -450, seqInDay: 0 } as const;
    expect(computeFitid({ ...base, description: 'STARBUCKS STORE 1234' })).toBe(
      computeFitid({ ...base, description: 'STARBUCKS STORE 1234' }),
    );
    // Deriving from session-scoped tokens (the pre-fix bug) is NOT stable:
    expect(computeFitid({ ...base, description: '<MERCHANT_1>' })).not.toBe(
      computeFitid({ ...base, description: '<MERCHANT_7>' }),
    );
  });

  it('is deterministic across calls with the same input', () => {
    const a = computeFitid({
      postedDate: '2026-03-05',
      amountCents: -450,
      description: 'X',
      seqInDay: 0,
    });
    const b = computeFitid({
      postedDate: '2026-03-05',
      amountCents: -450,
      description: 'X',
      seqInDay: 0,
    });
    expect(a).toBe(b);
  });

  it('disambiguates same-day same-amount via seqInDay', () => {
    const a = computeFitid({
      postedDate: '2026-03-05',
      amountCents: -450,
      description: 'STARBUCKS',
      seqInDay: 0,
    });
    const b = computeFitid({
      postedDate: '2026-03-05',
      amountCents: -450,
      description: 'STARBUCKS',
      seqInDay: 1,
    });
    expect(a).not.toBe(b);
  });

  it('description normalization strips merchant noise consistently', () => {
    expect(normalizeDescription('STARBUCKS #1234')).toBe('starbucks');
    expect(normalizeDescription('AMAZON*ABC123 PURCH')).toBe('amazon abc123 purch');
    const a = computeFitid({
      postedDate: '2026-03-05',
      amountCents: -450,
      description: 'STARBUCKS #1234',
      seqInDay: 0,
    });
    const b = computeFitid({
      postedDate: '2026-03-05',
      amountCents: -450,
      description: 'starbucks  #99999',
      seqInDay: 0,
    });
    expect(a).toBe(b);
  });
});

describe('assignSeqInDay', () => {
  it('assigns 0-based seq within each posted_date group', () => {
    const rows = [
      { postedDate: '2026-03-05', amountCents: -450, description: 'A', sourceLine: 1 },
      { postedDate: '2026-03-05', amountCents: -450, description: 'B', sourceLine: 2 },
      { postedDate: '2026-03-06', amountCents: -100, description: 'C', sourceLine: 3 },
    ];
    const out = assignSeqInDay(rows);
    expect(out[0]?.seqInDay).toBe(0);
    expect(out[1]?.seqInDay).toBe(1);
    expect(out[2]?.seqInDay).toBe(0);
  });

  it('preserves input order even when dates interleave (regression)', () => {
    const rows = [
      { postedDate: '2026-03-05', amountCents: -100, description: 'A', sourceLine: 0 },
      { postedDate: '2026-03-06', amountCents: -200, description: 'B', sourceLine: 1 },
      { postedDate: '2026-03-05', amountCents: -300, description: 'C', sourceLine: 2 },
      { postedDate: '2026-03-07', amountCents: -400, description: 'D', sourceLine: 3 },
      { postedDate: '2026-03-05', amountCents: -500, description: 'E', sourceLine: 4 },
    ];
    const out = assignSeqInDay(rows);
    // Output indices must align with input indices (worker depends on this).
    expect(out.map((r) => r.description)).toEqual(['A', 'B', 'C', 'D', 'E']);
    // Seq within each date follows source-line order.
    expect(out[0]?.seqInDay).toBe(0); // A on 2026-03-05 (sourceLine 0)
    expect(out[1]?.seqInDay).toBe(0); // B on 2026-03-06
    expect(out[2]?.seqInDay).toBe(1); // C on 2026-03-05 (sourceLine 2)
    expect(out[3]?.seqInDay).toBe(0); // D on 2026-03-07
    expect(out[4]?.seqInDay).toBe(2); // E on 2026-03-05 (sourceLine 4)
  });

  it('breaks sourceLine ties by amount, then description', () => {
    const rows = [
      { postedDate: '2026-03-05', amountCents: -200, description: 'B' },
      { postedDate: '2026-03-05', amountCents: -100, description: 'A' },
      { postedDate: '2026-03-05', amountCents: -100, description: 'B' },
    ];
    const out = assignSeqInDay(rows);
    // No sourceLine — ties break on amount asc (-200 first), then description asc.
    // Seq assigned by sorted order, mapped back to input order.
    expect(out[0]?.seqInDay).toBe(0); // -200 'B'
    expect(out[1]?.seqInDay).toBe(1); // -100 'A'
    expect(out[2]?.seqInDay).toBe(2); // -100 'B'
  });
});

describe('inferTrntype', () => {
  it('routes ATM withdrawals to ATM', () => {
    expect(inferTrntype({ description: 'ATM WITHDRAWAL #1234', amountCents: -6000n })).toBe('ATM');
  });
  it('routes Direct Deposit to DIRECTDEP', () => {
    expect(inferTrntype({ description: 'DIRECT DEPOSIT - PAYROLL', amountCents: 320_000n })).toBe(
      'DIRECTDEP',
    );
  });
  it('routes wire transfers to XFER', () => {
    expect(inferTrntype({ description: 'WIRE TRANSFER FROM 555', amountCents: 5_000n })).toBe(
      'XFER',
    );
  });
  it('falls back to LLM hint when no rule fires', () => {
    expect(
      inferTrntype({ description: 'OBSCURE PURCHASE', amountCents: -100n, llmHint: 'POS' }),
    ).toBe('POS');
  });
  it('falls back to sign for plain bank accounts', () => {
    expect(inferTrntype({ description: 'unknown', amountCents: -100n })).toBe('DEBIT');
    expect(inferTrntype({ description: 'unknown', amountCents: 100n })).toBe('CREDIT');
  });
  it('credit-card payment is PAYMENT (negative on a CC)', () => {
    expect(
      inferTrntype({
        description: 'PAYMENT - THANK YOU',
        amountCents: -50_000n,
        isCreditCard: true,
      }),
    ).toBe('PAYMENT');
  });
  it('credit-card positive amount is DEBIT (charge)', () => {
    expect(inferTrntype({ description: 'STARBUCKS', amountCents: 500n, isCreditCard: true })).toBe(
      'DEBIT',
    );
  });

  // Phase 17 #2 expanded rules.
  it('routes interest credit to INT', () => {
    expect(inferTrntype({ description: 'INTEREST CREDIT', amountCents: 412n })).toBe('INT');
    expect(inferTrntype({ description: 'INT EARNED', amountCents: 412n })).toBe('INT');
  });
  it('routes dividend to DIV', () => {
    expect(inferTrntype({ description: 'DIVIDEND PAYMENT', amountCents: 1_500n })).toBe('DIV');
    expect(inferTrntype({ description: 'DIV PAID', amountCents: 1_500n })).toBe('DIV');
  });
  it('routes NSF / overdraft fees to FEE', () => {
    expect(inferTrntype({ description: 'NSF FEE', amountCents: -3500n })).toBe('FEE');
    expect(inferTrntype({ description: 'OVERDRAFT FEE', amountCents: -3500n })).toBe('FEE');
  });
  it('routes maintenance / monthly fees to SRVCHG', () => {
    expect(inferTrntype({ description: 'MAINTENANCE FEE', amountCents: -1500n })).toBe('SRVCHG');
    expect(inferTrntype({ description: 'MONTHLY FEE', amountCents: -1500n })).toBe('SRVCHG');
  });
  it('routes payroll vendors to DIRECTDEP', () => {
    for (const vendor of ['ADP PAYROLL', 'PAYCHEX', 'GUSTO INC', 'SALARY DEPOSIT']) {
      expect(inferTrntype({ description: vendor, amountCents: 320_000n })).toBe('DIRECTDEP');
    }
  });
  it('routes BILL PAY / online payment to PAYMENT', () => {
    for (const desc of ['ONLINE PAYMENT', 'BILL PAY', 'WEB PAY', 'EPAY']) {
      expect(inferTrntype({ description: desc, amountCents: -10_000n })).toBe('PAYMENT');
    }
  });
  it('routes WIRE in/out to XFER', () => {
    expect(inferTrntype({ description: 'WIRE OUT TO ACME', amountCents: -100_000n })).toBe('XFER');
    expect(inferTrntype({ description: 'WIRE IN FROM CUSTOMER', amountCents: 100_000n })).toBe(
      'XFER',
    );
  });
  it('narrowed CASH rule does not match generic /cash/', () => {
    // "CASH BACK REWARD" should NOT route to CASH.
    expect(inferTrntype({ description: 'CASH BACK REWARD', amountCents: 500n })).not.toBe('CASH');
    // "CASH WITHDRAWAL" should.
    expect(inferTrntype({ description: 'CASH WITHDRAWAL', amountCents: -10_000n })).toBe('CASH');
  });
  it('checkNumber short-circuits to CHECK regardless of description', () => {
    expect(
      inferTrntype({
        description: 'BILL PAY',
        amountCents: -10_000n,
        checkNumber: '1234',
      }),
    ).toBe('CHECK');
  });

  // Word boundaries bind to EVERY alternative, not just the first and last.
  it('does not match rule keywords inside other words', () => {
    // 'adp' inside LEADPAGES / HEADPHONES, 'gusto' inside AUGUSTO'S.
    for (const desc of ['LEADPAGES.NET', 'HEADPHONES PLUS', "AUGUSTO'S PIZZA"]) {
      expect(getTrntypeReason({ description: desc, amountCents: -4_999n })).toBe(
        'sign-fallback:negative',
      );
    }
    // 'int paid' inside SPRINT PAID; 'interest' prefix of INTERESTING.
    expect(inferTrntype({ description: 'SPRINT PAID', amountCents: -8_000n })).toBe('DEBIT');
    expect(inferTrntype({ description: 'INTERESTING FINDS', amountCents: -2_500n })).toBe('DEBIT');
    // 'to acct' inside AUTO ACCT.
    expect(inferTrntype({ description: 'GEICO AUTO ACCT', amountCents: -12_000n })).toBe('DEBIT');
  });
  it('routes ATM W/D to ATM (normalization turns "/" into a space)', () => {
    expect(normalizeDescription('ATM W/D 0423')).toBe('atm w d 0423');
    expect(inferTrntype({ description: 'ATM W/D 0423', amountCents: -6_000n })).toBe('ATM');
  });
  it('keeps the common BILL PAYMENT / DIVIDENDS / SERVICE CHARGES forms', () => {
    expect(inferTrntype({ description: 'ONLINE BILL PAYMENT', amountCents: -10_000n })).toBe(
      'PAYMENT',
    );
    expect(inferTrntype({ description: 'DIVIDENDS EARNED', amountCents: 1_500n })).toBe('DIV');
    expect(inferTrntype({ description: 'SERVICE CHARGES', amountCents: -1_200n })).toBe('SRVCHG');
  });
  it('DIRECTDEP only for money in (holder perspective)', () => {
    // A business paying its own payroll is a debit, not a direct deposit.
    expect(inferTrntype({ description: 'GUSTO PAYROLL', amountCents: -250_000n })).toBe('DEBIT');
    expect(inferTrntype({ description: 'ADP WAGE PAY', amountCents: -250_000n })).toBe('DEBIT');
    // Credit cards store amounts inverted: a positive amount is a charge
    // (money out), a negative one is money in.
    expect(
      inferTrntype({ description: 'GUSTO PAYROLL', amountCents: 5_000n, isCreditCard: true }),
    ).toBe('DEBIT');
    expect(
      inferTrntype({ description: 'GUSTO PAYROLL', amountCents: -5_000n, isCreditCard: true }),
    ).toBe('DIRECTDEP');
  });
  it('plain DEPOSIT is money in only too', () => {
    // Skipped by the direct-deposit rule (money out) — must not fall through
    // to the plain-deposit rule and come out as a money-in DEP.
    expect(
      getTrntypeReason({ description: 'DIRECT DEPOSIT REVERSAL', amountCents: -320_000n }),
    ).toBe('sign-fallback:negative');
    expect(inferTrntype({ description: 'DEPOSIT RETURNED', amountCents: -50_000n })).toBe('DEBIT');
    expect(inferTrntype({ description: 'MOBILE DEPOSIT', amountCents: 50_000n })).toBe('DEP');
    expect(inferTrntype({ description: 'BRANCH DEPOSITS', amountCents: 50_000n })).toBe('DEP');
    // Credit card: a positive amount is a charge (money out), not a DEP.
    expect(inferTrntype({ description: 'DEPOSIT', amountCents: 5_000n, isCreditCard: true })).toBe(
      'DEBIT',
    );
  });
  // The word boundaries must not cost the plural / inflected / abbreviated
  // forms banks print.
  it.each([
    ['TRANSFERRED TO SAVINGS', 'XFER', -50_000n],
    ['ONLINE TRANSFERS', 'XFER', -50_000n],
    ['ONLINE BILL PAYMT', 'PAYMENT', -10_000n],
    ['BILL PAYMENTS', 'PAYMENT', -10_000n],
    ['ONLINE PAYMENTS', 'PAYMENT', -10_000n],
    ['OVERDRAFT FEES', 'FEE', -3_500n],
    ['CASH WITHDRAWALS', 'CASH', -10_000n],
    ['ATM WITHDRAWALS', 'ATM', -6_000n],
    ['POS PURCHASES', 'POS', -2_500n],
    ['ACH DEBITS', 'DIRECTDEBIT', -7_500n],
    ['DIRECT DEPOSITS', 'DIRECTDEP', 320_000n],
    ['MONTHLY FEES', 'SRVCHG', -1_500n],
  ] as const)('routes %j to %s', (description, expected, amountCents) => {
    expect(inferTrntype({ description, amountCents })).toBe(expected);
  });
});
