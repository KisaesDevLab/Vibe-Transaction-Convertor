import { describe, expect, it } from 'vitest';
import { schemas } from '@vibe-tx-converter/shared';

import {
  mapStatementModelOutput,
  mergeStatementPages,
  normalizeDeclaredDateFormat,
  normalizeStatementDate,
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
    // The per-page model closing is untrusted (integration doc §4 step 7 / §5):
    // no disagreement note, so it can't hold the statement for review.
    expect(parsed.notes).toBeUndefined();
  });

  it('a complete multi-page statement whose page 2 reports its own closing is not held', () => {
    // Per-page calls each report "their" closing: page 2 prints its last running
    // balance, page 3 prints none, so the merge's closing is page 2's value.
    const merged = mergeStatementPages([
      {
        pageNum: 1,
        raw: {
          period: { start_date: '2026-05-01', end_date: '2026-05-31' },
          balances: { opening_balance_cents: 100_000, closing_balance_cents: null },
          source_date_format: 'MDY',
          transactions: [
            { date: '2026-05-02', amount_cents: 10_000, running_balance_cents: 110_000 },
          ],
        },
      },
      {
        pageNum: 2,
        raw: {
          balances: { opening_balance_cents: null, closing_balance_cents: 130_000 },
          transactions: [
            { date: '2026-05-10', amount_cents: 20_000, running_balance_cents: 130_000 },
          ],
        },
      },
      {
        pageNum: 3,
        raw: {
          balances: { opening_balance_cents: null, closing_balance_cents: null },
          transactions: [
            { date: '2026-05-20', amount_cents: -5_000, running_balance_cents: 125_000 },
          ],
        },
      },
    ]);
    const parsed = schemas.extraction.ExtractionResult.parse(
      mapStatementModelOutput(merged as never),
    );
    expect(parsed.balances).toEqual({ opening_cents: 100_000, closing_cents: 125_000 });
    // opening + Σ amounts = closing — it reconciles; nothing to flag.
    expect(parsed.notes).toBeUndefined();
  });

  it('no closing-balance note when the printed closing matches the chain', () => {
    const r = {
      period: { start_date: '2026-05-01', end_date: '2026-05-31' },
      balances: { opening_balance_cents: 1_000_000, closing_balance_cents: 1_120_000 },
      transactions: [
        { date: '2026-05-04', amount_cents: 120_000, running_balance_cents: 1_120_000 },
      ],
      source_date_format: 'MDY',
    };
    const mapped = mapStatementModelOutput(r) as { notes?: string };
    expect(mapped.notes).toBeUndefined();
  });

  it('reads a non-ISO row date with the declared order instead of the period start (C11a)', () => {
    const r = {
      source_date_format: 'DMY',
      period: { start_date: '2026-03-01', end_date: '2026-03-31' },
      balances: { opening_balance_cents: 0, closing_balance_cents: 100 },
      transactions: [{ date: '20/03/2026', amount_cents: 100, source_page: 1 }],
    };
    const mapped = mapStatementModelOutput(r) as {
      notes?: string;
      transactions: Array<{ posted_date: string }>;
    };
    expect(mapped.transactions[0]!.posted_date).toBe('2026-03-20');
    expect(mapped.notes).toBeUndefined();
  });

  it('notes rows with no readable date that fell back to the statement start (C11a)', () => {
    const r = {
      source_date_format: 'MDY',
      period: { start_date: '2026-03-01', end_date: '2026-03-31' },
      balances: { opening_balance_cents: 0, closing_balance_cents: 150 },
      transactions: [
        { date: null, amount_cents: 100, source_page: 1 },
        { date: '03/27', amount_cents: 50, source_page: 1 }, // no year → unreadable
      ],
    };
    const mapped = mapStatementModelOutput(r) as {
      notes?: string;
      transactions: Array<{ posted_date: string }>;
    };
    expect(mapped.transactions.map((t) => t.posted_date)).toEqual(['2026-03-01', '2026-03-01']);
    expect(mapped.notes).toMatch(
      /2 row\(s\) had no readable date — set to the statement start date; verify/,
    );
  });

  it('flags ambiguous day/month reads when the order is not declared', () => {
    const r = {
      source_date_format: 'AMBIGUOUS',
      period: { start_date: '2026-05-01', end_date: '2026-05-31' },
      balances: { opening_balance_cents: 0, closing_balance_cents: 100 },
      transactions: [{ date: '05/04/2026', amount_cents: 100, source_page: 1 }],
    };
    const mapped = mapStatementModelOutput(r) as {
      notes?: string;
      transactions: Array<{ posted_date: string }>;
    };
    expect(mapped.transactions[0]!.posted_date).toBe('2026-05-04');
    expect(mapped.notes).toMatch(/1 row date\(s\) used an ambiguous day\/month order/);
  });

  it('dateFormatOverride drives the row reading and forces source_date_format (C11b)', () => {
    const r = {
      source_date_format: 'MDY',
      confidence: 0.7,
      period: { start_date: '01/04/2026', end_date: '30/04/2026' },
      balances: { opening_balance_cents: 0, closing_balance_cents: 100 },
      transactions: [{ date: '05/04/2026', amount_cents: 100, source_page: 1 }],
    };
    const parsed = schemas.extraction.ExtractionResult.parse(
      mapStatementModelOutput(r, { dateFormatOverride: 'DMY' }),
    );
    expect(parsed.transactions[0]!.posted_date).toBe('2026-04-05');
    expect(parsed.period).toEqual({ start: '2026-04-01', end: '2026-04-30' });
    expect(parsed.source_date_format).toMatchObject({ format: 'DMY', confidence: 1 });
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

describe('normalizeDeclaredDateFormat', () => {
  it('maps common spellings of a declared format onto the enum', () => {
    for (const s of ['MDY', 'mdy', 'MM/DD/YYYY', 'MM/DD/YY', 'M/D/Y', 'M/D/YYYY', 'MM/DD']) {
      expect(normalizeDeclaredDateFormat(s)).toBe('MDY');
    }
    for (const s of ['DMY', 'DD/MM/YYYY', 'DD.MM.YY', 'D/M/Y', 'DD/MM']) {
      expect(normalizeDeclaredDateFormat(s)).toBe('DMY');
    }
    for (const s of ['YMD', 'YYYY-MM-DD', 'ISO', 'iso 8601', 'ISO-8601']) {
      expect(normalizeDeclaredDateFormat(s)).toBe('YMD');
    }
    expect(normalizeDeclaredDateFormat('textual')).toBe('TEXTUAL');
    expect(normalizeDeclaredDateFormat(' Ambiguous ')).toBe('AMBIGUOUS');
  });

  it('returns null for missing or unrecognized values (callers → AMBIGUOUS)', () => {
    expect(normalizeDeclaredDateFormat(null)).toBeNull();
    expect(normalizeDeclaredDateFormat(42)).toBeNull();
    expect(normalizeDeclaredDateFormat('')).toBeNull();
    expect(normalizeDeclaredDateFormat('local')).toBeNull();
    expect(normalizeDeclaredDateFormat('constructor')).toBeNull(); // no prototype lookups
  });

  it('the statement-model path honors a spelled-out declared format', () => {
    const parsed = schemas.extraction.ExtractionResult.parse(
      mapStatementModelOutput({
        source_date_format: 'DD/MM/YYYY',
        period: { start_date: '2026-04-01', end_date: '2026-04-30' },
        balances: { opening_balance_cents: 0, closing_balance_cents: 100 },
        transactions: [{ date: '05/04/2026', amount_cents: 100, source_page: 1 }],
      }),
    );
    expect(parsed.source_date_format.format).toBe('DMY');
    expect(parsed.transactions[0]!.posted_date).toBe('2026-04-05');
  });
});

describe('normalizeStatementDate', () => {
  it('passes valid ISO through and rejects impossible calendar dates', () => {
    expect(normalizeStatementDate('2026-04-05')).toEqual({ iso: '2026-04-05', ambiguous: false });
    expect(normalizeStatementDate('2026-02-30').iso).toBeNull();
    expect(normalizeStatementDate(null).iso).toBeNull();
    expect(normalizeStatementDate('03/27').iso).toBeNull(); // no year
  });

  it('honors the declared order', () => {
    expect(normalizeStatementDate('05/04/2026', 'MDY').iso).toBe('2026-05-04');
    expect(normalizeStatementDate('05/04/2026', 'DMY').iso).toBe('2026-04-05');
    expect(normalizeStatementDate('26/04/05', 'YMD').iso).toBe('2026-04-05');
    expect(normalizeStatementDate('2026/4/5').iso).toBe('2026-04-05'); // 4-digit year first
    expect(normalizeStatementDate('13/04/2026', 'MDY').iso).toBeNull(); // strict
  });

  it('with an unknown order, reads unambiguous dates the only valid way', () => {
    expect(normalizeStatementDate('13/04/2026')).toEqual({ iso: '2026-04-13', ambiguous: false });
    expect(normalizeStatementDate('04/13/2026')).toEqual({ iso: '2026-04-13', ambiguous: false });
    expect(normalizeStatementDate('05/05/26')).toEqual({ iso: '2026-05-05', ambiguous: false });
  });

  it('with an unknown order, reads both-<=12 dates as month/day and flags them', () => {
    expect(normalizeStatementDate('05/04/2026')).toEqual({ iso: '2026-05-04', ambiguous: true });
    expect(normalizeStatementDate('05/04/2026', 'DMY').ambiguous).toBe(false);
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

  it('splits a SINGLE blob with inline `<!-- page N -->` references (GLM/Paddle OCR)', () => {
    const blob =
      '<!-- page 1 -->\n05/02 ALPHA 100.00\n<!-- page 2 -->\n05/10 BRAVO -50.00\n<!-- page 3 -->\n05/20 CHARLIE -10.00';
    const pages = splitMarkdownPages(blob);
    expect(pages.map((p) => p.pageNum)).toEqual([1, 2, 3]);
    expect(pages[0]!.text).toContain('ALPHA');
    expect(pages[1]!.text).toContain('BRAVO');
    expect(pages[2]!.text).toContain('CHARLIE');
    // Critically: no page's text bleeds into another (one page per call).
    expect(pages[0]!.text).not.toContain('BRAVO');
  });

  it('falls back to form-feed (\\f) page breaks when there are no markers', () => {
    const pages = splitMarkdownPages('page one text\f page two text\f page three text');
    expect(pages).toHaveLength(3);
    expect(pages[1]!.text).toContain('page two');
  });

  it('handles `### Page N` (deeper heading) and case-insensitive "page"', () => {
    const pages = splitMarkdownPages('### page 1\nrow a\n### PAGE 2\nrow b');
    expect(pages.map((p) => p.pageNum)).toEqual([1, 2]);
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
