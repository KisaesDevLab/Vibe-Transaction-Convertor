import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  DEFAULT_VISION_MODEL,
  ExtractionResponseError,
  LocalGatewayProvider,
  computeAnthropicCostMicros,
  describeAnthropicRequest,
  describeJsonParseError,
  expandArrayTransactions,
  parseExtractionResponse,
  sanitizeSchemaForOllama,
} from './llm-client.js';
import { clearOcrCache, resetEngineVersionCache, resetOcrCircuit } from './glm-ocr-client.js';

describe('sanitizeSchemaForOllama', () => {
  it('strips `pattern` at every depth while preserving all other keywords', () => {
    const schema = {
      type: 'object',
      required: ['period', 'transactions'],
      properties: {
        period: {
          type: 'object',
          properties: {
            start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
        },
        transactions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              posted_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              trntype: { type: 'string', enum: ['CREDIT', 'DEBIT'] },
            },
          },
        },
      },
    };
    const out = sanitizeSchemaForOllama(schema);
    expect(JSON.stringify(out)).not.toContain('pattern');
    // Non-`pattern` constraints survive untouched.
    const o = out as typeof schema;
    expect(o.required).toEqual(['period', 'transactions']);
    expect(o.properties.transactions.items.properties.trntype.enum).toEqual(['CREDIT', 'DEBIT']);
    expect(o.properties.period.properties.start.type).toBe('string');
  });

  it('does not mutate the input schema (returns a deep copy)', () => {
    const schema = { type: 'string', pattern: 'x' };
    const out = sanitizeSchemaForOllama(schema);
    expect(schema.pattern).toBe('x'); // original untouched
    expect((out as { pattern?: string }).pattern).toBeUndefined();
  });

  it('passes through primitives, arrays, null, and undefined', () => {
    expect(sanitizeSchemaForOllama(undefined)).toBeUndefined();
    expect(sanitizeSchemaForOllama(null)).toBeNull();
    expect(sanitizeSchemaForOllama([{ pattern: 'a' }, { type: 'integer' }])).toEqual([
      {},
      { type: 'integer' },
    ]);
  });
});

describe('describeAnthropicRequest', () => {
  it('summarizes a vision request without leaking content', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBBBB' } },
          { type: 'text', text: 'secret prompt' },
        ],
      },
    ];
    const s = describeAnthropicRequest(messages, 'claude-sonnet-4-6', 32000, true);
    expect(s).toContain('model=claude-sonnet-4-6');
    expect(s).toContain('max_tokens=32000');
    expect(s).toContain('images=2');
    expect(s).toContain('imageB64Bytes=10');
    expect(s).toContain('media=image/jpeg');
    expect(s).toContain('viaGateway=true');
    expect(s).not.toContain('secret');
  });
});

const SAMPLE = {
  account: { masked_number: '1234', type_hint: 'CHECKING' },
  institution: { name: 'Acme Bank', intu_org_hint: null },
  period: { start: '2026-03-01', end: '2026-03-31' },
  balances: { opening_cents: 100, closing_cents: 0 },
  source_date_format: { format: 'MDY', confidence: 0.9 },
  transactions: [
    {
      posted_date: '2026-03-03',
      description: 'X',
      amount_cents: -100,
      source_page: 1,
      confidence: 1,
    },
  ],
};

const okJsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('expandArrayTransactions (parallel-array salvage)', () => {
  it('expands an object with parallel description + amount_cents arrays', () => {
    const out = expandArrayTransactions({
      transactions: [
        {
          posted_date: '2026-04-06',
          description: ['TOAST A', 'TOAST B', 'TOAST C'],
          amount_cents: [100, 200, 300],
          source_page: 3,
          confidence: 0.95,
        },
      ],
    }) as { transactions: Array<Record<string, unknown>> };
    expect(out.transactions).toHaveLength(3);
    expect(out.transactions[1]).toMatchObject({
      posted_date: '2026-04-06',
      description: 'TOAST B',
      amount_cents: 200,
      source_page: 3,
    });
  });

  it('broadcasts a scalar description across an amount_cents array (mismatched)', () => {
    const out = expandArrayTransactions({
      transactions: [{ description: 'TOAST DEP', amount_cents: [328, 50012, 391597] }],
    }) as { transactions: Array<Record<string, unknown>> };
    expect(out.transactions).toHaveLength(3);
    expect(out.transactions.map((t) => t.amount_cents)).toEqual([328, 50012, 391597]);
    expect(out.transactions.every((t) => t.description === 'TOAST DEP')).toBe(true);
  });

  it('leaves normal scalar transactions untouched', () => {
    const input = { transactions: [{ description: 'X', amount_cents: 100 }] };
    expect(expandArrayTransactions(input)).toEqual(input);
  });

  it('keeps an explicit null element null — never borrows the last element (C12)', () => {
    const out = expandArrayTransactions({
      transactions: [{ description: ['A', 'B', 'C'], amount_cents: [100, null, 300] }],
    }) as { transactions: Array<Record<string, unknown>> };
    expect(out.transactions.map((t) => t.amount_cents)).toEqual([100, null, 300]);
  });

  it('a SHORT amount array yields null past its end — never repeats a figure', () => {
    const out = expandArrayTransactions({
      transactions: [{ description: ['A', 'B', 'C'], amount_cents: [100, 200] }],
    }) as { transactions: Array<Record<string, unknown>> };
    expect(out.transactions.map((t) => t.amount_cents)).toEqual([100, 200, null]);
  });

  it('indexes every parallel field: money → null past the end, others repeat their last', () => {
    const out = expandArrayTransactions({
      transactions: [
        {
          posted_date: ['2026-04-06', '2026-04-07'],
          description: ['A', 'B'],
          amount_cents: [100, 200, 300],
          running_balance_cents: [1_100, 1_300],
          source_page: 2,
        },
      ],
    }) as { transactions: Array<Record<string, unknown>> };
    expect(out.transactions).toEqual([
      {
        posted_date: '2026-04-06',
        description: 'A',
        amount_cents: 100,
        running_balance_cents: 1_100,
        source_page: 2,
      },
      {
        posted_date: '2026-04-07',
        description: 'B',
        amount_cents: 200,
        running_balance_cents: 1_300,
        source_page: 2,
      },
      {
        posted_date: '2026-04-07',
        description: 'B',
        amount_cents: 300,
        running_balance_cents: null,
        source_page: 2,
      },
    ]);
  });

  it('a short amount array is re-asked (signal) or flagged (salvage), never fabricated', () => {
    const raw = JSON.stringify({
      period: { start: '2026-04-01', end: '2026-04-30' },
      balances: { opening_cents: 0, closing_cents: 300 },
      source_date_format: { format: 'MDY', confidence: 0.9 },
      transactions: [
        {
          posted_date: '2026-04-06',
          description: ['A', 'B', 'C'],
          amount_cents: [100, 200],
          source_page: 1,
        },
      ],
    });
    expect(() => parseExtractionResponse(raw, undefined, { salvageAmounts: false })).toThrow(
      expect.objectContaining({ nullAmountRows: 1 }),
    );
    const out = parseExtractionResponse(raw);
    expect(out.transactions.map((t) => t.amount_cents)).toEqual([100, 200, 0]);
    expect(out.notes).toMatch(/1 transaction\(s\) had an unreadable amount/);
  });

  it('an explicit null amount inside a compressed row is flagged, not fabricated', () => {
    const out = parseExtractionResponse(
      JSON.stringify({
        period: { start: '2026-04-01', end: '2026-04-30' },
        balances: { opening_cents: 0, closing_cents: 400 },
        source_date_format: { format: 'MDY', confidence: 0.9 },
        transactions: [
          {
            posted_date: '2026-04-06',
            description: ['A', 'B', 'C'],
            amount_cents: [100, null, 300],
            source_page: 1,
          },
        ],
      }),
    );
    expect(out.transactions.map((t) => t.amount_cents)).toEqual([100, 0, 300]);
    expect(out.notes).toMatch(/1 transaction\(s\) had an unreadable amount/);
  });

  it('parseExtractionResponse salvages a compressed response end-to-end', () => {
    const raw = JSON.stringify({
      period: { start: '2026-04-01', end: '2026-04-30' },
      balances: { opening_cents: 0, closing_cents: 600 },
      source_date_format: { format: 'MDY', confidence: 0.9 },
      transactions: [
        {
          posted_date: '2026-04-06',
          description: ['A', 'B'],
          amount_cents: [100, 200],
          source_page: 1,
          confidence: 0.95,
        },
        {
          posted_date: '2026-04-07',
          description: 'C',
          amount_cents: 300,
          source_page: 1,
          confidence: 0.95,
        },
      ],
    });
    const result = parseExtractionResponse(raw);
    expect(result.transactions).toHaveLength(3);
    expect(result.transactions.map((t) => Number(t.amount_cents))).toEqual([100, 200, 300]);
  });
});

describe('parseExtractionResponse — null amount handling', () => {
  const withRows = (rows: unknown[]) => ({
    period: { start: '2026-05-01', end: '2026-05-31' },
    balances: { opening_cents: 0, closing_cents: 100 },
    source_date_format: { format: 'MDY', confidence: 0.9 },
    transactions: rows,
  });
  const good = { posted_date: '2026-05-02', description: 'A', amount_cents: 100, source_page: 1 };
  const nullAmt = {
    posted_date: '2026-05-03',
    description: 'B',
    amount_cents: null,
    source_page: 1,
  };

  it('signals (throws with nullAmountRows) when salvageAmounts=false', () => {
    try {
      parseExtractionResponse(JSON.stringify(withRows([good, nullAmt, nullAmt])), undefined, {
        salvageAmounts: false,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractionResponseError);
      expect((err as ExtractionResponseError).nullAmountRows).toBe(2);
    }
  });

  it('coerces null-amount rows to 0 + keeps them + notes when salvaging (default)', () => {
    const out = parseExtractionResponse(JSON.stringify(withRows([good, nullAmt])));
    expect(out.transactions).toHaveLength(2); // kept, not dropped
    const b = out.transactions.find((t) => t.description === 'B');
    expect(b!.amount_cents).toBe(0); // coerced
    expect(out.notes).toMatch(/unreadable amount/i);
  });

  it('is a no-op when every amount is readable', () => {
    const out = parseExtractionResponse(JSON.stringify(withRows([good])));
    expect(out.transactions).toHaveLength(1);
    expect(out.notes).toBeUndefined();
  });
});

describe('parseExtractionResponse — field + structural salvage (never fail on a bad field)', () => {
  const base = (overrides: Record<string, unknown>, tx: Record<string, unknown>) => ({
    period: { start: '2026-05-01', end: '2026-05-31' },
    balances: { opening_cents: 0, closing_cents: 100 },
    source_date_format: { format: 'MDY', confidence: 0.9 },
    transactions: [
      { posted_date: '2026-05-02', description: 'A', amount_cents: 100, source_page: 1, ...tx },
    ],
    ...overrides,
  });

  it('normalizes a non-ISO MM/DD/YYYY date', () => {
    const out = parseExtractionResponse(JSON.stringify(base({}, { posted_date: '05/15/2026' })));
    expect(out.transactions[0]!.posted_date).toBe('2026-05-15');
  });

  it('falls back an invalid calendar date (2026-02-30) to the period start', () => {
    const out = parseExtractionResponse(JSON.stringify(base({}, { posted_date: '2026-02-30' })));
    expect(out.transactions[0]!.posted_date).toBe('2026-05-01'); // period.start
    expect(out.notes).toMatch(/unreadable date/i);
  });

  it('derives a missing period from transaction dates', () => {
    const out = parseExtractionResponse(JSON.stringify(base({ period: null }, {})));
    expect(out.period.start).toBe('2026-05-02');
    expect(out.period.end).toBe('2026-05-02');
  });

  it('defaults missing balances to 0 instead of failing', () => {
    const out = parseExtractionResponse(JSON.stringify(base({ balances: null }, {})));
    expect(out.balances.opening_cents).toBe(0);
    expect(out.balances.closing_cents).toBe(0);
  });

  it('coerces field-local quirks: empty desc, page 0, confidence 1.5, numeric check_number', () => {
    const out = parseExtractionResponse(
      JSON.stringify(
        base({}, { description: '', source_page: 0, confidence: 1.5, check_number: 1234 }),
      ),
    );
    const t = out.transactions[0]!;
    expect(t.description).toBe('[unreadable]');
    expect(t.source_page).toBe(1);
    expect(t.confidence).toBe(1);
    expect(t.check_number).toBe('1234');
  });

  it('treats a missing source_date_format as AMBIGUOUS (never a silent MDY guess)', () => {
    const out = parseExtractionResponse(JSON.stringify(base({ source_date_format: null }, {})));
    // AMBIGUOUS → the worker halts in awaiting-locale-confirmation.
    expect(out.source_date_format.format).toBe('AMBIGUOUS');
    expect(out.notes).toMatch(/source date format was missing or unrecognized/);
  });

  it('accepts a lower-case or bare-string declared format', () => {
    const lower = parseExtractionResponse(
      JSON.stringify(base({ source_date_format: { format: 'dmy', confidence: 0.8 } }, {})),
    );
    expect(lower.source_date_format).toMatchObject({ format: 'DMY', confidence: 0.8 });
    const bare = parseExtractionResponse(JSON.stringify(base({ source_date_format: 'ymd' }, {})));
    expect(bare.source_date_format.format).toBe('YMD');
    const amb = parseExtractionResponse(
      JSON.stringify(base({ source_date_format: { format: 'ambiguous', confidence: 0.3 } }, {})),
    );
    expect(amb.source_date_format.format).toBe('AMBIGUOUS');
  });

  it.each([
    ['MM/DD/YYYY', 'MDY'],
    ['M/D/Y', 'MDY'],
    ['mm/dd/yy', 'MDY'],
    ['mdy', 'MDY'],
    ['DD/MM/YYYY', 'DMY'],
    ['dd.mm.yyyy', 'DMY'],
    ['YYYY-MM-DD', 'YMD'],
    ['ISO', 'YMD'],
    ['ISO 8601', 'YMD'],
    ['Textual', 'TEXTUAL'],
  ])('normalizes a declared format spelled %j → %s (no AMBIGUOUS halt)', (spelled, fmt) => {
    const out = parseExtractionResponse(
      JSON.stringify(base({ source_date_format: { format: spelled, confidence: 0.8 } }, {})),
    );
    expect(out.source_date_format).toMatchObject({ format: fmt, confidence: 0.8 });
    expect(out.notes ?? '').not.toMatch(/missing or unrecognized/);
  });

  it('an unrecognizable declared format is still AMBIGUOUS', () => {
    const out = parseExtractionResponse(JSON.stringify(base({ source_date_format: 'local' }, {})));
    expect(out.source_date_format.format).toBe('AMBIGUOUS');
    expect(out.notes).toMatch(/missing or unrecognized/);
  });

  it('keeps a non-string model note (array / object) when merging salvage notes', () => {
    const nullAmountRow = { amount_cents: null, description: 'B' };
    const fromArray = parseExtractionResponse(
      JSON.stringify(base({ notes: ['page 2 blurry', 'check images'] }, nullAmountRow)),
    );
    expect(fromArray.notes).toMatch(/^page 2 blurry; check images 1 transaction\(s\) had an/);
    const fromObject = parseExtractionResponse(
      JSON.stringify(base({ notes: { warning: 'faded' }, source_date_format: null }, {})),
    );
    expect(fromObject.notes).toMatch(
      /^\{"warning":"faded"\} source date format was missing or unrecognized/,
    );
  });

  it('a long model note is trimmed so all our salvage notes fit the 2000-char cap', () => {
    const out = parseExtractionResponse(
      JSON.stringify(
        base({ notes: 'x'.repeat(2_500), source_date_format: null }, { amount_cents: null }),
      ),
    );
    expect(out.notes!.length).toBeLessThanOrEqual(2_000);
    expect(out.notes).toMatch(
      /x 1 transaction\(s\) had an unreadable amount .*exporting\. source date format was missing or unrecognized .*confirmed\.$/,
    );
  });
});

describe('parseExtractionResponse — date order (C27)', () => {
  const withDate = (posted_date: string, sdf: unknown) => ({
    period: { start: '2026-04-01', end: '2026-05-31' },
    balances: { opening_cents: 0, closing_cents: 100 },
    source_date_format: sdf,
    transactions: [{ posted_date, description: 'A', amount_cents: 100, source_page: 1 }],
  });

  it('reads a non-ISO date in the declared DMY order (no MDY assumption)', () => {
    const out = parseExtractionResponse(
      JSON.stringify(withDate('05/04/2026', { format: 'DMY', confidence: 0.9 })),
    );
    expect(out.transactions[0]!.posted_date).toBe('2026-04-05');
    expect(out.notes).toMatch(/converted using the DMY order/);
  });

  it('the operator override wins over the declared format and is forced into the result', () => {
    const out = parseExtractionResponse(
      JSON.stringify(withDate('05/04/2026', { format: 'MDY', confidence: 0.9 })),
      undefined,
      { dateFormat: 'DMY' },
    );
    expect(out.transactions[0]!.posted_date).toBe('2026-04-05');
    expect(out.source_date_format).toMatchObject({ format: 'DMY', confidence: 1 });
  });

  it('an override fills a missing format (no AMBIGUOUS halt after the operator confirmed)', () => {
    const out = parseExtractionResponse(JSON.stringify(withDate('2026-04-05', null)), undefined, {
      dateFormat: 'MDY',
    });
    expect(out.source_date_format).toMatchObject({ format: 'MDY', confidence: 1 });
    expect(out.notes ?? '').not.toMatch(/missing or unrecognized/);
  });

  it('flags an ambiguous day/month read when the order is unknown', () => {
    const out = parseExtractionResponse(
      JSON.stringify(withDate('05/04/2026', { format: 'TEXTUAL', confidence: 0.9 })),
    );
    expect(out.transactions[0]!.posted_date).toBe('2026-05-04'); // read as month/day…
    expect(out.notes).toMatch(/1 row date\(s\) used an ambiguous day\/month order/); // …and flagged
  });

  it('an unambiguous date under an unknown order is read the only valid way', () => {
    const out = parseExtractionResponse(
      JSON.stringify(withDate('13/04/2026', { format: 'TEXTUAL', confidence: 0.9 })),
    );
    expect(out.transactions[0]!.posted_date).toBe('2026-04-13');
    expect(out.notes ?? '').not.toMatch(/ambiguous day\/month/);
  });

  it('an impossible reading under the declared order still ditto/period-fills with a note', () => {
    const out = parseExtractionResponse(
      JSON.stringify(withDate('13/04/2026', { format: 'MDY', confidence: 0.9 })),
    );
    expect(out.transactions[0]!.posted_date).toBe('2026-04-01'); // period start
    expect(out.notes).toMatch(/unreadable date/);
  });
});

describe('parseExtractionResponse — closing balance (C09)', () => {
  const stmt = (balances: unknown, rows: Array<Record<string, unknown>>) => ({
    period: { start: '2026-05-01', end: '2026-05-31' },
    balances,
    source_date_format: { format: 'MDY', confidence: 0.9 },
    transactions: rows.map((r) => ({ description: 'R', source_page: 1, ...r })),
  });

  it('keeps the printed closing over the last running balance and notes the disagreement', () => {
    // The model dropped the trailing $300.00 row: the last running balance is
    // $1200.00 but the statement prints $1500.00. Using the derived value would
    // reconcile the rows against themselves and falsely verify.
    const out = parseExtractionResponse(
      JSON.stringify(
        stmt({ opening_cents: 100_000, closing_cents: 150_000 }, [
          { posted_date: '2026-05-02', amount_cents: 20_000, running_balance_cents: 120_000 },
        ]),
      ),
    );
    expect(out.balances.closing_cents).toBe(150_000);
    expect(out.notes).toMatch(
      /printed closing balance \(\$1500\.00\) differs from the last running balance \(\$1200\.00\)/,
    );
  });

  it('no disagreement note when the printed closing matches the chain', () => {
    const out = parseExtractionResponse(
      JSON.stringify(
        stmt({ opening_cents: 100_000, closing_cents: 120_000 }, [
          { posted_date: '2026-05-02', amount_cents: 20_000, running_balance_cents: 120_000 },
        ]),
      ),
    );
    expect(out.balances.closing_cents).toBe(120_000);
    expect(out.notes).toBeUndefined();
  });

  it('still derives a MISSING closing from the running-balance chain', () => {
    const out = parseExtractionResponse(
      JSON.stringify(
        stmt({ opening_cents: 100_000 }, [
          { posted_date: '2026-05-02', amount_cents: 20_000, running_balance_cents: 120_000 },
        ]),
      ),
    );
    expect(out.balances.closing_cents).toBe(120_000);
    expect(out.notes).toMatch(/balance was missing/);
  });
});

describe('LocalGatewayProvider', () => {
  it('parses an OpenAI-shaped chat-completions response', async () => {
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      modelId: 'qwen3-8b',
      fetcher: async () =>
        okJsonResponse({
          choices: [{ message: { content: JSON.stringify(SAMPLE) } }],
          usage: { prompt_tokens: 11, completion_tokens: 22 },
        }),
    });
    const r = await provider.extract('# md');
    expect(r.data.transactions[0]?.description).toBe('X');
    expect(r.telemetry.inputTokens).toBe(11);
    expect(r.telemetry.outputTokens).toBe(22);
    expect(r.telemetry.costMicros).toBe(0n);
    expect(provider.id).toBe('local');
  });

  it('threads the configured temperature into the extract request (default 0)', async () => {
    let sentTemp: number | undefined;
    const capture = (init: RequestInit | undefined): Response => {
      sentTemp = JSON.parse(String(init?.body)).temperature;
      return okJsonResponse({ choices: [{ message: { content: JSON.stringify(SAMPLE) } }] });
    };
    // Default (no option) → temperature 0.
    const def = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      fetcher: async (_u, init) => capture(init),
    });
    await def.extract('# md');
    expect(sentTemp).toBe(0);
    // Explicit override → that value.
    const warm = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      temperature: 0.4,
      fetcher: async (_u, init) => capture(init),
    });
    await warm.extract('# md');
    expect(sentTemp).toBe(0.4);
  });

  it('statement-model: retries a transient per-page failure (fetch failed) and recovers', async () => {
    const prev = process.env.VIBETC_STATEMENT_PAGE_RETRY_MS;
    process.env.VIBETC_STATEMENT_PAGE_RETRY_MS = '0'; // no backoff in test
    try {
      let calls = 0;
      const provider = new LocalGatewayProvider({
        baseUrl: 'http://gw.test',
        modelId: 'qwen2.5-stmt',
        statementModelMode: true,
        fetcher: async () => {
          calls += 1;
          if (calls === 1) throw new TypeError('fetch failed'); // transient blip
          return okJsonResponse({
            message: {
              content: JSON.stringify({
                period: { start_date: '2026-05-01', end_date: '2026-05-31' },
                balances: { opening_balance_cents: 0, closing_balance_cents: 100 },
                transactions: [
                  { date: '2026-05-01', source_text: 'ROW', amount_cents: 100, source_page: 1 },
                ],
              }),
            },
            prompt_eval_count: 5,
            eval_count: 5,
          });
        },
      });
      const r = await provider.extract('# Page 1\n\nROW 1.00');
      expect(calls).toBe(2); // 1 fail + 1 retry-success
      expect(r.data.transactions).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.VIBETC_STATEMENT_PAGE_RETRY_MS;
      else process.env.VIBETC_STATEMENT_PAGE_RETRY_MS = prev;
    }
  });

  it('statement-model: fails with page context after exhausting retries', async () => {
    const prev = process.env.VIBETC_STATEMENT_PAGE_RETRY_MS;
    process.env.VIBETC_STATEMENT_PAGE_RETRY_MS = '0';
    try {
      const provider = new LocalGatewayProvider({
        baseUrl: 'http://gw.test',
        modelId: 'qwen2.5-stmt',
        statementModelMode: true,
        fetcher: async () => {
          throw new TypeError('fetch failed');
        },
      });
      await expect(provider.extract('# Page 1\n\nROW\n\n# Page 2\n\nROW2')).rejects.toThrowError(
        /page 1 of 2 after 3 attempts: fetch failed/i,
      );
    } finally {
      if (prev === undefined) delete process.env.VIBETC_STATEMENT_PAGE_RETRY_MS;
      else process.env.VIBETC_STATEMENT_PAGE_RETRY_MS = prev;
    }
  });

  it('throws an actionable error when the gateway truncates at max_tokens (finish_reason=length)', async () => {
    // Non-empty BUT cut off mid-JSON — the real failure on a transaction-heavy
    // statement. Must surface "truncated at max_tokens", not a JSON parse error.
    const truncated = JSON.stringify(SAMPLE).slice(0, 40); // valid prefix, no closing
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      fetcher: async () =>
        okJsonResponse({ choices: [{ message: { content: truncated }, finish_reason: 'length' }] }),
    });
    await expect(provider.extract('# md')).rejects.toThrowError(/truncated at max_tokens/i);
  });

  it('sends the configured maxCompletionTokens as max_tokens (not the old 6000)', async () => {
    let body: { max_tokens?: number } = {};
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      maxCompletionTokens: 24000,
      fetcher: async (_url, init) => {
        body = JSON.parse((init as RequestInit).body as string) as typeof body;
        return okJsonResponse({ choices: [{ message: { content: JSON.stringify(SAMPLE) } }] });
      },
    });
    await provider.extract('# md');
    expect(body.max_tokens).toBe(24000);
  });

  it('strips `pattern` from the schema sent to the gateway (Ollama grammar safety)', async () => {
    let body: { response_format?: { json_schema?: { schema?: unknown } } } = {};
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      modelId: 'qwen2.5:32b-instruct',
      fetcher: async (_url, init) => {
        body = JSON.parse((init as RequestInit).body as string) as typeof body;
        return okJsonResponse({ choices: [{ message: { content: JSON.stringify(SAMPLE) } }] });
      },
    });
    await provider.extract('# md', {
      schema: {
        type: 'object',
        properties: { posted_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
      },
    });
    // The regex `pattern` (which silently disables Ollama's grammar) is gone…
    expect(JSON.stringify(body.response_format?.json_schema?.schema)).not.toContain('pattern');
    // …and a non-ISO date is now SALVAGED (normalized) rather than rejected, so
    // one bad date never fails the whole statement.
    const bad = JSON.stringify({
      ...SAMPLE,
      transactions: [{ ...SAMPLE.transactions[0], posted_date: '03/03/2026' }],
    });
    const strict = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      fetcher: async () => okJsonResponse({ choices: [{ message: { content: bad } }] }),
    });
    const r = await strict.extract('# md');
    expect(r.data.transactions[0]?.posted_date).toBe('2026-03-03'); // normalized, not rejected
  });

  it('sends systemPromptOverride as the system message (text path); falls back to default', async () => {
    let body: { messages?: Array<{ role: string; content: string }> } = {};
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      modelId: 'qwen3-8b',
      fetcher: async (_url, init) => {
        body = JSON.parse((init as RequestInit).body as string) as typeof body;
        return okJsonResponse({ choices: [{ message: { content: JSON.stringify(SAMPLE) } }] });
      },
    });
    await provider.extract('# md', { systemPromptOverride: 'CUSTOM EXTRACTION PROMPT' });
    expect(body.messages?.[0]).toMatchObject({
      role: 'system',
      content: 'CUSTOM EXTRACTION PROMPT',
    });

    await provider.extract('# md'); // no override → built-in default
    expect(body.messages?.[0]?.content).not.toBe('CUSTOM EXTRACTION PROMPT');
    expect(body.messages?.[0]?.content).toMatch(/bank-statement transcription engine/i);
  });

  it('rejects schema-mismatch payloads with ExtractionResponseError carrying the raw response', async () => {
    // The exact shape the operator hit on the appliance: gateway returned
    // valid JSON but the `transactions` field was missing entirely. The
    // provider retries once with a reminder prompt; this fetcher returns
    // the same partial both times so the retry exhausts and the original
    // wrapper error surfaces, raw payload intact for the audit log.
    const partial = JSON.stringify({
      period: { start: '2026-03-01', end: '2026-03-31' },
      balances: { opening_cents: 100, closing_cents: 0 },
      source_date_format: { format: 'MDY', confidence: 0.9 },
    });
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      fetcher: async () => okJsonResponse({ choices: [{ message: { content: partial } }] }),
    });
    await expect(provider.extract('md')).rejects.toMatchObject({
      name: 'ExtractionResponseError',
      summary: 'LLM response did not match extraction schema',
      issues: expect.stringContaining('transactions'),
      rawResponse: partial,
      missingTopLevelFields: ['transactions'],
    });
  });

  it('retries once with a reminder prompt when the first response omits transactions', async () => {
    // Models the real recovery path: gateway sneaks a partial response
    // through the first time, the reminder prompt corrals it into
    // emitting a full extraction the second time. Telemetry accumulates
    // across both calls so cost/tokens stay accurate.
    const partial = JSON.stringify({
      period: { start: '2026-03-01', end: '2026-03-31' },
      balances: { opening_cents: 100, closing_cents: 0 },
      source_date_format: { format: 'MDY', confidence: 0.9 },
    });
    let callCount = 0;
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      fetcher: async () => {
        callCount += 1;
        return okJsonResponse({
          choices: [{ message: { content: callCount === 1 ? partial : JSON.stringify(SAMPLE) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      },
    });
    const r = await provider.extract('# md');
    expect(callCount).toBe(2);
    expect(r.data.transactions[0]?.description).toBe('X');
    expect(r.telemetry.inputTokens).toBe(20);
    expect(r.telemetry.outputTokens).toBe(10);
  });

  it('salvages a deeper-path bad date (→ period start) instead of failing or retrying', async () => {
    // An unparseable date used to be a hard path-2 fail; now it is salvaged to
    // the period start so the statement completes — in a single call (no retry).
    const broken = JSON.stringify({
      ...SAMPLE,
      transactions: [{ ...SAMPLE.transactions[0], posted_date: 'not-a-date' }],
    });
    let callCount = 0;
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      fetcher: async () => {
        callCount += 1;
        return okJsonResponse({ choices: [{ message: { content: broken } }] });
      },
    });
    const r = await provider.extract('md');
    expect(r.data.transactions[0]?.posted_date).toBe('2026-03-01'); // SAMPLE.period.start
    expect(callCount).toBe(1);
  });

  it('retries in json_object mode when the grammar dead-ends (peg-native 500)', async () => {
    // Ollama's grammar engine can 500 mid-generation on real OCR content. The
    // local provider must recover in plain JSON mode rather than bouncing to the
    // Anthropic fallback — the prompt + exemplars still convey the shape and Zod
    // re-validates.
    const formats: string[] = [];
    let calls = 0;
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      modelId: 'qwen2.5:32b-instruct',
      fetcher: async (_url, init) => {
        calls += 1;
        const body = JSON.parse((init as RequestInit).body as string) as {
          response_format?: { type?: string };
        };
        formats.push(body.response_format?.type ?? '');
        if (calls === 1) {
          return new Response(
            JSON.stringify({
              error: {
                message:
                  'llama-server chat error: The model produced output that does not match the expected peg-native format',
                type: 'api_error',
              },
            }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          );
        }
        return okJsonResponse({
          choices: [{ message: { content: JSON.stringify(SAMPLE) } }],
          usage: { prompt_tokens: 5, completion_tokens: 9 },
        });
      },
    });
    const r = await provider.extract('# md', { schema: { type: 'object' } });
    expect(r.data.transactions[0]?.description).toBe('X');
    // Grammar attempt first, then the no-grammar retry.
    expect(formats).toEqual(['json_schema', 'json_object']);
    expect(calls).toBe(2);
  });

  it('does NOT retry a non-grammar 500 (no schema → no grammar to blame)', async () => {
    let calls = 0;
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      fetcher: async () => {
        calls += 1;
        return new Response('upstream boom', { status: 500 });
      },
    });
    await expect(provider.extract('# md')).rejects.toThrow(/HTTP 500: upstream boom/);
    expect(calls).toBe(1);
  });

  it('skips the grammar attempt entirely when structuredOutputMode=json_object', async () => {
    const formats: string[] = [];
    let calls = 0;
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      structuredOutputMode: 'json_object',
      fetcher: async (_url, init) => {
        calls += 1;
        const body = JSON.parse((init as RequestInit).body as string) as {
          response_format?: { type?: string };
        };
        formats.push(body.response_format?.type ?? '');
        return okJsonResponse({ choices: [{ message: { content: JSON.stringify(SAMPLE) } }] });
      },
    });
    await provider.extract('# md', { schema: { type: 'object' } });
    // Even with a schema present, no grammar (json_schema) request is ever sent.
    expect(calls).toBe(1);
    expect(formats).toEqual(['json_object']);
  });

  it('rejects unparseable JSON with ExtractionResponseError', async () => {
    const broken = '{"period": {"start": "2026';
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      fetcher: async () => okJsonResponse({ choices: [{ message: { content: broken } }] }),
    });
    await expect(provider.extract('md')).rejects.toBeInstanceOf(ExtractionResponseError);
    await expect(provider.extract('md')).rejects.toMatchObject({
      summary: 'LLM response was not valid JSON',
      rawResponse: broken,
    });
  });

  it('OCRs scanned pages via the native /api/chat vision path', async () => {
    // The worker hands page images to extract({ images }); the local provider
    // POSTs them to Ollama's native /api/chat with the schema as `format`
    // and the vision model, then parses message.content as the extraction.
    let calledUrl = '';
    let body: Record<string, unknown> = {};
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      modelId: 'qwen3.5:35b-a3b',
      visionModelId: 'qwen2.5vl:7b',
      fetcher: async (url, init) => {
        calledUrl = String(url);
        body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
        return okJsonResponse({
          message: { content: JSON.stringify(SAMPLE) },
          prompt_eval_count: 30,
          eval_count: 12,
        });
      },
    });
    const r = await provider.extract('', {
      schema: { type: 'object' },
      images: [{ data: Buffer.from('img'), mediaType: 'image/jpeg' }],
    });
    expect(calledUrl).toBe('http://gw.test/api/chat');
    expect(body.model).toBe('qwen2.5vl:7b');
    expect(body.format).toEqual({ type: 'object' });
    const messages = body.messages as Array<{ images?: string[] }>;
    expect(messages[1]?.images?.[0]).toBe(Buffer.from('img').toString('base64'));
    expect(r.data.transactions[0]?.description).toBe('X');
    expect(r.telemetry.model).toBe('qwen2.5vl:7b');
    expect(r.telemetry.inputTokens).toBe(30);
    expect(r.telemetry.outputTokens).toBe(12);
    expect(r.telemetry.costMicros).toBe(0n);
  });

  it('throws on a non-2xx text response (HTTP rejection → provider fallback)', async () => {
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      fetcher: async () => new Response('upstream boom', { status: 500 }),
    });
    // The Ollama error body (model-not-pulled / OOM / grammar-compile failure)
    // is surfaced into the message so a 500 is diagnosable from the audit trace.
    await expect(provider.extract('# md')).rejects.toThrow(/HTTP 500: upstream boom/);
  });

  it('throws on a non-2xx vision response', async () => {
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      visionModelId: 'qwen2.5vl:7b',
      fetcher: async () => new Response('vision boom', { status: 503 }),
    });
    await expect(
      provider.extract('', { images: [{ data: Buffer.from('i'), mediaType: 'image/jpeg' }] }),
    ).rejects.toThrow(/ollama vision HTTP 503: vision boom/);
  });

  it('surfaces an empty vision completion as ExtractionResponseError', async () => {
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      fetcher: async () => okJsonResponse({ message: { content: '' } }),
    });
    await expect(
      provider.extract('', { images: [{ data: Buffer.from('i'), mediaType: 'image/jpeg' }] }),
    ).rejects.toMatchObject({
      name: 'ExtractionResponseError',
      summary: 'ollama vision returned an empty completion',
    });
  });

  it('rejects malformed vision JSON with ExtractionResponseError', async () => {
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      fetcher: async () => okJsonResponse({ message: { content: '{ not json' } }),
    });
    await expect(
      provider.extract('', { images: [{ data: Buffer.from('i'), mediaType: 'image/jpeg' }] }),
    ).rejects.toBeInstanceOf(ExtractionResponseError);
  });

  it('retries the vision call once when the first response omits transactions', async () => {
    const partial = JSON.stringify({
      period: { start: '2026-03-01', end: '2026-03-31' },
      balances: { opening_cents: 100, closing_cents: 0 },
      source_date_format: { format: 'MDY', confidence: 0.9 },
    });
    let callCount = 0;
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      fetcher: async () => {
        callCount += 1;
        return okJsonResponse({
          message: { content: callCount === 1 ? partial : JSON.stringify(SAMPLE) },
          prompt_eval_count: 10,
          eval_count: 5,
        });
      },
    });
    const r = await provider.extract('', {
      images: [{ data: Buffer.from('i'), mediaType: 'image/jpeg' }],
    });
    expect(callCount).toBe(2);
    expect(r.data.transactions[0]?.description).toBe('X');
    expect(r.telemetry.inputTokens).toBe(20);
  });

  it('strips a trailing /v1 from the base URL so the native /api/chat path resolves', async () => {
    let calledUrl = '';
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test/v1',
      fetcher: async (url) => {
        calledUrl = String(url);
        return okJsonResponse({ message: { content: JSON.stringify(SAMPLE) } });
      },
    });
    await provider.extract('', { images: [{ data: Buffer.from('i'), mediaType: 'image/jpeg' }] });
    expect(calledUrl).toBe('http://gw.test/api/chat');
  });

  it('completeWithImages posts images to /api/chat and returns parsed JSON (check-resolve)', async () => {
    let calledUrl = '';
    let body: Record<string, unknown> = {};
    const checks = { checks: [{ check_number: '1234', payee: 'JOHN DOE', amount_cents: 5000 }] };
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      visionModelId: 'qwen2.5vl:7b',
      fetcher: async (url, init) => {
        calledUrl = String(url);
        body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
        return okJsonResponse({
          message: { content: JSON.stringify(checks) },
          prompt_eval_count: 9,
          eval_count: 4,
        });
      },
    });
    const r = await provider.completeWithImages({
      systemPrompt: 'read checks',
      userPrompt: 'emit JSON',
      schema: { type: 'object' },
      images: [{ data: Buffer.from('img'), mediaType: 'image/png' }],
    });
    expect(calledUrl).toBe('http://gw.test/api/chat');
    expect(body.model).toBe('qwen2.5vl:7b');
    expect(body.format).toEqual({ type: 'object' });
    expect(r.data).toEqual(checks);
    expect(r.telemetry.inputTokens).toBe(9);
    expect(r.telemetry.costMicros).toBe(0n);
  });

  it('completeWithImages requires at least one image', async () => {
    const provider = new LocalGatewayProvider({ baseUrl: 'http://gw.test' });
    await expect(
      provider.completeWithImages({ systemPrompt: 's', userPrompt: 'u', schema: {}, images: [] }),
    ).rejects.toThrow(/at least one image/);
  });

  it('defaults the vision model to qwen3-vl (check-payee fallback; never the text model) when unset', async () => {
    expect(DEFAULT_VISION_MODEL).toBe('qwen3-vl:30b');
    const prev = process.env.OLLAMA_VISION_MODEL;
    delete process.env.OLLAMA_VISION_MODEL;
    let body: Record<string, unknown> = {};
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      modelId: 'qwen3.5:35b-a3b', // text model — must NOT be used for vision
      // no visionModelId → falls back to DEFAULT_VISION_MODEL
      fetcher: async (_url, init) => {
        body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
        return okJsonResponse({ message: { content: JSON.stringify(SAMPLE) } });
      },
    });
    try {
      await provider.extract('', { images: [{ data: Buffer.from('i'), mediaType: 'image/jpeg' }] });
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_VISION_MODEL;
      else process.env.OLLAMA_VISION_MODEL = prev;
    }
    expect(body.model).toBe(DEFAULT_VISION_MODEL);
  });

  it('caps vision output via num_predict (visionMaxTokens)', async () => {
    let body: { options?: { num_predict?: number } } = {};
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      visionMaxTokens: 4096,
      fetcher: async (_url, init) => {
        body = JSON.parse((init as RequestInit).body as string) as typeof body;
        return okJsonResponse({ message: { content: JSON.stringify(SAMPLE) } });
      },
    });
    await provider.extract('', { images: [{ data: Buffer.from('i'), mediaType: 'image/jpeg' }] });
    expect(body.options?.num_predict).toBe(4096);
  });

  it('ocrToMarkdown transcribes images via the local GLM-OCR engine (ADR-025)', async () => {
    clearOcrCache();
    resetOcrCircuit();
    resetEngineVersionCache();
    let url = '';
    let body: { model?: string } = {};
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      glmOcrUrl: 'http://glm.test:8090',
      glmOcrModel: 'glm-ocr',
      fetcher: async (u, init) => {
        url = String(u);
        if (url.endsWith('/version')) return new Response('{}', { status: 404 });
        body = JSON.parse((init as RequestInit).body as string) as typeof body;
        return okJsonResponse({
          choices: [
            { message: { content: '```\n# Page 1\n\nROW ONE\n```' }, finish_reason: 'stop' },
          ],
        });
      },
    });
    const r = await provider.ocrToMarkdown({
      images: [{ data: Buffer.from('glm-img-1'), mediaType: 'image/jpeg' }],
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(body.model).toBe('glm-ocr'); // GLM-OCR, not the Ollama vision model
    expect(r.markdown).toBe('# Page 1\n\nROW ONE'); // outer code fence stripped
    expect(r.telemetry.model).toBe('glm-ocr');
    expect(r.telemetry.costMicros).toBe(0n);
  });

  it('ocrToMarkdown rejects when GLM-OCR errors (no MiniCPM fallback — hard-removed)', async () => {
    clearOcrCache();
    resetOcrCircuit();
    resetEngineVersionCache();
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      glmOcrUrl: 'http://glm.test:8090',
      fetcher: async (u) => {
        if (String(u).endsWith('/version')) return new Response('{}', { status: 404 });
        return new Response('boom', { status: 500 });
      },
    });
    await expect(
      provider.ocrToMarkdown({
        images: [{ data: Buffer.from('glm-img-err'), mediaType: 'image/jpeg' }],
        systemPrompt: 's',
        userPrompt: 'u',
      }),
    ).rejects.toThrow(/GLM-OCR/);
  });

  it('ocrImagesToText concatenates GLM-OCR page text (check-payee primary path)', async () => {
    clearOcrCache();
    resetOcrCircuit();
    resetEngineVersionCache();
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      glmOcrUrl: 'http://glm.test:8090',
      glmOcrModel: 'glm-ocr',
      fetcher: async (u) => {
        if (String(u).endsWith('/version')) return new Response('{}', { status: 404 });
        return okJsonResponse({
          choices: [{ message: { content: 'Pay to the order of ACME' }, finish_reason: 'stop' }],
        });
      },
    });
    const r = await provider.ocrImagesToText([
      { data: Buffer.from('chk-1'), mediaType: 'image/png' },
    ]);
    expect(r.text).toBe('Pay to the order of ACME');
    expect(r.model).toBe('glm-ocr');
  });
});

describe('AnthropicProvider', () => {
  it('reads input from the tool_use content block', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-6',
      fetcher: async () =>
        okJsonResponse({
          content: [{ type: 'tool_use', name: 'emit_extraction', input: SAMPLE }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
    });
    const r = await provider.extract('# md');
    expect(r.data.balances.opening_cents).toBe(100);
    expect(r.telemetry.inputTokens).toBe(100);
    expect(r.telemetry.costMicros).toBeGreaterThan(0n);
    expect(provider.id).toBe('anthropic');
  });

  it('retries once with a reminder prompt when tool_use input omits transactions', async () => {
    // Same defensive retry the local gateway uses — Anthropic tool_use
    // almost always honors input_schema, but if the model ever ships a
    // tool_use whose input drops a required top-level field, we recover
    // before bouncing to provider fallback.
    const partial = {
      period: { start: '2026-03-01', end: '2026-03-31' },
      balances: { opening_cents: 100, closing_cents: 0 },
      source_date_format: { format: 'MDY', confidence: 0.9 },
    };
    let callCount = 0;
    const provider = new AnthropicProvider({
      apiKey: 'k',
      fetcher: async () => {
        callCount += 1;
        const input = callCount === 1 ? partial : SAMPLE;
        return okJsonResponse({
          content: [{ type: 'tool_use', name: 'emit_extraction', input }],
          usage: { input_tokens: 20, output_tokens: 10 },
        });
      },
    });
    const r = await provider.extract('md');
    expect(callCount).toBe(2);
    expect(r.data.transactions[0]?.description).toBe('X');
    expect(r.telemetry.inputTokens).toBe(40);
    expect(r.telemetry.outputTokens).toBe(20);
  });

  it('reports truncation (not a schema miss) and does not retry when stop_reason=max_tokens', async () => {
    // A multi-page statement whose transaction list overflows the output
    // cap: Anthropic returns the partial tool_use input (header fields, no
    // transactions) with stop_reason='max_tokens'. The guard must surface
    // truncation rather than letting Zod blame `transactions: Required`,
    // and must NOT burn a reminder retry (same cap → same truncation).
    const partial = {
      period: { start: '2026-03-01', end: '2026-03-31' },
      balances: { opening_cents: 100, closing_cents: 0 },
      source_date_format: { format: 'MDY', confidence: 0.9 },
    };
    let callCount = 0;
    const provider = new AnthropicProvider({
      apiKey: 'k',
      maxTokens: 6000,
      fetcher: async () => {
        callCount += 1;
        return okJsonResponse({
          content: [{ type: 'tool_use', name: 'emit_extraction', input: partial }],
          stop_reason: 'max_tokens',
          usage: { input_tokens: 20, output_tokens: 6000 },
        });
      },
    });
    await expect(provider.extract('md')).rejects.toMatchObject({
      name: 'ExtractionResponseError',
      summary: 'LLM output truncated at max_tokens (6000)',
    });
    expect(callCount).toBe(1);
  });

  it('sends the configured max_tokens unchanged (no gateway ceiling clamp)', async () => {
    let sentMaxTokens = -1;
    const provider = new AnthropicProvider({
      apiKey: 'sk-ant-k',
      baseUrl: 'https://api.anthropic.com',
      maxTokens: 64_000,
      fetcher: async (_url, init) => {
        sentMaxTokens = JSON.parse((init as RequestInit).body as string).max_tokens;
        return okJsonResponse({
          content: [{ type: 'tool_use', name: 'emit_extraction', input: SAMPLE }],
          usage: { input_tokens: 10, output_tokens: 10 },
        });
      },
    });
    await provider.extract('# md');
    expect(sentMaxTokens).toBe(64_000);
  });

  it('sends systemPromptOverride as the Anthropic system field', async () => {
    let body: { system?: string } = {};
    const provider = new AnthropicProvider({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-6',
      fetcher: async (_url, init) => {
        body = JSON.parse((init as RequestInit).body as string) as typeof body;
        return okJsonResponse({
          content: [{ type: 'tool_use', name: 'emit_extraction', input: SAMPLE }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    await provider.extract('# md', { systemPromptOverride: 'CUSTOM ANTHROPIC PROMPT' });
    expect(body.system).toBe('CUSTOM ANTHROPIC PROMPT');
  });

  it('rejects image inputs — Anthropic is text-only (vision/OCR is local)', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'k',
      fetcher: async () =>
        okJsonResponse({
          content: [{ type: 'tool_use', name: 'emit_extraction', input: SAMPLE }],
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
    });
    await expect(
      provider.extract('', { images: [{ data: Buffer.from('img'), mediaType: 'image/jpeg' }] }),
    ).rejects.toThrow(/text-only/);
  });

  it('completeWithImages rejects — Anthropic is text-only', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k' });
    await expect(
      provider.completeWithImages({
        systemPrompt: 's',
        userPrompt: 'u',
        schema: {},
        images: [{ data: Buffer.from('i'), mediaType: 'image/png' }],
      }),
    ).rejects.toThrow(/text-only/);
  });

  it('ocrToMarkdown rejects — OCR is local-only (page images never egress)', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k' });
    await expect(
      provider.ocrToMarkdown({
        systemPrompt: 's',
        userPrompt: 'u',
        images: [{ data: Buffer.from('i'), mediaType: 'image/png' }],
      }),
    ).rejects.toThrow(/text-only/);
  });

  it('surfaces a non-2xx response body + request shape on an HTTP error', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'sk-ant-k',
      model: 'claude-sonnet-4-6',
      fetcher: async () =>
        new Response('{"error":{"type":"overloaded_error","message":"Overloaded"}}', {
          status: 529,
        }),
    });
    await expect(provider.extract('# md')).rejects.toThrow(/anthropic HTTP 529.*Overloaded/s);
  });

  it('wraps missing-tool_use as ExtractionResponseError so the audit log captures the raw body', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'k',
      fetcher: async () =>
        okJsonResponse({ content: [{ type: 'text', text: 'I cannot use the tool' }] }),
    });
    await expect(provider.extract('md')).rejects.toMatchObject({
      name: 'ExtractionResponseError',
      summary: 'anthropic response missing tool_use block',
      rawResponse: expect.stringContaining('I cannot use the tool'),
    });
  });
});

describe('LocalGatewayProvider empty-completion handling', () => {
  it('surfaces an ExtractionResponseError when the gateway returns an empty content string', async () => {
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      fetcher: async () =>
        okJsonResponse({
          choices: [{ message: { content: '' }, finish_reason: 'length' }],
        }),
    });
    await expect(provider.extract('md')).rejects.toMatchObject({
      name: 'ExtractionResponseError',
      summary: 'local gateway returned an empty completion',
      issues: 'finish_reason=length',
    });
  });
});

describe('LocalGatewayProvider.complete (C13)', () => {
  const completeOpts = { systemPrompt: 's', userPrompt: 'u', schema: { type: 'object' } };

  it('sends the configured maxCompletionTokens (not a hard 6000) when no per-call cap', async () => {
    let body: { max_tokens?: number } = {};
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      maxCompletionTokens: 20_000,
      fetcher: async (_url, init) => {
        body = JSON.parse((init as RequestInit).body as string) as typeof body;
        return okJsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] });
      },
    });
    const r = await provider.complete(completeOpts);
    expect(body.max_tokens).toBe(20_000);
    expect(r.data).toEqual({ ok: true });
    await provider.complete({ ...completeOpts, maxOutputTokens: 4096 }); // per-call cap wins
    expect(body.max_tokens).toBe(4096);
  });

  it('throws an actionable truncation error on finish_reason=length (not "not valid JSON")', async () => {
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      maxCompletionTokens: 20_000,
      fetcher: async () =>
        okJsonResponse({
          choices: [
            { message: { content: '{"transactions": [{"index": 0' }, finish_reason: 'length' },
          ],
        }),
    });
    await expect(provider.complete(completeOpts)).rejects.toMatchObject({
      name: 'ExtractionResponseError',
      summary: 'ollama complete() output truncated at max_tokens (20000)',
      rawResponse: '{"transactions": [{"index": 0',
    });
  });
});

describe('LocalGatewayProvider statement-model date override (C11b)', () => {
  it('tells every page the confirmed order, reads rows with it, and forces source_date_format', async () => {
    const prev = process.env.VIBETC_STATEMENT_PAGE_RETRY_MS;
    process.env.VIBETC_STATEMENT_PAGE_RETRY_MS = '0';
    const sent: string[] = [];
    try {
      const provider = new LocalGatewayProvider({
        baseUrl: 'http://gw.test',
        modelId: 'qwen2.5-stmt',
        statementModelMode: true,
        fetcher: async (_url, init) => {
          const body = JSON.parse((init as RequestInit).body as string) as {
            messages: Array<{ content: string }>;
          };
          sent.push(body.messages[0]!.content);
          return okJsonResponse({
            message: {
              content: JSON.stringify({
                source_date_format: 'MDY', // the model's guess — overridden
                period: { start_date: '2026-04-01', end_date: '2026-04-30' },
                transactions: [{ date: '05/04/2026', source_text: 'ROW', amount_cents: 100 }],
              }),
            },
          });
        },
      });
      const r = await provider.extract('# Page 1\n\nROW\n\n# Page 2\n\nROW2', {
        dateFormatOverride: 'DMY',
      });
      expect(sent).toHaveLength(2);
      for (const content of sent) {
        expect(content.startsWith('Dates on this statement are written in DMY order')).toBe(true);
      }
      expect(r.data.source_date_format).toMatchObject({ format: 'DMY', confidence: 1 });
      expect(r.data.transactions.map((t) => t.posted_date)).toEqual(['2026-04-05', '2026-04-05']);
    } finally {
      if (prev === undefined) delete process.env.VIBETC_STATEMENT_PAGE_RETRY_MS;
      else process.env.VIBETC_STATEMENT_PAGE_RETRY_MS = prev;
    }
  });

  it('sends no date-order line when there is no override', async () => {
    let content = '';
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      modelId: 'qwen2.5-stmt',
      statementModelMode: true,
      fetcher: async (_url, init) => {
        content = (
          JSON.parse((init as RequestInit).body as string) as {
            messages: Array<{ content: string }>;
          }
        ).messages[0]!.content;
        return okJsonResponse({
          message: {
            content: JSON.stringify({
              source_date_format: 'MDY',
              period: { start_date: '2026-04-01', end_date: '2026-04-30' },
              transactions: [{ date: '2026-04-05', source_text: 'ROW', amount_cents: 100 }],
            }),
          },
        });
      },
    });
    await provider.extract('# Page 1\n\nROW');
    expect(content.startsWith('<statement_ocr>')).toBe(true);
  });
});

describe('LocalGatewayProvider statement-model closing balance', () => {
  it('does not hold a complete statement whose page 2 reports its own closing', async () => {
    const prev = process.env.VIBETC_STATEMENT_PAGE_RETRY_MS;
    process.env.VIBETC_STATEMENT_PAGE_RETRY_MS = '0';
    // Per-page outputs: page 2 reports its own last running balance as the
    // closing; page 3 prints none — so the merged "printed" closing is page 2's.
    const perPage: Record<string, unknown> = {
      P1: {
        source_date_format: 'MDY',
        period: { start_date: '2026-05-01', end_date: '2026-05-31' },
        balances: { opening_balance_cents: 100_000, closing_balance_cents: null },
        transactions: [
          {
            date: '2026-05-02',
            source_text: 'A',
            amount_cents: 10_000,
            running_balance_cents: 110_000,
          },
        ],
      },
      P2: {
        balances: { opening_balance_cents: null, closing_balance_cents: 130_000 },
        transactions: [
          {
            date: '2026-05-10',
            source_text: 'B',
            amount_cents: 20_000,
            running_balance_cents: 130_000,
          },
        ],
      },
      P3: {
        balances: { opening_balance_cents: null, closing_balance_cents: null },
        transactions: [
          {
            date: '2026-05-20',
            source_text: 'C',
            amount_cents: -5_000,
            running_balance_cents: 125_000,
          },
        ],
      },
    };
    try {
      const provider = new LocalGatewayProvider({
        baseUrl: 'http://gw.test',
        modelId: 'qwen2.5-stmt',
        statementModelMode: true,
        fetcher: async (_url, init) => {
          const content = (
            JSON.parse((init as RequestInit).body as string) as {
              messages: Array<{ content: string }>;
            }
          ).messages[0]!.content;
          const key = ['P1', 'P2', 'P3'].find((k) => content.includes(k))!;
          return okJsonResponse({ message: { content: JSON.stringify(perPage[key]) } });
        },
      });
      const r = await provider.extract('# Page 1\n\nP1\n\n# Page 2\n\nP2\n\n# Page 3\n\nP3');
      expect(r.data.balances).toEqual({ opening_cents: 100_000, closing_cents: 125_000 });
      expect(r.data.notes).toBeUndefined(); // nothing to hold for review
    } finally {
      if (prev === undefined) delete process.env.VIBETC_STATEMENT_PAGE_RETRY_MS;
      else process.env.VIBETC_STATEMENT_PAGE_RETRY_MS = prev;
    }
  });
});

describe('JSON parse failures never quote model output (error messages are logged/stored)', () => {
  const parseErr = (s: string): unknown => {
    try {
      JSON.parse(s);
    } catch (err) {
      return err;
    }
    throw new Error('expected JSON.parse to throw');
  };

  it('describeJsonParseError keeps only the error name and offset', () => {
    expect(describeJsonParseError(parseErr('Jane Doe acct 4444555566'))).toBe('SyntaxError');
    expect(describeJsonParseError(parseErr('{"a": 1 "b": 2}'))).toMatch(
      /^SyntaxError at position \d+$/,
    );
    expect(describeJsonParseError(parseErr('{"a": 1} trailing'))).toBe('SyntaxError at position 9');
    expect(describeJsonParseError(parseErr(''))).toBe('SyntaxError: unexpected end of JSON input');
  });

  it('parseExtractionResponse: the raw text stays in rawResponse only', () => {
    let err: unknown;
    try {
      parseExtractionResponse('Jane Doe acct 4444555566');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExtractionResponseError);
    const e = err as ExtractionResponseError;
    expect(e.issues).toBe('SyntaxError; prose-recovery attempt also failed');
    expect(e.message).not.toMatch(/Jane|4444555566/);
    expect(e.rawResponse).toBe('Jane Doe acct 4444555566');
  });

  it('statement model: an unparseable page is non-transient and names no model text', async () => {
    const prev = process.env.VIBETC_STATEMENT_PAGE_RETRY_MS;
    process.env.VIBETC_STATEMENT_PAGE_RETRY_MS = '0';
    try {
      const provider = new LocalGatewayProvider({
        baseUrl: 'http://gw.test',
        modelId: 'qwen2.5-stmt',
        statementModelMode: true,
        fetcher: async () => okJsonResponse({ message: { content: 'Jane Doe acct 4444555566' } }),
      });
      const err = await provider.extract('# Page 1\n\nROW').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExtractionResponseError);
      expect((err as ExtractionResponseError).message).not.toMatch(/Jane|4444555566/);
      expect((err as ExtractionResponseError).transient).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.VIBETC_STATEMENT_PAGE_RETRY_MS;
      else process.env.VIBETC_STATEMENT_PAGE_RETRY_MS = prev;
    }
  });
});

describe('ExtractionResponseError.transient — set for empty completions only', () => {
  const image = [{ data: Buffer.from('i'), mediaType: 'image/jpeg' as const }];
  const completeOpts = { systemPrompt: 's', userPrompt: 'u', schema: { type: 'object' } };
  const gateway = (choice: Record<string, unknown>) =>
    new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      fetcher: async () => okJsonResponse({ choices: [choice] }),
    });

  it('text path: an empty completion is transient, unless it stopped at the token cap', async () => {
    await expect(
      gateway({ message: { content: '' }, finish_reason: 'stop' }).extract('md'),
    ).rejects.toMatchObject({
      summary: 'local gateway returned an empty completion',
      transient: true,
    });
    await expect(
      gateway({ message: { content: '' }, finish_reason: 'length' }).extract('md'),
    ).rejects.toMatchObject({ transient: false });
  });

  it('complete(): an empty completion is transient, unless at the token cap', async () => {
    await expect(
      gateway({ message: { content: '' }, finish_reason: 'stop' }).complete(completeOpts),
    ).rejects.toMatchObject({ transient: true });
    await expect(
      gateway({ message: { content: '' }, finish_reason: 'length' }).complete(completeOpts),
    ).rejects.toMatchObject({ transient: false });
  });

  it('vision: an empty completion is transient, unless done_reason=length', async () => {
    const vision = (body: unknown) =>
      new LocalGatewayProvider({
        baseUrl: 'http://gw.test',
        fetcher: async () => okJsonResponse(body),
      });
    await expect(
      vision({ message: { content: '' }, done_reason: 'stop' }).extract('', { images: image }),
    ).rejects.toMatchObject({
      summary: 'ollama vision returned an empty completion',
      transient: true,
    });
    await expect(
      vision({ message: { content: '' }, done_reason: 'length' }).extract('', { images: image }),
    ).rejects.toMatchObject({ issues: 'done_reason=length', transient: false });
  });

  it('statement model: still transient after the per-page retries are exhausted', async () => {
    const prev = process.env.VIBETC_STATEMENT_PAGE_RETRY_MS;
    process.env.VIBETC_STATEMENT_PAGE_RETRY_MS = '0';
    try {
      const provider = new LocalGatewayProvider({
        baseUrl: 'http://gw.test',
        modelId: 'qwen2.5-stmt',
        statementModelMode: true,
        fetcher: async () => okJsonResponse({ message: { content: '' } }),
      });
      const err = await provider.extract('# Page 1\n\nROW').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExtractionResponseError);
      expect((err as ExtractionResponseError).summary).toMatch(
        /page 1 of 1 after 3 attempts: statement model returned an empty completion/,
      );
      expect((err as ExtractionResponseError).transient).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.VIBETC_STATEMENT_PAGE_RETRY_MS;
      else process.env.VIBETC_STATEMENT_PAGE_RETRY_MS = prev;
    }
  });

  it('truncation, unparseable output and schema mismatch are not transient', async () => {
    const truncated = await gateway({ message: { content: '{"a":' }, finish_reason: 'length' })
      .extract('md')
      .catch((e: unknown) => e);
    expect(truncated).toBeInstanceOf(ExtractionResponseError);
    expect((truncated as ExtractionResponseError).transient).toBeUndefined();
    const garbled = await gateway({ message: { content: '{ not json' } })
      .extract('md')
      .catch((e: unknown) => e);
    expect((garbled as ExtractionResponseError).summary).toBe('LLM response was not valid JSON');
    expect((garbled as ExtractionResponseError).transient).toBeUndefined();
    const schemaMiss = await gateway({ message: { content: '{"transactions": "nope"}' } })
      .extract('md')
      .catch((e: unknown) => e);
    expect((schemaMiss as ExtractionResponseError).summary).toBe(
      'LLM response did not match extraction schema',
    );
    expect((schemaMiss as ExtractionResponseError).transient).toBeUndefined();
  });
});

describe('dateFormatOverride reaches the parser on every provider path (C27)', () => {
  const nonIso = {
    ...SAMPLE,
    transactions: [{ ...SAMPLE.transactions[0], posted_date: '03/04/2026' }],
  };

  it('LocalGatewayProvider text path', async () => {
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      fetcher: async () =>
        okJsonResponse({ choices: [{ message: { content: JSON.stringify(nonIso) } }] }),
    });
    const r = await provider.extract('# md', { dateFormatOverride: 'DMY' });
    expect(r.data.transactions[0]!.posted_date).toBe('2026-04-03');
    expect(r.data.source_date_format.format).toBe('DMY');
  });

  it('AnthropicProvider', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'k',
      fetcher: async () =>
        okJsonResponse({
          content: [{ type: 'tool_use', name: 'emit_extraction', input: nonIso }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    });
    const r = await provider.extract('# md', { dateFormatOverride: 'DMY' });
    expect(r.data.transactions[0]!.posted_date).toBe('2026-04-03');
    expect(r.data.source_date_format.format).toBe('DMY');
  });
});

describe('parseExtractionResponse prose-recovery', () => {
  const sampleJson = JSON.stringify(SAMPLE);

  it('parses plain JSON unchanged (regression)', () => {
    const r = parseExtractionResponse(sampleJson);
    expect(r.balances.opening_cents).toBe(100);
  });

  it('recovers from a prose prefix wrapping the JSON', () => {
    const wrapped = `Sure! Here is the extraction:\n${sampleJson}`;
    const r = parseExtractionResponse(wrapped);
    expect(r.transactions[0]?.description).toBe('X');
  });

  it('recovers from a prose suffix following the JSON', () => {
    const wrapped = `${sampleJson}\n\nLet me know if you need anything else.`;
    const r = parseExtractionResponse(wrapped);
    expect(r.period.start).toBe('2026-03-01');
  });

  it('recovers from both prefix and suffix', () => {
    const wrapped = `Here you go:\n\n${sampleJson}\n\nDone!`;
    const r = parseExtractionResponse(wrapped);
    expect(r.transactions).toHaveLength(1);
  });

  it('throws ExtractionResponseError when no JSON object is recoverable', () => {
    expect(() => parseExtractionResponse('I cannot do that.')).toThrow(ExtractionResponseError);
  });

  it('throws when carved range is itself unparseable JSON', () => {
    // Has braces but the slice between them is not valid JSON.
    expect(() => parseExtractionResponse('{ this is not json }')).toThrow(ExtractionResponseError);
  });
});

describe('computeAnthropicCostMicros', () => {
  it('calculates a non-zero cost for a known model', () => {
    expect(computeAnthropicCostMicros('claude-sonnet-4-6', 1_000_000, 100_000)).toBeGreaterThan(0n);
  });
  it('returns 0 for an unknown model', () => {
    expect(computeAnthropicCostMicros('not-a-model', 100, 100)).toBe(0n);
  });
});
