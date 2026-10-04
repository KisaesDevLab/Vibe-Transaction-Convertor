import type { schemas } from '@vibe-tx-converter/shared';

type Trntype = schemas.extraction.Trntype;

// Description normalization for FITID and TRNTYPE inference. Lower-case,
// collapse whitespace, strip merchant suffixes (#1234, *5678, store IDs),
// drop trailing punctuation. Keep alphanumerics, spaces, and a few
// disambiguating tokens.
export const normalizeDescription = (raw: string): string => {
  return raw
    .toLowerCase()
    .replace(/[#*]\s*\d+/g, ' ')
    .replace(/\bid\s*\d+\b/g, ' ')
    .replace(/\b\d{6,}\b/g, ' ') // long numeric tokens (terminal IDs)
    .replace(/[^a-z0-9 .-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

interface Rule {
  id: string;
  re: RegExp;
  trntype: Trntype;
  // When the sign matters, specify it from the account HOLDER's perspective:
  // 'positive' = money in. Credit-card amounts are stored inverted (charges
  // positive), so inferTrntypeWithReason() flips them before checking.
  sign?: 'positive' | 'negative' | 'any';
}

// First-match-wins. Order is the BuildPlan Phase 17 rule list verbatim
// (item 2). Any rule reordering is a behavior change — keep this aligned
// with the spec list and `docs/extraction.md`.
//
// Every alternation is wrapped as /\b(?:a|b|c)\b/ so the word boundaries
// bind to EACH alternative. The bare /\ba|b|c\b/ form only anchors the first
// and last, which let 'adp' match inside "LEADPAGES"/"HEADPHONES", 'gusto'
// inside "AUGUSTO'S", 'int paid' inside "SPRINT PAID" and 'to acct' inside
// "GEICO AUTO ACCT". The trailing boundary would also reject the plural /
// inflected / abbreviated forms banks print ("ONLINE TRANSFERS",
// "TRANSFERRED", "BILL PAYMENTS", "BILL PAYMT", "OVERDRAFT FEES",
// "ATM WITHDRAWALS", "POS PURCHASES", "ACH DEBITS"), so those suffixes are
// spelled out per word. Patterns run against normalizeDescription() output,
// where '/' and other punctuation are already spaces (hence `atm w ?d` for
// "ATM W/D").
const RULES: Rule[] = [
  // INTEREST — both directions (interest credit / int paid / int earned).
  {
    id: 'interest',
    re: /\b(?:interest|int paid|int earned|interest credit)\b/i,
    trntype: 'INT',
  },
  // DIVIDENDS.
  { id: 'dividend', re: /\b(?:dividends?|div paid)\b/i, trntype: 'DIV' },
  // Service / maintenance / monthly fees.
  {
    id: 'service-charge',
    re: /\b(?:service charges?|maintenance fees?|monthly fees?)\b/i,
    trntype: 'SRVCHG',
  },
  // Generic / NSF / overdraft fees. Excludes the more specific words above.
  { id: 'fee', re: /\b(?:fees?|overdraft fees?|nsf fees?)\b/i, trntype: 'FEE' },
  // ATM withdrawals — narrower than just /atm/ to avoid matching
  // "ATM Mastercard rebate".
  {
    id: 'atm',
    re: /\b(?:atm withdrawals?|atm w ?d|withdrawals? at machine|atm cash)\b/i,
    trntype: 'ATM',
  },
  // Direct deposits — includes the major payroll providers. Money IN only:
  // a business paying its own payroll ("GUSTO PAYROLL", "ADP WAGE PAY") is a
  // debit, not a direct deposit.
  {
    id: 'direct-deposit',
    re: /\b(?:direct deposits?|payroll|adp|paychex|gusto|salary deposits?)\b/i,
    trntype: 'DIRECTDEP',
    sign: 'positive',
  },
  // Direct/ACH debits.
  {
    id: 'direct-debit',
    re: /\b(?:ach debits?|preauthorized debits?|direct debits?)\b/i,
    trntype: 'DIRECTDEBIT',
  },
  // Internal transfers ("TRANSFERS", "TRANSFERRED", "XFERS").
  {
    id: 'transfer',
    re: /\b(?:transfer\w*|xfer\w*|to acct|from acct|tfr to|tfr from)\b/i,
    trntype: 'XFER',
  },
  // POS card purchases.
  {
    id: 'pos',
    re: /\b(?:pos purchases?|debit card purchases?|visa purchases?)\b/i,
    trntype: 'POS',
  },
  // Online bill pay / electronic payment ("BILL PAYMENT" is the common form;
  // "PAYMT" the common abbreviation).
  {
    id: 'online-payment',
    re: /\b(?:online pay(?:ments?|mt)|bill pay(?:ments?|mt)?|web pay(?:ments?|mt)?|epay(?:ments?|mt)?)\b/i,
    trntype: 'PAYMENT',
  },
  // Wire transfers — always XFER regardless of direction.
  { id: 'wire-in', re: /\bwire (?:in|received)\b/i, trntype: 'XFER' },
  { id: 'wire-out', re: /\bwire (?:out|sent)\b/i, trntype: 'XFER' },
  // Plain deposits (after we've ruled out direct-deposit and dividend).
  // Money IN only, like DIRECTDEP: a money-out row the direct-deposit rule
  // skipped ("DIRECT DEPOSIT REVERSAL") must not land here as a DEP.
  { id: 'deposit', re: /\bdeposits?\b/i, trntype: 'DEP', sign: 'positive' },
  // Cash withdrawals (narrowed — not just /\bcash\b/).
  { id: 'cash', re: /\b(?:cash withdrawals?|cash out)\b/i, trntype: 'CASH' },
];

export interface InferTrntypeInput {
  description: string;
  amountCents: bigint | number;
  llmHint?: Trntype | undefined;
  isCreditCard?: boolean | undefined;
  checkNumber?: string | null | undefined;
}

export interface TrntypeDecision {
  trntype: Trntype;
  reason: string;
}

// Phase 17 #21: returns both the result and a human-readable reason
// (rule id, "user override", or "sign-fallback"). Used in the review UI
// tooltip so operators can see why a row got its TRNTYPE.
export const inferTrntypeWithReason = (input: InferTrntypeInput): TrntypeDecision => {
  const amt = typeof input.amountCents === 'bigint' ? input.amountCents : BigInt(input.amountCents);
  // 1. checkNumber present → CHECK (Phase 17 item 2 first bullet).
  if (input.checkNumber && input.checkNumber.trim().length > 0) {
    return { trntype: 'CHECK', reason: 'rule:check-number' };
  }
  // 2. LLM hint, when present and a known enum value.
  if (input.llmHint) return { trntype: input.llmHint, reason: 'llm-hint' };
  // 3. Description-rule pass. Rule signs are holder-perspective (money in =
  // positive); credit-card amounts are stored inverted, so flip them first.
  const norm = normalizeDescription(input.description);
  const holderAmt = input.isCreditCard ? -amt : amt;
  for (const rule of RULES) {
    if (!rule.re.test(norm)) continue;
    if (rule.sign === 'negative' && holderAmt >= 0n) continue;
    if (rule.sign === 'positive' && holderAmt <= 0n) continue;
    return { trntype: rule.trntype, reason: `rule:${rule.id}` };
  }
  // 4. Sign fallback. On credit cards, positive amounts are debits/charges
  // and negative amounts are payments/credits (the customer's side of the
  // ledger is reversed vs a checking account).
  if (input.isCreditCard) {
    return amt > 0n
      ? { trntype: 'DEBIT', reason: 'sign-fallback:cc-positive' }
      : { trntype: 'PAYMENT', reason: 'sign-fallback:cc-negative' };
  }
  return amt >= 0n
    ? { trntype: 'CREDIT', reason: 'sign-fallback:positive' }
    : { trntype: 'DEBIT', reason: 'sign-fallback:negative' };
};

export const inferTrntype = (input: InferTrntypeInput): Trntype =>
  inferTrntypeWithReason(input).trntype;

// Phase 17 #21: explanation helper for the review UI tooltip.
export const getTrntypeReason = (input: InferTrntypeInput): string =>
  inferTrntypeWithReason(input).reason;
