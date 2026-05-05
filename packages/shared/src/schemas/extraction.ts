import { z } from 'zod';

import { ACCOUNT_TYPES } from '../account-types.js';

// Canonical extraction schema. The LLM produces a JSON object that
// validates against this; both the local Vibe Gateway provider and the
// Anthropic provider constrain generation to this schema (ADR-004,
// ADR-019, ADR-020).
//
// Internal storage: dates are ISO 8601 strings (YYYY-MM-DD), amounts
// are signed integer cents (BigInt at the DB boundary, JSON
// `amount_cents` as number-or-string of cents to keep the LLM honest).

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

export const ExtractionTransaction = z.object({
  posted_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD required'),
  description: z.string().min(1).max(500),
  amount_cents: z.number().int(),
  running_balance_cents: z.number().int().nullable().optional(),
  check_number: z.string().max(40).nullable().optional(),
  trntype: TrntypeEnum.optional(),
  source_page: z.number().int().min(1),
  confidence: z.number().min(0).max(1).default(1),
});
export type ExtractionTransaction = z.infer<typeof ExtractionTransaction>;

export const ExtractionResult = z.object({
  account_number_masked: z.string().nullable().optional(),
  account_type_hint: z.enum(ACCOUNT_TYPES).nullable().optional(),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  opening_balance_cents: z.number().int(),
  closing_balance_cents: z.number().int(),
  transactions: z.array(ExtractionTransaction),
  source_date_format: SourceDateFormatEnum,
  source_date_format_confidence: z.number().min(0).max(1),
  notes: z.string().max(2000).optional(),
});
export type ExtractionResult = z.infer<typeof ExtractionResult>;

// JSON Schema (Draft 2020-12 via zod-to-json-schema would be neater
// but we don't want the dep — handcrafted from the Zod source).
// This is the schema we send to:
//   * Vibe LLM Gateway as `guided_json`
//   * Anthropic as a tool's `input_schema`
export const ExtractionJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'period_start',
    'period_end',
    'opening_balance_cents',
    'closing_balance_cents',
    'transactions',
    'source_date_format',
    'source_date_format_confidence',
  ],
  properties: {
    account_number_masked: {
      type: ['string', 'null'],
      description: 'Last-4 of the account number, or null if not detected.',
    },
    account_type_hint: {
      type: ['string', 'null'],
      enum: [...ACCOUNT_TYPES, null],
      description: 'Best-guess account type from the statement banner.',
    },
    period_start: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      description: 'Statement period start in ISO 8601.',
    },
    period_end: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      description: 'Statement period end in ISO 8601.',
    },
    opening_balance_cents: {
      type: 'integer',
      description: 'Opening balance in signed integer cents.',
    },
    closing_balance_cents: {
      type: 'integer',
      description: 'Closing balance in signed integer cents.',
    },
    source_date_format: {
      type: 'string',
      enum: ['MDY', 'DMY', 'YMD', 'TEXTUAL', 'AMBIGUOUS'],
      description: 'How dates appear in the source PDF.',
    },
    source_date_format_confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
    notes: { type: 'string', maxLength: 2000 },
    transactions: {
      type: 'array',
      items: {
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
      },
    },
  },
} as const;
