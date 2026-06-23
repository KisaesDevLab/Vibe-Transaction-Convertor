import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  DEFAULT_VISION_MODEL,
  ExtractionResponseError,
  LocalGatewayProvider,
  computeAnthropicCostMicros,
  describeAnthropicRequest,
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
    // …but Zod still enforces the date format after parsing — a bad date is
    // rejected even though the gateway grammar never saw the pattern.
    const bad = JSON.stringify({
      ...SAMPLE,
      transactions: [{ ...SAMPLE.transactions[0], posted_date: '03/03/2026' }],
    });
    const strict = new LocalGatewayProvider({
      baseUrl: 'http://gw.test',
      fetcher: async () => okJsonResponse({ choices: [{ message: { content: bad } }] }),
    });
    await expect(strict.extract('# md')).rejects.toBeInstanceOf(ExtractionResponseError);
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
    expect(body.messages?.[0]?.content).toMatch(/bank-statement extractor/i);
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
