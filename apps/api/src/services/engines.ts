// DB-backed configuration for the external "engines" the worker depends
// on (GLM-OCR + LLM Gateway). Mirrors the LLM-provider pattern: each
// setting reads from `system_settings` first, falls back to the env var,
// and reports its `source` so the admin UI can label it.
//
// 60-second in-memory cache so the worker's hot path doesn't hit
// system_settings on every OCR/extract call. Mutating routes call
// invalidateEngineCache() to drop the cache.

import { eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { systemSettings } from '../db/schema.js';
import { invalidateProviderCache } from './llm-provider.js';

export type EngineKey = 'glm-ocr' | 'llm-gateway';

interface EngineSettingKeys {
  url: string;
  timeoutMs?: string;
  concurrency?: string;
}

const KEYS: Record<EngineKey, EngineSettingKeys> = {
  'glm-ocr': {
    url: 'engine.glm_ocr.url',
    timeoutMs: 'engine.glm_ocr.timeout_ms',
    concurrency: 'engine.glm_ocr.concurrency',
  },
  'llm-gateway': {
    url: 'engine.llm_gateway.url',
  },
};

const ENV_FALLBACK: Record<EngineKey, string> = {
  'glm-ocr': 'GLM_OCR_URL',
  'llm-gateway': 'LLM_GATEWAY_URL',
};

export interface EngineConfig {
  url: string | null;
  source: 'db' | 'env' | 'unset';
  timeoutMs?: number | undefined;
  concurrency?: number | undefined;
}

const TTL_MS = 60_000;
let cached: { at: number; map: Map<EngineKey, EngineConfig> } | null = null;

export const invalidateEngineCache = (): void => {
  cached = null;
};

const readSetting = async (db: Db, key: string): Promise<string | null> => {
  const rows = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
  return rows[0]?.valuePlaintext ?? null;
};

const loadConfig = async (db: Db, engine: EngineKey): Promise<EngineConfig> => {
  const keys = KEYS[engine];
  const dbUrl = await readSetting(db, keys.url);
  const envName = ENV_FALLBACK[engine];
  const envUrl = process.env[envName] ?? null;

  let url: string | null;
  let source: 'db' | 'env' | 'unset';
  if (dbUrl && dbUrl.length > 0) {
    url = dbUrl;
    source = 'db';
  } else if (envUrl && envUrl.length > 0) {
    url = envUrl;
    source = 'env';
  } else {
    url = null;
    source = 'unset';
  }

  const out: EngineConfig = { url, source };
  if (keys.timeoutMs) {
    const v = await readSetting(db, keys.timeoutMs);
    if (v !== null) {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n)) out.timeoutMs = n;
    }
  }
  if (keys.concurrency) {
    const v = await readSetting(db, keys.concurrency);
    if (v !== null) {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n)) out.concurrency = n;
    }
  }
  return out;
};

export const getEngineConfig = async (db: Db, engine: EngineKey): Promise<EngineConfig> => {
  if (cached && Date.now() - cached.at < TTL_MS) {
    const hit = cached.map.get(engine);
    if (hit) return hit;
  }
  const config = await loadConfig(db, engine);
  if (!cached || Date.now() - cached.at >= TTL_MS) {
    cached = { at: Date.now(), map: new Map() };
  }
  cached.map.set(engine, config);
  return config;
};

export const getAllEngineConfigs = async (db: Db): Promise<Record<EngineKey, EngineConfig>> => {
  const [glmOcr, llmGateway] = await Promise.all([
    getEngineConfig(db, 'glm-ocr'),
    getEngineConfig(db, 'llm-gateway'),
  ]);
  return { 'glm-ocr': glmOcr, 'llm-gateway': llmGateway };
};

export interface SetEngineInput {
  url?: string | null;
  timeoutMs?: number | null;
  concurrency?: number | null;
}

const writeSetting = async (
  db: Db,
  key: string,
  value: string | null,
  actorId: string,
): Promise<void> => {
  if (value === null) {
    await db.delete(systemSettings).where(eq(systemSettings.key, key));
    return;
  }
  await db
    .insert(systemSettings)
    .values({ key, valuePlaintext: value, isSecret: false })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { valuePlaintext: value, updatedAt: sql`now()`, updatedByUserId: actorId },
    });
};

export const setEngineConfig = async (
  db: Db,
  engine: EngineKey,
  input: SetEngineInput,
  actorId: string,
): Promise<EngineConfig> => {
  const keys = KEYS[engine];
  if (input.url !== undefined) {
    if (input.url !== null && !/^https?:\/\//.test(input.url)) {
      throw new Error(`url must start with http:// or https://`);
    }
    await writeSetting(db, keys.url, input.url, actorId);
  }
  if (input.timeoutMs !== undefined && keys.timeoutMs) {
    const v =
      input.timeoutMs === null
        ? null
        : Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
          ? String(Math.floor(input.timeoutMs))
          : null;
    await writeSetting(db, keys.timeoutMs, v, actorId);
  }
  if (input.concurrency !== undefined && keys.concurrency) {
    const v =
      input.concurrency === null
        ? null
        : Number.isFinite(input.concurrency) && input.concurrency > 0
          ? String(Math.floor(input.concurrency))
          : null;
    await writeSetting(db, keys.concurrency, v, actorId);
  }
  // Engine URL is read by the LLM provider (for engine.llm_gateway.url)
  // and the OCR client (for engine.glm_ocr.url); drop both caches.
  invalidateEngineCache();
  invalidateProviderCache();
  return getEngineConfig(db, engine);
};

export const clearEngineConfig = async (
  db: Db,
  engine: EngineKey,
  actorId: string,
): Promise<EngineConfig> => {
  const keys = KEYS[engine];
  await db.delete(systemSettings).where(eq(systemSettings.key, keys.url));
  if (keys.timeoutMs) {
    await db.delete(systemSettings).where(eq(systemSettings.key, keys.timeoutMs));
  }
  if (keys.concurrency) {
    await db.delete(systemSettings).where(eq(systemSettings.key, keys.concurrency));
  }
  void actorId; // audit-logged at the route layer
  invalidateEngineCache();
  invalidateProviderCache();
  return getEngineConfig(db, engine);
};
