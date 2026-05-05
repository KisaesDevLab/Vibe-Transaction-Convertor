import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  LocalGatewayProvider,
  computeAnthropicCostMicros,
} from './llm-client.js';

const SAMPLE = {
  period_start: '2026-03-01',
  period_end: '2026-03-31',
  opening_balance_cents: 0,
  closing_balance_cents: 0,
  source_date_format: 'MDY',
  source_date_format_confidence: 0.9,
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

  it('rejects when the response is not schema-valid', async () => {
    const provider = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      fetcher: async () => okJsonResponse({ choices: [{ message: { content: '{"oops":1}' } }] }),
    });
    await expect(provider.extract('md')).rejects.toThrow();
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
    expect(r.data.opening_balance_cents).toBe(0);
    expect(r.telemetry.inputTokens).toBe(100);
    expect(r.telemetry.costMicros).toBeGreaterThan(0n);
    expect(provider.id).toBe('anthropic');
  });

  it('throws when the response has no tool_use block', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'k',
      fetcher: async () => okJsonResponse({ content: [{ type: 'text', text: 'sorry' }] }),
    });
    await expect(provider.extract('md')).rejects.toThrow(/tool_use/);
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
