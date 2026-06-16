import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildShieldOcrRequestBody,
  clearOcrCache,
  ocrPdfPages,
  parseAnthropicOcrResponse,
  resetOcrCircuit,
  ShieldOcrError,
} from './shield-ocr-client.js';

const BASE = { baseUrl: 'http://vibe-shield-gateway:8080', apiKey: 'vs_live_test' };

// Minimal Anthropic Message response with a single text block.
const messageResponse = (text: string, extra: Record<string, unknown> = {}) =>
  ({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text }],
      usage: { input_tokens: 100, output_tokens: 40 },
      ...extra,
    }),
  }) as unknown as Response;

beforeEach(() => {
  clearOcrCache();
  resetOcrCircuit();
});

describe('buildShieldOcrRequestBody', () => {
  it('places the image block before the text prompt and includes session + policy', () => {
    const body = buildShieldOcrRequestBody(Buffer.from('PNGDATA'), {
      model: 'claude-sonnet-4-6',
      prompt: 'Transcribe.',
      maxTokens: 8000,
      sessionId: 'sess-1',
      policyName: 'cpa-converter-output',
    });
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.policy_name).toBe('cpa-converter-output');
    expect(body.session_id).toBe('sess-1');
    const content = (body.messages as Array<{ content: unknown[] }>)[0]!.content;
    expect((content[0] as { type: string }).type).toBe('image');
    expect(content[1] as { type: string; text: string }).toEqual({
      type: 'text',
      text: 'Transcribe.',
    });
  });

  it('omits session_id when no session is set', () => {
    const body = buildShieldOcrRequestBody(Buffer.from('x'), {
      model: 'm',
      prompt: 'p',
      maxTokens: 10,
      sessionId: null,
      policyName: 'cpa-converter-output',
    });
    expect('session_id' in body).toBe(false);
  });
});

describe('parseAnthropicOcrResponse', () => {
  it('joins text blocks and surfaces usage', () => {
    const { result, inputTokens, outputTokens } = parseAnthropicOcrResponse(
      {
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
        usage: { input_tokens: 5, output_tokens: 7 },
      },
      0,
      0.9,
    );
    expect(result.markdown).toBe('ab');
    expect(result.confidence).toBe(0.9);
    expect(inputTokens).toBe(5);
    expect(outputTokens).toBe(7);
  });

  it('stamps confidence 0 on empty content', () => {
    const { result } = parseAnthropicOcrResponse({ content: [] }, 0, 0.9);
    expect(result.markdown).toBe('');
    expect(result.confidence).toBe(0);
  });

  it('throws on a max_tokens truncation', () => {
    expect(() =>
      parseAnthropicOcrResponse(
        { content: [{ type: 'text', text: 'x' }], stop_reason: 'max_tokens' },
        2,
        0.9,
      ),
    ).toThrow(ShieldOcrError);
  });

  it('throws on a Shield error envelope', () => {
    expect(() =>
      parseAnthropicOcrResponse({ error: { type: 'invalid_request', message: 'bad' } }, 0, 0.9),
    ).toThrow(ShieldOcrError);
  });
});

describe('ocrPdfPages', () => {
  it('sends Bearer auth to /v1/messages and returns per-page markdown + usage', async () => {
    const fetcher = vi.fn(async () => messageResponse('# Page text'));
    const res = await ocrPdfPages([Buffer.from('img1')], {
      ...BASE,
      fetcher: fetcher as unknown as typeof fetch,
      sessionId: 'sess-1',
    });
    expect(res.pages[0]!.markdown).toBe('# Page text');
    expect(res.engineVersion).toMatch(/^vibe-shield\//);
    expect(res.usage.inputTokens).toBe(100);
    expect(res.usage.outputTokens).toBe(40);

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://vibe-shield-gateway:8080/v1/messages');
    expect((init as RequestInit).headers).toMatchObject({
      authorization: 'Bearer vs_live_test',
    });
  });

  it('caches by image+session so a repeat page does not re-fetch', async () => {
    const fetcher = vi.fn(async () => messageResponse('cached me'));
    const img = Buffer.from('same-image');
    await ocrPdfPages([img], {
      ...BASE,
      fetcher: fetcher as unknown as typeof fetch,
      sessionId: 's',
    });
    await ocrPdfPages([img], {
      ...BASE,
      fetcher: fetcher as unknown as typeof fetch,
      sessionId: 's',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fails fast (no retry) on a 4xx', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 400 }) as unknown as Response);
    await expect(
      ocrPdfPages([Buffer.from('x')], { ...BASE, fetcher: fetcher as unknown as typeof fetch }),
    ).rejects.toThrow(ShieldOcrError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('throws when the API key is missing', async () => {
    await expect(
      ocrPdfPages([Buffer.from('x')], { baseUrl: BASE.baseUrl, apiKey: '' }),
    ).rejects.toThrow(/api[_ ]?key/i);
  });
});

describe('direct Anthropic mode (bypass Shield)', () => {
  it('buildShieldOcrRequestBody(direct) drops policy_name + session_id', () => {
    const body = buildShieldOcrRequestBody(Buffer.from('x'), {
      model: 'm',
      prompt: 'p',
      maxTokens: 10,
      sessionId: 's',
      policyName: 'cpa-converter-output',
      direct: true,
    });
    expect('policy_name' in body).toBe(false);
    expect('session_id' in body).toBe(false);
  });

  it('uses x-api-key (not Bearer), omits Shield fields, and tags engine "anthropic"', async () => {
    const fetcher = vi.fn(async () => messageResponse('# Direct OCR'));
    const res = await ocrPdfPages([Buffer.from('img')], {
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test',
      fetcher: fetcher as unknown as typeof fetch,
      sessionId: 'ignored-in-direct-mode',
    });
    expect(res.engineVersion).toMatch(/^anthropic\//);

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers.authorization).toBeUndefined();

    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect('policy_name' in body).toBe(false);
    expect('session_id' in body).toBe(false);
  });
});
