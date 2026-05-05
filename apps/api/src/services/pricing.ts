// DB-backed Anthropic price table. Operators add or override per-model
// pricing from /admin/llm-provider; the worker reads the merged table
// (operator overrides win over the curated defaults from
// `ANTHROPIC_PRICE_TABLE_DEFAULT` in the extractor package).
//
// Storage: system_settings key pattern
//   llm.pricing.anthropic.<model_id>
//   value: '{"inputPerMTokenMicros":"<bigint>","outputPerMTokenMicros":"<bigint>"}'
// (BigInt as string because JSON doesn't have BigInt and Postgres text is
// the cleanest cross-process carrier.)
//
// 60-second cache mirroring the LLM provider pattern. Mutating routes
// call invalidatePricingCache() AND invalidateProviderCache() since
// the AnthropicProvider holds its priceTable by reference.

import { eq, like, sql } from 'drizzle-orm';

import {
  ANTHROPIC_PRICE_TABLE_DEFAULT,
  type AnthropicPriceTable,
  type ModelPriceRow,
} from '@vibe-tx-converter/extractor';

import type { Db } from '../db/client.js';
import { systemSettings } from '../db/schema.js';
import { invalidateProviderCache } from './llm-provider.js';

const KEY_PREFIX = 'llm.pricing.anthropic.';

export type PricingSource = 'default' | 'operator' | 'operator-override';

export interface PricingRow extends ModelPriceRow {
  model: string;
  source: PricingSource;
}

const TTL_MS = 60_000;
let cached: { at: number; map: AnthropicPriceTable } | null = null;

export const invalidatePricingCache = (): void => {
  cached = null;
};

const parseRow = (raw: string): ModelPriceRow | null => {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const i = v.inputPerMTokenMicros;
    const o = v.outputPerMTokenMicros;
    if (typeof i !== 'string' || typeof o !== 'string') return null;
    const inMicros = BigInt(i);
    const outMicros = BigInt(o);
    if (inMicros < 0n || outMicros < 0n) return null;
    return { inputPerMTokenMicros: inMicros, outputPerMTokenMicros: outMicros };
  } catch {
    return null;
  }
};

const loadOperatorMap = async (db: Db): Promise<Record<string, ModelPriceRow>> => {
  const rows = await db
    .select()
    .from(systemSettings)
    .where(like(systemSettings.key, `${KEY_PREFIX}%`));
  const out: Record<string, ModelPriceRow> = {};
  for (const r of rows) {
    if (!r.valuePlaintext) continue;
    const model = r.key.slice(KEY_PREFIX.length);
    const parsed = parseRow(r.valuePlaintext);
    if (parsed) out[model] = parsed;
  }
  return out;
};

export const getMergedPriceTable = async (db: Db): Promise<AnthropicPriceTable> => {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.map;
  const operator = await loadOperatorMap(db);
  // Operator entries win over curated defaults.
  const merged: AnthropicPriceTable = { ...ANTHROPIC_PRICE_TABLE_DEFAULT, ...operator };
  cached = { at: Date.now(), map: merged };
  return merged;
};

// View-shape for the admin UI. Combines default + operator entries
// with a `source` label so the table can show which models have been
// customized.
export const listPricings = async (db: Db): Promise<PricingRow[]> => {
  const operator = await loadOperatorMap(db);
  const seen = new Set<string>();
  const out: PricingRow[] = [];
  for (const [model, row] of Object.entries(ANTHROPIC_PRICE_TABLE_DEFAULT)) {
    seen.add(model);
    const op = operator[model];
    if (op) {
      out.push({ model, source: 'operator-override', ...op });
    } else {
      out.push({ model, source: 'default', ...row });
    }
  }
  for (const [model, row] of Object.entries(operator)) {
    if (seen.has(model)) continue;
    out.push({ model, source: 'operator', ...row });
  }
  out.sort((a, b) => (a.model < b.model ? -1 : 1));
  return out;
};

const SAFE_MODEL_PATTERN = /^claude-[a-z0-9-]+$/i;

export const setPricing = async (
  db: Db,
  model: string,
  inputPerMTokenMicros: bigint,
  outputPerMTokenMicros: bigint,
  actorId: string,
): Promise<void> => {
  if (!SAFE_MODEL_PATTERN.test(model)) {
    throw new Error(`model id must match /^claude-[a-z0-9-]+$/i (got ${model})`);
  }
  if (inputPerMTokenMicros < 0n || outputPerMTokenMicros < 0n) {
    throw new Error('prices must be non-negative');
  }
  const value = JSON.stringify({
    inputPerMTokenMicros: inputPerMTokenMicros.toString(),
    outputPerMTokenMicros: outputPerMTokenMicros.toString(),
  });
  const key = KEY_PREFIX + model;
  await db
    .insert(systemSettings)
    .values({ key, valuePlaintext: value, isSecret: false })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { valuePlaintext: value, updatedAt: sql`now()`, updatedByUserId: actorId },
    });
  invalidatePricingCache();
  invalidateProviderCache();
};

export const clearPricing = async (db: Db, model: string): Promise<void> => {
  const key = KEY_PREFIX + model;
  await db.delete(systemSettings).where(eq(systemSettings.key, key));
  invalidatePricingCache();
  invalidateProviderCache();
};
