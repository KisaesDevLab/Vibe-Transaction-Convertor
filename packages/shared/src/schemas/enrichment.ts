import { z } from 'zod';

// Phase 33 — LLM-driven enrichment of transaction descriptions and
// business categories. Operator-triggered from the review page; runs a
// single batched LLM call per statement, with the JSON Schema shaped
// dynamically based on which transforms were requested. Both the local
// Vibe Gateway and the Anthropic provider speak the same schema (the
// existing `LlmProvider.extract(opts.schema)` parameter handles both
// without caller-side branching — see `packages/extractor/src/llm-client.ts`).

export const ENRICHMENT_CLEANSED_MAX_LENGTH = 80;

// Richer transaction taxonomy produced by the cleanse pass (distinct from the
// OFX `trntype`). The model classifies each row into exactly one of these.
export const ENRICHMENT_TRANSACTION_TYPES = [
  'purchase',
  'bill_payment',
  'transfer',
  'p2p',
  'check',
  'fee',
  'interest',
  'dividend',
  'deposit',
  'atm',
  'refund',
  'payroll',
  'tax',
  'government',
  'unknown',
] as const;
export const ENRICHMENT_CONFIDENCE_BANDS = ['high', 'medium', 'low'] as const;

// ----- request input (what the API sends to the LLM) -----

export const EnrichmentInputTransaction = z.object({
  // Index in the statement's transaction list. The LLM must emit
  // outputs in the same indexed shape so the caller can re-attach
  // results to rows without relying on the LLM to echo back FITIDs.
  index: z.number().int().min(0),
  raw_description: z.string().min(1),
  amount_cents: z.number().int(),
  trntype: z.string().nullable().optional(),
  // The payee read off a cancelled check (when present). The cleanse pass judges
  // whether it's a reasonable match for the description and reports
  // payee_confidence; the caller adopts it as the description above a threshold.
  payee: z.string().nullable().optional(),
});
export type EnrichmentInputTransaction = z.infer<typeof EnrichmentInputTransaction>;

export const EnrichmentRequest = z.object({
  cleanse: z.boolean(),
  categorize: z.boolean(),
  account_type: z.string().nullable().optional(),
  // Operator-editable category list — the LLM picks exactly one of
  // these names when categorizing. Empty when categorize=false.
  categories: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().nullable().optional(),
    }),
  ),
  transactions: z.array(EnrichmentInputTransaction).min(1),
});
export type EnrichmentRequest = z.infer<typeof EnrichmentRequest>;

// ----- LLM response shape (what the schema enforces) -----

export const EnrichedTransaction = z.object({
  index: z.number().int().min(0),
  cleansed_description: z.string().min(1).max(ENRICHMENT_CLEANSED_MAX_LENGTH).nullable().optional(),
  category: z.string().min(1).nullable().optional(),
  // Structured cleanse outputs. Kept LENIENT (any string, nullable, optional)
  // so a model that omits or mis-spells one field never fails the whole batch —
  // the JSON Schema below constrains the model to the enums; Zod is the safety
  // net (mirrors the extraction lessons about over-strict re-validation).
  merchant_name: z.string().max(120).nullable().optional(),
  processor: z.string().max(60).nullable().optional(),
  transaction_type: z.string().max(40).nullable().optional(),
  is_opaque: z.boolean().nullable().optional(),
  confidence: z.string().max(10).nullable().optional(),
  // 0.0–1.0 — how reasonable the supplied `payee` is for this transaction
  // (description + amount + trntype). null when no payee was supplied. The
  // caller adopts the payee as the cleansed description when this exceeds 0.7.
  payee_confidence: z.number().min(0).max(1).nullable().optional(),
});
export type EnrichedTransaction = z.infer<typeof EnrichedTransaction>;

export const EnrichmentResponse = z.object({
  transactions: z.array(EnrichedTransaction),
});
export type EnrichmentResponse = z.infer<typeof EnrichmentResponse>;

// ----- dynamic JSON Schema -----

// Build a JSON Schema (Draft 2020-12) shaped to enforce only the fields
// the operator asked for. The LLM gets exactly the constraints it needs
// — when only `cleanse=true`, the `category` field is forbidden; when
// only `categorize=true`, `cleansed_description` is forbidden; when
// both, both are required.
//
// The `category` enum is built from the live category list so the LLM
// can't invent a category that doesn't exist in the operator's
// vocabulary. An empty list with `categorize=true` is invalid — callers
// must reject the request before reaching the LLM.
export const buildEnrichmentJsonSchema = (opts: {
  cleanse: boolean;
  categorize: boolean;
  categoryNames: string[];
}): Record<string, unknown> => {
  if (!opts.cleanse && !opts.categorize) {
    throw new Error('buildEnrichmentJsonSchema: at least one of cleanse/categorize must be true');
  }
  if (opts.categorize && opts.categoryNames.length === 0) {
    throw new Error('buildEnrichmentJsonSchema: categorize=true requires non-empty categoryNames');
  }

  const itemRequired: string[] = ['index'];
  const itemProperties: Record<string, unknown> = {
    index: { type: 'integer', minimum: 0 },
  };
  if (opts.cleanse) {
    itemProperties.cleansed_description = {
      type: 'string',
      minLength: 1,
      maxLength: ENRICHMENT_CLEANSED_MAX_LENGTH,
      description:
        'Concise human-readable display name derived ONLY from tokens in the raw input. No invented merchant, brand, location, amount, date, or category.',
    };
    itemProperties.merchant_name = {
      type: ['string', 'null'],
      maxLength: 120,
      description:
        'Underlying merchant or person (looking past any payment processor). null when no identifiable counterparty.',
    };
    itemProperties.processor = {
      type: ['string', 'null'],
      maxLength: 60,
      description: 'Payment intermediary if present (Square, Toast, PayPal, …). null when none.',
    };
    itemProperties.transaction_type = {
      type: 'string',
      enum: [...ENRICHMENT_TRANSACTION_TYPES],
      description: 'Exactly one transaction type from the enum.',
    };
    itemProperties.is_opaque = {
      type: 'boolean',
      description: 'true when no meaningful counterparty could be identified (abstained).',
    };
    itemProperties.confidence = {
      type: 'string',
      enum: [...ENRICHMENT_CONFIDENCE_BANDS],
      description: 'Self-reported confidence band.',
    };
    itemProperties.payee_confidence = {
      type: ['number', 'null'],
      minimum: 0,
      maximum: 1,
      description:
        'When a "payee" is supplied for the row, 0.0–1.0 = how reasonable that payee is for this transaction (description + amount + trntype). null when no payee was supplied.',
    };
    // All required (merchant_name/processor allow null) so the model always
    // emits them — left optional, some models silently drop merchant_name.
    itemRequired.push(
      'cleansed_description',
      'merchant_name',
      'processor',
      'transaction_type',
      'is_opaque',
      'confidence',
    );
  }
  if (opts.categorize) {
    itemProperties.category = {
      type: 'string',
      enum: opts.categoryNames,
      description:
        'Exactly one category name from the operator-supplied list. Pick the closest match.',
    };
    itemRequired.push('category');
  }

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['transactions'],
    properties: {
      transactions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: itemRequired,
          properties: itemProperties,
        },
      },
    },
  };
};
