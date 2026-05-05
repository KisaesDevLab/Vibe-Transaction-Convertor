// Phase 27 #29 — parameterized contract tests for the LlmProvider
// abstraction (ADR-019, ADR-020). Both `LocalGatewayProvider` and
// `AnthropicProvider` MUST satisfy the same observable contract — the
// downstream pipeline never branches on provider id, so any divergence
// here is a bug.

import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  LocalGatewayProvider,
  prepareMarkdown,
  type ExtractCallTelemetry,
  type ExtractResult,
  type LlmProvider,
} from './llm-client.js';

// Minimal valid extraction shaped to the nested ExtractionResult schema.
const SAMPLE_EXTRACTION = {
  period: { start: '2026-03-01', end: '2026-03-31' },
  balances: { opening_cents: 0, closing_cents: 0 },
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
} as const;

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

interface CapturedRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}

interface ProviderTestCase {
  name: 'local' | 'anthropic';
  factory: (capture: CapturedRequest[]) => LlmProvider;
  /** OK response shape for this provider. */
  successResponse: unknown;
  /** When given a JSON Schema, the provider should embed it as ... */
  expectSchemaSignal: (body: string) => boolean;
  /** Where to find the user prompt content in the captured body. */
  extractUserPrompt: (body: string) => string;
}

const localCase: ProviderTestCase = {
  name: 'local',
  factory: (capture) =>
    new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      modelId: 'qwen3-8b',
      fetcher: async (input, init) => {
        capture.push({
          url: typeof input === 'string' ? input : (input as URL | Request).toString(),
          body: typeof init?.body === 'string' ? init.body : '',
          headers: (init?.headers as Record<string, string>) ?? {},
        });
        return okJson({
          choices: [{ message: { content: JSON.stringify(SAMPLE_EXTRACTION) } }],
          usage: { prompt_tokens: 11, completion_tokens: 22 },
        });
      },
    }),
  successResponse: {
    choices: [{ message: { content: JSON.stringify(SAMPLE_EXTRACTION) } }],
    usage: { prompt_tokens: 11, completion_tokens: 22 },
  },
  // Local provider sets response_format.type = 'json_schema' when schema given.
  expectSchemaSignal: (body) =>
    /"response_format"\s*:\s*\{\s*"type"\s*:\s*"json_schema"/.test(body),
  extractUserPrompt: (body) => {
    const parsed = JSON.parse(body) as {
      messages: Array<{ role: string; content: string }>;
    };
    return parsed.messages.map((m) => m.content).join('\n');
  },
};

const anthropicCase: ProviderTestCase = {
  name: 'anthropic',
  factory: (capture) =>
    new AnthropicProvider({
      apiKey: 'sk-ant-test-1234567890abcdefghij',
      model: 'claude-sonnet-4-6',
      fetcher: async (input, init) => {
        capture.push({
          url: typeof input === 'string' ? input : (input as URL | Request).toString(),
          body: typeof init?.body === 'string' ? init.body : '',
          headers: (init?.headers as Record<string, string>) ?? {},
        });
        return okJson({
          content: [{ type: 'tool_use', name: 'emit_extraction', input: SAMPLE_EXTRACTION }],
          usage: { input_tokens: 100, output_tokens: 50 },
        });
      },
    }),
  successResponse: {
    content: [{ type: 'tool_use', name: 'emit_extraction', input: SAMPLE_EXTRACTION }],
    usage: { input_tokens: 100, output_tokens: 50 },
  },
  // Anthropic provider always sends a tools[] block with input_schema, and
  // forces tool_choice to that tool — that's the schema-constrained signal.
  expectSchemaSignal: (body) => {
    const parsed = JSON.parse(body) as {
      tools?: Array<{ name?: string; input_schema?: unknown }>;
      tool_choice?: { type?: string; name?: string };
    };
    const hasTool = (parsed.tools ?? []).some(
      (t) => t.name === 'emit_extraction' && t.input_schema !== undefined,
    );
    const choiceLocked = parsed.tool_choice?.type === 'tool';
    return hasTool && choiceLocked;
  },
  extractUserPrompt: (body) => {
    const parsed = JSON.parse(body) as {
      system?: string;
      messages: Array<{ role: string; content: string | Array<{ type?: string; text?: string }> }>;
    };
    const sys = parsed.system ?? '';
    const userBits = parsed.messages.flatMap((m) =>
      typeof m.content === 'string' ? [m.content] : m.content.map((c) => c.text ?? ''),
    );
    return [sys, ...userBits].join('\n');
  },
};

const cases: ProviderTestCase[] = [localCase, anthropicCase];

describe.each(cases)('LlmProvider contract — $name', (tc) => {
  it('extract() returns { data, telemetry, rawJson }', async () => {
    const capture: CapturedRequest[] = [];
    const provider = tc.factory(capture);
    const r: ExtractResult = await provider.extract('# md');

    // shape
    expect(r).toHaveProperty('data');
    expect(r).toHaveProperty('telemetry');
    expect(r).toHaveProperty('rawJson');

    // data is the parsed extraction
    expect(r.data.transactions[0]?.description).toBe('X');

    // telemetry is the documented shape
    const t: ExtractCallTelemetry = r.telemetry;
    expect(typeof t.inputTokens).toBe('number');
    expect(typeof t.outputTokens).toBe('number');
    expect(typeof t.ms).toBe('number');
    expect(t.ms).toBeGreaterThanOrEqual(0);
    expect(typeof t.model).toBe('string');
    expect(typeof t.costMicros).toBe('bigint');

    // rawJson is a serialized JSON string of the same data
    expect(typeof r.rawJson).toBe('string');
    expect(() => JSON.parse(r.rawJson)).not.toThrow();
  });

  it('health() returns { ok: boolean, detail?: string }', async () => {
    const capture: CapturedRequest[] = [];
    const provider = tc.factory(capture);
    const h = await provider.health();
    expect(h).toHaveProperty('ok');
    expect(typeof h.ok).toBe('boolean');
    if ('detail' in h && h.detail !== undefined) {
      expect(typeof h.detail).toBe('string');
    }
  });

  it('dateFormatOverride flows into the prompt content', async () => {
    const capture: CapturedRequest[] = [];
    const provider = tc.factory(capture);
    await provider.extract('# md', { dateFormatOverride: 'DMY' });
    expect(capture).toHaveLength(1);
    const promptBlob = tc.extractUserPrompt(capture[0]!.body);
    // The override-line in prompts/extract.ts says:
    // "interpret every date in the markdown using the **DMY** format"
    expect(promptBlob).toMatch(/\*\*DMY\*\*/);
    expect(promptBlob).toMatch(/Operator override/i);
  });

  it('extract() with markdown larger than the budget gets truncated', async () => {
    // Squeeze the budget so we can verify the truncation runs without
    // blowing up the test process. We just need to prove prepareMarkdown
    // is the boundary and the captured body length stays bounded.
    const ORIG = process.env.LLM_MAX_PROMPT_TOKENS;
    process.env.LLM_MAX_PROMPT_TOKENS = '5000'; // ~4KB after the reserve

    try {
      // Sanity check: prepareMarkdown actually truncates this size of input.
      const big = 'A'.repeat(200_000);
      const prepared = prepareMarkdown(big);
      expect(prepared.truncated).toBe(true);
      expect(prepared.text.length).toBeLessThan(big.length);

      const capture: CapturedRequest[] = [];
      const provider = tc.factory(capture);
      await provider.extract(big);
      expect(capture).toHaveLength(1);
      // The captured request body is bounded — it must be smaller than the
      // raw input plus a generous overhead allowance for prompt scaffolding.
      const body = capture[0]!.body;
      expect(body.length).toBeLessThan(big.length / 2);
    } finally {
      if (ORIG === undefined) delete process.env.LLM_MAX_PROMPT_TOKENS;
      else process.env.LLM_MAX_PROMPT_TOKENS = ORIG;
    }
  });

  it('schema-constrained mode emits the provider-correct signal on the wire', async () => {
    const capture: CapturedRequest[] = [];
    const provider = tc.factory(capture);
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { foo: { type: 'string' } },
    };
    await provider.extract('# md', { schema });
    expect(capture).toHaveLength(1);
    expect(tc.expectSchemaSignal(capture[0]!.body)).toBe(true);
  });
});
