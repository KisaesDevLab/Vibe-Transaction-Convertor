import type { NextFunction, Request, RequestHandler, Response } from 'express';
import Redis from 'ioredis';

import { RateLimitError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 10;

const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

let redisClient: Redis | undefined;
const getRedis = (): Redis | undefined => {
  const url = process.env.REDIS_URL;
  if (!url) return undefined;
  if (!redisClient) {
    redisClient = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    redisClient.on('error', (err) => logger.warn({ err }, 'redis error (login-rate-limit)'));
  }
  return redisClient;
};

const keyFor = (email: string): string => `login:attempts:${email.trim().toLowerCase()}`;

// Drop expired buckets so the in-memory map can't grow unbounded across
// the lifetime of a long-running process. Cheap O(n) sweep; called
// at most once per increment, gated to one sweep per minute.
let lastSweepAt = 0;
const sweepExpired = (now: number): void => {
  if (now - lastSweepAt < 60_000) return;
  lastSweepAt = now;
  for (const [k, v] of memoryBuckets) {
    if (v.resetAt < now) memoryBuckets.delete(k);
  }
};

const incrementMemory = (email: string): { count: number; resetAt: number } => {
  const k = keyFor(email);
  const now = Date.now();
  sweepExpired(now);
  const bucket = memoryBuckets.get(k);
  if (!bucket || bucket.resetAt < now) {
    const fresh = { count: 1, resetAt: now + WINDOW_MS };
    memoryBuckets.set(k, fresh);
    return fresh;
  }
  bucket.count += 1;
  return bucket;
};

const incrementRedis = async (
  client: Redis,
  email: string,
): Promise<{ count: number; resetAt: number }> => {
  const k = keyFor(email);
  const count = await client.incr(k);
  if (count === 1) {
    await client.pexpire(k, WINDOW_MS);
  }
  const ttl = await client.pttl(k);
  return { count, resetAt: Date.now() + (ttl > 0 ? ttl : WINDOW_MS) };
};

// Test helper: clear accumulated login-attempt counters so a full-suite rerun
// against a persistent Redis (or a long-lived process) doesn't carry attempts
// across files and spuriously 429 the login-based route tests. Always clears
// the in-memory buckets; touches Redis only if a client already exists, so it
// never opens (and leaks) a connection just to reset.
export const resetLoginRateLimits = async (): Promise<void> => {
  memoryBuckets.clear();
  if (!redisClient) return;
  try {
    const keys = await redisClient.keys('login:attempts:*');
    if (keys.length > 0) await redisClient.del(...keys);
  } catch {
    /* best-effort — the limiter fails open anyway */
  }
};

export const loginRateLimit: RequestHandler = async (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  try {
    const email = (req.body?.email as string | undefined) ?? '';
    if (!email) return next();
    const client = getRedis();
    const bucket = client ? await incrementRedis(client, email) : incrementMemory(email);
    if (bucket.count > MAX_ATTEMPTS) {
      const seconds = Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000));
      return next(new RateLimitError(`Too many login attempts; retry in ${seconds}s`));
    }
    next();
  } catch (err) {
    logger.warn({ err }, 'login rate limit failed open');
    next();
  }
};
