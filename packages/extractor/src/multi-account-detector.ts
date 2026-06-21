// Detect when a single PDF carries more than one account (household
// statements). Phase 14 — the splitter UI confirms before extraction.
//
// Heuristic: scan each page for any of:
//   * "Account number: 1234567890"
//   * "Account ending in 1234" / "Account ending ••••1234"
//   * "Acct # 1234" / "Account # XXXX1234"
// Take the LAST 4 visible digits as the account-key per occurrence.
// If two or more distinct keys appear we flag a multi-account PDF.

import type { PageText } from './preprocess.js';

const ACCOUNT_REGEXES: RegExp[] = [
  /account\s*(?:number|no\.?|#|ending(?:\s*in)?)\s*[:#-]?\s*(?:•|x|X|\*|-)*(\d{4,})/g,
  /acct\s*(?:no\.?|#|ending(?:\s*in)?)?\s*[:#-]?\s*(?:•|x|X|\*|-)*(\d{4,})/g,
];

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

export const detectMultiAccount = (pages: PageText[]): MultiAccountAnalysis => {
  const occurrences: AccountOccurrence[] = [];
  for (const page of pages) {
    const haystack = page.text.toLowerCase();
    for (const re of ACCOUNT_REGEXES) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(haystack)) !== null) {
        const digits = m[1] ?? '';
        const last4 = digits.slice(-4);
        if (last4.length === 4) {
          occurrences.push({ page: page.index, last4 });
        }
      }
    }
  }

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
