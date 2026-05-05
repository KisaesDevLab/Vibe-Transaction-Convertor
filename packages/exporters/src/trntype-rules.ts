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
  re: RegExp;
  trntype: Trntype;
  // When the sign matters (e.g. PAYMENT must be a credit on a CC), specify.
  sign?: 'positive' | 'negative' | 'any';
}

// First-match-wins. Order from most specific to most general.
const RULES: Rule[] = [
  { re: /\batm\b/i, trntype: 'ATM' },
  { re: /\b(direct\s*dep(?:osit)?|payroll|dir\s*dep)\b/i, trntype: 'DIRECTDEP' },
  { re: /\b(direct\s*deb(?:it)?|ach\s*debit|preauth\s*debit)\b/i, trntype: 'DIRECTDEBIT' },
  { re: /\bach\b/i, trntype: 'XFER' },
  { re: /\bwire\b/i, trntype: 'XFER' },
  { re: /\bcheck\s*#?\d+\b/i, trntype: 'CHECK' },
  { re: /\bsrvchg|service\s*charge|account\s*fee\b/i, trntype: 'SRVCHG' },
  { re: /\boverdraft|nsf|insufficient\s*funds\b/i, trntype: 'FEE' },
  { re: /\bint(?:erest)?\s*(?:earned|paid|credit)?\b/i, trntype: 'INT' },
  { re: /\bdiv(?:idend)?\b/i, trntype: 'DIV' },
  {
    re: /\b(payment|pmt)\s*(?:received|thank\s*you|credit)\b/i,
    trntype: 'PAYMENT',
    sign: 'negative',
  },
  { re: /\btransfer\b/i, trntype: 'XFER' },
  { re: /\b(deposit|dep)\b/i, trntype: 'DEP' },
  { re: /\bpos\s*(?:purchase|debit)?\b/i, trntype: 'POS' },
  { re: /\bcash\b/i, trntype: 'CASH' },
  { re: /\bhold\b/i, trntype: 'HOLD' },
  { re: /\b(?:fee|charge)\b/i, trntype: 'FEE' },
];

export interface InferTrntypeInput {
  description: string;
  amountCents: bigint | number;
  llmHint?: Trntype | undefined;
  isCreditCard?: boolean | undefined;
}

export const inferTrntype = (input: InferTrntypeInput): Trntype => {
  const norm = normalizeDescription(input.description);
  const amt = typeof input.amountCents === 'bigint' ? input.amountCents : BigInt(input.amountCents);
  for (const rule of RULES) {
    if (!rule.re.test(norm)) continue;
    if (rule.sign === 'negative' && amt >= 0n) continue;
    if (rule.sign === 'positive' && amt <= 0n) continue;
    return rule.trntype;
  }
  // LLM tiebreaker
  if (input.llmHint) return input.llmHint;
  // Fallback by sign
  if (input.isCreditCard) {
    return amt > 0n ? 'DEBIT' : 'PAYMENT';
  }
  return amt >= 0n ? 'CREDIT' : 'DEBIT';
};
