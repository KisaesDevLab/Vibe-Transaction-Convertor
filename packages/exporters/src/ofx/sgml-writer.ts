// OFX 1.0.2 SGML writer — required by QBO Web Connect (.qbo) and Quicken
// Web Connect (.qfx). The two share the same body shape; only INTU.BID
// (and INTU.ORG for QBO) presence differs.

import {
  accountTypeForBank,
  centsToDecimal,
  deriveIntuUserid,
  ofxDate,
  ofxDateTime,
  type Stmt,
} from './ast.js';

// Phase 22 items 5/7/15/16: QBO Web Connect requires INTU.BID — when an
// account has no Intuit BID on file we fall back to '3000' (Wells Fargo's
// generic ID, accepted everywhere) and surface the fallback to the audit
// log so operators can see how often we're guessing.
const HARDCODED_INTU_BID_FALLBACK = '3000';

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

// SGML record separation is `\r\n`. Any embedded newline inside a text
// value (often present after OCR of multi-line descriptions) would split
// the record and break parsers — collapse to single spaces first.
const sgmlEscape = (s: string): string =>
  s
    .replaceAll(/[\r\n]+/g, ' ')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

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
  // Toggles the standard OFX <FI><ORG><FID></FI> block. QBO emits it,
  // QFX skips it (Quicken).
  emitFiBlock?: boolean | undefined;
  // QFX writers emit INTU.USERID; QBO does not. Phase 23 #2/#3.
  emitIntuUserid?: boolean | undefined;
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
  const effectiveIntuBid = stmt.bankAccountInfo.intuBid ?? HARDCODED_INTU_BID_FALLBACK;
  if (opts.emitFiBlock !== false) {
    sonrs.push(
      '<FI>',
      stag('ORG', sgmlEscape(stmt.bankAccountInfo.intuOrg ?? 'Unknown')),
      stag('FID', effectiveIntuBid),
      '</FI>',
    );
  }
  if (opts.emitIntuBid !== false) {
    // Always emit INTU.BID — falling back to '3000' if the account has no
    // BID configured. This matches Phase 22 item 5/7/15/16.
    sonrs.push(stag('INTU.BID', effectiveIntuBid));
  }
  if (opts.emitIntuUserid) {
    // Phase 23 #2/#3: QFX requires INTU.USERID. Use the explicit value if
    // the caller provided one (operator override), otherwise derive
    // deterministically from the seed (typically account.id) so re-exports
    // are byte-stable.
    const userid =
      stmt.bankAccountInfo.intuUserid ??
      (stmt.bankAccountInfo.intuUseridSeed
        ? deriveIntuUserid(stmt.bankAccountInfo.intuUseridSeed)
        : undefined);
    if (userid) sonrs.push(stag('INTU.USERID', sgmlEscape(userid)));
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

// Phase 22: QBO is the SGML writer with INTU.BID + the standard <FI> block.
export const renderQbo = (stmt: Stmt): string =>
  renderOfxSgml(stmt, { emitIntuBid: true, emitFiBlock: true });

// Phase 23: QFX is the SGML writer with INTU.BID + INTU.USERID. Quicken
// doesn't require the <FI> block when INTU.BID is present.
export const renderQfx = (stmt: Stmt): string =>
  renderOfxSgml(stmt, { emitIntuBid: true, emitFiBlock: false, emitIntuUserid: true });
