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

  let dropped = 0;
  const transactions = (raw.transactions ?? [])
    .map((t) => {
      const amount = intOrNull(t.amount_cents);
      if (amount === null) {
        dropped += 1;
        return null;
      }
      const date = str(t.date);
      const postedDate =
        date && ISO.test(date) ? date : periodStart && ISO.test(periodStart) ? periodStart : null;
      const trntypeRaw =
        typeof t.trntype === 'string' ? TRNTYPE_MAP[t.trntype.toUpperCase()] : undefined;
      const description = (str(t.source_text) ?? str(t.payee) ?? '[unreadable]').slice(0, 500);
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
        source_page: intOrNull(t.source_page) ?? 1,
        // The model emits only a doc-level confidence; apply it per row so the
        // per-row review-hold gate keeps working.
        confidence: docConfidence,
      };
    })
    .filter((t): t is NonNullable<typeof t> => t !== null && t.posted_date !== null);

  // period.start/end are required ISO dates. A whole-statement call may not
  // surface the header prose (the header-crop read does, in the full pipeline),
  // so derive the bounds from the transaction dates when the model omits them.
  const isoStart = str(raw.period?.start_date);
  const isoEnd = str(raw.period?.end_date);
  const txDates = transactions
    .map((t) => t.posted_date)
    .filter((d): d is string => typeof d === 'string' && ISO.test(d))
    .sort();
  const periodStartOut = isoStart && ISO.test(isoStart) ? isoStart : (txDates[0] ?? null);
  const periodEndOut = isoEnd && ISO.test(isoEnd) ? isoEnd : (txDates[txDates.length - 1] ?? null);

  const out: Record<string, unknown> = {
    account: {
      masked_number: acctNum ? acctNum.replace(/\D/g, '').slice(-4) || null : null,
      type_hint:
        acctType === 'credit_card' ? 'CREDITCARD' : acctType === 'bank' ? 'CHECKING' : null,
    },
    institution: { name: str(raw.institution?.name), intu_org_hint: null },
    period: { start: periodStartOut, end: periodEndOut },
    balances: {
      opening_cents: intOrNull(raw.balances?.opening_balance_cents) ?? 0,
      closing_cents: intOrNull(raw.balances?.closing_balance_cents) ?? 0,
    },
    source_date_format: { format: fmt, confidence: docConfidence },
    transactions,
  };
  if (dropped > 0) {
    out.notes = `${dropped} row(s) dropped: no readable amount.`;
  }
  return out;
};

export type { ExtractionResult };
