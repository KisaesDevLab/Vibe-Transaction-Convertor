// Enrichment cache guards: an entry with no fields carries no answer, so it is
// never stored and an old one read back is a miss. ioredis is replaced by an
// in-memory fake; REDIS_URL is set only inside each test so the shared
// rate-limiter setup never sees it.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { enrichmentCache, type EnrichmentCacheKey } from './enrichment-cache.js';

const store = new Map<string, string>();

vi.mock('ioredis', () => ({
  default: class FakeRedis {
    on(): this {
      return this;
    }
    async get(k: string): Promise<string | null> {
      return store.get(k) ?? null;
    }
    async set(k: string, v: string): Promise<'OK'> {
      store.set(k, v);
      return 'OK';
    }
  },
}));

const key: EnrichmentCacheKey = {
  rawDescription: 'COFFEE SHOP 1',
  accountType: 'CHECKING',
  promptVersion: '3+abc',
  cleanse: true,
  categorize: false,
};

describe('enrichmentCache', () => {
  const prevUrl = process.env.REDIS_URL;
  afterEach(() => {
    store.clear();
    if (prevUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prevUrl;
  });

  it('round-trips an entry with an answer', async () => {
    process.env.REDIS_URL = 'redis://fake:6379';
    await enrichmentCache.set(key, { cleansedDescription: 'Coffee Shop' });
    expect(await enrichmentCache.get(key)).toEqual({ cleansedDescription: 'Coffee Shop' });
  });

  it('never stores an empty or all-null entry', async () => {
    process.env.REDIS_URL = 'redis://fake:6379';
    await enrichmentCache.set(key, {});
    await enrichmentCache.set(key, { cleansedDescription: null, category: undefined });
    expect(store.size).toBe(0);
    expect(await enrichmentCache.get(key)).toBeNull();
  });

  it('treats an empty entry written by an older build as a miss', async () => {
    process.env.REDIS_URL = 'redis://fake:6379';
    await enrichmentCache.set(key, { cleansedDescription: 'Coffee Shop' });
    for (const k of store.keys()) store.set(k, '{}');
    expect(await enrichmentCache.get(key)).toBeNull();
    for (const k of store.keys()) store.set(k, '"not an object"');
    expect(await enrichmentCache.get(key)).toBeNull();
  });
});
