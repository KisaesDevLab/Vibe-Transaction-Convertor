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
  '      <DTASOF>__DTSERVER__</DTASOF>\r\n' +
  '    </LEDGERBAL>\r\n' +
  '  </STMTRS>\r\n' +
  '</STMTTRNRS></BANKMSGSRSV1>\r\n' +
  '</OFX>';

// DTASOF is also a time-varying field; same normalization rule.
const stripDtFields = (s: string): string =>
  stripDtServer(s)
    .replace(/<DTASOF>[^<]+<\/DTASOF>/g, '<DTASOF>__DTSERVER__</DTASOF>')
    .replace(/<DTASOF>[^\r\n<]+/g, '<DTASOF>__DTSERVER__');

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
  '<DTASOF>__DTSERVER__\r\n' +
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
  '<DTASOF>__DTSERVER__\r\n' +
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
  it('renderOfxXml byte-identical to inline golden (DTSERVER/DTASOF normalized)', () => {
    const actual = stripDtFields(renderOfxXml(STMT));
    expect(actual).toBe(EXPECTED_OFX_XML);
  });
});

describe('golden masters — QBO SGML (Phase 22 #16)', () => {
  it('renderQbo byte-identical to inline golden (DTSERVER/DTASOF normalized)', () => {
    const actual = stripDtFields(renderQbo(STMT));
    expect(actual).toBe(EXPECTED_QBO_SGML);
  });
});

describe('golden masters — QFX SGML (Phase 23 #11)', () => {
  it('renderQfx byte-identical to inline golden (DTSERVER/DTASOF normalized)', () => {
    const actual = stripDtFields(
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
