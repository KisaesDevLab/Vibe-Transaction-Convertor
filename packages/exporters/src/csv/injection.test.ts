// CSV formula-injection neutralization. description/payee/memo are OCR-derived
// from untrusted PDFs; a cell starting with =,+,-,@,tab,CR makes a spreadsheet
// evaluate it as a formula on open. We prefix those with a single quote — but
// never a genuine signed number (negative Amounts must stay numeric).

import { describe, expect, it } from 'vitest';

import { renderCsv } from './index.js';

describe('renderCsv — CSV formula-injection guard', () => {
  it('neutralizes a formula-leading payee and description, but not a negative amount', () => {
    const out = renderCsv('generic', [
      {
        postedDate: '2026-03-08',
        description: '=HYPERLINK("http://evil","click")',
        amountCents: -4250n, // -42.50 — must stay numeric
        payee: "=cmd|'/c calc'!A1",
      },
    ]);
    // Payee neutralized with a leading apostrophe.
    expect(out).toContain("'=cmd|");
    // Description neutralized (apostrophe-prefixed; quoted because it has a ").
    expect(out).toContain('"\'=HYPERLINK(');
    // The negative amount is a number, NOT prefixed.
    expect(out).toContain('-42.50');
    expect(out).not.toContain("'-42.50");
  });

  it('guards every dangerous leading character', () => {
    for (const lead of ['=', '+', '-', '@', '\t']) {
      const out = renderCsv('generic', [
        { postedDate: '2026-03-08', description: `${lead}DANGER`, amountCents: 100n },
      ]);
      // The cell should carry a leading apostrophe before the trigger char.
      expect(out).toContain(`'${lead}DANGER`);
    }
  });

  it('leaves ordinary text and plain numbers untouched', () => {
    const out = renderCsv('generic', [
      { postedDate: '2026-03-08', description: 'ACME PLUMBING', amountCents: 12_345n },
    ]);
    expect(out).toContain('ACME PLUMBING');
    expect(out).not.toContain("'ACME");
    expect(out).toContain('123.45');
    expect(out).not.toContain("'123.45");
  });

  it('neutralizes a formula-leading payee in the Xero Payee column too', () => {
    const out = renderCsv('xero', [
      {
        postedDate: '2026-03-08',
        description: 'CHECK 1021',
        amountCents: -5000n,
        payee: '@SUM(A1:A9)',
      },
    ]);
    expect(out).toContain("'@SUM(A1:A9)");
    expect(out).toContain('-50.00');
  });
});
