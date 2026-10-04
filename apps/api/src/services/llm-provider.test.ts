import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/client.js';
import {
  buildProviderForProcess,
  buildProviderForProcessId,
  modelMatchesProvider,
  processModelForProvider,
  providerOrderFor,
  resolveAiModeInfo,
  resolveProcessLabel,
  type LlmProviderPolicy,
} from './llm-provider.js';

describe('providerOrderFor', () => {
  it('maps each policy to the right primary/secondary pair', () => {
    const cases: Array<[LlmProviderPolicy, 'local' | 'anthropic', 'local' | 'anthropic' | null]> = [
      ['local-only', 'local', null],
      ['anthropic-only', 'anthropic', null],
      ['local-first', 'local', 'anthropic'],
      ['anthropic-first', 'anthropic', 'local'],
    ];
    for (const [policy, primary, secondary] of cases) {
      expect(providerOrderFor(policy)).toEqual({ primary, secondary });
    }
  });

  it('returns secondary=null exactly for the *-only modes', () => {
    expect(providerOrderFor('local-only').secondary).toBeNull();
    expect(providerOrderFor('anthropic-only').secondary).toBeNull();
    expect(providerOrderFor('local-first').secondary).toBe('anthropic');
    expect(providerOrderFor('anthropic-first').secondary).toBe('local');
  });
});

// Minimal Db stand-in for readSetting's select().from().where() chain.
const dbWithSetting = (valuePlaintext: string | null): Db =>
  ({
    select: () => ({
      from: () => ({
        where: async () =>
          valuePlaintext === null ? [] : [{ valuePlaintext, valueEncrypted: null }],
      }),
    }),
  }) as unknown as Db;

describe('resolveAiModeInfo', () => {
  const ENV_KEYS = ['VIBE_AI_MODE', 'VIBE_AI_ROUTER_URL', 'VIBE_AI_TOKEN'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('admin-selected DB value wins over the env', async () => {
    process.env.VIBE_AI_MODE = 'router';
    process.env.VIBE_AI_ROUTER_URL = 'http://router:8220';
    process.env.VIBE_AI_TOKEN = 'tok';
    expect(await resolveAiModeInfo(dbWithSetting('direct'))).toEqual({
      mode: 'direct',
      source: 'db',
    });
    expect(await resolveAiModeInfo(dbWithSetting('router'))).toEqual({
      mode: 'router',
      source: 'db',
    });
  });

  it('a stored "router" degrades to direct when the env creds are gone', async () => {
    expect(await resolveAiModeInfo(dbWithSetting('router'))).toEqual({
      mode: 'direct',
      source: 'db',
    });
  });

  it('falls back to the VIBE_AI_MODE env when no DB row exists', async () => {
    process.env.VIBE_AI_MODE = 'router';
    process.env.VIBE_AI_ROUTER_URL = 'http://router:8220';
    process.env.VIBE_AI_TOKEN = 'tok';
    expect(await resolveAiModeInfo(dbWithSetting(null))).toEqual({
      mode: 'router',
      source: 'env',
    });
  });

  it('defaults to direct with nothing configured (and ignores junk rows)', async () => {
    expect(await resolveAiModeInfo(dbWithSetting(null))).toEqual({
      mode: 'direct',
      source: 'default',
    });
    expect(await resolveAiModeInfo(dbWithSetting('banana'))).toEqual({
      mode: 'direct',
      source: 'default',
    });
  });
});

// Key-aware Db stand-in: answers select().from(system_settings).where(...)
// for the eq / inArray / like-on-key conditions the settings readers issue,
// from a plain key → value map, so the real resolvers run unmodified.
const dialect = new PgDialect();
const dbWithSettings = (settings: Record<string, string>): Db =>
  ({
    select: (fields?: Record<string, { name: string }>) => ({
      from: () => ({
        where: async (cond: SQL) => {
          const { sql, params } = dialect.sqlToQuery(cond);
          const prefix = / like /i.test(sql) ? String(params[0]).replace(/%$/, '') : null;
          return Object.entries(settings)
            .filter(([key]) => (prefix !== null ? key.startsWith(prefix) : params.includes(key)))
            .map(([key, value]) => {
              const byColumn: Record<string, unknown> = {
                key,
                value_plaintext: value,
                value_encrypted: null,
              };
              if (!fields) return { key, valuePlaintext: value, valueEncrypted: null };
              return Object.fromEntries(
                Object.entries(fields).map(([alias, col]) => [alias, byColumn[col.name]]),
              );
            });
        },
      }),
    }),
  }) as unknown as Db;

// The providers keep their model private; read it the way a request would.
const modelOf = (provider: { id: string }): string =>
  provider.id === 'anthropic'
    ? (provider as unknown as { model: string }).model
    : (provider as unknown as { modelId: string }).modelId;

describe('per-process model override vs. provider family', () => {
  it('matches claude-* ids to Anthropic and everything else to local', () => {
    expect(modelMatchesProvider('claude-sonnet-4-6', 'anthropic')).toBe(true);
    expect(modelMatchesProvider('claude-sonnet-4-6', 'local')).toBe(false);
    expect(modelMatchesProvider('qwen2.5:32b-instruct', 'local')).toBe(true);
    expect(modelMatchesProvider('qwen2.5:32b-instruct', 'anthropic')).toBe(false);
    expect(processModelForProvider('qwen2.5:32b-instruct', 'anthropic')).toBeNull();
    expect(processModelForProvider('claude-opus-4-7', 'anthropic')).toBe('claude-opus-4-7');
    expect(processModelForProvider(null, 'local')).toBeNull();
  });

  const ENV_KEYS = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_BASE_URL',
    'LLM_MODEL_ID',
    'VIBE_AI_MODE',
    'VIBE_AI_ROUTER_URL',
    'VIBE_AI_TOKEN',
    ...['EXTRACTION', 'CLEANSE', 'CATEGORY', 'CHECK'].flatMap((p) => [
      `VIBETC_PROC_${p}_PROVIDER`,
      `VIBETC_PROC_${p}_MODEL`,
    ]),
  ];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-0000000000000000';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const base = {
    'llm.local.model': 'qwen2.5:32b-instruct',
    'llm.anthropic.model': 'claude-haiku-4-5-20251001',
  };

  it('never sends an Ollama tag to Anthropic (local-first fallback / Process via Anthropic)', async () => {
    const db = dbWithSettings({ ...base, 'llm.process.extraction.model': 'qwen2.5:14b' });
    const anthropic = await buildProviderForProcessId(db, 'extraction', 'anthropic');
    expect(anthropic.id).toBe('anthropic');
    expect(modelOf(anthropic)).toBe('claude-haiku-4-5-20251001');
    // ...while the local attempt still honors the override.
    const local = await buildProviderForProcessId(db, 'extraction', 'local');
    expect(modelOf(local)).toBe('qwen2.5:14b');
  });

  it('never sends a claude-* id to Ollama', async () => {
    const db = dbWithSettings({ ...base, 'llm.process.extraction.model': 'claude-opus-4-7' });
    expect(modelOf(await buildProviderForProcessId(db, 'extraction', 'local'))).toBe(
      'qwen2.5:32b-instruct',
    );
    expect(modelOf(await buildProviderForProcessId(db, 'extraction', 'anthropic'))).toBe(
      'claude-opus-4-7',
    );
  });

  it('applies the same rule to enrichment and to the status label', async () => {
    const db = dbWithSettings({
      ...base,
      'llm.provider': 'anthropic-only',
      'llm.process.cleanse.model': 'qwen2.5:7b',
    });
    const built = await buildProviderForProcess(db, 'cleanse');
    expect(built.providerId).toBe('anthropic');
    expect(modelOf(built.provider)).toBe('claude-haiku-4-5-20251001');
    expect(await resolveProcessLabel(db, 'cleanse')).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    });
  });
});
