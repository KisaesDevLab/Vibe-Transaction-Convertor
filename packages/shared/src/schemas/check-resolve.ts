import { z } from 'zod';

// Per-check record returned by the Anthropic vision call. The
// `extractor` package's prompt module ships the matching JSON Schema
// (Anthropic tool input_schema); this Zod schema is what the API
// service validates against before persisting any payee back to
// transactions.cleansedDescription.

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD required');

export const CheckResolveItem = z.object({
  check_number: z.string().min(1).max(40),
  // Vision may genuinely fail to read a smudged payee. Treat null as
  // "no match possible" — the resolver skips items with null payee.
  payee: z.string().min(1).max(500).nullable(),
  amount_cents: z.number().int().nullable().optional(),
  date: DateString.nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
});
export type CheckResolveItem = z.infer<typeof CheckResolveItem>;

export const CheckResolveResult = z.object({
  checks: z.array(CheckResolveItem),
});
export type CheckResolveResult = z.infer<typeof CheckResolveResult>;
