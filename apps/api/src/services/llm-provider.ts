import { eq } from 'drizzle-orm';

import {
  AnthropicProvider,
  LocalGatewayProvider,
  type LlmProvider,
} from '@vibe-tx-converter/extractor';

import type { Db } from '../db/client.js';
import { systemSettings } from '../db/schema.js';
import { unwrapSecret } from '../lib/secrets.js';

const KEY_PROVIDER = 'llm.provider';
const KEY_ANTHROPIC_KEY = 'llm.anthropic.api_key';
const KEY_ANTHROPIC_MODEL = 'llm.anthropic.model';

export type ProviderId = 'local' | 'anthropic';

const readSetting = async (
  db: Db,
  key: string,
): Promise<{ valuePlaintext: string | null; valueEncrypted: Buffer | null } | null> => {
  const rows = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
  const row = rows[0];
  if (!row) return null;
  return {
    valuePlaintext: row.valuePlaintext,
    valueEncrypted: row.valueEncrypted as Buffer | null,
  };
};

export const resolveProviderId = async (db: Db): Promise<ProviderId> => {
  const r = await readSetting(db, KEY_PROVIDER);
  const v = r?.valuePlaintext;
  return v === 'anthropic' ? 'anthropic' : 'local';
};

// Phase 13: 60-second provider cache. Constructing the provider hits
// system_settings (3 rows) and unwraps the API key. The worker may build
// 100+ providers per minute under load, so we cache instances and
// invalidate via invalidateProviderCache(). Admin-routes that mutate
// LLM settings call the invalidator.
const PROVIDER_TTL_MS = 60_000;
let cached: { at: number; provider: LlmProvider } | null = null;

export const invalidateProviderCache = (): void => {
  cached = null;
};

const constructProvider = async (db: Db): Promise<LlmProvider> => {
  const id = await resolveProviderId(db);
  if (id === 'local') {
    // engine.llm_gateway.url is operator-configurable from /admin/engines.
    // Fall back to LLM_GATEWAY_URL env if the DB has no override.
    const gatewayRow = await readSetting(db, 'engine.llm_gateway.url');
    const baseUrl = gatewayRow?.valuePlaintext ?? undefined;
    return new LocalGatewayProvider(baseUrl ? { baseUrl } : {});
  }

  const keyRow = await readSetting(db, KEY_ANTHROPIC_KEY);
  let apiKey: string | undefined;
  if (keyRow?.valueEncrypted) {
    apiKey = unwrapSecret(keyRow.valueEncrypted);
  } else if (process.env.ANTHROPIC_API_KEY) {
    apiKey = process.env.ANTHROPIC_API_KEY;
  }
  if (!apiKey) {
    throw new Error('llm.provider=anthropic but no API key in DB or ANTHROPIC_API_KEY env');
  }
  const modelRow = await readSetting(db, KEY_ANTHROPIC_MODEL);
  const model = modelRow?.valuePlaintext ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
  return new AnthropicProvider({ apiKey, model });
};

export const buildProvider = async (db: Db): Promise<LlmProvider> => {
  if (cached && Date.now() - cached.at < PROVIDER_TTL_MS) return cached.provider;
  const provider = await constructProvider(db);
  cached = { at: Date.now(), provider };
  return provider;
};
