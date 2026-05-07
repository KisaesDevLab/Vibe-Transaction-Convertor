// Phase 33 — Generic CSV with cleansed/category columns. QBO/Xero/etc.
// templates ignore the new fields so they aren't tested here.

import { describe, expect, it } from 'vitest';

import { renderCsv } from './index.js';

describe('renderCsv generic — Phase 33 enrichment columns', () => {
  it('always emits the two new columns in the header', () => {
    const out = renderCsv('generic', [
      { postedDate: '2026-03-08', description: 'PAYROLL', amountCents: 320_000n },
    ]);
    expect(out.split('\r\n')[0]).toBe(
      'Date,Description,Amount,RunningBalance,CheckNumber,TRNTYPE,FITID,CleansedDescription,Category',
    );
  });

  it('renders cleansed and category when set, blanks when null', () => {
    const out = renderCsv('generic', [
      {
        postedDate: '2026-03-08',
        description: 'POS DBT 0123 SQ *AMTHAUS',
        amountCents: -42_50n,
        cleansedDescription: 'Square — Amthaus',
        category: 'Software & Subscriptions',
      },
      {
        postedDate: '2026-03-09',
        description: 'OPAQUE LINE',
        amountCents: 100n,
        cleansedDescription: null,
        category: null,
      },
    ]);
    expect(out).toContain(
      '03/08/2026,POS DBT 0123 SQ *AMTHAUS,-42.50,,,,,Square — Amthaus,Software & Subscriptions',
    );
    // Note the trailing two empty cells for the null row.
    expect(out).toContain('03/09/2026,OPAQUE LINE,1.00,,,,,,');
  });

  it('quotes commas in cleansed and category cells', () => {
    const out = renderCsv('generic', [
      {
        postedDate: '2026-03-08',
        description: 'X',
        amountCents: 100n,
        cleansedDescription: 'Acme, Inc.',
        category: 'Meals & Entertainment',
      },
    ]);
    // 'Acme, Inc.' should be quoted; 'Meals & Entertainment' has no
    // comma so it stays bare.
    expect(out).toContain('"Acme, Inc."');
    expect(out).toContain('Meals & Entertainment');
  });
});
