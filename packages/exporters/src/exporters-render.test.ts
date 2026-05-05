import { describe, expect, it } from 'vitest';
import { renderOfxXml } from './ofx/xml-writer.js';
import { renderQbo, renderQfx } from './ofx/sgml-writer.js';
import { renderCsv } from './csv/index.js';
import type { Stmt } from './ofx/ast.js';

const STMT: Stmt = {
  bankAccountInfo: {
    bankId: '121000248',
    accountId: '1234567890',
    accountType: 'CHECKING',
    intuBid: '3000',
    intuOrg: 'Wells Fargo',
  },
  transactions: [
    {
      trntype: 'DIRECTDEP',
      postedDate: '2026-03-08',
      amountCents: 320_000n,
      fitid: 'VTC-abc1234567890def',
      name: 'PAYROLL DEPOSIT',
    },
    {
      trntype: 'POS',
      postedDate: '2026-03-12',
      amountCents: -7_421n,
      fitid: 'VTC-zzz1234567890def',
      name: 'GROCERY STORE',
      memo: 'pickup',
    },
  ],
  ledgerBalanceCents: 412_579n,
  startDate: '2026-03-01',
  endDate: '2026-03-31',
  asOf: new Date(Date.UTC(2026, 3, 1, 0, 0, 0)),
  currency: 'USD',
};

describe('OFX 2.x XML', () => {
  it('emits a parseable structure with the required tags', () => {
    const out = renderOfxXml(STMT);
    expect(out).toMatch(/<\?OFX OFXHEADER="200" VERSION="211"/);
    expect(out).toContain('<BANKID>121000248</BANKID>');
    expect(out).toContain('<ACCTID>1234567890</ACCTID>');
    expect(out).toContain('<ACCTTYPE>CHECKING</ACCTTYPE>');
    expect(out).toContain('<TRNAMT>3200.00</TRNAMT>');
    expect(out).toContain('<TRNAMT>-74.21</TRNAMT>');
    expect(out).toContain('<FITID>VTC-abc1234567890def</FITID>');
    expect(out).toContain('<DTSTART>20260301</DTSTART>');
    expect(out).toContain('<DTEND>20260331</DTEND>');
  });

  it('escapes &/<> in name and memo', () => {
    const out = renderOfxXml({
      ...STMT,
      transactions: [
        { ...STMT.transactions[0]!, name: 'A & B <Co>', memo: 'safe<text>' },
        STMT.transactions[1]!,
      ],
    });
    expect(out).toContain('A &amp; B &lt;Co&gt;');
    expect(out).toContain('safe&lt;text&gt;');
  });
});

describe('OFX 1.x SGML — QBO/QFX', () => {
  it('QBO emits the SGML header + INTU.BID + INTU.USERID', () => {
    const out = renderQbo(STMT);
    expect(out.startsWith('OFXHEADER:100')).toBe(true);
    expect(out).toContain('VERSION:102');
    expect(out).toContain('<INTU.BID>3000');
    expect(out).toContain('<INTU.USERID>Wells Fargo');
    expect(out).toContain('<TRNAMT>-74.21');
  });

  it('QFX emits INTU.BID but skips INTU.USERID', () => {
    const out = renderQfx(STMT);
    expect(out).toContain('<INTU.BID>3000');
    expect(out).not.toContain('<INTU.USERID>');
  });
});

describe('CSV exporters', () => {
  const rows = [
    { postedDate: '2026-03-08', description: 'PAYROLL', amountCents: 320_000n },
    { postedDate: '2026-03-12', description: 'GROCERY', amountCents: -7_421n },
  ];

  it('qbo3 puts signed amount in one column', () => {
    const out = renderCsv('qbo3', rows);
    expect(out).toContain('Date,Description,Amount');
    expect(out).toContain('03/08/2026,PAYROLL,3200.00');
    expect(out).toContain('03/12/2026,GROCERY,-74.21');
  });

  it('qbo4 splits debits and credits', () => {
    const out = renderCsv('qbo4', rows);
    expect(out).toContain('Date,Description,Debit,Credit');
    expect(out).toContain('03/08/2026,PAYROLL,,3200.00');
    expect(out).toContain('03/12/2026,GROCERY,74.21,');
  });

  it('xero matches its required header', () => {
    const out = renderCsv('xero', rows);
    expect(out.startsWith('*Date,*Amount,Payee')).toBe(true);
  });

  it('generic uses Memo column', () => {
    const out = renderCsv(
      'generic',
      rows.map((r) => ({ ...r, memo: 'note' })),
    );
    expect(out).toContain('Date,Description,Amount,Memo');
    expect(out).toContain('03/08/2026,PAYROLL,3200.00,note');
  });

  it('quotes cells containing commas/quotes', () => {
    const out = renderCsv('qbo3', [
      { postedDate: '2026-03-08', description: 'A,B "X"', amountCents: 100n },
    ]);
    expect(out).toContain('"A,B ""X"""');
  });
});
