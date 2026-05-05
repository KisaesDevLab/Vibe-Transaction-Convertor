import { describe, expect, it } from 'vitest';
import { assignSeqInDay, computeFitid } from './fitid.js';
import { inferTrntype, normalizeDescription } from './trntype-rules.js';

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
});
