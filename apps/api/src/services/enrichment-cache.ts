// Phase 33 — Redis-backed cache for LLM enrichment results. Same merchant
// shows up across many statements, so caching by
// (raw_description, account_type, request_kind) hits frequently and
// trims Anthropic spend dramatically. Mirrors `ocr-cache.ts`: best-effort,
// silently falls through to a miss when REDIS_URL is unset or the
// connection is flapping.

import Redis from 'ioredis';
import { createHash } from 'node:crypto';

const KEY_PREFIX = 'vibetc:enrich:';
const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

let _client: Redis | null = null;

const client = (): Redis | null => {
  if (_client) return _client;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  _client = new Redis(url, { maxRetriesPerRequest: 1 });
  _client.on('error', () => undefined);
  return _client;
};

export interface EnrichmentCachePayload {
  cleansedDescription?: string | null | undefined;
  category?: string | null | undefined;
}

export interface EnrichmentCacheKey {
  rawDescription: string;
  accountType?: string | null | undefined;
  // Bumped whenever the prompt or output schema changes — invalidates
  // every cached entry without a manual flush. Match the value in
  // packages/extractor/src/prompts/enrich.ts when prompts evolve.
  promptVersion: number;
  // Differentiates "cleansed only" vs "category only" vs "both" so a
  // partial enrichment doesn't satisfy a later request for the missing
  // half.
  cleanse: boolean;
  categorize: boolean;
}

export const ENRICHMENT_PROMPT_VERSION = 1;

const hashKey = (k: EnrichmentCacheKey): string => {
  const h = createHash('sha256');
  h.update(k.rawDescription);
  h.update('|');
  h.update(k.accountType ?? '');
  h.update('|');
  h.update(String(k.promptVersion));
  h.update('|');
  h.update(k.cleanse ? '1' : '0');
  h.update(k.categorize ? '1' : '0');
  return h.digest('hex').slice(0, 32);
};

export const enrichmentCache = {
  async get(key: EnrichmentCacheKey): Promise<EnrichmentCachePayload | null> {
    const r = client();
    if (!r) return null;
    try {
      const raw = await r.get(KEY_PREFIX + hashKey(key));
      if (!raw) return null;
      return JSON.parse(raw) as EnrichmentCachePayload;
    } catch {
      return null;
    }
  },
  async set(key: EnrichmentCacheKey, value: EnrichmentCachePayload): Promise<void> {
    const r = client();
    if (!r) return;
    try {
      await r.set(KEY_PREFIX + hashKey(key), JSON.stringify(value), 'EX', TTL_SECONDS);
    } catch {
      // best-effort
    }
  },
};
