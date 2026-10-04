// Phase 27 #4 + ADR-016 — byte-stable golden masters for every export
// format. Closes the audit gap on Phase 20 #24 (CSV), Phase 21 #14
// (OFX 2.x XML), Phase 22 #16 (QBO SGML), and Phase 23 #11 (QFX SGML).
//
// Contract: same Stmt fixture in → byte-identical bytes out, modulo the
// time-varying <DTSERVER> field (which is normalized below). If a writer
// changes its emit format intentionally, update the inline expected
// strings in this file *and* document the reason in the relevant ADR —
// downstream importers (QuickBooks Desktop, Quicken, Xero) may break.

import { describe, expect, it } from 'vitest';
import { renderCsv, type CsvRow } from './csv/index.js';
import { renderOfxXml } from './ofx/xml-writer.js';
import { renderQbo, renderQfx } from './ofx/sgml-writer.js';
import type { Stmt } from './ofx/ast.js';

// Inline a self-contained fixture so this file doesn't piggyback on the
// exporters-render.test.ts STMT — that lets either file evolve without
// silently breaking the other.
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
  // Frozen wall clock: 2026-04-01 00:00:00 UTC. The XML/SGML writers
  // emit DTSERVER from this; we strip it below before comparing.
  asOf: new Date(Date.UTC(2026, 3, 1, 0, 0, 0)),
  currency: 'USD',
};

const CSV_ROWS: CsvRow[] = [
  { postedDate: '2026-03-08', description: 'PAYROLL', amountCents: 320_000n },
  { postedDate: '2026-03-12', description: 'GROCERY', amountCents: -7_421n },
];

const CSV_GENERIC_ROWS: CsvRow[] = [
  {
    postedDate: '2026-03-08',
    description: 'PAYROLL',
    amountCents: 320_000n,
    runningBalanceCents: 412_579n,
    trntype: 'DIRECTDEP',
    fitid: 'VTC-abc1234567890def',
  },
  {
    postedDate: '2026-03-12',
    description: 'GROCERY',
    amountCents: -7_421n,
    runningBalanceCents: 405_158n,
    trntype: 'POS',
    fitid: 'VTC-zzz1234567890def',
  },
];

// <DTSERVER>...</DTSERVER> (XML) and <DTSERVER>... (SGML, unclosed-tag form).
const stripDtServer = (s: string): string =>
  s
    .replace(/<DTSERVER>[^<]+<\/DTSERVER>/g, '<DTSERVER>__DTSERVER__</DTSERVER>')
    .replace(/<DTSERVER>[^\r\n<]+/g, '<DTSERVER>__DTSERVER__');

// ---- Inline expected strings ------------------------------------------------
//
// These were captured from a known-good run of the writers against the
// fixture above (DTSERVER replaced with the placeholder). The ASCII art
// is intentional — diff-friendly when an importer regression nudges a
// tag. Do NOT reformat without intent.
//
// CRLF preserved as `\r\n` in the JS string literals so the file is safe
// to edit in any editor (LF on disk, CRLF in the buffer).

// U+FEFF UTF-8 BOM prepended to every CSV so Excel on Windows decodes
// non-ASCII (em dashes, accented merchants) as UTF-8 instead of cp1252.
const BOM = '﻿';

const EXPECTED_CSV_QBO3 =
  BOM +
  'Date,Description,Amount\r\n' +
  '03/08/2026,PAYROLL,3200.00\r\n' +
  '03/12/2026,GROCERY,-74.21\r\n';

const EXPECTED_CSV_QBO4 =
  BOM +
  'Date,Description,Credit,Debit\r\n' +
  '03/08/2026,PAYROLL,3200.00,\r\n' +
  '03/12/2026,GROCERY,,74.21\r\n';

const EXPECTED_CSV_XERO =
  BOM +
  '*Date,*Amount,Payee,Description,Reference\r\n' +
  '03/08/2026,3200.00,PAYROLL,PAYROLL,\r\n' +
  '03/12/2026,-74.21,GROCERY,GROCERY,\r\n';

const EXPECTED_CSV_GENERIC =
  BOM +
  'Date,Description,Amount,RunningBalance,CheckNumber,Payee,TRNTYPE,FITID,CleansedDescription,Category\r\n' +
  '03/08/2026,PAYROLL,3200.00,4125.79,,,DIRECTDEP,VTC-abc1234567890def,,\r\n' +
  '03/12/2026,GROCERY,-74.21,4051.58,,,POS,VTC-zzz1234567890def,,\r\n';

const EXPECTED_OFX_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\r\n' +
  '<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>\r\n' +
  '\r\n' +
  '<OFX>\r\n' +
  '  <SIGNONMSGSRSV1>\r\n' +
  '    <SONRS>\r\n' +
  '      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>\r\n' +
  '      <DTSERVER>__DTSERVER__</DTSERVER>\r\n' +
  '      <LANGUAGE>ENG</LANGUAGE>\r\n' +
  '      <FI>\r\n' +
  '        <ORG>Wells Fargo</ORG>\r\n' +
  '        <FID>3000</FID>\r\n' +
  '      </FI>\r\n' +
  '    </SONRS>\r\n' +
  '  </SIGNONMSGSRSV1>\r\n' +
  '  <BANKMSGSRSV1><STMTTRNRS>\r\n' +
  '  <TRNUID>1</TRNUID>\r\n' +
  '  <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>\r\n' +
  '  <STMTRS>\r\n' +
  '    <CURDEF>USD</CURDEF>\r\n' +
  '    <BANKACCTFROM>\r\n' +
  '      <BANKID>121000248</BANKID>\r\n' +
  '      <ACCTID>1234567890</ACCTID>\r\n' +
  '      <ACCTTYPE>CHECKING</ACCTTYPE>\r\n' +
  '    </BANKACCTFROM>\r\n' +
  '    <BANKTRANLIST>\r\n' +
  '      <DTSTART>20260301</DTSTART>\r\n' +
  '      <DTEND>20260331</DTEND>\r\n' +
  '      <STMTTRN>\r\n' +
  '        <TRNTYPE>DIRECTDEP</TRNTYPE>\r\n' +
  '        <DTPOSTED>20260308</DTPOSTED>\r\n' +
  '        <TRNAMT>3200.00</TRNAMT>\r\n' +
  '        <FITID>VTC-abc1234567890def</FITID>\r\n' +
  '        <NAME>PAYROLL DEPOSIT</NAME>\r\n' +
  '      </STMTTRN>\r\n' +
  '      <STMTTRN>\r\n' +
  '        <TRNTYPE>POS</TRNTYPE>\r\n' +
  '        <DTPOSTED>20260312</DTPOSTED>\r\n' +
  '        <TRNAMT>-74.21</TRNAMT>\r\n' +
  '        <FITID>VTC-zzz1234567890def</FITID>\r\n' +
  '        <NAME>GROCERY STORE</NAME>\r\n' +
  '        <MEMO>pickup</MEMO>\r\n' +
  '      </STMTTRN>\r\n' +
  '    </BANKTRANLIST>\r\n' +
  '    <LEDGERBAL>\r\n' +
  '      <BALAMT>4125.79</BALAMT>\r\n' +
  '      <DTASOF>20260331</DTASOF>\r\n' +
  '    </LEDGERBAL>\r\n' +
  '  </STMTRS>\r\n' +
  '</STMTTRNRS></BANKMSGSRSV1>\r\n' +
  '</OFX>';

// <DTASOF> is NOT normalized: it is the statement period end (BuildPlan
// Phase 21 #11), deterministic for a given statement — never the upload or
// render time.

const EXPECTED_QBO_SGML =
  'OFXHEADER:100\r\n' +
  'DATA:OFXSGML\r\n' +
  'VERSION:102\r\n' +
  'SECURITY:NONE\r\n' +
  'ENCODING:USASCII\r\n' +
  'CHARSET:1252\r\n' +
  'COMPRESSION:NONE\r\n' +
  'OLDFILEUID:NONE\r\n' +
  'NEWFILEUID:NONE\r\n' +
  '\r\n' +
  '<OFX>\r\n' +
  '<SIGNONMSGSRSV1>\r\n' +
  '<SONRS>\r\n' +
  '<STATUS>\r\n' +
  '<CODE>0\r\n' +
  '<SEVERITY>INFO\r\n' +
  '</STATUS>\r\n' +
  '<DTSERVER>__DTSERVER__\r\n' +
  '<LANGUAGE>ENG\r\n' +
  '<FI>\r\n' +
  '<ORG>Wells Fargo\r\n' +
  '<FID>3000\r\n' +
  '</FI>\r\n' +
  '<INTU.BID>3000\r\n' +
  '</SONRS>\r\n' +
  '</SIGNONMSGSRSV1>\r\n' +
  '<BANKMSGSRSV1>\r\n' +
  '<STMTTRNRS>\r\n' +
  '<TRNUID>1\r\n' +
  '<STATUS>\r\n' +
  '<CODE>0\r\n' +
  '<SEVERITY>INFO\r\n' +
  '</STATUS>\r\n' +
  '<STMTRS>\r\n' +
  '<CURDEF>USD\r\n' +
  '<BANKACCTFROM>\r\n' +
  '<BANKID>121000248\r\n' +
  '<ACCTID>1234567890\r\n' +
  '<ACCTTYPE>CHECKING\r\n' +
  '</BANKACCTFROM>\r\n' +
  '<BANKTRANLIST>\r\n' +
  '<DTSTART>20260301\r\n' +
  '<DTEND>20260331\r\n' +
  '<STMTTRN>\r\n' +
  '<TRNTYPE>DIRECTDEP\r\n' +
  '<DTPOSTED>20260308\r\n' +
  '<TRNAMT>3200.00\r\n' +
  '<FITID>VTC-abc1234567890def\r\n' +
  '<NAME>PAYROLL DEPOSIT\r\n' +
  '</STMTTRN>\r\n' +
  '<STMTTRN>\r\n' +
  '<TRNTYPE>POS\r\n' +
  '<DTPOSTED>20260312\r\n' +
  '<TRNAMT>-74.21\r\n' +
  '<FITID>VTC-zzz1234567890def\r\n' +
  '<NAME>GROCERY STORE\r\n' +
  '<MEMO>pickup\r\n' +
  '</STMTTRN>\r\n' +
  '</BANKTRANLIST>\r\n' +
  '<LEDGERBAL>\r\n' +
  '<BALAMT>4125.79\r\n' +
  '<DTASOF>20260331\r\n' +
  '</LEDGERBAL>\r\n' +
  '</STMTRS>\r\n' +
  '</STMTTRNRS>\r\n' +
  '</BANKMSGSRSV1>\r\n' +
  '</OFX>\r\n';

// QFX is QBO without <FI> and with <INTU.USERID>.
const EXPECTED_QFX_SGML =
  'OFXHEADER:100\r\n' +
  'DATA:OFXSGML\r\n' +
  'VERSION:102\r\n' +
  'SECURITY:NONE\r\n' +
  'ENCODING:USASCII\r\n' +
  'CHARSET:1252\r\n' +
  'COMPRESSION:NONE\r\n' +
  'OLDFILEUID:NONE\r\n' +
  'NEWFILEUID:NONE\r\n' +
  '\r\n' +
  '<OFX>\r\n' +
  '<SIGNONMSGSRSV1>\r\n' +
  '<SONRS>\r\n' +
  '<STATUS>\r\n' +
  '<CODE>0\r\n' +
  '<SEVERITY>INFO\r\n' +
  '</STATUS>\r\n' +
  '<DTSERVER>__DTSERVER__\r\n' +
  '<LANGUAGE>ENG\r\n' +
  '<INTU.BID>3000\r\n' +
  '<INTU.USERID>VTC11111111222233334444555555555555\r\n' +
  '</SONRS>\r\n' +
  '</SIGNONMSGSRSV1>\r\n' +
  '<BANKMSGSRSV1>\r\n' +
  '<STMTTRNRS>\r\n' +
  '<TRNUID>1\r\n' +
  '<STATUS>\r\n' +
  '<CODE>0\r\n' +
  '<SEVERITY>INFO\r\n' +
  '</STATUS>\r\n' +
  '<STMTRS>\r\n' +
  '<CURDEF>USD\r\n' +
  '<BANKACCTFROM>\r\n' +
  '<BANKID>121000248\r\n' +
  '<ACCTID>1234567890\r\n' +
  '<ACCTTYPE>CHECKING\r\n' +
  '</BANKACCTFROM>\r\n' +
  '<BANKTRANLIST>\r\n' +
  '<DTSTART>20260301\r\n' +
  '<DTEND>20260331\r\n' +
  '<STMTTRN>\r\n' +
  '<TRNTYPE>DIRECTDEP\r\n' +
  '<DTPOSTED>20260308\r\n' +
  '<TRNAMT>3200.00\r\n' +
  '<FITID>VTC-abc1234567890def\r\n' +
  '<NAME>PAYROLL DEPOSIT\r\n' +
  '</STMTTRN>\r\n' +
  '<STMTTRN>\r\n' +
  '<TRNTYPE>POS\r\n' +
  '<DTPOSTED>20260312\r\n' +
  '<TRNAMT>-74.21\r\n' +
  '<FITID>VTC-zzz1234567890def\r\n' +
  '<NAME>GROCERY STORE\r\n' +
  '<MEMO>pickup\r\n' +
  '</STMTTRN>\r\n' +
  '</BANKTRANLIST>\r\n' +
  '<LEDGERBAL>\r\n' +
  '<BALAMT>4125.79\r\n' +
  '<DTASOF>20260331\r\n' +
  '</LEDGERBAL>\r\n' +
  '</STMTRS>\r\n' +
  '</STMTTRNRS>\r\n' +
  '</BANKMSGSRSV1>\r\n' +
  '</OFX>\r\n';

describe('golden masters — CSV (Phase 20 #24)', () => {
  it('csv-qbo3 byte-identical to inline golden', () => {
    expect(renderCsv('qbo3', CSV_ROWS)).toBe(EXPECTED_CSV_QBO3);
  });

  it('csv-qbo4 byte-identical to inline golden', () => {
    expect(renderCsv('qbo4', CSV_ROWS)).toBe(EXPECTED_CSV_QBO4);
  });

  it('csv-xero byte-identical to inline golden', () => {
    expect(renderCsv('xero', CSV_ROWS)).toBe(EXPECTED_CSV_XERO);
  });

  it('csv-generic byte-identical to inline golden', () => {
    expect(renderCsv('generic', CSV_GENERIC_ROWS)).toBe(EXPECTED_CSV_GENERIC);
  });
});

describe('golden masters — OFX 2.x XML (Phase 21 #14)', () => {
  it('renderOfxXml byte-identical to inline golden (DTSERVER normalized)', () => {
    const actual = stripDtServer(renderOfxXml(STMT));
    expect(actual).toBe(EXPECTED_OFX_XML);
  });
});

describe('golden masters — QBO SGML (Phase 22 #16)', () => {
  it('renderQbo byte-identical to inline golden (DTSERVER normalized)', () => {
    const actual = stripDtServer(renderQbo(STMT));
    expect(actual).toBe(EXPECTED_QBO_SGML);
  });
});

describe('golden masters — QFX SGML (Phase 23 #11)', () => {
  it('renderQfx byte-identical to inline golden (DTSERVER normalized)', () => {
    const actual = stripDtServer(
      renderQfx({
        ...STMT,
        bankAccountInfo: {
          ...STMT.bankAccountInfo,
          intuUseridSeed: '11111111-2222-3333-4444-555555555555',
        },
      }),
    );
    expect(actual).toBe(EXPECTED_QFX_SGML);
  });
});

describe('golden masters — <DTASOF> is the period end, not the upload time', () => {
  // asOf (the statement's upload time) only feeds <DTSERVER>; the balance
  // <DTASOF> must stay the period end however late the statement was uploaded.
  const lateUpload: Stmt = { ...STMT, asOf: new Date(Date.UTC(2026, 6, 9, 13, 45, 0)) };

  it('emits <DTASOF> = period end in OFX 2.x XML, QBO and QFX', () => {
    expect(renderOfxXml(lateUpload)).toContain('<DTASOF>20260331</DTASOF>');
    expect(renderQbo(lateUpload)).toContain('<DTASOF>20260331\r\n');
    expect(renderQfx(lateUpload)).toContain('<DTASOF>20260331\r\n');
    for (const out of [renderOfxXml(lateUpload), renderQbo(lateUpload), renderQfx(lateUpload)]) {
      expect(out).not.toContain('<DTASOF>20260709');
    }
  });
});

// Credit-card variant (Phase 21 #15 / Phase 22 #11). The AST carries
// HOLDER-perspective signs — services/exports.ts negates the stored
// statement-sign amounts for CREDITCARD accounts — so a purchase is
// negative, a payment positive and an owed balance negative (OFX 3.2.9.2).
const CC_STMT: Stmt = {
  bankAccountInfo: {
    bankId: '000000000',
    accountId: '379912345678901',
    accountType: 'CREDITCARD',
    intuBid: '10898',
    intuOrg: 'American Express',
  },
  transactions: [
    {
      trntype: 'DEBIT',
      postedDate: '2026-03-04',
      amountCents: -12_783n,
      fitid: 'VTC-cc01234567890abc',
      name: 'WHOLE FOODS MARKET',
    },
    {
      trntype: 'PAYMENT',
      postedDate: '2026-03-15',
      amountCents: 50_000n,
      fitid: 'VTC-cc11234567890abc',
      name: 'PAYMENT - THANK YOU',
    },
  ],
  ledgerBalanceCents: -289_045n,
  startDate: '2026-03-01',
  endDate: '2026-03-31',
  asOf: new Date(Date.UTC(2026, 3, 1, 0, 0, 0)),
  currency: 'USD',
};

const EXPECTED_QBO_CC_SGML =
  'OFXHEADER:100\r\n' +
  'DATA:OFXSGML\r\n' +
  'VERSION:102\r\n' +
  'SECURITY:NONE\r\n' +
  'ENCODING:USASCII\r\n' +
  'CHARSET:1252\r\n' +
  'COMPRESSION:NONE\r\n' +
  'OLDFILEUID:NONE\r\n' +
  'NEWFILEUID:NONE\r\n' +
  '\r\n' +
  '<OFX>\r\n' +
  '<SIGNONMSGSRSV1>\r\n' +
  '<SONRS>\r\n' +
  '<STATUS>\r\n' +
  '<CODE>0\r\n' +
  '<SEVERITY>INFO\r\n' +
  '</STATUS>\r\n' +
  '<DTSERVER>__DTSERVER__\r\n' +
  '<LANGUAGE>ENG\r\n' +
  '<FI>\r\n' +
  '<ORG>American Express\r\n' +
  '<FID>10898\r\n' +
  '</FI>\r\n' +
  '<INTU.BID>10898\r\n' +
  '</SONRS>\r\n' +
  '</SIGNONMSGSRSV1>\r\n' +
  '<CREDITCARDMSGSRSV1>\r\n' +
  '<CCSTMTTRNRS>\r\n' +
  '<TRNUID>1\r\n' +
  '<STATUS>\r\n' +
  '<CODE>0\r\n' +
  '<SEVERITY>INFO\r\n' +
  '</STATUS>\r\n' +
  '<CCSTMTRS>\r\n' +
  '<CURDEF>USD\r\n' +
  '<CCACCTFROM>\r\n' +
  '<ACCTID>379912345678901\r\n' +
  '</CCACCTFROM>\r\n' +
  '<BANKTRANLIST>\r\n' +
  '<DTSTART>20260301\r\n' +
  '<DTEND>20260331\r\n' +
  '<STMTTRN>\r\n' +
  '<TRNTYPE>DEBIT\r\n' +
  '<DTPOSTED>20260304\r\n' +
  '<TRNAMT>-127.83\r\n' +
  '<FITID>VTC-cc01234567890abc\r\n' +
  '<NAME>WHOLE FOODS MARKET\r\n' +
  '</STMTTRN>\r\n' +
  '<STMTTRN>\r\n' +
  '<TRNTYPE>PAYMENT\r\n' +
  '<DTPOSTED>20260315\r\n' +
  '<TRNAMT>500.00\r\n' +
  '<FITID>VTC-cc11234567890abc\r\n' +
  '<NAME>PAYMENT - THANK YOU\r\n' +
  '</STMTTRN>\r\n' +
  '</BANKTRANLIST>\r\n' +
  '<LEDGERBAL>\r\n' +
  '<BALAMT>-2890.45\r\n' +
  '<DTASOF>20260331\r\n' +
  '</LEDGERBAL>\r\n' +
  '</CCSTMTRS>\r\n' +
  '</CCSTMTTRNRS>\r\n' +
  '</CREDITCARDMSGSRSV1>\r\n' +
  '</OFX>\r\n';

describe('golden masters — credit-card QBO SGML (Phase 22 #11)', () => {
  it('renderQbo CC variant byte-identical (CCACCTFROM, holder-perspective signs)', () => {
    expect(stripDtServer(renderQbo(CC_STMT))).toBe(EXPECTED_QBO_CC_SGML);
  });

  it('OFX 2.x XML CC variant carries the same signs and balance', () => {
    const out = renderOfxXml(CC_STMT);
    expect(out).toContain('<CREDITCARDMSGSRSV1><CCSTMTTRNRS>');
    expect(out).toContain('<TRNAMT>-127.83</TRNAMT>');
    expect(out).toContain('<TRNAMT>500.00</TRNAMT>');
    expect(out).toContain('<BALAMT>-2890.45</BALAMT>');
    expect(out).not.toContain('<BANKID>');
    expect(out).not.toContain('<ACCTTYPE>');
  });
});
