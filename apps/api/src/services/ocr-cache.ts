// Phase 11 #5: Redis-backed OCR cache. The extractor package defines the
// store interface but can't take an ioredis dep directly; this adapter
// lives at the API layer where ioredis is already a transitive dep
// (BullMQ uses it). Falls back to the extractor's in-memory cache when
// REDIS_URL is unset.

import Redis from 'ioredis';

import type { OcrCacheStore, OcrPageResult } from '@vibe-tx-converter/extractor';

const KEY_PREFIX = 'vibetc:ocr:';

let _client: Redis | null = null;

const client = (): Redis | null => {
  if (_client) return _client;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  _client = new Redis(url, { maxRetriesPerRequest: 1 });
  // Don't crash the process on transient redis errors; surface as a
  // cache miss instead.
  _client.on('error', () => undefined);
  return _client;
};

export const redisOcrCache: OcrCacheStore = {
  async get(key: string): Promise<OcrPageResult | null> {
    const r = client();
    if (!r) return null;
    try {
      const raw = await r.get(KEY_PREFIX + key);
      if (!raw) return null;
      return JSON.parse(raw) as OcrPageResult;
    } catch {
      return null;
    }
  },
  async set(key: string, value: OcrPageResult, ttlSeconds: number): Promise<void> {
    const r = client();
    if (!r) return;
    try {
      await r.set(KEY_PREFIX + key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      // ignore; cache is best-effort
    }
  },
};
