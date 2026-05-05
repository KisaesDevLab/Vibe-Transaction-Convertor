import { z } from 'zod';

import { ACCOUNT_TYPES } from '../account-types.js';

// Canonical extraction schema (Phase 12 #1: nested shape). The LLM
// produces a JSON object that validates against this; both the local
// Vibe Gateway provider and the Anthropic provider constrain generation
// to this schema (ADR-004, ADR-019, ADR-020).
//
// Internal storage: dates are ISO 8601 strings (YYYY-MM-DD); amounts
// are signed integer cents (BigInt at the DB boundary, JSON
// `*_cents` as number-of-cents to keep the LLM honest).

export const TrntypeEnum = z.enum([
  'CREDIT',
  'DEBIT',
  'INT',
  'DIV',
  'FEE',
  'SRVCHG',
  'DEP',
  'ATM',
  'POS',
  'XFER',
  'CHECK',
  'PAYMENT',
  'CASH',
  'DIRECTDEP',
  'DIRECTDEBIT',
  'REPEATPMT',
  'HOLD',
  'OTHER',
]);
export type Trntype = z.infer<typeof TrntypeEnum>;

export const SourceDateFormatEnum = z.enum(['MDY', 'DMY', 'YMD', 'TEXTUAL', 'AMBIGUOUS']);
export type SourceDateFormat = z.infer<typeof SourceDateFormatEnum>;

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD required');

export const ExtractionTransaction = z.object({
  posted_date: DateString,
  description: z.string().min(1).max(500),
  amount_cents: z.number().int(),
  running_balance_cents: z.number().int().nullable().optional(),
  check_number: z.string().max(40).nullable().optional(),
  trntype: TrntypeEnum.optional(),
  source_page: z.number().int().min(1),
  confidence: z.number().min(0).max(1).default(1),
});
export type ExtractionTransaction = z.infer<typeof ExtractionTransaction>;

// Phase 12 #1: split top-level fields into structured groups so the LLM
// has a clearer mental model and the worker reads richly-typed data.
// No backwards-compatible flat shape — every consumer was updated in
// the same change.

export const ExtractionAccount = z.object({
  masked_number: z.string().nullable().optional(),
  type_hint: z.enum(ACCOUNT_TYPES).nullable().optional(),
});

export const ExtractionInstitution = z.object({
  name: z.string().nullable().optional(),
  intu_org_hint: z.string().nullable().optional(),
});

export const ExtractionPeriod = z.object({
  start: DateString,
  end: DateString,
});

export const ExtractionBalances = z.object({
  opening_cents: z.number().int(),
  closing_cents: z.number().int(),
});

export const ExtractionDateFormat = z.object({
  format: SourceDateFormatEnum,
  confidence: z.number().min(0).max(1),
  evidence: z.string().nullable().optional(),
  sample: z.string().nullable().optional(),
});

export const ExtractionResult = z.object({
  account: ExtractionAccount.default({}),
  institution: ExtractionInstitution.default({}),
  period: ExtractionPeriod,
  balances: ExtractionBalances,
  transactions: z.array(ExtractionTransaction),
  source_date_format: ExtractionDateFormat,
  notes: z.string().max(2000).optional(),
});
export type ExtractionResult = z.infer<typeof ExtractionResult>;

// JSON Schema (Draft 2020-12 via zod-to-json-schema would be neater
// but we don't want the dep — handcrafted from the Zod source).
// Sent to:
//   * Vibe LLM Gateway as `guided_json`
//   * Anthropic as a tool's `input_schema`
const transactionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['posted_date', 'description', 'amount_cents', 'source_page'],
  properties: {
    posted_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    description: { type: 'string', minLength: 1, maxLength: 500 },
    amount_cents: { type: 'integer' },
    running_balance_cents: { type: ['integer', 'null'] },
    check_number: { type: ['string', 'null'], maxLength: 40 },
    trntype: { type: 'string', enum: TrntypeEnum.options },
    source_page: { type: 'integer', minimum: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

export const ExtractionJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['period', 'balances', 'transactions', 'source_date_format'],
  properties: {
    account: {
      type: 'object',
      additionalProperties: false,
      properties: {
        masked_number: {
          type: ['string', 'null'],
          description: 'Last-4 of the account number, or null if not detected.',
        },
        type_hint: {
          type: ['string', 'null'],
          enum: [...ACCOUNT_TYPES, null],
        },
      },
    },
    institution: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: ['string', 'null'] },
        intu_org_hint: { type: ['string', 'null'] },
      },
    },
    period: {
      type: 'object',
      additionalProperties: false,
      required: ['start', 'end'],
      properties: {
        start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
    },
    balances: {
      type: 'object',
      additionalProperties: false,
      required: ['opening_cents', 'closing_cents'],
      properties: {
        opening_cents: { type: 'integer' },
        closing_cents: { type: 'integer' },
      },
    },
    source_date_format: {
      type: 'object',
      additionalProperties: false,
      required: ['format', 'confidence'],
      properties: {
        format: { type: 'string', enum: ['MDY', 'DMY', 'YMD', 'TEXTUAL', 'AMBIGUOUS'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        evidence: { type: ['string', 'null'] },
        sample: { type: ['string', 'null'] },
      },
    },
    transactions: { type: 'array', items: transactionJsonSchema },
    notes: { type: 'string', maxLength: 2000 },
  },
} as const;
