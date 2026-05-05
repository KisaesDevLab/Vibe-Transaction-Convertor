// OFX 1.0.2 SGML writer — required by QBO Web Connect (.qbo) and Quicken
// Web Connect (.qfx). The two share the same body shape; only INTU.BID
// (and INTU.ORG for QBO) presence differs.

import { accountTypeForBank, centsToDecimal, ofxDate, ofxDateTime, type Stmt } from './ast.js';

const SGML_HEADER = [
  'OFXHEADER:100',
  'DATA:OFXSGML',
  'VERSION:102',
  'SECURITY:NONE',
  'ENCODING:USASCII',
  'CHARSET:1252',
  'COMPRESSION:NONE',
  'OLDFILEUID:NONE',
  'NEWFILEUID:NONE',
].join('\r\n');

// SGML uses unclosed tags — `<TAG>value` per line. Strict consumers
// (QuickBooks) accept either, but unclosed is canonical.
const stag = (name: string, value: string | number): string => `<${name}>${value}`;

const sgmlEscape = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const renderStmtTrnSgml = (trn: Stmt['transactions'][number]): string => {
  const lines: string[] = [
    '<STMTTRN>',
    stag('TRNTYPE', trn.trntype),
    stag('DTPOSTED', ofxDate(trn.postedDate)),
    stag('TRNAMT', centsToDecimal(trn.amountCents)),
    stag('FITID', sgmlEscape(trn.fitid)),
  ];
  if (trn.checkNumber) lines.push(stag('CHECKNUM', sgmlEscape(trn.checkNumber)));
  lines.push(stag('NAME', sgmlEscape(trn.name.slice(0, 32))));
  if (trn.memo) lines.push(stag('MEMO', sgmlEscape(trn.memo.slice(0, 255))));
  lines.push('</STMTTRN>');
  return lines.join('\r\n');
};

export interface SgmlWriterOptions {
  emitIntuBid?: boolean | undefined;
  emitIntuOrg?: boolean | undefined;
}

export const renderOfxSgml = (stmt: Stmt, opts: SgmlWriterOptions = {}): string => {
  const isCC = stmt.bankAccountInfo.accountType === 'CREDITCARD';
  const trns = stmt.transactions.map(renderStmtTrnSgml).join('\r\n');

  const sonrs: string[] = [
    '<SONRS>',
    '<STATUS>',
    stag('CODE', 0),
    stag('SEVERITY', 'INFO'),
    '</STATUS>',
    stag('DTSERVER', ofxDateTime(stmt.asOf)),
    stag('LANGUAGE', 'ENG'),
  ];
  if (opts.emitIntuOrg !== false && stmt.bankAccountInfo.intuOrg) {
    sonrs.push('<FI>', stag('ORG', sgmlEscape(stmt.bankAccountInfo.intuOrg)));
    if (stmt.bankAccountInfo.intuBid) sonrs.push(stag('FID', stmt.bankAccountInfo.intuBid));
    sonrs.push('</FI>');
  }
  if (opts.emitIntuBid !== false && stmt.bankAccountInfo.intuBid) {
    sonrs.push(stag('INTU.BID', stmt.bankAccountInfo.intuBid));
  }
  if (opts.emitIntuOrg !== false && stmt.bankAccountInfo.intuOrg) {
    sonrs.push(stag('INTU.USERID', sgmlEscape(stmt.bankAccountInfo.intuOrg)));
  }
  sonrs.push('</SONRS>');

  const acct = isCC
    ? ['<CCACCTFROM>', stag('ACCTID', sgmlEscape(stmt.bankAccountInfo.accountId)), '</CCACCTFROM>']
    : [
        '<BANKACCTFROM>',
        stag('BANKID', sgmlEscape(stmt.bankAccountInfo.bankId)),
        stag('ACCTID', sgmlEscape(stmt.bankAccountInfo.accountId)),
        stag('ACCTTYPE', accountTypeForBank(stmt.bankAccountInfo.accountType)),
        '</BANKACCTFROM>',
      ];

  const stmtRs = isCC
    ? [
        '<CCSTMTTRNRS>',
        stag('TRNUID', '1'),
        '<STATUS>',
        stag('CODE', 0),
        stag('SEVERITY', 'INFO'),
        '</STATUS>',
        '<CCSTMTRS>',
        stag('CURDEF', stmt.currency),
        ...acct,
        '<BANKTRANLIST>',
        stag('DTSTART', ofxDate(stmt.startDate)),
        stag('DTEND', ofxDate(stmt.endDate)),
        trns,
        '</BANKTRANLIST>',
        '<LEDGERBAL>',
        stag('BALAMT', centsToDecimal(stmt.ledgerBalanceCents)),
        stag('DTASOF', ofxDateTime(stmt.asOf)),
        '</LEDGERBAL>',
        '</CCSTMTRS>',
        '</CCSTMTTRNRS>',
      ]
    : [
        '<STMTTRNRS>',
        stag('TRNUID', '1'),
        '<STATUS>',
        stag('CODE', 0),
        stag('SEVERITY', 'INFO'),
        '</STATUS>',
        '<STMTRS>',
        stag('CURDEF', stmt.currency),
        ...acct,
        '<BANKTRANLIST>',
        stag('DTSTART', ofxDate(stmt.startDate)),
        stag('DTEND', ofxDate(stmt.endDate)),
        trns,
        '</BANKTRANLIST>',
        '<LEDGERBAL>',
        stag('BALAMT', centsToDecimal(stmt.ledgerBalanceCents)),
        stag('DTASOF', ofxDateTime(stmt.asOf)),
        '</LEDGERBAL>',
        '</STMTRS>',
        '</STMTTRNRS>',
      ];

  const wrapper = isCC ? 'CREDITCARDMSGSRSV1' : 'BANKMSGSRSV1';
  const body = [
    '<OFX>',
    '<SIGNONMSGSRSV1>',
    ...sonrs,
    '</SIGNONMSGSRSV1>',
    `<${wrapper}>`,
    ...stmtRs,
    `</${wrapper}>`,
    '</OFX>',
  ].join('\r\n');

  return `${SGML_HEADER}\r\n\r\n${body}\r\n`;
};

// Phase 22: QBO is the SGML writer with intu.bid/intu.org enabled.
export const renderQbo = (stmt: Stmt): string =>
  renderOfxSgml(stmt, { emitIntuBid: true, emitIntuOrg: true });

// Phase 23: QFX is the SGML writer with intu.bid only (Quicken).
export const renderQfx = (stmt: Stmt): string =>
  renderOfxSgml(stmt, { emitIntuBid: true, emitIntuOrg: false });
