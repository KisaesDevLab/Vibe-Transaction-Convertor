import { describe, expect, it } from 'vitest';
import { ExtractionResult, ExtractionJsonSchema } from './extraction.js';

const sampleNested = {
  account: { masked_number: '1234', type_hint: 'CHECKING' },
  institution: { name: 'Acme Bank', intu_org_hint: null },
  period: { start: '2026-03-01', end: '2026-03-31' },
  balances: { opening_cents: 120_000, closing_cents: 431_579 },
  source_date_format: { format: 'MDY' as const, confidence: 0.9 },
  transactions: [
    {
      posted_date: '2026-03-03',
      description: 'ATM WITHDRAWAL #4123',
      amount_cents: -6_000,
      source_page: 1,
      confidence: 0.99,
    },
  ],
};

describe('ExtractionResult (nested)', () => {
  it('accepts a sample valid result', () => {
    expect(() => ExtractionResult.parse(sampleNested)).not.toThrow();
  });

  it('rejects malformed period dates', () => {
    expect(() =>
      ExtractionResult.parse({
        ...sampleNested,
        period: { start: '03/01/2026', end: '2026-03-31' },
      }),
    ).toThrow();
  });

  it('rejects non-integer amount_cents', () => {
    expect(() =>
      ExtractionResult.parse({
        ...sampleNested,
        transactions: [
          {
            posted_date: '2026-03-03',
            description: 'x',
            amount_cents: 12.5,
            source_page: 1,
            confidence: 1,
          },
        ],
      }),
    ).toThrow();
  });

  it('defaults account and institution to empty objects', () => {
    const out = ExtractionResult.parse({
      period: { start: '2026-03-01', end: '2026-03-31' },
      balances: { opening_cents: 0, closing_cents: 0 },
      source_date_format: { format: 'MDY', confidence: 1 },
      transactions: [],
    });
    expect(out.account).toEqual({});
    expect(out.institution).toEqual({});
  });

  it('exposes a JSON Schema with the right top-level required fields', () => {
    expect(ExtractionJsonSchema.required).toContain('period');
    expect(ExtractionJsonSchema.required).toContain('balances');
    expect(ExtractionJsonSchema.required).toContain('transactions');
    expect(ExtractionJsonSchema.required).toContain('source_date_format');
    expect(ExtractionJsonSchema.properties.transactions.type).toBe('array');
    expect(ExtractionJsonSchema.properties.period.type).toBe('object');
    expect(ExtractionJsonSchema.properties.balances.type).toBe('object');
  });
});
