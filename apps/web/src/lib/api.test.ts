import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, fetchReady } from './api';

const readyBody = {
  status: 'degraded',
  dependencies: {
    postgres: { status: 'ok', latencyMs: 3 },
    redis: { status: 'fail', detail: 'connect ECONNREFUSED' },
    llmGateway: { status: 'unconfigured' },
  },
};

const respond = (status: number, body: string, contentType: string) =>
  vi.fn(
    async () => new globalThis.Response(body, { status, headers: { 'content-type': contentType } }),
  );

describe('fetchReady', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the dependency body on 200', async () => {
    const fetchMock = respond(
      200,
      JSON.stringify({ ...readyBody, status: 'ok' }),
      'application/json',
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchReady()).resolves.toMatchObject({ status: 'ok' });
    expect(fetchMock).toHaveBeenCalledWith('/api/health/ready', { credentials: 'include' });
  });

  it('returns the dependency body on 503 instead of throwing (degraded is data)', async () => {
    vi.stubGlobal(
      'fetch',
      respond(503, JSON.stringify(readyBody), 'application/json; charset=utf-8'),
    );
    const ready = await fetchReady();
    expect(ready.status).toBe('degraded');
    expect(ready.dependencies.redis).toEqual({ status: 'fail', detail: 'connect ECONNREFUSED' });
  });

  it('throws ApiError for a 503 without a readiness body (e.g. a proxy error page)', async () => {
    vi.stubGlobal('fetch', respond(503, '<html>Service Unavailable</html>', 'text/html'));
    const err = await fetchReady().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
  });

  it('throws ApiError for a 200 that is not a readiness body (e.g. an SPA fallback)', async () => {
    vi.stubGlobal('fetch', respond(200, '<!doctype html><html></html>', 'text/html'));
    await expect(fetchReady()).rejects.toBeInstanceOf(ApiError);
  });

  it('throws ApiError carrying the server message for other statuses', async () => {
    vi.stubGlobal('fetch', respond(500, JSON.stringify({ message: 'boom' }), 'application/json'));
    const err = await fetchReady().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toContain('boom');
  });

  it('rejects when the network request itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(fetchReady()).rejects.toThrow('Failed to fetch');
  });
});
