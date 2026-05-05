import { describe, expect, it } from 'vitest';
import { renderOfxXml } from './ofx/xml-writer.js';
import { renderQbo, renderQfx } from './ofx/sgml-writer.js';
import { renderCsv } from './csv/index.js';
import { resolveBankId, FALLBACK_BANK_ID, type Stmt } from './ofx/ast.js';

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
    // Phase 21 item 8 — SONRS carries the FI block.
    expect(out).toContain('<ORG>Wells Fargo</ORG>');
    expect(out).toContain('<FID>3000</FID>');
    // Phase 21 item 3 — CRLF line endings.
    expect(out).toContain('\r\n');
    expect(out).not.toMatch(/[^\r]\n/);
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

  it('collapses embedded newlines in name/memo (OCR multi-line tolerance)', () => {
    const out = renderOfxXml({
      ...STMT,
      transactions: [
        { ...STMT.transactions[0]!, name: 'PAYROLL\r\nDEPOSIT', memo: 'line1\nline2' },
        STMT.transactions[1]!,
      ],
    });
    expect(out).toContain('<NAME>PAYROLL DEPOSIT</NAME>');
    expect(out).toContain('<MEMO>line1 line2</MEMO>');
  });
});

describe('OFX 1.x SGML — QBO/QFX', () => {
  it('QBO always emits INTU.BID even when account.intuBid is unset (falls back to 3000)', () => {
    const out = renderQbo({
      ...STMT,
      bankAccountInfo: { ...STMT.bankAccountInfo, intuBid: undefined },
    });
    expect(out).toContain('<INTU.BID>3000');
    expect(out).toContain('<FID>3000');
  });

  it('QBO emits the SGML header + INTU.BID + the standard <FI> block', () => {
    const out = renderQbo(STMT);
    expect(out.startsWith('OFXHEADER:100')).toBe(true);
    expect(out).toContain('VERSION:102');
    expect(out).toContain('<INTU.BID>3000');
    expect(out).toContain('<FI>');
    expect(out).toContain('<ORG>Wells Fargo');
    expect(out).toContain('<FID>3000');
    expect(out).not.toContain('<INTU.USERID>'); // never emitted (was wrong)
    expect(out).toContain('<TRNAMT>-74.21');
  });

  it('QFX emits INTU.BID + INTU.USERID and skips the <FI> block (Quicken)', () => {
    const out = renderQfx({
      ...STMT,
      bankAccountInfo: {
        ...STMT.bankAccountInfo,
        intuUseridSeed: '11111111-2222-3333-4444-555555555555',
      },
    });
    expect(out).toContain('<INTU.BID>3000');
    expect(out).toContain('<INTU.USERID>VTC111111112222333344445555555555');
    expect(out).not.toContain('<FI>');
  });

  it('QFX INTU.USERID is byte-stable across re-runs (idempotent re-exports)', () => {
    const seed = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const a = renderQfx({
      ...STMT,
      bankAccountInfo: { ...STMT.bankAccountInfo, intuUseridSeed: seed },
    });
    const b = renderQfx({
      ...STMT,
      bankAccountInfo: { ...STMT.bankAccountInfo, intuUseridSeed: seed },
    });
    expect(a).toBe(b);
    expect(a).toContain('<INTU.USERID>VTCAAAAAAAABBBBCCCCDDDDEEEEEEEEEEEE');
  });

  it('QFX honors operator override of INTU.USERID', () => {
    const out = renderQfx({
      ...STMT,
      bankAccountInfo: { ...STMT.bankAccountInfo, intuUserid: 'CUSTOM-USERID' },
    });
    expect(out).toContain('<INTU.USERID>CUSTOM-USERID');
  });
});

describe('SGML transliteration (Phase 22 #8 — CHARSET 1252)', () => {
  it('strips diacritics and folds smart quotes/dashes in QBO output', () => {
    const out = renderQbo({
      ...STMT,
      transactions: [
        {
          ...STMT.transactions[0]!,
          name: 'CAFÉ "L’Étoile" — São Paulo™',
        },
        STMT.transactions[1]!,
      ],
    });
    expect(out).toContain('CAFE "L\'Etoile" - Sao Paulo(TM)');
    // Confirm no non-ASCII chars survived in the rendered output.
    // (Plain ASCII `-` and `"` are fine; we want the smart variants gone.)
    // eslint-disable-next-line no-control-regex
    const hasNonAscii = /[^\x00-\x7F]/.test(out);
    expect(hasNonAscii).toBe(false);
  });

  it('drops fully non-ASCII codepoints to ? rather than shipping raw UTF-8', () => {
    const out = renderQfx({
      ...STMT,
      transactions: [{ ...STMT.transactions[0]!, name: '東京銀行' }, STMT.transactions[1]!],
    });
    // Each CJK codepoint becomes '?'; the spec preference is "lossy
    // ASCII over corrupted bytes the consumer can't decode".
    expect(out).toContain('????');
  });
});

describe('BANKID fallback ladder (ADR-012, Phase 22 #19/#21)', () => {
  it('uses routing number when present and 9-digit', () => {
    expect(resolveBankId('121000248', '3000')).toEqual({
      bankId: '121000248',
      source: 'routing',
    });
  });
  it('uses 9-digit BID when routing is missing', () => {
    expect(resolveBankId(null, '123456789')).toEqual({
      bankId: '123456789',
      source: 'bid-9',
    });
  });
  it('zero-pads short BIDs to 9 digits', () => {
    expect(resolveBankId(null, '3000')).toEqual({
      bankId: '000003000',
      source: 'bid-padded',
    });
  });
  it('falls back to all-zero when nothing is configured', () => {
    expect(resolveBankId(null, null)).toEqual({
      bankId: FALLBACK_BANK_ID,
      source: 'fallback',
    });
    expect(FALLBACK_BANK_ID).toBe('000000000');
  });
  it('rejects non-numeric BIDs and falls through to fallback', () => {
    expect(resolveBankId(null, 'WELLS').source).toBe('fallback');
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

  it('qbo4 splits credits and debits — credit column comes first', () => {
    const out = renderCsv('qbo4', rows);
    expect(out).toContain('Date,Description,Credit,Debit');
    // Positive amount → credit column populated, debit blank.
    expect(out).toContain('03/08/2026,PAYROLL,3200.00,');
    // Negative amount → debit column populated, credit blank.
    expect(out).toContain('03/12/2026,GROCERY,,74.21');
  });

  it('xero matches its 5-column header', () => {
    const out = renderCsv('xero', rows);
    expect(out.startsWith('*Date,*Amount,Payee,Description,Reference\r\n')).toBe(true);
    // No "Cheque Number" column anymore.
    expect(out).not.toContain('Cheque Number');
  });

  it('generic emits the full denormalized row', () => {
    const out = renderCsv('generic', [
      {
        postedDate: '2026-03-08',
        description: 'PAYROLL',
        amountCents: 320_000n,
        runningBalanceCents: 412_579n,
        trntype: 'DIRECTDEP',
        fitid: 'VTC-abc1234567890def',
      },
    ]);
    expect(out).toContain('Date,Description,Amount,RunningBalance,CheckNumber,TRNTYPE,FITID');
    expect(out).toContain('03/08/2026,PAYROLL,3200.00,4125.79,,DIRECTDEP,VTC-abc1234567890def');
  });

  it('quotes cells containing commas/quotes', () => {
    const out = renderCsv('qbo3', [
      { postedDate: '2026-03-08', description: 'A,B "X"', amountCents: 100n },
    ]);
    expect(out).toContain('"A,B ""X"""');
  });
});

// ADR-016 — same input must produce byte-identical output, modulo the
// time-varying <DTSERVER> field. These tests are golden masters: if the
// expected strings change, the export contract has shifted and existing
// downstream importers (QuickBooks Desktop, Quicken) may break. Update
// only when intentional.
describe('determinism (ADR-016)', () => {
  const stripDtServer = (s: string): string =>
    s
      .replace(/<DTSERVER>[^<]+<\/DTSERVER>/g, '<DTSERVER>X</DTSERVER>')
      .replace(/<DTSERVER>[^\r\n<]+/g, '<DTSERVER>X');

  it('OFX 2.x XML is byte-identical across calls (modulo DTSERVER)', () => {
    const a = stripDtServer(renderOfxXml(STMT));
    const b = stripDtServer(renderOfxXml(STMT));
    expect(a).toBe(b);
  });

  it('QBO SGML is byte-identical across calls (modulo DTSERVER)', () => {
    const a = stripDtServer(renderQbo(STMT));
    const b = stripDtServer(renderQbo(STMT));
    expect(a).toBe(b);
  });

  it('QFX SGML is byte-identical across calls (modulo DTSERVER)', () => {
    const a = stripDtServer(renderQfx(STMT));
    const b = stripDtServer(renderQfx(STMT));
    expect(a).toBe(b);
  });

  it('CSV outputs are byte-identical across calls', () => {
    const rows = [
      { postedDate: '2026-03-08', description: 'PAYROLL', amountCents: 320_000n },
      { postedDate: '2026-03-12', description: 'GROCERY', amountCents: -7_421n },
    ];
    for (const tmpl of ['qbo3', 'qbo4', 'xero', 'generic'] as const) {
      expect(renderCsv(tmpl, rows)).toBe(renderCsv(tmpl, rows));
    }
  });

  it('OFX XML preserves transaction order regardless of input shuffling', () => {
    // Order is the caller's responsibility; the writer must not reorder.
    const reversed: Stmt = {
      ...STMT,
      transactions: [...STMT.transactions].reverse(),
    };
    const out = renderOfxXml(reversed);
    const firstFitid = out.indexOf('VTC-zzz1234567890def');
    const secondFitid = out.indexOf('VTC-abc1234567890def');
    expect(firstFitid).toBeGreaterThan(0);
    expect(secondFitid).toBeGreaterThan(firstFitid);
  });
});
