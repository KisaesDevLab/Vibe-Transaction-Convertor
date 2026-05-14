import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearOcrCache,
  GlmOcrError,
  ocrPdfPages,
  parseOcrResponse,
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

describe('parseOcrResponse', () => {
  const DEF = 0.5;

  it('accepts pages[0] with markdown + numeric confidence', () => {
    const { result, diagnostic } = parseOcrResponse(
      { pages: [{ markdown: '# a', confidence: 0.87 }] },
      0,
      DEF,
    );
    expect(result).toEqual({ index: 0, markdown: '# a', confidence: 0.87 });
    expect(diagnostic.variant).toBe('pages-array');
    expect(diagnostic.textFieldUsed).toBe('markdown');
    expect(diagnostic.confidenceSource).toBe('present-number');
    expect(diagnostic.emptyText).toBe(false);
  });

  it('accepts data.pages[0] with text alias and percent score', () => {
    const { result, diagnostic } = parseOcrResponse(
      { data: { pages: [{ text: '# b', score: 92 }] } },
      3,
      DEF,
    );
    expect(result.markdown).toBe('# b');
    expect(result.confidence).toBeCloseTo(0.92, 5);
    expect(result.index).toBe(3);
    expect(diagnostic.variant).toBe('data-pages');
    expect(diagnostic.textFieldUsed).toBe('text');
    expect(diagnostic.confidenceSource).toBe('coerced-percent');
  });

  it('accepts result wrapper with content + string confidence', () => {
    const { result, diagnostic } = parseOcrResponse(
      { result: { content: '# c', confidence: '0.4' } },
      0,
      DEF,
    );
    expect(result.markdown).toBe('# c');
    expect(result.confidence).toBe(0.4);
    expect(diagnostic.variant).toBe('result-wrapper');
    expect(diagnostic.textFieldUsed).toBe('content');
    expect(diagnostic.confidenceSource).toBe('coerced-string');
  });

  it('accepts flat page with only markdown (confidence defaults)', () => {
    const { result, diagnostic } = parseOcrResponse({ markdown: '# d' }, 0, DEF);
    expect(result.markdown).toBe('# d');
    expect(result.confidence).toBe(DEF);
    expect(diagnostic.variant).toBe('flat-page');
    expect(diagnostic.textFieldUsed).toBe('markdown');
    expect(diagnostic.confidenceSource).toBe('assumed-default');
  });

  it('accepts flat page with output alias and conf=1', () => {
    const { result, diagnostic } = parseOcrResponse({ output: '# e', conf: 1 }, 0, DEF);
    expect(result.markdown).toBe('# e');
    expect(result.confidence).toBe(1);
    expect(diagnostic.variant).toBe('flat-page');
    expect(diagnostic.textFieldUsed).toBe('output');
    expect(diagnostic.confidenceSource).toBe('present-number');
  });

  it('accepts result wrapper with bare string body', () => {
    const { result, diagnostic } = parseOcrResponse({ result: '# wrapped' }, 0, DEF);
    expect(result.markdown).toBe('# wrapped');
    expect(result.confidence).toBe(DEF);
    expect(diagnostic.variant).toBe('result-wrapper');
    expect(diagnostic.textFieldUsed).toBe('none');
  });

  it('accepts bare-string body as output-string variant', () => {
    const { result, diagnostic } = parseOcrResponse('# bare', 0, DEF);
    expect(result.markdown).toBe('# bare');
    expect(result.confidence).toBe(DEF);
    expect(diagnostic.variant).toBe('output-string');
  });

  it('treats empty text field as confidence 0 regardless of source value', () => {
    const { result, diagnostic } = parseOcrResponse({ ocr_text: '', confidence: 0.9 }, 0, DEF);
    expect(result.markdown).toBe('');
    expect(result.confidence).toBe(0);
    expect(diagnostic.emptyText).toBe(true);
    expect(diagnostic.confidenceSource).toBe('assumed-default');
  });

  it('treats null markdown as empty', () => {
    const { result, diagnostic } = parseOcrResponse({ pages: [{ markdown: null }] }, 0, DEF);
    expect(result.markdown).toBe('');
    expect(result.confidence).toBe(0);
    expect(diagnostic.emptyText).toBe(true);
  });

  it('coerces non-string text to string', () => {
    const { result, diagnostic } = parseOcrResponse({ pages: [{ markdown: 42 }] }, 0, DEF);
    expect(result.markdown).toBe('42');
    expect(diagnostic.textFieldUsed).toBe('markdown');
  });

  it('falls back to default when confidence >100', () => {
    const { result, diagnostic } = parseOcrResponse(
      { pages: [{ markdown: '# m', confidence: 150 }] },
      0,
      DEF,
    );
    expect(result.confidence).toBe(DEF);
    expect(diagnostic.confidenceSource).toBe('assumed-default');
  });

  it('falls back to default when confidence is negative', () => {
    const { result, diagnostic } = parseOcrResponse(
      { pages: [{ text: 'x', confidence: -0.1 }] },
      0,
      DEF,
    );
    expect(result.confidence).toBe(DEF);
    expect(diagnostic.confidenceSource).toBe('assumed-default');
  });

  it('throws on unrecognized object shape and captures top-level keys', () => {
    let caught: GlmOcrError | null = null;
    try {
      parseOcrResponse({ unrelated: 'shape' }, 0, DEF);
    } catch (err) {
      caught = err as GlmOcrError;
    }
    expect(caught).toBeInstanceOf(GlmOcrError);
    expect(caught?.message).toContain('unrelated');
  });

  it('throws on null body', () => {
    expect(() => parseOcrResponse(null, 0, DEF)).toThrow(GlmOcrError);
  });

  it('throws on top-level array body', () => {
    expect(() => parseOcrResponse([], 0, DEF)).toThrow(GlmOcrError);
  });

  it('throws on empty pages array', () => {
    expect(() => parseOcrResponse({ pages: [] }, 0, DEF)).toThrow(GlmOcrError);
  });

  it('preserves pageIndex from caller, not from page body', () => {
    const { result } = parseOcrResponse(
      { pages: [{ index: 99, markdown: '# m', confidence: 0.5 }] },
      7,
      DEF,
    );
    expect(result.index).toBe(7);
  });
});

describe('ocrPdfPages', () => {
  beforeEach(() => {
    clearOcrCache();
    resetOcrCircuit();
  });
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
    // Count only /ocr hits — /version probes are also fetched and cached
    // separately (Phase 11 #6) but aren't on the per-image hot path.
    let ocrCount = 0;
    const fetcher = buildFetcher(async ({ url }) => {
      if (url.endsWith('/version')) {
        return okResponse({ version: 'glm-ocr/test' });
      }
      ocrCount += 1;
      return okResponse({ pages: [{ index: 0, markdown: 'cached', confidence: 1 }] });
    });
    const buf = Buffer.from('same-bytes');
    await ocrPdfPages([buf, buf, buf], { baseUrl: 'http://x', fetcher, concurrency: 1 });
    expect(ocrCount).toBe(1);
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

  it('fails fast on 4xx without retrying — wrong URL or bad payload is not transient', async () => {
    let attempts = 0;
    const fetcher = buildFetcher(async () => {
      attempts += 1;
      return failResponse(404);
    });
    await expect(
      ocrPdfPages([Buffer.from('p')], { baseUrl: 'http://x', fetcher, maxAttempts: 5 }),
    ).rejects.toThrow(/GLM-OCR POST http:\/\/x\/ocr → HTTP 404/);
    expect(attempts).toBe(1);
  });

  it('tolerates text alias on flat upstream payload', async () => {
    const fetcher = buildFetcher(async ({ url }) => {
      if (url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      return okResponse({ text: '# from flat', confidence: 0.8 });
    });
    const result = await ocrPdfPages([Buffer.from('p')], { baseUrl: 'http://x', fetcher });
    expect(result.pages[0]?.markdown).toBe('# from flat');
    expect(result.pages[0]?.confidence).toBe(0.8);
    expect(result.parseDiagnostics[0]?.variant).toBe('flat-page');
    expect(result.parseDiagnostics[0]?.textFieldUsed).toBe('text');
  });

  it('returns parseDiagnostics matching page count with per-call variants', async () => {
    let n = 0;
    const fetcher = buildFetcher(async ({ url }) => {
      if (url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      n += 1;
      if (n === 1) return okResponse({ pages: [{ markdown: 'a', confidence: 0.9 }] });
      if (n === 2) return okResponse({ data: { pages: [{ text: 'b', score: 90 }] } });
      return okResponse({ markdown: 'c' });
    });
    const result = await ocrPdfPages([Buffer.from('1'), Buffer.from('2'), Buffer.from('3')], {
      baseUrl: 'http://x',
      fetcher,
      concurrency: 1,
    });
    expect(result.parseDiagnostics).toHaveLength(3);
    expect(result.parseDiagnostics.map((d) => d.variant)).toEqual([
      'pages-array',
      'data-pages',
      'flat-page',
    ]);
  });

  it('empty markdown across many calls does not trip the circuit breaker', async () => {
    // 11 distinct image buffers (defeats per-image cache), all returning
    // empty markdown. Soft outcomes must call onSuccess; the breaker
    // (CB_THRESHOLD=10) would otherwise open and reject call 12.
    const fetcher = buildFetcher(async ({ url }) => {
      if (url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      return okResponse({ pages: [{ markdown: '', confidence: 0.9 }] });
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

  it('unrecognized response shape throws GlmOcrError with key forensics', async () => {
    const fetcher = buildFetcher(async ({ url }) => {
      if (url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      return okResponse({ wrong: 'shape' });
    });
    await expect(
      ocrPdfPages([Buffer.from('p')], { baseUrl: 'http://x', fetcher, maxAttempts: 1 }),
    ).rejects.toThrow(/unrecognized shape.*wrong/);
  });

  it('cache hit synthesizes a from-cache diagnostic', async () => {
    const fetcher = buildFetcher(async ({ url }) => {
      if (url.endsWith('/version')) return okResponse({ version: 'glm-ocr/test' });
      return okResponse({ pages: [{ markdown: 'hot', confidence: 0.7 }] });
    });
    const buf = Buffer.from('repeat');
    const first = await ocrPdfPages([buf], { baseUrl: 'http://x', fetcher });
    expect(first.parseDiagnostics[0]?.variant).toBe('pages-array');
    const second = await ocrPdfPages([buf], { baseUrl: 'http://x', fetcher });
    expect(second.parseDiagnostics[0]?.variant).toBe('from-cache');
    expect(second.pages[0]?.markdown).toBe('hot');
  });
});
