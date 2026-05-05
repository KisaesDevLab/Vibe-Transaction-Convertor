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

export const authRateLimiter = (): RateLimitRequestHandler => buildLimiter('rl:auth:', 1000);
