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

  it('regression (S4): one checking statement with a grouped number + a transfer reference', () => {
    const pages = [
      page(0, 'Account Number: 0012-3456-7890'),
      page(1, 'ONLINE TRANSFER TO SAV ACCT ENDING IN 5678'),
      page(2, 'Account ending in 7890'),
    ];
    const r = detectMultiAccount(pages);
    expect(r.multiAccount).toBe(false);
    expect(r.uniqueLast4).toEqual(['7890']); // last 4 of the WHOLE number, not "0012"
    expect(r.splits).toEqual([{ last4: '7890', pageStart: 0, pageEnd: 2 }]);
  });

  it('takes the last 4 digits of a space-grouped or masked number', () => {
    expect(
      detectMultiAccount([page(0, 'Account Number: 4147 2000 1234 5678')]).uniqueLast4,
    ).toEqual(['5678']);
    expect(detectMultiAccount([page(0, 'Acct # XXXX-XXXX-9012')]).uniqueLast4).toEqual(['9012']);
    expect(detectMultiAccount([page(0, 'Account number\n1234-5678')]).uniqueLast4).toEqual([
      '5678',
    ]);
  });

  it('ignores account references on transaction rows (leading date AND a money amount)', () => {
    const pages = [
      page(
        0,
        [
          'Checking Account ending in 1234',
          '03/15 BILL PAY COMCAST ACCT # 8155400 89.99 1,144.57',
          '| 03/16 | ACH DEBIT ACCOUNT NUMBER 55554444 | -45.00 | 1,099.57 |',
          '03/17 PAYEE ACCT 99887766 1234.56',
        ].join('\n'),
      ),
    ];
    const r = detectMultiAccount(pages);
    expect(r.multiAccount).toBe(false);
    expect(r.uniqueLast4).toEqual(['1234']);
  });

  it('ignores transfer descriptions (transfer / xfer / tfr / to acct / from acct)', () => {
    const pages = [
      page(
        0,
        [
          'Account ending in 1234',
          'ONLINE TRANSFER TO SAV ACCT ENDING IN 5678',
          'XFER ACCT 2222',
          'TFR FROM ACCOUNT ENDING 3333',
          '| Payment to acct ending 4321 | -45.00 |',
          'Deposit from sav acct 6666',
        ].join('\n'),
      ),
    ];
    const r = detectMultiAccount(pages);
    expect(r.multiAccount).toBe(false);
    expect(r.uniqueLast4).toEqual(['1234']);
  });

  it('counts a lone mid-page mention of another account (recall over precision)', () => {
    // A miss would hide the split option entirely; a false positive is only a
    // dismissible banner — so a single non-transfer, non-row hit counts.
    const filler = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\n');
    const pages = [
      page(0, `Account ending in 1234\n${filler}\nOverdraft protection: account ending 5678`),
      page(1, 'Account ending in 1234'),
    ];
    const r = detectMultiAccount(pages);
    expect(r.multiAccount).toBe(true);
    expect(r.uniqueLast4.sort()).toEqual(['1234', '5678']);
  });

  describe('multi-account layouts (each must be detected)', () => {
    const rows = (n: number): string =>
      Array.from(
        { length: n },
        (_, i) => `03/${String(i + 1).padStart(2, '0')} DEBIT CARD PURCHASE 10.00 1,${500 - i}.00`,
      ).join('\n');

    it('a second account whose section starts mid-page with one header line', () => {
      const pages = [
        page(0, `CHECKING\nAccount Number: 1111222233\n${rows(20)}`),
        page(1, `${rows(15)}\nSAVINGS\nAccount Number: 4444555566\n${rows(3)}`),
      ];
      const r = detectMultiAccount(pages);
      expect(r.multiAccount).toBe(true);
      expect(r.uniqueLast4.sort()).toEqual(['2233', '5566']);
    });

    it('a header line that also carries a balance', () => {
      const pages = [
        page(0, `Checking Account Number: 1111222233\n${rows(5)}`),
        page(1, `Savings Account Number: 4444555566 Beginning Balance $5,000.00\n${rows(5)}`),
      ];
      const r = detectMultiAccount(pages);
      expect(r.multiAccount).toBe(true);
      expect(r.splits).toEqual([
        { last4: '2233', pageStart: 0, pageEnd: 0 },
        { last4: '5566', pageStart: 1, pageEnd: 1 },
      ]);
    });

    it('a header line starting with the statement period (even with a balance)', () => {
      const pages = [
        page(0, `03/01/2024 - 03/31/2024 Account Number: 1111222233\n${rows(5)}`),
        page(
          1,
          `03/01/2024 to 03/31/2024 Account Number: 4444555566 Beginning Balance $5,000.00\n${rows(5)}`,
        ),
      ];
      const r = detectMultiAccount(pages);
      expect(r.multiAccount).toBe(true);
      expect(r.uniqueLast4.sort()).toEqual(['2233', '5566']);
    });

    it('a dash separator ("Account Number - 1111222233")', () => {
      const pages = [
        page(0, `Account Number - 1111222233\n${rows(5)}`),
        page(1, `Account Number – 4444555566\n${rows(5)}`),
      ];
      const r = detectMultiAccount(pages);
      expect(r.multiAccount).toBe(true);
      expect(r.uniqueLast4.sort()).toEqual(['2233', '5566']);
    });

    it('a footer-only number on a one-page account', () => {
      const pages = [
        page(0, `Checking Account Number: 1111222233\n${rows(20)}`),
        page(1, `continued checking\n${rows(20)}`),
        page(2, `SAVINGS STATEMENT\n${rows(20)}\nAccount Number: 4444555566   Page 1 of 1`),
      ];
      const r = detectMultiAccount(pages);
      expect(r.multiAccount).toBe(true);
      expect(r.splits).toEqual([
        { last4: '2233', pageStart: 0, pageEnd: 1 },
        { last4: '5566', pageStart: 2, pageEnd: 2 },
      ]);
    });

    it('two accounts on the same page', () => {
      const pages = [
        page(
          0,
          `Checking Account Number: 1111222233\n${rows(3)}\nSavings Account Number: 4444555566\n${rows(3)}`,
        ),
      ];
      const r = detectMultiAccount(pages);
      expect(r.multiAccount).toBe(true);
      expect(r.uniqueLast4.sort()).toEqual(['2233', '5566']);
    });
  });

  it('is word-bounded ("subaccount" is not an account label)', () => {
    const r = detectMultiAccount([page(0, 'Statement subaccount #5555 summary')]);
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
