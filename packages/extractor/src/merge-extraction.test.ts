import { describe, expect, it } from 'vitest';

import { schemas } from '@vibe-tx-converter/shared';

import { mergeExtractionResults, type MergePart } from './merge-extraction.js';

type ExtractionResult = schemas.extraction.ExtractionResult;

const tx = (page: number, amount: number, desc = 'x') => ({
  posted_date: '2026-03-15',
  description: desc,
  amount_cents: amount,
  source_page: page,
  confidence: 1,
});

const part = (over: Partial<ExtractionResult>, startPage: number): MergePart => ({
  startPage,
  data: {
    account: {},
    institution: {},
    period: { start: '2026-03-01', end: '2026-03-31' },
    balances: { opening_cents: 0, closing_cents: 0 },
    transactions: [],
    source_date_format: { format: 'MDY', confidence: 0.5 },
    ...over,
  } as ExtractionResult,
});

describe('mergeExtractionResults', () => {
  it('returns the sole batch unchanged when there is one (startPage 1)', () => {
    const only = part({ transactions: [tx(1, 100)] }, 1);
    expect(mergeExtractionResults([only])).toBe(only.data);
  });

  it('concatenates transactions and lifts source_page to the global page', () => {
    const a = part({ transactions: [tx(1, 100), tx(2, 200)] }, 1); // pages 1-2
    const b = part({ transactions: [tx(1, 300)] }, 3); // batch-local page 1 == global page 3
    const merged = mergeExtractionResults([a, b]);
    expect(merged.transactions.map((t) => t.amount_cents)).toEqual([100, 200, 300]);
    expect(merged.transactions.map((t) => t.source_page)).toEqual([1, 2, 3]);
  });

  it('takes opening from the first batch and closing from the last', () => {
    const a = part({ balances: { opening_cents: 5000, closing_cents: 9999 } }, 1);
    const mid = part({ balances: { opening_cents: -1, closing_cents: -1 } }, 3);
    const b = part({ balances: { opening_cents: 1234, closing_cents: 7000 } }, 5);
    const merged = mergeExtractionResults([a, mid, b]);
    expect(merged.balances.opening_cents).toBe(5000);
    expect(merged.balances.closing_cents).toBe(7000);
  });

  it('spans the widest period and keeps the highest-confidence date format', () => {
    const a = part(
      {
        period: { start: '2026-03-05', end: '2026-03-20' },
        source_date_format: { format: 'MDY', confidence: 0.9 },
      },
      1,
    );
    const b = part(
      {
        period: { start: '2026-03-01', end: '2026-03-31' },
        source_date_format: { format: 'AMBIGUOUS', confidence: 0.2 },
      },
      3,
    );
    const merged = mergeExtractionResults([a, b]);
    expect(merged.period).toEqual({ start: '2026-03-01', end: '2026-03-31' });
    expect(merged.source_date_format.format).toBe('MDY');
  });

  it('picks the first batch that carries account/institution and joins notes', () => {
    const a = part({ account: {}, institution: {}, notes: 'first' }, 1);
    const b = part(
      {
        account: { masked_number: '5596', type_hint: 'CHECKING' },
        institution: { name: 'Generations Bank' },
        notes: 'second',
      },
      3,
    );
    const merged = mergeExtractionResults([a, b]);
    expect(merged.account.masked_number).toBe('5596');
    expect(merged.institution.name).toBe('Generations Bank');
    expect(merged.notes).toBe('first second');
  });
});
