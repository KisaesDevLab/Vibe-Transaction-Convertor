import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  ExtractionResponseError,
  LocalGatewayProvider,
  computeAnthropicCostMicros,
  parseExtractionResponse,
} from './llm-client.js';

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

  it('does not retry when the error is at a deeper path (no missing top-level fields)', async () => {
    // A transaction with an invalid date is a path-2 error; the retry
    // is only meant to recover from a relaxed-gateway "forgot a top-
    // level key" failure, not from semantic content errors.
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
    await expect(provider.extract('md')).rejects.toBeInstanceOf(ExtractionResponseError);
    expect(callCount).toBe(1);
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
