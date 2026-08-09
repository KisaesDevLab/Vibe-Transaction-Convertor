import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/client.js';
import { providerOrderFor, resolveAiModeInfo, type LlmProviderPolicy } from './llm-provider.js';

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
