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
  // QFX only — synthetic per-account user identifier. Phase 23 #2/#3.
  // When undefined the QFX writer derives one from intuUseridSeed.
  intuUserid?: string | undefined;
  intuUseridSeed?: string | undefined; // typically account.id (UUID)
}

// Phase 23 #3: synthesize INTU.USERID = 'VTC' + UUID without dashes.
// Stable across re-exports because it's a pure function of the seed.
export const deriveIntuUserid = (seed: string): string =>
  `VTC${seed.replace(/-/g, '').toUpperCase()}`;

export interface StmtTrn {
  trntype: Trntype;
  postedDate: string; // YYYY-MM-DD
  amountCents: bigint; // signed
  fitid: string;
  name: string; // truncated NAME
  memo?: string | undefined;
  checkNumber?: string | undefined;
}

// Phase 22 items 19/21: BANKID fallback ladder when no routing is on file.
// Order: account.routing → 9-digit BID padded with leading zeros →
// '000000000'. QuickBooks doesn't validate BANKID, so a numeric placeholder
// keeps the import happy. The previous '999999999' was non-canonical.
export const FALLBACK_BANK_ID = '000000000';

export type BankIdSource = 'routing' | 'bid-9' | 'bid-padded' | 'fallback';

export const resolveBankId = (
  routingNumber: string | null | undefined,
  intuBid: string | null | undefined,
): { bankId: string; source: BankIdSource } => {
  if (routingNumber && /^\d{9}$/.test(routingNumber)) {
    return { bankId: routingNumber, source: 'routing' };
  }
  if (intuBid && /^\d{9}$/.test(intuBid)) {
    return { bankId: intuBid, source: 'bid-9' };
  }
  if (intuBid && /^\d{1,9}$/.test(intuBid)) {
    return { bankId: intuBid.padStart(9, '0'), source: 'bid-padded' };
  }
  return { bankId: FALLBACK_BANK_ID, source: 'fallback' };
};

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
