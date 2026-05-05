import { describe, expect, it } from 'vitest';
import { ExtractionResult, ExtractionJsonSchema } from './extraction.js';

describe('ExtractionResult', () => {
  it('accepts a sample valid result', () => {
    const sample = {
      period_start: '2026-03-01',
      period_end: '2026-03-31',
      opening_balance_cents: 120_000,
      closing_balance_cents: 431_579,
      source_date_format: 'MDY' as const,
      source_date_format_confidence: 0.9,
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
    expect(() => ExtractionResult.parse(sample)).not.toThrow();
  });

  it('rejects malformed dates', () => {
    expect(() =>
      ExtractionResult.parse({
        period_start: '03/01/2026',
        period_end: '2026-03-31',
        opening_balance_cents: 0,
        closing_balance_cents: 0,
        source_date_format: 'MDY',
        source_date_format_confidence: 1,
        transactions: [],
      }),
    ).toThrow();
  });

  it('rejects non-integer amount_cents', () => {
    expect(() =>
      ExtractionResult.parse({
        period_start: '2026-03-01',
        period_end: '2026-03-31',
        opening_balance_cents: 0,
        closing_balance_cents: 0,
        source_date_format: 'MDY',
        source_date_format_confidence: 1,
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

  it('exposes a JSON Schema with the right top-level required fields', () => {
    expect(ExtractionJsonSchema.required).toContain('period_start');
    expect(ExtractionJsonSchema.required).toContain('period_end');
    expect(ExtractionJsonSchema.required).toContain('transactions');
    expect(ExtractionJsonSchema.properties.transactions.type).toBe('array');
  });
});
