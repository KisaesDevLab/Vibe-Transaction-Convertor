import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiRateLimiter, closeRateLimitStore } from './rate-limit.js';

describe('apiRateLimiter with Redis unreachable', () => {
  afterEach(() => {
    closeRateLimitStore();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // Before the fix every request answered 500 (express-rate-limit's
  // passOnStoreError defaults to false), and the RedisStore constructor's
  // SCRIPT LOAD promises rejected unhandled, which exits Node.
  it('fails open instead of answering 500, with no unhandled rejection', async () => {
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:1');
    // express-rate-limit reports each store failure it lets through here.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const app = express();
    app.use(apiRateLimiter());
    app.get('/ok', (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // The request went through the store-error path, not a memory store.
    expect(consoleError).toHaveBeenCalled();
  }, 20_000);
});
