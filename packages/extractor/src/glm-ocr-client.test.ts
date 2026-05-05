import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearOcrCache, ocrPdfPages } from './glm-ocr-client.js';

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

describe('ocrPdfPages', () => {
  beforeEach(() => clearOcrCache());
  afterEach(() => vi.useRealTimers());

  it('runs OCR over multiple pages with concurrency', async () => {
    const calls: string[] = [];
    const fetcher = buildFetcher(async ({ init }) => {
      const body = JSON.parse(String(init.body));
      calls.push(body.pages[0].image_base64.slice(0, 4));
      return okResponse({
        pages: [{ index: 0, markdown: '# page', confidence: 0.91 }],
      });
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
    let count = 0;
    const fetcher = buildFetcher(async () => {
      count += 1;
      return okResponse({ pages: [{ index: 0, markdown: 'cached', confidence: 1 }] });
    });
    const buf = Buffer.from('same-bytes');
    await ocrPdfPages([buf, buf, buf], { baseUrl: 'http://x', fetcher, concurrency: 1 });
    expect(count).toBe(1);
  });

  it('retries on 5xx and eventually succeeds', async () => {
    let attempts = 0;
    const fetcher = buildFetcher(async () => {
      attempts += 1;
      if (attempts < 3) return failResponse(503);
      return okResponse({ pages: [{ index: 0, markdown: 'ok', confidence: 0.5 }] });
    });
    const result = await ocrPdfPages([Buffer.from('p')], {
      baseUrl: 'http://x',
      fetcher,
      maxAttempts: 5,
    });
    expect(attempts).toBe(3);
    expect(result.pages[0]?.markdown).toBe('ok');
  });

  it('throws when REDIS_URL/GLM_OCR_URL absent and no baseUrl override', async () => {
    const orig = process.env.GLM_OCR_URL;
    delete process.env.GLM_OCR_URL;
    await expect(ocrPdfPages([Buffer.from('p')])).rejects.toThrow(/GLM_OCR_URL/);
    if (orig !== undefined) process.env.GLM_OCR_URL = orig;
  });

  it('gives up after maxAttempts on persistent 5xx', async () => {
    const fetcher = buildFetcher(async () => failResponse(500));
    await expect(
      ocrPdfPages([Buffer.from('p')], { baseUrl: 'http://x', fetcher, maxAttempts: 2 }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
