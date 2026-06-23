import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOpenAiOcrRequestBody,
  clearOcrCache,
  GlmOcrError,
  ocrPdfPages,
  parseOpenAiChatResponse,
  resetEngineVersionCache,
  resetOcrCircuit,
} from './glm-ocr-client.js';

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const failResponse = (status: number): Response => new Response(`error ${status}`, { status });

const buildFetcher = (
  handler: (args: { url: string; init: RequestInit }) => Promise<Response>,
): typeof fetch => {
  return async (input, init) => handler({ url: String(input), init: init ?? {} });
};

// Canonical successful response from vibe-glm-ocr (llama-server) — the
// shape every other test asserts against.
const chatResponse = (markdown: string): Response =>
  okResponse({
    choices: [{ message: { role: 'assistant', content: markdown }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

describe('parseOpenAiChatResponse', () => {
  const DEF = 0.9;

  it('pulls the markdown from choices[0].message.content', () => {
    const { result, diagnostic } = parseOpenAiChatResponse(
      {
        choices: [{ message: { role: 'assistant', content: '# header\n| a | b |' } }],
      },
      0,
      DEF,
    );
    expect(result).toEqual({ index: 0, markdown: '# header\n| a | b |', confidence: DEF });
    expect(diagnostic.variant).toBe('openai-chat');
    expect(diagnostic.textFieldUsed).toBe('content');
    expect(diagnostic.confidenceSource).toBe('assumed-default');
    expect(diagnostic.emptyText).toBe(false);
  });

  it('preserves pageIndex from caller, not from body', () => {
    const { result } = parseOpenAiChatResponse(
      { choices: [{ message: { content: 'x' } }] },
      7,
      DEF,
    );
    expect(result.index).toBe(7);
  });

  it('joins array-typed content parts into a single string', () => {
    // Some OpenAI variants stream content as an array of parts. Handle
    // both string objects and plain strings inside the array.
    const { result } = parseOpenAiChatResponse(
      {
        choices: [
          {
            message: {
              content: [
                { type: 'text', text: 'first ' },
                'middle ',
                { type: 'text', text: 'last' },
              ],
            },
          },
        ],
      },
      0,
      DEF,
    );
    expect(result.markdown).toBe('first middle last');
  });

  it('treats empty content as confidence 0 — distinguishes "got nothing" from "no signal"', () => {
    const { result, diagnostic } = parseOpenAiChatResponse(
      { choices: [{ message: { content: '' } }] },
      0,
      DEF,
    );
    expect(result.markdown).toBe('');
    expect(result.confidence).toBe(0);
    expect(diagnostic.emptyText).toBe(true);
  });

  it('throws on non-object body with top-level keys captured for forensics', () => {
    let caught: GlmOcrError | null = null;
    try {
      parseOpenAiChatResponse('raw string body', 0, DEF);
    } catch (err) {
      caught = err as GlmOcrError;
    }
    expect(caught).toBeInstanceOf(GlmOcrError);
    expect(caught?.message).toContain('expected JSON object');
  });

  it('throws on missing choices array', () => {
    expect(() => parseOpenAiChatResponse({ id: 'x', object: 'chat.completion' }, 0, DEF)).toThrow(
      /missing or empty "choices"/,
    );
  });

  it('throws on empty choices array', () => {
    expect(() => parseOpenAiChatResponse({ choices: [] }, 0, DEF)).toThrow(
      /missing or empty "choices"/,
    );
  });

  it('throws on missing message inside choices[0]', () => {
    expect(() => parseOpenAiChatResponse({ choices: [{ finish_reason: 'stop' }] }, 0, DEF)).toThrow(
      /message is missing/,
    );
  });

  it('captures the top-level keys of the offending body', () => {
    let caught: GlmOcrError | null = null;
    try {
      parseOpenAiChatResponse({ error: { message: 'bad request' } }, 0, DEF);
    } catch (err) {
      caught = err as GlmOcrError;
    }
    expect(caught?.message).toContain('error');
  });
});

describe('buildOpenAiOcrRequestBody', () => {
  it('emits the vibe-glm-ocr shape with a base64 data URL and prompt', () => {
    const body = buildOpenAiOcrRequestBody(Buffer.from('PNG-bytes-here'), {
      model: 'GLM-OCR',
      prompt: 'Text Recognition:',
    });
    expect(body.model).toBe('GLM-OCR');
    expect(body.temperature).toBe(0.02);
    const messages = body.messages as Array<{ role: string; content: unknown[] }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    const parts = messages[0]?.content as Array<Record<string, unknown>>;
    expect(parts[0]?.type).toBe('image_url');
    expect((parts[0]?.image_url as { url: string }).url).toMatch(
      /^data:image\/png;base64,UE5HLWJ5dGVzLWhlcmU=/,
    );
    expect(parts[1]).toEqual({ type: 'text', text: 'Text Recognition:' });
  });

  it('honors a custom prompt (Table Recognition)', () => {
    const body = buildOpenAiOcrRequestBody(Buffer.from('x'), {
      model: 'GLM-OCR',
      prompt: 'Table Recognition:',
    });
    const messages = body.messages as Array<{ content: unknown[] }>;
    const parts = messages[0]?.content as Array<Record<string, unknown>>;
    expect(parts[1]?.text).toBe('Table Recognition:');
  });
});

describe('ocrPdfPages', () => {
  beforeEach(() => {
    clearOcrCache();
    resetOcrCircuit();
    resetEngineVersionCache();
  });
  afterEach(() => vi.useRealTimers());

  it('POSTs the OpenAI shape to /v1/chat/completions and parses the markdown', async () => {
    const captured: { url: string; init: RequestInit }[] = [];
    const fetcher = buildFetcher(async (args) => {
      captured.push(args);
      if (args.url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      return chatResponse('# extracted markdown');
    });
    const r = await ocrPdfPages([Buffer.from('page-bytes')], {
      baseUrl: 'http://x',
      fetcher,
      concurrency: 1,
    });
    expect(r.pages[0]?.markdown).toBe('# extracted markdown');
    expect(r.parseDiagnostics[0]?.variant).toBe('openai-chat');
    const ocrCall = captured.find((c) => c.url.endsWith('/v1/chat/completions'));
    expect(ocrCall).toBeDefined();
    expect(ocrCall?.url).toBe('http://x/v1/chat/completions');
    const sent = JSON.parse(String(ocrCall?.init.body));
    expect(sent.model).toBe('glm-ocr');
    expect(sent.messages[0].content[0].type).toBe('image_url');
    expect(sent.messages[0].content[1].text).toBe('OCR:');
  });

  it('strips a trailing /v1 from the base URL (server publishes …:8082/v1)', async () => {
    const captured: { url: string; init: RequestInit }[] = [];
    const fetcher = buildFetcher(async (args) => {
      captured.push(args);
      if (args.url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      return chatResponse('ok');
    });
    await ocrPdfPages([Buffer.from('p')], {
      baseUrl: 'http://192.168.68.105:8082/v1',
      fetcher,
      concurrency: 1,
    });
    const ocrCall = captured.find((c) => c.url.endsWith('/chat/completions'));
    // No doubled /v1 — resolves to the single canonical endpoint.
    expect(ocrCall?.url).toBe('http://192.168.68.105:8082/v1/chat/completions');
  });

  it('runs OCR over multiple pages with concurrency', async () => {
    const calls: string[] = [];
    const fetcher = buildFetcher(async ({ url }) => {
      if (url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      calls.push(url);
      return chatResponse('# page');
    });
    const result = await ocrPdfPages([Buffer.from('aaa'), Buffer.from('bbb'), Buffer.from('ccc')], {
      baseUrl: 'http://localhost:9999',
      fetcher,
      concurrency: 2,
    });
    expect(result.pages).toHaveLength(3);
    expect(result.pages.every((p) => p.markdown === '# page')).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('caches results by image hash', async () => {
    let ocrCount = 0;
    const fetcher = buildFetcher(async ({ url }) => {
      if (url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      ocrCount += 1;
      return chatResponse('cached');
    });
    const buf = Buffer.from('same-bytes');
    await ocrPdfPages([buf, buf, buf], { baseUrl: 'http://x', fetcher, concurrency: 1 });
    expect(ocrCount).toBe(1);
  });

  it('retries on 5xx and eventually succeeds', async () => {
    let attempts = 0;
    const fetcher = buildFetcher(async ({ url }) => {
      if (url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      attempts += 1;
      if (attempts < 3) return failResponse(503);
      return chatResponse('ok');
    });
    const result = await ocrPdfPages([Buffer.from('p')], {
      baseUrl: 'http://x',
      fetcher,
      maxAttempts: 5,
    });
    expect(attempts).toBe(3);
    expect(result.pages[0]?.markdown).toBe('ok');
  });

  it('throws when GLM_OCR_URL absent and no baseUrl override', async () => {
    const orig = process.env.GLM_OCR_URL;
    delete process.env.GLM_OCR_URL;
    await expect(ocrPdfPages([Buffer.from('p')])).rejects.toThrow(/GLM_OCR_URL/);
    if (orig !== undefined) process.env.GLM_OCR_URL = orig;
  });

  it('gives up after maxAttempts on persistent 5xx', async () => {
    const fetcher = buildFetcher(async ({ url }) => {
      if (url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      return failResponse(500);
    });
    await expect(
      ocrPdfPages([Buffer.from('p')], { baseUrl: 'http://x', fetcher, maxAttempts: 2 }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('fails fast on 4xx without retrying — wrong URL or bad payload is not transient', async () => {
    let attempts = 0;
    const fetcher = buildFetcher(async ({ url }) => {
      if (url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      attempts += 1;
      return failResponse(404);
    });
    await expect(
      ocrPdfPages([Buffer.from('p')], { baseUrl: 'http://x', fetcher, maxAttempts: 5 }),
    ).rejects.toThrow(/GLM-OCR POST http:\/\/x\/v1\/chat\/completions → HTTP 404/);
    expect(attempts).toBe(1);
  });

  it('honors a custom ocrPath override (escape hatch for path-rewriting proxies)', async () => {
    const captured: string[] = [];
    const fetcher = buildFetcher(async ({ url }) => {
      captured.push(url);
      if (url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      return chatResponse('via custom path');
    });
    await ocrPdfPages([Buffer.from('p')], {
      baseUrl: 'http://x',
      fetcher,
      ocrPath: '/api/ocr',
    });
    expect(captured.some((u) => u === 'http://x/api/ocr')).toBe(true);
  });

  it('honors a custom prompt (Table Recognition mode)', async () => {
    const captured: { init: RequestInit }[] = [];
    const fetcher = buildFetcher(async (args) => {
      captured.push(args);
      if (args.url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      return chatResponse('| a |');
    });
    await ocrPdfPages([Buffer.from('p')], {
      baseUrl: 'http://x',
      fetcher,
      prompt: 'Table Recognition:',
    });
    const ocrCall = captured.find((c) => !String(c.init.body).includes('version'));
    const sent = JSON.parse(String(ocrCall?.init.body));
    expect(sent.messages[0].content[1].text).toBe('Table Recognition:');
  });

  it('empty markdown across many calls does not trip the circuit breaker', async () => {
    // 11 distinct image buffers (defeats per-image cache), all returning
    // empty content. Soft outcomes must call onSuccess; the breaker
    // (CB_THRESHOLD=10) would otherwise open and reject call 12.
    const fetcher = buildFetcher(async ({ url }) => {
      if (url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      return chatResponse('');
    });
    for (let i = 0; i < 11; i += 1) {
      const buf = Buffer.from(`page-${i}`);
      const r = await ocrPdfPages([buf], { baseUrl: 'http://x', fetcher });
      expect(r.pages[0]?.markdown).toBe('');
      expect(r.pages[0]?.confidence).toBe(0);
    }
    // Twelfth call still succeeds — proves breaker stayed closed.
    const final = await ocrPdfPages([Buffer.from('final')], { baseUrl: 'http://x', fetcher });
    expect(final.pages[0]?.markdown).toBe('');
  });

  it('unrecognized response shape throws GlmOcrError', async () => {
    const fetcher = buildFetcher(async ({ url }) => {
      if (url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      return okResponse({ error: { message: 'bad' } });
    });
    await expect(
      ocrPdfPages([Buffer.from('p')], { baseUrl: 'http://x', fetcher, maxAttempts: 1 }),
    ).rejects.toThrow(/missing or empty "choices"/);
  });

  it('cache hit synthesizes a from-cache diagnostic', async () => {
    const fetcher = buildFetcher(async ({ url }) => {
      if (url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      return chatResponse('hot');
    });
    const buf = Buffer.from('repeat');
    const first = await ocrPdfPages([buf], { baseUrl: 'http://x', fetcher });
    expect(first.parseDiagnostics[0]?.variant).toBe('openai-chat');
    const second = await ocrPdfPages([buf], { baseUrl: 'http://x', fetcher });
    expect(second.parseDiagnostics[0]?.variant).toBe('from-cache');
    expect(second.pages[0]?.markdown).toBe('hot');
  });

  it('throws GlmOcrError on finish_reason=length so truncated markdown never reaches the LLM', async () => {
    const fetcher = buildFetcher(async ({ url }) => {
      if (url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      // llama-server response with finish_reason: 'length' — model hit
      // the output cap before completing the page.
      return okResponse({
        choices: [
          { message: { role: 'assistant', content: 'partial markdown…' }, finish_reason: 'length' },
        ],
      });
    });
    await expect(
      ocrPdfPages([Buffer.from('p')], { baseUrl: 'http://x', fetcher, maxAttempts: 1 }),
    ).rejects.toThrow(/truncated by output-token cap/);
  });

  it('sends Authorization: Bearer when apiKey is configured', async () => {
    const captured: { url: string; init: RequestInit }[] = [];
    const fetcher = buildFetcher(async (args) => {
      captured.push(args);
      if (args.url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      return chatResponse('with auth');
    });
    await ocrPdfPages([Buffer.from('p')], {
      baseUrl: 'http://x',
      fetcher,
      apiKey: 'sk-test-1234',
    });
    const ocrCall = captured.find((c) => c.url.endsWith('/v1/chat/completions'));
    expect((ocrCall?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
      'Bearer sk-test-1234',
    );
  });

  it('omits Authorization header when apiKey is unset', async () => {
    const captured: { url: string; init: RequestInit }[] = [];
    const fetcher = buildFetcher(async (args) => {
      captured.push(args);
      if (args.url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      return chatResponse('no auth');
    });
    await ocrPdfPages([Buffer.from('p')], { baseUrl: 'http://x', fetcher });
    const ocrCall = captured.find((c) => c.url.endsWith('/v1/chat/completions'));
    expect(
      (ocrCall?.init.headers as Record<string, string> | undefined)?.authorization,
    ).toBeUndefined();
  });

  it('degrades engineVersion to "glm-ocr/unknown" when /version 404s (llama-server has no /version)', async () => {
    const fetcher = buildFetcher(async ({ url }) => {
      if (url.endsWith('/version')) return failResponse(404);
      return chatResponse('still works');
    });
    const result = await ocrPdfPages([Buffer.from('p')], { baseUrl: 'http://x', fetcher });
    expect(result.engineVersion).toBe('glm-ocr/unknown');
    expect(result.pages[0]?.markdown).toBe('still works');
  });
});
