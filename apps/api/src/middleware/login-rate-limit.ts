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
    /* best-effort — with Redis down the limiter counts in memory (cleared above) */
  }
};

// Count an attempt in Redis when it is configured. If Redis errors (outage,
// auth, OOM), count in this process's memory instead: the global API limiter
// fails open on store errors, so letting the attempt through here would leave
// the login endpoint with no brute-force limit at all for the outage.
const countAttempt = async (email: string): Promise<{ count: number; resetAt: number }> => {
  const client = getRedis();
  if (!client) return incrementMemory(email);
  try {
    return await incrementRedis(client, email);
  } catch (err) {
    // Name + message only: an ioredis reply error carries the failed command,
    // whose key embeds the email address.
    const { name, message } = err as Error;
    logger.warn(
      { err: { name, message } },
      'login rate limit: redis unavailable, counting in memory',
    );
    return incrementMemory(email);
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
    const bucket = await countAttempt(email);
    if (bucket.count > MAX_ATTEMPTS) {
      const seconds = Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000));
      return next(new RateLimitError(`Too many login attempts; retry in ${seconds}s`));
    }
    next();
  } catch (err) {
    // Only reached when even the in-memory count failed: fail open rather
    // than lock every user out of login.
    logger.warn({ err }, 'login rate limit failed open');
    next();
  }
};
