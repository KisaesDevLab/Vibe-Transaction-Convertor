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

const DATE_FORMATS = new Set(['MDY', 'DMY', 'YMD', 'TEXTUAL', 'AMBIGUOUS']);
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

// Split page-marked markdown (`# Page N`) into per-page chunks. The statement
// models take ONE page per call (whole-statement output truncates at 25k+
// tokens), so the engine loops over these. No markers → one page.
export const splitMarkdownPages = (text: string): Array<{ pageNum: number; text: string }> => {
  const marker = /^#\s*Page\s+(\d+)\s*$/gim;
  const matches = [...text.matchAll(marker)];
  if (matches.length === 0) return [{ pageNum: 1, text: text.trim() }];
  const pages: Array<{ pageNum: number; text: string }> = [];
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i]!;
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? text.length) : text.length;
    const body = text.slice(start, end).trim();
    if (body.length > 0) pages.push({ pageNum: Number(m[1]), text: body });
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

// Map the statement model's native output to our internal ExtractionResult shape.
// Returns a plain object; the caller runs ExtractionResult.parse() on it so Zod
// validation, defaults, and the trntype/date normalization still apply. Rows
// without a numeric amount are dropped (and noted) rather than failing the batch.
export const mapStatementModelOutput = (raw: StatementModelRaw): Record<string, unknown> => {
  const docConfidence = (() => {
    const c = raw.confidence;
    return typeof c === 'number' && c >= 0 && c <= 1 ? c : 0.8;
  })();
  const fmt =
    typeof raw.source_date_format === 'string' && DATE_FORMATS.has(raw.source_date_format)
      ? raw.source_date_format
      : 'AMBIGUOUS';
  const acctNum = str(raw.account?.account_number);
  const acctType = raw.account?.account_type;
  const periodStart = str(raw.period?.start_date);

  // Balance-marker rows ("Beginning/Opening/Previous Balance") are not
  // transactions — some models emit them with the opening figure in the amount
  // column, which double-counts and corrupts the derived opening. Drop them.
  // Matches anywhere — source_text carries the date/amount prefix
  // ("04/01  Beginning Balance  2,178.46  2,178.46"), so it can't be anchored.
  const BALANCE_MARKER = /\b(beginning|opening|previous|starting|ending|closing)\s+balance\b/i;

  let amountDropped = 0;
  let dateDropped = 0;
  const transactions = (raw.transactions ?? [])
    .map((t) => {
      const amount = intOrNull(t.amount_cents);
      if (amount === null) {
        amountDropped += 1;
        return null;
      }
      const descText = str(t.source_text) ?? str(t.payee) ?? '';
      if (BALANCE_MARKER.test(descText)) return null; // not a transaction
      const date = str(t.date);
      const postedDate =
        date && ISO.test(date) ? date : periodStart && ISO.test(periodStart) ? periodStart : null;
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

  // period.start/end are required ISO dates. A whole-statement call may not
  // surface the header prose (the header-crop read does, in the full pipeline),
  // so derive the bounds from the transaction dates when the model omits them.
  const isoStart = str(raw.period?.start_date);
  const isoEnd = str(raw.period?.end_date);

  // Cross-page year drift: per-page calls past page 1 don't see the period
  // header, so the model guesses the year (e.g. 2023 instead of 2026). When the
  // statement period is known, snap each transaction's year to whichever
  // period-boundary year places the MM-DD inside the period.
  if (isoStart && ISO.test(isoStart) && isoEnd && ISO.test(isoEnd)) {
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
  const periodStartOut = isoStart && ISO.test(isoStart) ? isoStart : (txDates[0] ?? null);
  const periodEndOut = isoEnd && ISO.test(isoEnd) ? isoEnd : (txDates[txDates.length - 1] ?? null);

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
    source_date_format: { format: fmt, confidence: docConfidence },
    transactions,
  };
  const noteParts: string[] = [];
  if (amountDropped > 0) noteParts.push(`${amountDropped} row(s) dropped: no readable amount`);
  if (dateDropped > 0) noteParts.push(`${dateDropped} row(s) dropped: no readable date`);
  if (noteParts.length > 0) out.notes = `${noteParts.join('; ')}.`;
  return out;
};

export type { ExtractionResult };
