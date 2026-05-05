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

export const renderStmtTrnXml = (trn: Stmt['transactions'][number]): string =>
  `      <STMTTRN>
        ${tag('TRNTYPE', trn.trntype)}
        ${tag('DTPOSTED', ofxDate(trn.postedDate))}
        ${tag('TRNAMT', centsToDecimal(trn.amountCents))}
        ${tag('FITID', xmlEscape(trn.fitid))}` +
  (trn.checkNumber ? `\n        ${tag('CHECKNUM', xmlEscape(trn.checkNumber))}` : '') +
  `\n        ${tag('NAME', xmlEscape(trn.name.slice(0, 32)))}` +
  (trn.memo ? `\n        ${tag('MEMO', xmlEscape(trn.memo.slice(0, 255)))}` : '') +
  `\n      </STMTTRN>`;

export const renderOfxXml = (stmt: Stmt): string => {
  const isCC = stmt.bankAccountInfo.accountType === 'CREDITCARD';
  const trnList = stmt.transactions.map(renderStmtTrnXml).join('\n');

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
      ${tag('DTASOF', ofxDateTime(stmt.asOf))}
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
      ${tag('DTASOF', ofxDateTime(stmt.asOf))}
    </LEDGERBAL>
  </STMTRS>
</STMTTRNRS>`;

  const messages = isCC
    ? `<CREDITCARDMSGSRSV1>${stmtBlock}</CREDITCARDMSGSRSV1>`
    : `<BANKMSGSRSV1>${stmtBlock}</BANKMSGSRSV1>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <SIGNONMSGSRSV1>
    <SONRS>
      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
      ${tag('DTSERVER', ofxDateTime(stmt.asOf))}
      ${tag('LANGUAGE', 'ENG')}
    </SONRS>
  </SIGNONMSGSRSV1>
  ${messages}
</OFX>`;
};
