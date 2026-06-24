import { describe, expect, it } from 'vitest';
import { schemas } from '@vibe-tx-converter/shared';

import {
  mapStatementModelOutput,
  mergeStatementPages,
  splitMarkdownPages,
} from './statement-model.js';

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

  it('derives closing from the running-balance chain (rb of last row)', () => {
    const r = {
      period: { start_date: '2026-05-01', end_date: '2026-05-31' },
      balances: { opening_balance_cents: 1_000_000, closing_balance_cents: 999 /* wrong */ },
      transactions: [
        {
          date: '2026-05-04',
          amount_cents: 120_000,
          running_balance_cents: 1_120_000,
          source_page: 1,
        },
        {
          date: '2026-05-06',
          amount_cents: -45_000,
          running_balance_cents: 1_075_000,
          source_page: 1,
        },
      ],
    };
    const parsed = schemas.extraction.ExtractionResult.parse(mapStatementModelOutput(r));
    // opening = printed; closing = rb[-1] (1_075_000), NOT the bad model closing.
    expect(parsed.balances.opening_cents).toBe(1_000_000);
    expect(parsed.balances.closing_cents).toBe(1_075_000);
  });

  it('drops a "Beginning Balance" marker row (not a transaction) so it cannot double-count', () => {
    const r = {
      period: { start_date: '2026-05-01', end_date: '2026-05-31' },
      balances: { opening_balance_cents: 1_000_000, closing_balance_cents: 1_120_000 },
      transactions: [
        {
          date: '2026-05-01',
          source_text: '05/01  Beginning Balance  10,000.00  10,000.00',
          amount_cents: 1_000_000,
          running_balance_cents: 1_000_000,
          source_page: 1,
        },
        {
          date: '2026-05-04',
          source_text: '05/04  DEPOSIT  1,200.00  11,200.00',
          amount_cents: 120_000,
          running_balance_cents: 1_120_000,
          source_page: 1,
        },
      ],
    };
    const parsed = schemas.extraction.ExtractionResult.parse(mapStatementModelOutput(r));
    expect(parsed.transactions).toHaveLength(1); // marker dropped
    expect(parsed.transactions[0]!.description).toContain('DEPOSIT');
  });

  it('surfaces date-dropped rows in notes (never silent)', () => {
    const r = {
      period: { start_date: null, end_date: null }, // no period → no date fallback
      balances: { opening_balance_cents: 0, closing_balance_cents: 100 },
      transactions: [
        { date: '2026-05-04', amount_cents: 100, source_page: 1 },
        { date: 'not-a-date', amount_cents: 50, source_page: 1 },
      ],
    };
    const mapped = mapStatementModelOutput(r) as { notes?: string; transactions: unknown[] };
    expect(mapped.transactions).toHaveLength(1);
    expect(mapped.notes).toMatch(/no readable date/);
  });

  it('clamps a bogus source_page (0) to a schema-valid 1', () => {
    const r = {
      period: { start_date: '2026-05-01', end_date: '2026-05-31' },
      balances: { opening_balance_cents: 0, closing_balance_cents: 100 },
      transactions: [{ date: '2026-05-04', amount_cents: 100, source_page: 0 }],
    };
    const parsed = schemas.extraction.ExtractionResult.parse(mapStatementModelOutput(r));
    expect(parsed.transactions[0]!.source_page).toBe(1);
  });

  it('snaps a wrong-year transaction date into the statement period', () => {
    const r = {
      period: { start_date: '2026-05-01', end_date: '2026-05-31' },
      balances: { opening_balance_cents: 0, closing_balance_cents: 100 },
      transactions: [{ date: '2023-05-15', amount_cents: 100, source_page: 2 }],
    };
    const parsed = schemas.extraction.ExtractionResult.parse(mapStatementModelOutput(r));
    expect(parsed.transactions[0]!.posted_date).toBe('2026-05-15');
  });
});

describe('splitMarkdownPages', () => {
  it('splits on `# Page N` markers', () => {
    const pages = splitMarkdownPages('# Page 1\n\nrow a\n\n# Page 2\n\nrow b');
    expect(pages).toEqual([
      { pageNum: 1, text: 'row a' },
      { pageNum: 2, text: 'row b' },
    ]);
  });
  it('returns one page when there are no markers', () => {
    expect(splitMarkdownPages('just text')).toEqual([{ pageNum: 1, text: 'just text' }]);
  });
});

describe('mergeStatementPages', () => {
  it('stamps source_page from the page index and takes opening/closing across pages', () => {
    const merged = mergeStatementPages([
      {
        pageNum: 1,
        raw: {
          period: { start_date: '2026-05-01', end_date: '2026-05-31' },
          balances: { opening_balance_cents: 100, closing_balance_cents: 500 },
          transactions: [{ date: '2026-05-02', amount_cents: 400, source_page: 1 }],
        },
      },
      {
        pageNum: 2,
        raw: {
          balances: { closing_balance_cents: 900 },
          transactions: [{ date: '2026-05-09', amount_cents: 400, source_page: 1 }],
        },
      },
    ]) as { balances: Record<string, unknown>; transactions: Array<Record<string, unknown>> };
    expect(merged.transactions.map((t) => t.source_page)).toEqual([1, 2]); // re-stamped
    expect(merged.balances.opening_balance_cents).toBe(100); // first page
    expect(merged.balances.closing_balance_cents).toBe(900); // last page
  });
});
