import { describe, expect, it } from 'vitest';

import { probeVibeOcrHealth, vibeOcrFile, VibeOcrError } from './vibe-ocr-client.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A fetcher that drives the submit → poll → result lifecycle. `statuses` is the
// sequence of job statuses returned by successive GET /ocr/{id} polls.
const makeFetcher = (opts: {
  statuses: string[];
  result: unknown;
  submitStatus?: number;
  onCall?: (url: string, init?: RequestInit) => void;
}): typeof fetch => {
  let poll = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    opts.onCall?.(url, init);
    if (url.endsWith('/ocr')) {
      if (opts.submitStatus && opts.submitStatus >= 400) {
        return new Response('nope', { status: opts.submitStatus });
      }
      return json({ job_id: 'job-1', status: 'queued' });
    }
    if (url.endsWith('/ocr/job-1/result')) return json(opts.result);
    if (url.includes('/ocr/job-1')) {
      const s = opts.statuses[Math.min(poll, opts.statuses.length - 1)] ?? 'completed';
      poll += 1;
      return json({ status: s });
    }
    if (url.endsWith('/healthz')) return json({ service: 'ok', vlm_backend: 'ok' });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
};

describe('vibeOcrFile', () => {
  const baseOpts = { baseUrl: 'http://vibe.test:8099', apiKey: 'k', pollIntervalMs: 1 };

  it('submits, polls to completion, and returns sorted per-page markdown', async () => {
    const sentKey: string[] = [];
    const fetcher = makeFetcher({
      statuses: ['queued', 'processing', 'completed'],
      result: {
        total_pages: 2,
        pages: [
          { page_num: 2, markdown: '# B' },
          { page_num: 1, markdown: '# A' },
        ],
      },
      onCall: (_u, init) => {
        const k = (init?.headers as Record<string, string> | undefined)?.['x-api-key'];
        if (k) sentKey.push(k);
      },
    });
    const r = await vibeOcrFile(Buffer.from('%PDF'), 'stmt.pdf', 'application/pdf', {
      ...baseOpts,
      fetcher,
    });
    expect(r.pages.map((p) => p.pageNum)).toEqual([1, 2]); // sorted
    expect(r.pages.map((p) => p.markdown)).toEqual(['# A', '# B']);
    expect(r.totalPages).toBe(2);
    expect(sentKey).toContain('k'); // x-api-key forwarded
  });

  it('throws VibeOcrError when the job fails', async () => {
    const fetcher = makeFetcher({ statuses: ['processing', 'failed'], result: {} });
    await expect(
      vibeOcrFile(Buffer.from('x'), 'f.png', 'image/png', { ...baseOpts, fetcher }),
    ).rejects.toBeInstanceOf(VibeOcrError);
  });

  it('throws on a non-2xx submit (e.g. missing api key → 401)', async () => {
    const fetcher = makeFetcher({ statuses: ['completed'], result: {}, submitStatus: 401 });
    await expect(
      vibeOcrFile(Buffer.from('x'), 'f.png', 'image/png', { ...baseOpts, fetcher }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it('throws when the result has no pages', async () => {
    const fetcher = makeFetcher({ statuses: ['completed'], result: { pages: [] } });
    await expect(
      vibeOcrFile(Buffer.from('x'), 'f.png', 'image/png', { ...baseOpts, fetcher }),
    ).rejects.toThrow(/no pages/);
  });

  it('times out (overall budget) if the job never completes', async () => {
    const fetcher = makeFetcher({ statuses: ['processing'], result: {} });
    await expect(
      vibeOcrFile(Buffer.from('x'), 'f.png', 'image/png', {
        ...baseOpts,
        fetcher,
        timeoutMs: 5,
        pollIntervalMs: 2,
      }),
    ).rejects.toThrow(/did not finish/);
  });

  it('strips a trailing /v1 from the base URL', async () => {
    const urls: string[] = [];
    const fetcher = makeFetcher({
      statuses: ['completed'],
      result: { pages: [{ page_num: 1, markdown: 'x' }] },
      onCall: (u) => urls.push(u),
    });
    await vibeOcrFile(Buffer.from('x'), 'f.png', 'image/png', {
      baseUrl: 'http://vibe.test:8099/v1',
      pollIntervalMs: 1,
      fetcher,
    });
    expect(urls[0]).toBe('http://vibe.test:8099/ocr'); // no doubled /v1
  });
});

describe('probeVibeOcrHealth', () => {
  it('ok when the service + vlm backend are healthy', async () => {
    const fetcher = (async () =>
      json({ service: 'ok', vlm_backend: 'ok' })) as unknown as typeof fetch;
    expect(await probeVibeOcrHealth({ baseUrl: 'http://v.test', fetcher })).toEqual({ ok: true });
  });

  it('reports a degraded vlm backend', async () => {
    const fetcher = (async () =>
      json({ service: 'ok', vlm_backend: 'down' })) as unknown as typeof fetch;
    const r = await probeVibeOcrHealth({ baseUrl: 'http://v.test', fetcher });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('vlm_backend');
  });

  it('not ok when URL unset', async () => {
    const prev = process.env.VIBE_OCR_URL;
    delete process.env.VIBE_OCR_URL;
    try {
      expect((await probeVibeOcrHealth({})).ok).toBe(false);
    } finally {
      if (prev !== undefined) process.env.VIBE_OCR_URL = prev;
    }
  });
});
