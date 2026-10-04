import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const EMAIL = 'victim@example.com';

// A Redis that is configured but failing: every INCR rejects the way ioredis
// does, with the failed command (and so the email-bearing key) attached.
const mockRedisDown = (): void => {
  vi.doMock('ioredis', () => ({
    default: class {
      on(): this {
        return this;
      }
      async incr(key: string): Promise<number> {
        throw Object.assign(new Error('Connection is closed.'), {
          command: { name: 'incr', args: [key] },
        });
      }
      async keys(): Promise<string[]> {
        return [];
      }
      async del(): Promise<number> {
        return 0;
      }
    },
  }));
};

describe('loginRateLimit', () => {
  const savedRedisUrl = process.env.REDIS_URL;

  beforeEach(() => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    // test-setup.ts has already loaded this module with the real ioredis; a
    // fresh instance picks up the mock.
    vi.resetModules();
    mockRedisDown();
  });
  afterEach(() => {
    vi.doUnmock('ioredis');
    vi.restoreAllMocks();
    if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedRedisUrl;
  });

  const attempt = async (mw: RequestHandler): Promise<unknown> => {
    const next = vi.fn();
    await mw({ body: { email: EMAIL } } as Request, {} as Response, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
    return next.mock.calls[0]?.[0];
  };

  it('still limits attempts when Redis errors, by counting in memory', async () => {
    const { logger } = await import('../lib/logger.js');
    const warn = vi.spyOn(logger, 'warn');
    const { loginRateLimit } = await import('./login-rate-limit.js');

    for (let i = 0; i < 10; i += 1) {
      expect(await attempt(loginRateLimit)).toBeUndefined();
    }
    expect(await attempt(loginRateLimit)).toMatchObject({ status: 429, code: 'RATE_LIMIT' });

    // The fallback is logged without the failed command, whose key holds the
    // email address.
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(EMAIL);
  });
});
