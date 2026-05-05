// Shared AST for OFX 2.x XML and OFX 1.0.2 SGML (ADR-008). The two
// writers serialize this same node tree to their respective profiles.

import type { schemas } from '@vibe-tx-converter/shared';

type Trntype = schemas.extraction.Trntype;

export interface Stmt {
  bankAccountInfo: BankAccountInfo;
  transactions: StmtTrn[];
  ledgerBalanceCents: bigint;
  availableBalanceCents?: bigint | undefined;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  asOf: Date; // for <DTSERVER>
  currency: 'USD';
}

export interface BankAccountInfo {
  bankId: string; // routing number; required by spec, fallback documented in Phase 22
  accountId: string; // account number
  accountType: 'CHECKING' | 'SAVINGS' | 'MONEYMRKT' | 'CREDITLINE' | 'CREDITCARD';
  // Intuit-specific (QBO + QFX writers emit, OFX 2.x optional):
  intuBid?: string | undefined;
  intuOrg?: string | undefined;
}

export interface StmtTrn {
  trntype: Trntype;
  postedDate: string; // YYYY-MM-DD
  amountCents: bigint; // signed
  fitid: string;
  name: string; // truncated NAME
  memo?: string | undefined;
  checkNumber?: string | undefined;
}

export const FALLBACK_BANK_ID = '999999999'; // 9-digit placeholder when no
// routing on file (Phase 22 item 19). QuickBooks doesn't validate BANKID.

export const ofxDate = (iso: string): string => iso.replace(/-/g, ''); // YYYYMMDD
export const ofxDateTime = (d: Date): string => {
  const pad = (n: number, w = 2): string => n.toString().padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
};

export const centsToDecimal = (cents: bigint): string => {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${negative ? '-' : ''}${whole.toString()}.${frac.toString().padStart(2, '0')}`;
};

export const accountTypeForBank = (
  t: BankAccountInfo['accountType'],
): 'CHECKING' | 'SAVINGS' | 'MONEYMRKT' | 'CREDITLINE' => {
  if (t === 'CREDITCARD') {
    throw new Error('credit-card statements use CCSTMTRS, not BANKACCTFROM');
  }
  return t;
};
