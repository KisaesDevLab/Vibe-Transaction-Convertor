// Phase 33 — Redis-backed cache for LLM enrichment results. Same merchant
// shows up across many statements, so caching by
// (raw_description, account_type, request_kind) hits frequently and
// trims Anthropic spend dramatically. Best-effort: silently falls through
// to a miss when REDIS_URL is unset or the connection is flapping.

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
  // Structured cleanse outputs (see ADR / enrichment.ts). Cached alongside the
  // display name so the same merchant on the next statement reuses them.
  merchantName?: string | null | undefined;
  processor?: string | null | undefined;
  transactionType?: string | null | undefined;
  isOpaque?: boolean | null | undefined;
  confidence?: string | null | undefined;
}

export interface EnrichmentCacheKey {
  rawDescription: string;
  accountType?: string | null | undefined;
  // Identifies everything besides the description that shaped the cached
  // value. The base constant ENRICHMENT_PROMPT_VERSION reflects the
  // built-in defaults; the service folds in a hash of any operator
  // prompt overrides, the active category list (when categorizing) and
  // each enabled pass's provider:model, so a prompt edit, a category
  // rename/archive or a model switch transparently invalidates prior
  // cache entries without a manual flush.
  promptVersion: string;
  // Differentiates "cleansed only" vs "category only" vs "both" so a
  // partial enrichment doesn't satisfy a later request for the missing
  // half.
  cleanse: boolean;
  categorize: boolean;
}

// Bumped to '2' when the cleanse pass started emitting the structured fields
// (merchant_name/processor/transaction_type/is_opaque/confidence) — old cached
// entries lack them, so invalidate.
// Bumped to '3' when the key started folding in the category list + per-pass
// provider:model, and to drop entries written before the fixes for rows the
// model omitted (cached as `{}`) and payee-influenced results (cached under the
// bare description).
export const ENRICHMENT_PROMPT_VERSION = '3';

// An entry with no fields carries no answer — never store one, and treat one
// read back (written by an older build) as a miss.
const hasAnyField = (v: unknown): v is EnrichmentCachePayload =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).some((x) => x !== null && x !== undefined);

const hashKey = (k: EnrichmentCacheKey): string => {
  const h = createHash('sha256');
  h.update(k.rawDescription);
  h.update('|');
  h.update(k.accountType ?? '');
  h.update('|');
  h.update(k.promptVersion);
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
      const parsed: unknown = JSON.parse(raw);
      return hasAnyField(parsed) ? parsed : null;
    } catch {
      return null;
    }
  },
  async set(key: EnrichmentCacheKey, value: EnrichmentCachePayload): Promise<void> {
    if (!hasAnyField(value)) return;
    const r = client();
    if (!r) return;
    try {
      await r.set(KEY_PREFIX + hashKey(key), JSON.stringify(value), 'EX', TTL_SECONDS);
    } catch {
      // best-effort
    }
  },
};
