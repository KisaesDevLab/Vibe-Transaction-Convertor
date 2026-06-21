import { describe, expect, it } from 'vitest';
import {
  detectMultiAccount,
  detectMultiAccountFromSlices,
  last4FromMasked,
  type AccountSlice,
} from './multi-account-detector.js';
import type { PageText } from './preprocess.js';

const page = (index: number, text: string): PageText => ({
  index,
  text,
  width: 612,
  height: 792,
  words: [],
});

describe('detectMultiAccount', () => {
  it('returns multiAccount=false for a single-account PDF', () => {
    const pages = [
      page(0, 'Acme Bank Statement Account number: 1234567890 Period 03/01-03/31'),
      page(1, 'Transactions continue here, balance summary at the bottom.'),
    ];
    const r = detectMultiAccount(pages);
    expect(r.multiAccount).toBe(false);
    expect(r.uniqueLast4).toEqual(['7890']);
    expect(r.splits).toEqual([{ last4: '7890', pageStart: 0, pageEnd: 1 }]);
  });

  it('detects two accounts and produces page-range splits', () => {
    const pages = [
      page(0, 'Acme Bank — Checking Account ending ••••1234'),
      page(1, 'continued checking transactions here'),
      page(2, 'Acme Bank — Savings Account ending ••••5678'),
      page(3, 'continued savings transactions here'),
    ];
    const r = detectMultiAccount(pages);
    expect(r.multiAccount).toBe(true);
    expect(r.uniqueLast4.sort()).toEqual(['1234', '5678']);
    expect(r.splits).toEqual([
      { last4: '1234', pageStart: 0, pageEnd: 1 },
      { last4: '5678', pageStart: 2, pageEnd: 3 },
    ]);
  });

  it('returns no splits when no account number pattern matches', () => {
    const pages = [page(0, 'no identifiable account info here')];
    const r = detectMultiAccount(pages);
    expect(r.multiAccount).toBe(false);
    expect(r.uniqueLast4).toEqual([]);
  });
});

describe('last4FromMasked', () => {
  it('extracts the trailing 4 digits from masked formats', () => {
    expect(last4FromMasked('****1234')).toBe('1234');
    expect(last4FromMasked('xxxx-5678')).toBe('5678');
    expect(last4FromMasked('1234567890')).toBe('7890');
  });
  it('returns null for missing or too-short inputs', () => {
    expect(last4FromMasked(null)).toBeNull();
    expect(last4FromMasked(undefined)).toBeNull();
    expect(last4FromMasked('***')).toBeNull();
    expect(last4FromMasked('no digits')).toBeNull();
  });
});

describe('detectMultiAccountFromSlices (OCR/vision path)', () => {
  const slice = (pageStart: number, pageEnd: number, last4: string | null): AccountSlice => ({
    pageStart,
    pageEnd,
    last4,
  });

  it('flags two distinct accounts across batch slices and builds page ranges', () => {
    const r = detectMultiAccountFromSlices([slice(0, 1, '1111'), slice(2, 3, '2222')], 4);
    expect(r.multiAccount).toBe(true);
    expect(r.uniqueLast4).toEqual(expect.arrayContaining(['1111', '2222']));
    expect(r.splits).toEqual([
      { last4: '1111', pageStart: 0, pageEnd: 1 },
      { last4: '2222', pageStart: 2, pageEnd: 3 },
    ]);
  });

  it('is single-account when every slice reads the same number', () => {
    const r = detectMultiAccountFromSlices([slice(0, 0, '1111'), slice(1, 2, '1111')], 3);
    expect(r.multiAccount).toBe(false);
    expect(r.splits).toEqual([{ last4: '1111', pageStart: 0, pageEnd: 2 }]);
  });

  it('forward-fills a batch that reported no account (continuation page)', () => {
    const r = detectMultiAccountFromSlices(
      [slice(0, 0, '1111'), slice(1, 1, null), slice(2, 2, '2222')],
      3,
    );
    expect(r.multiAccount).toBe(true);
    // The null middle page is attributed to the prior account (1111).
    expect(r.splits).toEqual([
      { last4: '1111', pageStart: 0, pageEnd: 1 },
      { last4: '2222', pageStart: 2, pageEnd: 2 },
    ]);
  });

  it('returns no multi-account when all slices lack a readable number', () => {
    const r = detectMultiAccountFromSlices([slice(0, 1, null), slice(2, 3, null)], 4);
    expect(r.multiAccount).toBe(false);
    expect(r.uniqueLast4).toEqual([]);
  });
});
