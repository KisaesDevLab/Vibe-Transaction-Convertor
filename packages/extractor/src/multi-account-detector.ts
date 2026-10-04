// Detect when a single PDF carries more than one account (household
// statements). Phase 14 — the splitter UI confirms before extraction.
//
// Biased toward detection: a miss removes the split option entirely (the split
// UI opens only from detectedSplits), while a false positive is only a
// dismissible banner. Heuristic:
//   * Find account-number labels — "Account number: 0012-3456-7890",
//     "Account Number - 1111222233", "Account ending in 1234" /
//     "Account ending ••••1234", "Acct # XXXX1234".
//   * The account key is the LAST 4 digits of the WHOLE grouped/masked number
//     after the label (never its first digit group).
//   * Every label hit counts — a lone mid-page section header, a footer-only
//     number, a header line that also prints a balance or the period — EXCEPT
//     a hit that names a counterparty account: one on a transaction row (the
//     line starts with a posting date AND carries a money amount) or in a
//     transfer description ("ONLINE TRANSFER TO SAV ACCT ENDING IN 5678",
//     "PAYMENT TO ACCT 9876", "TFR FROM SAV ACCT 5678").
// Two or more distinct keys → a multi-account PDF.

import type { PageText } from './preprocess.js';

// Detection only needs each page's index + text, so accept the structural
// subset — this lets both the text-layer path (full PageText) and the OCR path
// (transcribed {index, text}) call it.
export type DetectablePage = Pick<PageText, 'index' | 'text'>;

// An account-number label (matched on lower-cased text). Word-bounded so
// "subaccount" / "xacct" don't match.
const LABEL_RE =
  /\b(?:account\s*(?:number|num\.?|no\.?|#|ending(?:\s*in)?)|acct\.?\s*(?:number|num\.?|no\.?|#|ending(?:\s*in)?)?)/g;
// The number right after a label (optional ":" / "#" / "." / dash separator;
// may sit on the next line). Captures the whole token: digit/mask groups joined
// by dashes ("0012-3456-7890", "xxxx-xxxx-1234") or by single spaces between
// 4-character groups ("4147 2000 1234 5678", "xxxx xxxx xxxx 1234").
const NUMBER_RE = /^\s*[:#.–—-]?\s*([x*•.-]*[\dx*•]+(?:-[\dx*•]+)*(?: [\dx*•]{4}(?![\dx*•]))*)/;
// A transaction row starts with a (posting) date — also inside a markdown table
// cell — AND carries a money amount (1,234.56 / 1234.56 / $12.50). A leading
// date RANGE is the statement period ("03/01/2024 - 03/31/2024 Account …"),
// i.e. a header line, not a row.
const LEADING_DATE_RE = /^\s*\|?\s*\d{1,2}[/-]\d{1,2}\b/;
const LEADING_DATE_RANGE_RE =
  /^\s*\|?\s*\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\s*(?:-|–|—|to|thru|through)\s*\d{1,2}[/-]\d{1,2}\b/;
const MONEY_RE = /(?:^|[\s$(+|-])\$?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}(?!\d|\.\d)/;
const isTransactionRow = (line: string): boolean =>
  LEADING_DATE_RE.test(line) && !LEADING_DATE_RANGE_RE.test(line) && MONEY_RE.test(line);
// A transfer description names the OTHER account of the transfer: transfer
// wording anywhere before the label, or "to"/"from" right before it (at most
// one word between: "to acct", "from sav acct").
const TRANSFER_RE = /\b(?:transfers?|transferred|xfer|trnsfr|tfr|trf)\b/;
const TO_FROM_ACCT_RE = /\b(?:to|from)\s+(?:[a-z]+\s+)?$/;

export interface AccountOccurrence {
  page: number;
  last4: string;
}

export interface MultiAccountAnalysis {
  multiAccount: boolean;
  occurrences: AccountOccurrence[];
  uniqueLast4: string[];
  // Suggested splits — page ranges grouped by account key.
  splits: Array<{ last4: string; pageStart: number; pageEnd: number }>;
}

const findAccountHits = (page: DetectablePage): AccountOccurrence[] => {
  const text = page.text.toLowerCase();
  const hits: AccountOccurrence[] = [];
  LABEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LABEL_RE.exec(text)) !== null) {
    const labelEnd = m.index + m[0].length;
    const num = NUMBER_RE.exec(text.slice(labelEnd, labelEnd + 80));
    const digits = (num?.[1] ?? '').replace(/\D/g, '');
    if (digits.length < 4) continue;
    const lineStart = text.lastIndexOf('\n', m.index - 1) + 1;
    const nl = text.indexOf('\n', m.index);
    if (isTransactionRow(text.slice(lineStart, nl < 0 ? text.length : nl))) continue;
    const beforeLabel = text.slice(lineStart, m.index);
    if (TRANSFER_RE.test(beforeLabel) || TO_FROM_ACCT_RE.test(beforeLabel)) continue;
    hits.push({ page: page.index, last4: digits.slice(-4) });
  }
  return hits;
};

export const detectMultiAccount = (pages: DetectablePage[]): MultiAccountAnalysis => {
  // Every non-counterparty label hit counts — even a single one (see header).
  const occurrences = pages.flatMap(findAccountHits);

  // Collapse consecutive same-account pages into a single split. If a
  // page has no detection, attribute it to the most recent split.
  const uniqueLast4 = Array.from(new Set(occurrences.map((o) => o.last4)));
  if (uniqueLast4.length <= 1) {
    return {
      multiAccount: false,
      occurrences,
      uniqueLast4,
      splits:
        uniqueLast4.length === 1
          ? [{ last4: uniqueLast4[0]!, pageStart: 0, pageEnd: pages.length - 1 }]
          : [],
    };
  }

  const pageOwner: Array<string | null> = pages.map(() => null);
  for (const o of occurrences) pageOwner[o.page] = o.last4;
  return { multiAccount: true, occurrences, uniqueLast4, splits: splitsFromPageOwner(pageOwner) };
};

// Collapse a per-page owner array (some entries may be null) into contiguous
// page-range splits. Forward-fills gaps from the previous identified page and
// back-fills any leading nulls from the first identified, so every page is
// attributed before ranges form. Shared by the text- and OCR-path detectors.
const splitsFromPageOwner = (
  owner: Array<string | null>,
): Array<{ last4: string; pageStart: number; pageEnd: number }> => {
  const pageOwner = [...owner];
  let last: string | null = null;
  for (let i = 0; i < pageOwner.length; i += 1) {
    const cur = pageOwner[i] ?? null;
    if (cur === null) pageOwner[i] = last;
    else last = cur;
  }
  let firstOwner: string | null = null;
  for (const o of pageOwner) {
    if (o !== null) {
      firstOwner = o;
      break;
    }
  }
  if (firstOwner !== null) {
    for (let i = 0; i < pageOwner.length; i += 1) {
      if (pageOwner[i] === null) pageOwner[i] = firstOwner;
    }
  }
  const splits: Array<{ last4: string; pageStart: number; pageEnd: number }> = [];
  if (pageOwner.length === 0) return splits;
  let curStart = 0;
  for (let i = 1; i < pageOwner.length; i += 1) {
    if (pageOwner[i] !== pageOwner[i - 1]) {
      splits.push({ last4: pageOwner[i - 1]!, pageStart: curStart, pageEnd: i - 1 });
      curStart = i;
    }
  }
  splits.push({
    last4: pageOwner[pageOwner.length - 1]!,
    pageStart: curStart,
    pageEnd: pageOwner.length - 1,
  });
  return splits;
};

// Take the trailing 4 digits of a (possibly masked) account number, e.g.
// "****1234" / "xxxx-1234" → "1234". null when fewer than 4 digits remain.
export const last4FromMasked = (masked: string | null | undefined): string | null => {
  if (!masked) return null;
  const digits = masked.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
};

// A page-range slice carrying the account it belongs to. 0-based, inclusive.
export interface AccountSlice {
  pageStart: number;
  pageEnd: number;
  last4: string | null;
}

// Multi-account detection for the OCR/vision path, where there is no page text
// to regex — instead each rasterized batch yields the account number the model
// read from those page(s). Two or more distinct account keys → multi-account.
// Coarser than the text-layer detector (batch-, not page-, granularity); the
// split UI lets the operator confirm/adjust the suggested ranges.
export const detectMultiAccountFromSlices = (
  slices: AccountSlice[],
  totalPages: number,
): MultiAccountAnalysis => {
  const occurrences: AccountOccurrence[] = [];
  for (const s of slices) {
    if (s.last4 && s.last4.length === 4) occurrences.push({ page: s.pageStart, last4: s.last4 });
  }
  const uniqueLast4 = Array.from(new Set(occurrences.map((o) => o.last4)));
  if (uniqueLast4.length <= 1) {
    return {
      multiAccount: false,
      occurrences,
      uniqueLast4,
      splits:
        uniqueLast4.length === 1 && totalPages > 0
          ? [{ last4: uniqueLast4[0]!, pageStart: 0, pageEnd: totalPages - 1 }]
          : [],
    };
  }
  const pageOwner: Array<string | null> = Array.from({ length: totalPages }, () => null);
  for (const s of slices) {
    if (!s.last4) continue;
    for (let p = Math.max(0, s.pageStart); p <= s.pageEnd && p < totalPages; p += 1) {
      pageOwner[p] = s.last4;
    }
  }
  return { multiAccount: true, occurrences, uniqueLast4, splits: splitsFromPageOwner(pageOwner) };
};
