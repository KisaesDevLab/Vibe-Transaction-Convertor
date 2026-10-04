// OFX 2.1.1 XML writer — used by the standalone .ofx export.
// QBO/QFX use the SGML writer instead.

import { accountTypeForBank, centsToDecimal, ofxDate, ofxDateTime, type Stmt } from './ast.js';

// Defensively collapse newlines to spaces so OCR-derived multi-line
// descriptions don't accidentally break record-oriented consumers that
// don't normalize whitespace inside <NAME>/<MEMO>.
const xmlEscape = (s: string): string =>
  s
    .replaceAll(/[\r\n]+/g, ' ')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

const tag = (name: string, content: string): string => `<${name}>${content}</${name}>`;

// Length-limited fields (NAME A-32, MEMO A-255). Collapse newlines before
// clipping so the limit counts what is actually emitted, clip by code point
// so a surrogate pair (e.g. an emoji) is never split into invalid UTF-8, and
// escape last so an entity is never cut in half.
const clipped = (s: string, max: number): string =>
  xmlEscape(
    Array.from(s.replaceAll(/[\r\n]+/g, ' '))
      .slice(0, max)
      .join(''),
  );

export const renderStmtTrnXml = (trn: Stmt['transactions'][number]): string =>
  `      <STMTTRN>
        ${tag('TRNTYPE', trn.trntype)}
        ${tag('DTPOSTED', ofxDate(trn.postedDate))}
        ${tag('TRNAMT', centsToDecimal(trn.amountCents))}
        ${tag('FITID', xmlEscape(trn.fitid))}` +
  (trn.checkNumber ? `\n        ${tag('CHECKNUM', xmlEscape(trn.checkNumber))}` : '') +
  `\n        ${tag('NAME', clipped(trn.name, 32))}` +
  (trn.memo ? `\n        ${tag('MEMO', clipped(trn.memo, 255))}` : '') +
  `\n      </STMTTRN>`;

export interface OfxXmlOptions {
  // When the statement was exported under a Golden Rule override, drop a
  // forensic XML comment up top so future reviewers see the trail.
  // (Phase 21 item 22.)
  overrideNote?: string;
}

export const renderOfxXml = (stmt: Stmt, opts: OfxXmlOptions = {}): string => {
  const isCC = stmt.bankAccountInfo.accountType === 'CREDITCARD';
  const trnList = stmt.transactions.map(renderStmtTrnXml).join('\n');
  const forensicComment = opts.overrideNote
    ? `<!-- Reconciliation: ${xmlEscape(opts.overrideNote)} -->\n`
    : '';

  const acctBlock = isCC
    ? `<CCACCTFROM>
      ${tag('ACCTID', xmlEscape(stmt.bankAccountInfo.accountId))}
    </CCACCTFROM>`
    : `<BANKACCTFROM>
      ${tag('BANKID', xmlEscape(stmt.bankAccountInfo.bankId))}
      ${tag('ACCTID', xmlEscape(stmt.bankAccountInfo.accountId))}
      ${tag('ACCTTYPE', accountTypeForBank(stmt.bankAccountInfo.accountType))}
    </BANKACCTFROM>`;

  const stmtBlock = isCC
    ? `<CCSTMTTRNRS>
  <TRNUID>1</TRNUID>
  <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
  <CCSTMTRS>
    ${tag('CURDEF', stmt.currency)}
    ${acctBlock}
    <BANKTRANLIST>
      ${tag('DTSTART', ofxDate(stmt.startDate))}
      ${tag('DTEND', ofxDate(stmt.endDate))}
${trnList}
    </BANKTRANLIST>
    <LEDGERBAL>
      ${tag('BALAMT', centsToDecimal(stmt.ledgerBalanceCents))}
      ${tag('DTASOF', ofxDate(stmt.endDate))}
    </LEDGERBAL>
  </CCSTMTRS>
</CCSTMTTRNRS>`
    : `<STMTTRNRS>
  <TRNUID>1</TRNUID>
  <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
  <STMTRS>
    ${tag('CURDEF', stmt.currency)}
    ${acctBlock}
    <BANKTRANLIST>
      ${tag('DTSTART', ofxDate(stmt.startDate))}
      ${tag('DTEND', ofxDate(stmt.endDate))}
${trnList}
    </BANKTRANLIST>
    <LEDGERBAL>
      ${tag('BALAMT', centsToDecimal(stmt.ledgerBalanceCents))}
      ${tag('DTASOF', ofxDate(stmt.endDate))}
    </LEDGERBAL>
  </STMTRS>
</STMTTRNRS>`;

  const messages = isCC
    ? `<CREDITCARDMSGSRSV1>${stmtBlock}</CREDITCARDMSGSRSV1>`
    : `<BANKMSGSRSV1>${stmtBlock}</BANKMSGSRSV1>`;

  // SONRS includes the <FI> block when the institution is known —
  // Phase 21 item 8. ORG defaults to the bank's intuOrg or "Unknown";
  // FID falls back to the intuBid (or BANK_ID for routing-only setups).
  const fiOrg = stmt.bankAccountInfo.intuOrg ?? 'Unknown';
  const fiFid = stmt.bankAccountInfo.intuBid ?? stmt.bankAccountInfo.bankId;
  const fiBlock = `      <FI>
        ${tag('ORG', xmlEscape(fiOrg))}
        ${tag('FID', xmlEscape(fiFid))}
      </FI>`;

  const lf = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
${forensicComment}
<OFX>
  <SIGNONMSGSRSV1>
    <SONRS>
      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
      ${tag('DTSERVER', ofxDateTime(stmt.asOf))}
      ${tag('LANGUAGE', 'ENG')}
${fiBlock}
    </SONRS>
  </SIGNONMSGSRSV1>
  ${messages}
</OFX>`;
  // Phase 21 item 3: OFX 2.x consumers (Quicken, GnuCash, ofxhome
  // validators) expect CRLF line endings to match the OFX 1.x norm.
  return lf.replaceAll('\n', '\r\n');
};
