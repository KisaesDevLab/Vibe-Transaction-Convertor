import {
  AnthropicProvider,
  LocalGatewayProvider,
  type LlmProvider,
} from '@vibe-tx-converter/extractor';

import type { Db } from '../db/client.js';
import { unwrapSecret } from '../lib/secrets.js';
import { getMergedPriceTable } from './pricing.js';
import { readSetting } from './system-settings.js';

const KEY_PROVIDER = 'llm.provider';
const KEY_ANTHROPIC_KEY = 'llm.anthropic.api_key';
const KEY_ANTHROPIC_MODEL = 'llm.anthropic.model';
const KEY_ANTHROPIC_BASE_URL = 'llm.anthropic.base_url';

const DIRECT_ANTHROPIC = 'https://api.anthropic.com';

export type ProviderId = 'local' | 'anthropic';

// Effective Anthropic base URL: operator-set (system_settings) wins, then
// the ANTHROPIC_BASE_URL env, then the direct Anthropic API. When this
// points anywhere other than api.anthropic.com the extraction LLM is
// routed through a gateway — for this app that's the Vibe Shield gateway,
// which redacts PII before it reaches Claude.
export const resolveAnthropicBaseUrl = async (db: Db): Promise<string> => {
  const row = await readSetting(db, KEY_ANTHROPIC_BASE_URL);
  const fromDb = row?.valuePlaintext?.trim();
  if (fromDb && fromDb.length > 0) return fromDb.replace(/\/$/, '');
  const fromEnv = process.env.ANTHROPIC_BASE_URL?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv.replace(/\/$/, '');
  return DIRECT_ANTHROPIC;
};

// True when the effective base URL is NOT the direct Anthropic API, i.e.
// extraction is proxied (through Vibe Shield on this appliance).
export const isAnthropicViaGateway = (baseUrl: string): boolean =>
  baseUrl.replace(/\/$/, '') !== DIRECT_ANTHROPIC;

// Operator-selectable routing policy for the LLM extraction call.
// - local-only / anthropic-only: hard pick, current behavior.
// - local-first / anthropic-first: try the primary; if extraction
//   fails one of the configured triggers (HTTP error, malformed
//   response, empty transactions, reconciliation discrepancy),
//   automatically retry once on the secondary.
export type LlmProviderPolicy = 'local-only' | 'anthropic-only' | 'local-first' | 'anthropic-first';

// Stored under the existing `llm.provider` system_settings key. Pre-
// policy values (`local`, `anthropic`) map to the *-only modes so an
// in-place upgrade doesn't change behavior.
export const resolveProviderPolicy = async (db: Db): Promise<LlmProviderPolicy> => {
  const r = await readSetting(db, KEY_PROVIDER);
  switch (r?.valuePlaintext) {
    case 'anthropic':
    case 'anthropic-only':
      return 'anthropic-only';
    case 'local-first':
      return 'local-first';
    case 'anthropic-first':
      return 'anthropic-first';
    case 'local':
    case 'local-only':
    default:
      return 'local-only';
  }
};

export const providerOrderFor = (
  policy: LlmProviderPolicy,
): { primary: ProviderId; secondary: ProviderId | null } => {
  switch (policy) {
    case 'local-only':
      return { primary: 'local', secondary: null };
    case 'anthropic-only':
      return { primary: 'anthropic', secondary: null };
    case 'local-first':
      return { primary: 'local', secondary: 'anthropic' };
    case 'anthropic-first':
      return { primary: 'anthropic', secondary: 'local' };
  }
};

// Backward-compat shim: routes that only care about "which one provider
// is active" continue to use this. Returns the policy's primary.
export const resolveProviderId = async (db: Db): Promise<ProviderId> => {
  const policy = await resolveProviderPolicy(db);
  return providerOrderFor(policy).primary;
};

// Per-id provider cache (60s). Falling-back attempts may need both
// providers in the same worker invocation, so we keep separate slots
// keyed by ProviderId rather than a single shared instance.
const PROVIDER_TTL_MS = 60_000;
const cache = new Map<ProviderId, { at: number; provider: LlmProvider }>();

export const invalidateProviderCache = (): void => {
  cache.clear();
};

const constructLocal = async (db: Db): Promise<LlmProvider> => {
  // engine.llm_gateway.url is operator-configurable from /admin/engines.
  // Fall back to LLM_GATEWAY_URL env if the DB has no override.
  const gatewayRow = await readSetting(db, 'engine.llm_gateway.url');
  const baseUrl = gatewayRow?.valuePlaintext ?? undefined;
  return new LocalGatewayProvider(baseUrl ? { baseUrl } : {});
};

const constructAnthropic = async (db: Db): Promise<LlmProvider> => {
  const keyRow = await readSetting(db, KEY_ANTHROPIC_KEY);
  let apiKey: string | undefined;
  if (keyRow?.valueEncrypted) {
    apiKey = unwrapSecret(keyRow.valueEncrypted);
  } else if (process.env.ANTHROPIC_API_KEY) {
    apiKey = process.env.ANTHROPIC_API_KEY;
  }
  if (!apiKey) {
    throw new Error('anthropic provider requested but no API key in DB or ANTHROPIC_API_KEY env');
  }
  const modelRow = await readSetting(db, KEY_ANTHROPIC_MODEL);
  const model = modelRow?.valuePlaintext ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
  // Merge curated defaults + operator overrides so worker cost rollups
  // include any models the operator added on /admin/llm-provider.
  const priceTable = await getMergedPriceTable(db);
  // Operator-set base URL (e.g. the Vibe Shield gateway) so routing the
  // extraction LLM through Shield is configurable from /admin/llm-provider
  // instead of an env-only ANTHROPIC_BASE_URL.
  const baseUrl = await resolveAnthropicBaseUrl(db);
  return new AnthropicProvider({ apiKey, model, priceTable, baseUrl });
};

export const buildProviderForId = async (db: Db, id: ProviderId): Promise<LlmProvider> => {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < PROVIDER_TTL_MS) return hit.provider;
  const provider = id === 'local' ? await constructLocal(db) : await constructAnthropic(db);
  cache.set(id, { at: Date.now(), provider });
  return provider;
};

// Resolves the policy's primary and returns that provider. Used by
// callers that don't participate in fallback (legacy code paths).
export const buildProvider = async (db: Db): Promise<LlmProvider> => {
  const id = await resolveProviderId(db);
  return buildProviderForId(db, id);
};
