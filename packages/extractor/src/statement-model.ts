// Statement-model extraction engine (ADR-pending; see
// docs/integrations/statement-models.md). The purpose-built models
// `qwen2.5-stmt` / `qwen2.5-stmt-32b` are served over Ollama's native
// `/api/chat`, bake their own CPA prompt, and ALWAYS emit their own schema
// (date/payee/source_text/reconciliation/top-level confidence) regardless of the
// `format` we send. So this engine: sends the model's own schema as `format`
// (reinforcement), then MAPS the model output back to our internal
// ExtractionResult at the boundary — keeping the DB, reconciler, exporters, and
// UI unchanged. The whole-statement call here is the v1; per-page + header-crop
// (the integration doc §4) are the next optimization.

import { schemas } from '@vibe-tx-converter/shared';

type ExtractionResult = schemas.extraction.ExtractionResult;
type Trntype = schemas.extraction.Trntype;
type SourceDateFormat = schemas.extraction.SourceDateFormat;

// Day/month order of a statement's numeric dates: the model's declared
// source_date_format (when MDY/DMY/YMD) or the operator's confirmation after an
// AMBIGUOUS halt (dateFormatOverride).
export type DateOrder = 'MDY' | 'DMY' | 'YMD';

// Common spellings of a declared source_date_format, keyed by their upper-cased
// letters only ("MM/DD/YYYY" → MMDDYYYY, "yyyy-mm-dd" → YYYYMMDD, "ISO 8601" →
// ISO). Keys are upper-case only, so no Object.prototype member can collide.
const DATE_FORMAT_ALIASES: Readonly<Record<string, SourceDateFormat>> = {
  MDY: 'MDY',
  MMDDYYYY: 'MDY',
  MMDDYY: 'MDY',
  MMDD: 'MDY',
  MDYYYY: 'MDY',
  MDYY: 'MDY',
  MD: 'MDY',
  DMY: 'DMY',
  DDMMYYYY: 'DMY',
  DDMMYY: 'DMY',
  DDMM: 'DMY',
  DMYYYY: 'DMY',
  DMYY: 'DMY',
  DM: 'DMY',
  YMD: 'YMD',
  YYYYMMDD: 'YMD',
  YYMMDD: 'YMD',
  YYYYMD: 'YMD',
  ISO: 'YMD',
  TEXTUAL: 'TEXTUAL',
  AMBIGUOUS: 'AMBIGUOUS',
};

// The model's declared source_date_format (any common spelling, any case) → the
// enum; null when missing or unrecognized (callers treat that as AMBIGUOUS, so
// the statement halts for locale confirmation rather than guessing).
export const normalizeDeclaredDateFormat = (v: unknown): SourceDateFormat | null =>
  typeof v === 'string'
    ? (DATE_FORMAT_ALIASES[v.toUpperCase().replace(/[^A-Z]/g, '')] ?? null)
    : null;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar date in ISO form (rejects 2026-02-30 / 2026-13-01).
export const isValidIsoDate = (s: unknown): s is string => {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m! < 1 || m! > 12 || d! < 1 || d! > 31) return false;
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
};

// Normalize one emitted/printed date to ISO (YYYY-MM-DD), honoring the
// statement's date order. Valid ISO passes through; a four-digit-year-first
// date (2025/3/5) is year-month-day in every convention. For D/M vs M/D:
//   - order DMY / MDY → read strictly that way (an impossible reading → null);
//   - order YMD → YY/MM/DD when the last group is a 2-digit year;
//   - order unknown (TEXTUAL / AMBIGUOUS / undeclared) → a component > 12
//     fixes the reading; when both are <= 12 (and differ) it is read as
//     month/day (v1 is en-US) and flagged `ambiguous` so the caller can surface
//     it for review instead of silently guessing.
// iso=null when unreadable.
export const normalizeStatementDate = (
  s: unknown,
  order?: DateOrder,
): { iso: string | null; ambiguous: boolean } => {
  if (isValidIsoDate(s)) return { iso: s, ambiguous: false };
  if (typeof s !== 'string') return { iso: null, ambiguous: false };
  const t = s.trim();
  const build = (y: string, mo: string, d: string): string | null => {
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    return isValidIsoDate(iso) ? iso : null;
  };
  const ymd = t.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (ymd) return { iso: build(ymd[1]!, ymd[2]!, ymd[3]!), ambiguous: false };
  const m = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/);
  if (!m) return { iso: null, ambiguous: false };
  const a = m[1]!;
  const b = m[2]!;
  const c = m[3]!;
  if (order === 'YMD' && c.length === 2) {
    return { iso: build(`20${a.padStart(2, '0')}`, b, c), ambiguous: false };
  }
  const year = c.length === 2 ? `20${c}` : c;
  const na = Number(a);
  const nb = Number(b);
  let monthFirst = true;
  let ambiguous = false;
  if (order === 'DMY') monthFirst = false;
  else if (order !== 'MDY') {
    // Unknown order (or YMD contradicted by a trailing 4-digit year).
    if (na > 12 && nb <= 12) monthFirst = false;
    else if (!(nb > 12 && na <= 12)) ambiguous = na !== nb && na <= 12 && nb <= 12;
  }
  const iso = monthFirst ? build(year, a, b) : build(year, b, a);
  return { iso, ambiguous: iso !== null && ambiguous };
};

const ORDER_WORDS: Record<DateOrder, string> = {
  MDY: 'month/day/year',
  DMY: 'day/month/year',
  YMD: 'year/month/day',
};

// The per-page user-message line that carries an operator-confirmed date order
// to the statement model (which has no system prompt of ours to put it in).
export const statementDateOrderLine = (order: DateOrder): string =>
  `Dates on this statement are written in ${order} order (${ORDER_WORDS[order]}).`;

// The `format` we send on /api/chat — the model's native shape. Sent as
// reinforcement; the model emits this shape with or without it.
export const STATEMENT_MODEL_FORMAT = {
  type: 'object',
  properties: {
    account: {
      type: 'object',
      properties: {
        holder_name: { type: ['string', 'null'] },
        account_number: { type: ['string', 'null'] },
        account_type: { type: 'string', enum: ['bank', 'credit_card'] },
      },
    },
    institution: {
      type: 'object',
      properties: {
        name: { type: ['string', 'null'] },
        address: { type: ['string', 'null'] },
      },
    },
    period: {
      type: 'object',
      properties: {
        start_date: { type: ['string', 'null'] },
        end_date: { type: ['string', 'null'] },
        currency: { type: 'string' },
      },
    },
    balances: {
      type: 'object',
      properties: {
        opening_balance_cents: { type: ['integer', 'null'] },
        closing_balance_cents: { type: ['integer', 'null'] },
      },
    },
    source_date_format: { type: 'string', enum: ['MDY', 'DMY', 'YMD', 'TEXTUAL', 'AMBIGUOUS'] },
    transactions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: ['string', 'null'] },
          payee: { type: ['string', 'null'] },
          amount_cents: { type: 'integer' },
          running_balance_cents: { type: ['integer', 'null'] },
          trntype: { type: 'string' },
          check_number: { type: ['string', 'null'] },
          source_page: { type: ['integer', 'null'] },
          source_text: { type: ['string', 'null'] },
        },
        required: ['amount_cents'],
      },
    },
  },
  required: ['transactions'],
} as const;

// The model's trntype taxonomy → our OFX-aligned enum (used only as a hint;
// inferTrntype derives the authoritative OFX type downstream).
const TRNTYPE_MAP: Record<string, Trntype> = {
  DEPOSIT: 'DEP',
  WITHDRAWAL: 'DEBIT',
  TRANSFER: 'XFER',
  INTEREST: 'INT',
  PAYMENT: 'PAYMENT',
  CHECK: 'CHECK',
  FEE: 'FEE',
  POS: 'POS',
  ATM: 'ATM',
  DEBIT: 'DEBIT',
  CREDIT: 'CREDIT',
  OTHER: 'OTHER',
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

interface StatementModelRaw {
  account?: { account_number?: unknown; account_type?: unknown } | null;
  institution?: { name?: unknown } | null;
  period?: { start_date?: unknown; end_date?: unknown } | null;
  balances?: { opening_balance_cents?: unknown; closing_balance_cents?: unknown } | null;
  source_date_format?: unknown;
  confidence?: unknown;
  transactions?: Array<Record<string, unknown>> | null;
}

// Split page-marked markdown into per-page chunks. The statement models take
// ONE page per call (whole-statement output truncates at 25k+ tokens), so the
// engine loops over these. Robust to BOTH page-marker conventions:
//   - `# Page N`  (the worker adds these when joining per-page OCR/text)
//   - `<!-- page N -->`  (GLM-OCR / Vibe-PaddleOCR emit these INLINE when the
//      whole document comes back in one markdown blob)
// Falls back to form-feed (\f, pdftotext) breaks, then to a single page.
export const splitMarkdownPages = (text: string): Array<{ pageNum: number; text: string }> => {
  // A `# Page N` markdown header (line-anchored) OR a `<!-- page N -->` comment.
  const marker = /(?:^[ \t]{0,3}#{1,6}\s*page\s+(\d+)\b[^\n]*$)|(?:<!--\s*page\s+(\d+)\s*-->)/gim;
  const matches = [...text.matchAll(marker)];
  if (matches.length === 0) {
    // No explicit markers — try form-feed page breaks before giving up.
    if (text.includes('\f')) {
      const parts = text
        .split('\f')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      if (parts.length > 1) return parts.map((t, i) => ({ pageNum: i + 1, text: t }));
    }
    return [{ pageNum: 1, text: text.trim() }];
  }
  const pages: Array<{ pageNum: number; text: string }> = [];
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i]!;
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? text.length) : text.length;
    const body = text.slice(start, end).trim();
    const n = Number(m[1] ?? m[2]);
    if (body.length > 0) {
      pages.push({ pageNum: Number.isFinite(n) && n > 0 ? n : i + 1, text: body });
    }
  }
  return pages.length > 0 ? pages : [{ pageNum: 1, text: text.trim() }];
};

const objKeys = (v: unknown): number => (v && typeof v === 'object' ? Object.keys(v).length : 0);
const numField = (o: unknown, key: string): number | null => {
  const v = o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

// Merge per-page native outputs into one. Transactions are concatenated in page
// order with source_page stamped from the page index (per-page calls all say
// page 1). Metadata is taken from the first page that carries it; opening comes
// from the first page that prints it, closing from the LAST.
export const mergeStatementPages = (
  pages: Array<{ pageNum: number; raw: Record<string, unknown> }>,
): Record<string, unknown> => {
  const firstWith = (key: string): unknown =>
    pages
      .map((p) => p.raw[key])
      .find((v) => v != null && (typeof v !== 'object' || objKeys(v) > 0)) ?? null;
  const transactions: unknown[] = [];
  for (const p of pages) {
    const arr = Array.isArray(p.raw.transactions) ? (p.raw.transactions as unknown[]) : [];
    for (const t of arr) {
      transactions.push(
        t && typeof t === 'object' ? { ...(t as object), source_page: p.pageNum } : t,
      );
    }
  }
  const opening = pages
    .map((p) => numField(p.raw.balances, 'opening_balance_cents'))
    .find((v) => v !== null);
  const closing = [...pages]
    .reverse()
    .map((p) => numField(p.raw.balances, 'closing_balance_cents'))
    .find((v) => v !== null);
  return {
    account: firstWith('account'),
    institution: firstWith('institution'),
    period: firstWith('period'),
    balances: { opening_balance_cents: opening ?? null, closing_balance_cents: closing ?? null },
    source_date_format: firstWith('source_date_format'),
    confidence: pages.map((p) => p.raw.confidence).find((c) => typeof c === 'number') ?? null,
    transactions,
  };
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const intOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;

export interface MapStatementModelOptions {
  // Operator-confirmed date order (after an AMBIGUOUS halt). Drives how numeric
  // row dates are read and forces source_date_format to { override, 1 }.
  dateFormatOverride?: DateOrder | undefined;
}

// Map the statement model's native output to our internal ExtractionResult shape.
// Returns a plain object; the caller runs ExtractionResult.parse() on it so Zod
// validation, defaults, and the trntype/date normalization still apply. Rows
// without a numeric amount are dropped (and noted) rather than failing the batch.
export const mapStatementModelOutput = (
  raw: StatementModelRaw,
  opts: MapStatementModelOptions = {},
): Record<string, unknown> => {
  const docConfidence = (() => {
    const c = raw.confidence;
    return typeof c === 'number' && c >= 0 && c <= 1 ? c : 0.8;
  })();
  const fmt = normalizeDeclaredDateFormat(raw.source_date_format) ?? 'AMBIGUOUS';
  // How numeric dates are read: the operator's confirmed order, else the
  // model's declared one; undefined (TEXTUAL / AMBIGUOUS) = infer per date.
  const order: DateOrder | undefined =
    opts.dateFormatOverride ??
    (fmt === 'MDY' || fmt === 'DMY' || fmt === 'YMD' ? (fmt as DateOrder) : undefined);
  const acctNum = str(raw.account?.account_number);
  const acctType = raw.account?.account_type;
  // period.start/end are required ISO dates; normalized with the same order as
  // the rows (null when absent/unreadable → derived from the row dates below).
  const isoStart = normalizeStatementDate(raw.period?.start_date, order).iso;
  const isoEnd = normalizeStatementDate(raw.period?.end_date, order).iso;

  // Balance-marker rows ("Beginning/Opening/Previous Balance") are not
  // transactions — some models emit them with the opening figure in the amount
  // column, which double-counts and corrupts the derived opening. Drop them.
  // Matches anywhere — source_text carries the date/amount prefix
  // ("04/01  Beginning Balance  2,178.46  2,178.46"), so it can't be anchored.
  const BALANCE_MARKER = /\b(beginning|opening|previous|starting|ending|closing)\s+balance\b/i;

  let amountDropped = 0;
  let dateDropped = 0;
  let dateDefaulted = 0;
  let dateAmbiguous = 0;
  const transactions = (raw.transactions ?? [])
    .map((t) => {
      const amount = intOrNull(t.amount_cents);
      if (amount === null) {
        amountDropped += 1;
        return null;
      }
      const descText = str(t.source_text) ?? str(t.payee) ?? '';
      if (BALANCE_MARKER.test(descText)) return null; // not a transaction
      // Format-aware read of the row date (honors the override / declared
      // order). A row with no readable date falls back to the statement start
      // date — counted and surfaced in notes so it holds for review, never silent.
      const norm = normalizeStatementDate(t.date, order);
      if (norm.ambiguous) dateAmbiguous += 1;
      let postedDate = norm.iso;
      if (postedDate === null && isoStart !== null) {
        postedDate = isoStart;
        dateDefaulted += 1;
      }
      const trntypeRaw =
        typeof t.trntype === 'string' ? TRNTYPE_MAP[t.trntype.toUpperCase()] : undefined;
      const description = (descText || '[unreadable]').slice(0, 500);
      return {
        // Grounded raw line drives FITID + OFX <MEMO>; the model's `payee`
        // (cleaned merchant) goes to description when no source_text.
        posted_date: postedDate,
        description,
        amount_cents: amount,
        running_balance_cents: intOrNull(t.running_balance_cents),
        check_number: str(t.check_number),
        // The model's `payee` is the merchant/description, NOT the check payee
        // (which the check-resolver fills from cancelled-check images). Leave null.
        payee: null,
        ...(trntypeRaw ? { trntype: trntypeRaw } : {}),
        source_page: Math.max(1, intOrNull(t.source_page) ?? 1),
        // The model emits only a doc-level confidence; apply it per row so the
        // per-row review-hold gate keeps working.
        confidence: docConfidence,
      };
    })
    .filter((t): t is NonNullable<typeof t> => {
      if (t === null) return false;
      if (t.posted_date === null) {
        dateDropped += 1; // surfaced in notes below — never silent
        return false;
      }
      return true;
    });

  // A whole-statement call may not surface the header prose (the header-crop
  // read does, in the full pipeline), so the period bounds are derived from the
  // transaction dates below when the model omits them.

  // Cross-page year drift: per-page calls past page 1 don't see the period
  // header, so the model guesses the year (e.g. 2023 instead of 2026). When the
  // statement period is known, snap each transaction's year to whichever
  // period-boundary year places the MM-DD inside the period.
  if (isoStart && isoEnd) {
    const yStart = isoStart.slice(0, 4);
    const yEnd = isoEnd.slice(0, 4);
    const years = yStart === yEnd ? [yStart] : [yStart, yEnd];
    for (const t of transactions) {
      if (typeof t.posted_date !== 'string') continue;
      const mmdd = t.posted_date.slice(5);
      for (const y of years) {
        const cand = `${y}-${mmdd}`;
        if (cand >= isoStart && cand <= isoEnd) {
          t.posted_date = cand;
          break;
        }
      }
    }
  }

  const txDates = transactions
    .map((t) => t.posted_date)
    .filter((d): d is string => typeof d === 'string' && ISO.test(d))
    .sort();
  const periodStartOut = isoStart ?? txDates[0] ?? null;
  const periodEndOut = isoEnd ?? txDates[txDates.length - 1] ?? null;

  // Deterministic reconciliation: the per-page model can't see the whole
  // statement's balances, so derive them from the running-balance chain when
  // it's printed. closing = rb of the last row that prints one; opening = that
  // first row's rb minus its amount. Printed opening (page-1 header) is trusted;
  // closing is derived. Both fall back to the model's stated balances.
  const firstRb = transactions.find((t) => typeof t.running_balance_cents === 'number');
  const lastRb = [...transactions]
    .reverse()
    .find((t) => typeof t.running_balance_cents === 'number');
  const derivedOpening =
    firstRb && typeof firstRb.running_balance_cents === 'number'
      ? firstRb.running_balance_cents - firstRb.amount_cents
      : null;
  const derivedClosing =
    lastRb && typeof lastRb.running_balance_cents === 'number'
      ? lastRb.running_balance_cents
      : null;
  const modelOpening = intOrNull(raw.balances?.opening_balance_cents);
  const modelClosing = intOrNull(raw.balances?.closing_balance_cents);

  const out: Record<string, unknown> = {
    account: {
      masked_number: acctNum ? acctNum.replace(/\D/g, '').slice(-4) || null : null,
      type_hint:
        acctType === 'credit_card' ? 'CREDITCARD' : acctType === 'bank' ? 'CHECKING' : null,
    },
    institution: { name: str(raw.institution?.name), intu_org_hint: null },
    period: { start: periodStartOut, end: periodEndOut },
    balances: {
      opening_cents: modelOpening ?? derivedOpening ?? 0,
      closing_cents: derivedClosing ?? modelClosing ?? 0,
    },
    // The operator's confirmed order is authoritative (the model was told it).
    source_date_format: opts.dateFormatOverride
      ? { format: opts.dateFormatOverride, confidence: 1 }
      : { format: fmt, confidence: docConfidence },
    transactions,
  };
  const noteParts: string[] = [];
  if (amountDropped > 0) noteParts.push(`${amountDropped} row(s) dropped: no readable amount`);
  if (dateDropped > 0) noteParts.push(`${dateDropped} row(s) dropped: no readable date`);
  if (dateDefaulted > 0) {
    noteParts.push(
      `${dateDefaulted} row(s) had no readable date — set to the statement start date; verify before exporting`,
    );
  }
  if (dateAmbiguous > 0) {
    noteParts.push(
      `${dateAmbiguous} row date(s) used an ambiguous day/month order and were read as month/day; verify`,
    );
  }
  // No note when the derived closing disagrees with modelClosing: the merged
  // value is just the last page that printed one (a per-page call often reports
  // its own page's last running balance), which the integration doc (§4 step 7,
  // §5) says not to trust — flagging it would hold complete, reconciling
  // statements. The chain-derived closing above is authoritative here.
  if (noteParts.length > 0) out.notes = `${noteParts.join('; ')}.`;
  return out;
};

export type { ExtractionResult };
