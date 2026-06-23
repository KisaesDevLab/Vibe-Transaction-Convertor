import { describe, expect, it } from 'vitest';
import { schemas } from '@vibe-tx-converter/shared';

import { mapStatementModelOutput } from './statement-model.js';

// A representative statement-model native output (the shape qwen2.5-stmt emits).
const raw = {
  account: { holder_name: 'Jane Doe', account_number: '****4471', account_type: 'bank' },
  institution: { name: 'First National', address: '1 Main St' },
  period: { start_date: null, end_date: null, currency: 'USD' },
  balances: { opening_balance_cents: 1_000_000, closing_balance_cents: 1_108_000 },
  source_date_format: 'MDY',
  confidence: 0.93,
  transactions: [
    {
      date: '2026-05-04',
      payee: 'Card Deposit Batch 8841',
      amount_cents: 120_000,
      running_balance_cents: 1_120_000,
      trntype: 'DEPOSIT',
      check_number: null,
      source_page: 1,
      source_text: '05/04 CARD DEPOSIT BATCH 8841 1,200.00 11,200.00',
    },
    {
      date: '2026-05-06',
      payee: null,
      amount_cents: -45_000,
      running_balance_cents: 1_075_000,
      trntype: 'CHECK',
      check_number: '0042',
      source_page: 1,
      source_text: '05/06 CHECK 0042 450.00',
    },
    // Row with no readable amount → dropped.
    { date: '2026-05-07', payee: 'x', amount_cents: null, source_page: 1 },
  ],
};

describe('mapStatementModelOutput', () => {
  it('maps the native shape to a valid internal ExtractionResult', () => {
    const mapped = mapStatementModelOutput(raw);
    const parsed = schemas.extraction.ExtractionResult.parse(mapped);
    expect(parsed.transactions).toHaveLength(2); // amount-less row dropped
    const t0 = parsed.transactions[0]!;
    expect(t0.posted_date).toBe('2026-05-04');
    expect(t0.amount_cents).toBe(120_000);
    expect(t0.trntype).toBe('DEP'); // DEPOSIT -> DEP
    expect(t0.description).toContain('CARD DEPOSIT BATCH 8841'); // source_text grounds it
    expect(t0.payee).toBeNull(); // model payee is merchant, not check payee
    const tCheck = parsed.transactions[1]!;
    expect(tCheck.check_number).toBe('0042'); // leading zero preserved
    expect(tCheck.trntype).toBe('CHECK');
  });

  it('derives period from transaction dates when the model omits it', () => {
    const parsed = schemas.extraction.ExtractionResult.parse(mapStatementModelOutput(raw));
    expect(parsed.period.start).toBe('2026-05-04');
    expect(parsed.period.end).toBe('2026-05-06');
  });

  it('maps account_type + masks the account number', () => {
    const parsed = schemas.extraction.ExtractionResult.parse(mapStatementModelOutput(raw));
    expect(parsed.account.type_hint).toBe('CHECKING');
    expect(parsed.account.masked_number).toBe('4471');
  });

  it('carries the doc-level confidence onto every row', () => {
    const parsed = schemas.extraction.ExtractionResult.parse(mapStatementModelOutput(raw));
    expect(parsed.transactions.every((t) => t.confidence === 0.93)).toBe(true);
  });
});
