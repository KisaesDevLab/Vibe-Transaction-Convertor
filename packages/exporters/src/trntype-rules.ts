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
  // When the sign matters (e.g. PAYMENT must be a credit on a CC), specify.
  sign?: 'positive' | 'negative' | 'any';
}

// First-match-wins. Order is the BuildPlan Phase 17 rule list verbatim
// (item 2). Any rule reordering is a behavior change — keep this aligned
// with the spec list and `docs/extraction.md`.
const RULES: Rule[] = [
  // INTEREST — both directions (interest credit / int paid / int earned).
  { id: 'interest', re: /\binterest|int paid|int earned|interest credit\b/i, trntype: 'INT' },
  // DIVIDENDS.
  { id: 'dividend', re: /\bdividend|div paid\b/i, trntype: 'DIV' },
  // Service / maintenance / monthly fees.
  {
    id: 'service-charge',
    re: /\bservice charge|maintenance fee|monthly fee\b/i,
    trntype: 'SRVCHG',
  },
  // Generic / NSF / overdraft fees. Excludes the more specific words above.
  { id: 'fee', re: /\bfee\b|overdraft fee|nsf fee\b/i, trntype: 'FEE' },
  // ATM withdrawals — narrower than just /atm/ to avoid matching
  // "ATM Mastercard rebate".
  {
    id: 'atm',
    re: /\batm withdrawal|atm w\/d|withdrawal at machine|atm cash\b/i,
    trntype: 'ATM',
  },
  // Direct deposits — includes the major payroll providers.
  {
    id: 'direct-deposit',
    re: /\bdirect deposit|payroll|adp|paychex|gusto|salary deposit\b/i,
    trntype: 'DIRECTDEP',
  },
  // Direct/ACH debits.
  {
    id: 'direct-debit',
    re: /\bach debit|preauthorized debit|direct debit\b/i,
    trntype: 'DIRECTDEBIT',
  },
  // Internal transfers.
  { id: 'transfer', re: /\btransfer|xfer|to acct|from acct|tfr to|tfr from\b/i, trntype: 'XFER' },
  // POS card purchases.
  { id: 'pos', re: /\bpos purchase|debit card purchase|visa purchase\b/i, trntype: 'POS' },
  // Online bill pay / electronic payment.
  { id: 'online-payment', re: /\bonline payment|bill pay|web pay|epay\b/i, trntype: 'PAYMENT' },
  // Wire transfers — always XFER regardless of direction.
  { id: 'wire-in', re: /\bwire (in|received)\b/i, trntype: 'XFER' },
  { id: 'wire-out', re: /\bwire (out|sent)\b/i, trntype: 'XFER' },
  // Plain deposits (after we've ruled out direct-deposit and dividend).
  { id: 'deposit', re: /\bdeposit\b/i, trntype: 'DEP' },
  // Cash withdrawals (narrowed — not just /\bcash\b/).
  { id: 'cash', re: /\bcash withdrawal|cash out\b/i, trntype: 'CASH' },
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
  // 3. Description-rule pass.
  const norm = normalizeDescription(input.description);
  for (const rule of RULES) {
    if (!rule.re.test(norm)) continue;
    if (rule.sign === 'negative' && amt >= 0n) continue;
    if (rule.sign === 'positive' && amt <= 0n) continue;
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
