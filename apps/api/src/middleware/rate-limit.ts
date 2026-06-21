import type { Request, RequestHandler } from 'express';
import { rateLimit, type RateLimitRequestHandler, type Store } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import Redis from 'ioredis';

import { logger } from '../lib/logger.js';

let sharedClient: Redis | undefined;

const buildStore = (prefix: string): Store | undefined => {
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.debug({ prefix }, 'REDIS_URL not set; rate limiter falls back to memory store');
    return undefined;
  }
  if (!sharedClient) {
    sharedClient = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    sharedClient.on('error', (err) => logger.warn({ err }, 'redis error (rate-limit)'));
  }
  return new RedisStore({
    sendCommand: (...args: string[]) => sharedClient!.call(args[0]!, ...args.slice(1)) as never,
    prefix,
  });
};

const baseOpts = {
  windowMs: 60 * 1000,
  standardHeaders: 'draft-7' as const,
  legacyHeaders: false,
};

const buildLimiter = (prefix: string, limit: number): RateLimitRequestHandler => {
  const store = buildStore(prefix);
  return store ? rateLimit({ ...baseOpts, limit, store }) : rateLimit({ ...baseOpts, limit });
};

export const unauthRateLimiter = (): RateLimitRequestHandler => buildLimiter('rl:unauth:', 100);

// Test helper: clear the express-rate-limit counters (per-IP unauth + per-user
// auth, prefix `rl:`) so a full-suite rerun against a persistent Redis doesn't
// accumulate request counts across files/runs within the 60s window and 429.
// No-op until a limiter has been built (sharedClient exists); never opens a
// connection just to reset.
export const resetRateLimiters = async (): Promise<void> => {
  if (!sharedClient) return;
  try {
    const keys = await sharedClient.keys('rl:*');
    if (keys.length > 0) await sharedClient.del(...keys);
  } catch {
    /* best-effort — the limiter fails open on store errors */
  }
};

// Authenticated limiter: a generous cap keyed per-user (not per-IP) so a
// single admin doing legitimate bulk work — e.g. toggling many feature-
// access rows — isn't throttled by a shared-IP budget.
const buildAuthLimiter = (): RateLimitRequestHandler => {
  const store = buildStore('rl:auth:');
  const opts = {
    ...baseOpts,
    limit: 1000,
    // Only ever invoked for authenticated requests (see apiRateLimiter),
    // so req.user is always present; the fallback is belt-and-suspenders.
    keyGenerator: (req: Request) => req.user?.id ?? 'anon',
  };
  return store ? rateLimit({ ...opts, store }) : rateLimit({ ...opts });
};

// Single global limiter for the API. Authenticated requests get the high
// per-user limit; anonymous traffic keeps the tight per-IP limit. MUST be
// mounted after loadSession so req.user is populated.
export const apiRateLimiter = (): RequestHandler => {
  const auth = buildAuthLimiter();
  const unauth = buildLimiter('rl:unauth:', 100);
  return (req, res, next) => (req.user ? auth : unauth)(req, res, next);
};
