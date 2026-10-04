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

  it('rounds a non-integer amount_cents instead of rejecting (salvage)', () => {
    const r = ExtractionResult.parse({
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
    });
    expect(r.transactions[0]!.amount_cents).toBe(13); // rounded, not rejected
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

  it('accepts trntype: null (model declined to classify) and normalizes it to undefined', () => {
    // Regression: a real statement returned `trntype: null` for every row; the
    // old `.optional()` schema rejected explicit null. inferTrntype derives the
    // type downstream, so null/absent must parse, not fail.
    const out = ExtractionResult.parse({
      ...sampleNested,
      transactions: [
        {
          posted_date: '2026-03-03',
          description: 'TOAST DEP',
          amount_cents: 12_345,
          trntype: null,
          source_page: 1,
          confidence: 0.95,
        },
      ],
    });
    expect(out.transactions[0]?.trntype).toBeUndefined();
  });

  it('still accepts a valid trntype enum value', () => {
    const out = ExtractionResult.parse({
      ...sampleNested,
      transactions: [{ ...sampleNested.transactions[0], trntype: 'DEP' }],
    });
    expect(out.transactions[0]?.trntype).toBe('DEP');
  });

  describe('non-essential metadata never fails the statement (C10)', () => {
    const parseWith = (overrides: Record<string, unknown>) =>
      ExtractionResult.parse({ ...sampleNested, ...overrides });

    it('notes: null → absent; non-strings stringified; long notes clipped', () => {
      expect(parseWith({ notes: null }).notes).toBeUndefined();
      expect(parseWith({ notes: 42 }).notes).toBe('42');
      expect(parseWith({ notes: ['row 3 illegible', 'sum off'] }).notes).toBe(
        'row 3 illegible; sum off',
      );
      expect(parseWith({ notes: 'x'.repeat(2500) }).notes).toHaveLength(2000);
    });

    it('account: numeric masked_number → string; type_hint mapped case-insensitively', () => {
      const r = parseWith({ account: { masked_number: 1234, type_hint: 'checking' } });
      expect(r.account).toEqual({ masked_number: '1234', type_hint: 'CHECKING' });
      expect(parseWith({ account: { type_hint: 'credit_card' } }).account.type_hint).toBe(
        'CREDITCARD',
      );
      expect(parseWith({ account: { type_hint: 'Money Market' } }).account.type_hint).toBe(
        'MONEYMRKT',
      );
      expect(parseWith({ account: { type_hint: 'BANK' } }).account.type_hint).toBeNull();
      expect(parseWith({ account: { type_hint: 7 } }).account.type_hint).toBeNull();
    });

    it('account / institution given as a non-object → default {}', () => {
      const r = parseWith({ account: '****1234', institution: ['Acme'] });
      expect(r.account).toEqual({});
      expect(r.institution).toEqual({});
    });

    it('institution: numeric name / org hint → string; object → null', () => {
      const r = parseWith({ institution: { name: 1867, intu_org_hint: { x: 1 } } });
      expect(r.institution).toEqual({ name: '1867', intu_org_hint: null });
    });

    it('source_date_format evidence / sample: non-string → null', () => {
      const r = parseWith({
        source_date_format: { format: 'MDY', confidence: 0.9, sample: 20260305, evidence: {} },
      });
      expect(r.source_date_format.sample).toBeNull();
      expect(r.source_date_format.evidence).toBeNull();
    });
  });

  it('JSON Schema marks trntype nullable so the model may defer to inference', () => {
    expect(ExtractionJsonSchema.properties.transactions.items.properties.trntype.type).toContain(
      'null',
    );
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
