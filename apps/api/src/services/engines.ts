// DB-backed configuration for the local LLM/Ollama gateway endpoint the
// worker depends on. Mirrors the LLM-provider pattern: the setting reads
// from `system_settings` first, falls back to the env var, and reports its
// `source` so the admin UI can label it.
//
// 60-second in-memory cache so the worker's hot path doesn't hit
// system_settings on every extract call. Mutating routes call
// invalidateEngineCache() to drop the cache.

import { eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { systemSettings } from '../db/schema.js';
import { unwrapSecret, wrapSecret } from '../lib/secrets.js';
import { invalidateProviderCache } from './llm-provider.js';

export type EngineKey = 'llm-gateway';

interface EngineSettingKeys {
  url: string;
  timeoutMs?: string;
  concurrency?: string;
  healthPath?: string;
  // Generic optional fields kept for the engine plumbing; the llm-gateway
  // engine only uses `url`.
  model?: string;
  prompt?: string;
  apiKey?: string;
}

const KEYS: Record<EngineKey, EngineSettingKeys> = {
  'llm-gateway': {
    url: 'engine.llm_gateway.url',
  },
};

const ENV_FALLBACK: Record<EngineKey, string> = {
  'llm-gateway': 'LLM_GATEWAY_URL',
};

// Built-in default URLs — the address the service is assigned on the
// appliance / docker network. Used as the final fallback when neither a
// DB override nor an env var is set. (The local LLM provider also defaults
// to http://localhost:11434 in its own constructor.)
const ENGINE_DEFAULTS: Partial<Record<EngineKey, string>> = {};

export interface EngineConfig {
  url: string | null;
  source: 'db' | 'env' | 'default' | 'unset';
  timeoutMs?: number | undefined;
  concurrency?: number | undefined;
  healthPath?: string | null | undefined;
  model?: string | null | undefined;
  prompt?: string | null | undefined;
  // Bearer-auth key (plaintext). The worker passes this to the OCR
  // client; admin responses are scrubbed via maskEngineConfig before
  // leaving the API. Loaded from the encrypted `value_secret` column
  // and decrypted in-process — never returned over the wire as-is.
  apiKey?: string | null | undefined;
}

// Strip the plaintext apiKey before serialising to admins. Surfaces a
// `hasApiKey` boolean plus the last 4 characters so an operator can
// sanity-check which key is loaded without us echoing it back.
export interface MaskedEngineConfig extends Omit<EngineConfig, 'apiKey'> {
  hasApiKey: boolean;
  apiKeyLastFour: string | null;
}

export const maskEngineConfig = (cfg: EngineConfig): MaskedEngineConfig => {
  const { apiKey, ...rest } = cfg;
  return {
    ...rest,
    hasApiKey: typeof apiKey === 'string' && apiKey.length > 0,
    apiKeyLastFour: typeof apiKey === 'string' && apiKey.length >= 4 ? apiKey.slice(-4) : null,
  };
};

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
  let source: EngineConfig['source'];
  if (dbUrl && dbUrl.length > 0) {
    url = dbUrl;
    source = 'db';
  } else if (envUrl && envUrl.length > 0) {
    url = envUrl;
    source = 'env';
  } else if (ENGINE_DEFAULTS[engine]) {
    // Built-in appliance/docker address — works out of the box.
    url = ENGINE_DEFAULTS[engine]!;
    source = 'default';
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
  if (keys.healthPath) {
    const v = await readSetting(db, keys.healthPath);
    if (v !== null && v.length > 0) out.healthPath = v;
  }
  if (keys.model) {
    const v = await readSetting(db, keys.model);
    if (v !== null && v.length > 0) out.model = v;
  }
  if (keys.prompt) {
    const v = await readSetting(db, keys.prompt);
    if (v !== null && v.length > 0) out.prompt = v;
  }
  if (keys.apiKey) {
    // API keys live in the encrypted secret column, NOT plaintext.
    // Wrapped blob is decrypted on every load; if decryption fails
    // (e.g. SESSION_SECRET rotated) we surface as "no key" rather
    // than crashing — the operator re-saves to recover.
    const rows = await db
      .select({ valueEncrypted: systemSettings.valueEncrypted })
      .from(systemSettings)
      .where(eq(systemSettings.key, keys.apiKey));
    const blob = rows[0]?.valueEncrypted;
    if (blob) {
      try {
        out.apiKey = unwrapSecret(blob);
      } catch {
        out.apiKey = null;
      }
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
  const llmGateway = await getEngineConfig(db, 'llm-gateway');
  return { 'llm-gateway': llmGateway };
};

export interface SetEngineInput {
  url?: string | null;
  timeoutMs?: number | null;
  concurrency?: number | null;
  // null clears the override (client default applies). Must start with "/".
  healthPath?: string | null;
  model?: string | null;
  prompt?: string | null;
  // null clears the stored key; a non-empty string is encrypted and
  // stored. Not echoed back in admin responses (see maskEngineConfig).
  apiKey?: string | null;
}

const normalisePath = (raw: string | null): string | null => {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith('/')) {
    throw new Error('path must start with "/" (e.g. /health)');
  }
  // Strip a trailing slash so concatenation with the baseUrl is
  // predictable (`baseUrl/health` vs `baseUrl/health/`).
  return trimmed.replace(/\/+$/, '');
};

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
  if (input.healthPath !== undefined && keys.healthPath) {
    await writeSetting(db, keys.healthPath, normalisePath(input.healthPath), actorId);
  }
  if (input.model !== undefined && keys.model) {
    const v = input.model === null || input.model.trim().length === 0 ? null : input.model.trim();
    await writeSetting(db, keys.model, v, actorId);
  }
  if (input.prompt !== undefined && keys.prompt) {
    const v =
      input.prompt === null || input.prompt.trim().length === 0 ? null : input.prompt.trim();
    await writeSetting(db, keys.prompt, v, actorId);
  }
  if (input.apiKey !== undefined && keys.apiKey) {
    if (input.apiKey === null || input.apiKey === '') {
      await db.delete(systemSettings).where(eq(systemSettings.key, keys.apiKey));
    } else {
      const wrapped = wrapSecret(input.apiKey);
      await db
        .insert(systemSettings)
        .values({ key: keys.apiKey, valueEncrypted: wrapped, isSecret: true })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: {
            valueEncrypted: wrapped,
            updatedAt: sql`now()`,
            updatedByUserId: actorId,
          },
        });
    }
  }
  // Engine URL is read by the local LLM provider (engine.llm_gateway.url);
  // drop both the engine cache and the provider cache.
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
  const allKeys = [
    keys.url,
    keys.timeoutMs,
    keys.concurrency,
    keys.healthPath,
    keys.model,
    keys.prompt,
    keys.apiKey,
  ].filter((k): k is string => typeof k === 'string');
  for (const k of allKeys) {
    await db.delete(systemSettings).where(eq(systemSettings.key, k));
  }
  void actorId; // audit-logged at the route layer
  invalidateEngineCache();
  invalidateProviderCache();
  return getEngineConfig(db, engine);
};
