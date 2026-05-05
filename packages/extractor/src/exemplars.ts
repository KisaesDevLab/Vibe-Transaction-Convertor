// In-context examples used to anchor the LLM. All exemplars are SANITIZED
// (no real account numbers, no real PII). They are sent only to the local
// gateway provider; the Anthropic provider gets a smaller subset to keep
// the prompt budget under control.

import type { schemas } from '@vibe-tx-converter/shared';

type ExtractionResult = schemas.extraction.ExtractionResult;

export interface Exemplar {
  label: string;
  markdown: string;
  expected: ExtractionResult;
}

export const EXEMPLARS: Exemplar[] = [
  {
    label: 'simple-checking',
    markdown: `# Acme Bank — Checking Statement
Account ending ••••1234
Period: 03/01/2026 – 03/31/2026

Opening Balance ........................ $1,200.00

Date       Description                                Amount       Balance
03/03/26   ATM WITHDRAWAL #4123                       -60.00       1,140.00
03/08/26   DIRECT DEPOSIT - PAYROLL                  3,200.00      4,340.00
03/12/26   GROCERY STORE #1882                         -74.21      4,265.79
03/19/26   WIRE TRANSFER FROM 555                       50.00      4,315.79

Closing Balance ........................ $4,315.79`,
    expected: {
      account_number_masked: '1234',
      account_type_hint: 'CHECKING',
      period_start: '2026-03-01',
      period_end: '2026-03-31',
      opening_balance_cents: 120_000,
      closing_balance_cents: 431_579,
      source_date_format: 'MDY',
      source_date_format_confidence: 0.9,
      transactions: [
        {
          posted_date: '2026-03-03',
          description: 'ATM WITHDRAWAL #4123',
          amount_cents: -6_000,
          running_balance_cents: 114_000,
          trntype: 'ATM',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-03-08',
          description: 'DIRECT DEPOSIT - PAYROLL',
          amount_cents: 320_000,
          running_balance_cents: 434_000,
          trntype: 'DIRECTDEP',
          source_page: 1,
          confidence: 0.99,
        },
        {
          posted_date: '2026-03-12',
          description: 'GROCERY STORE #1882',
          amount_cents: -7_421,
          running_balance_cents: 426_579,
          trntype: 'POS',
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-03-19',
          description: 'WIRE TRANSFER FROM 555',
          amount_cents: 5_000,
          running_balance_cents: 431_579,
          trntype: 'XFER',
          source_page: 1,
          confidence: 0.9,
        },
      ],
    },
  },
];

export const exemplarsAsMessages = (
  limit?: number,
): Array<{ role: 'user' | 'assistant'; content: string }> => {
  const subset = limit !== undefined ? EXEMPLARS.slice(0, limit) : EXEMPLARS;
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const ex of subset) {
    out.push({ role: 'user', content: `=== STATEMENT MARKDOWN ===\n${ex.markdown}\n=== END ===` });
    out.push({ role: 'assistant', content: JSON.stringify(ex.expected, null, 2) });
  }
  return out;
};
