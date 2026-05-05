import { describe, expect, it } from 'vitest';
import { detectMultiAccount } from './multi-account-detector.js';
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
