import {
  AnthropicProvider,
  DEFAULT_TEXT_MODEL,
  LocalGatewayProvider,
  type LlmProvider,
} from '@vibe-tx-converter/extractor';

import type { Db } from '../db/client.js';
import { unwrapSecret } from '../lib/secrets.js';
import { resolveAiSettings } from './ai-settings.js';
import { getMergedPriceTable } from './pricing.js';
import { readSetting } from './system-settings.js';

const KEY_PROVIDER = 'llm.provider';
const KEY_ANTHROPIC_KEY = 'llm.anthropic.api_key';
const KEY_ANTHROPIC_MODEL = 'llm.anthropic.model';
const KEY_ANTHROPIC_BASE_URL = 'llm.anthropic.base_url';
const KEY_LLM_TIMEOUT = 'llm.timeout_ms';
const KEY_LLM_MAX_TOKENS = 'llm.max_tokens';
// Local Ollama: base URL + text/vision model tags, operator-configurable from
// /admin/llm-provider. The base URL also has the legacy `engine.llm_gateway.url`
// alias (kept for in-place upgrades); a value under either key wins over env.
const KEY_OLLAMA_BASE_URL = 'engine.llm_gateway.url';
const KEY_OLLAMA_MODEL = 'llm.local.model';
const KEY_OLLAMA_VISION_MODEL = 'llm.local.vision_model';

// 180s default: scanned statements now extract on the local text model
// (qwen3.5, ~24 GB) in stage 2, whose first (cold) load can take ~2 min before
// any tokens stream. keep_alive holds it warm afterward, so only the first call
// per idle period is slow — but the default must not trip on it. Operator-tunable.
export const DEFAULT_LLM_TIMEOUT_MS = 180_000;
export const DEFAULT_LLM_MAX_TOKENS = 32_000;

// Per-call timeout (ms) for extraction + enrichment LLM requests, applied
// to both the local Ollama provider and the Anthropic provider. Operator-set
// (system_settings) wins, then the LLM_TIMEOUT_MS env, then 180s. A slow
// statement may take up to ~2x this (one reminder-retry).
export const resolveLlmTimeoutMs = async (db: Db): Promise<number> => {
  const row = await readSetting(db, KEY_LLM_TIMEOUT);
  const fromDb = row?.valuePlaintext ? Number.parseInt(row.valuePlaintext, 10) : NaN;
  if (Number.isFinite(fromDb) && fromDb > 0) return fromDb;
  const fromEnv = Number.parseInt(process.env.LLM_TIMEOUT_MS ?? '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_LLM_TIMEOUT_MS;
};

// Hard ceiling on output tokens per extraction call. Operator-set
// (system_settings) wins, then the LLM_MAX_COMPLETION_TOKENS env, then
// 32000. The old 6000 cap truncated multi-page statements mid-array and
// dropped `transactions`. A larger statement needs a larger cap and a
// proportionally larger timeout (more tokens take longer to generate).
export const resolveLlmMaxTokens = async (db: Db): Promise<number> => {
  const row = await readSetting(db, KEY_LLM_MAX_TOKENS);
  const fromDb = row?.valuePlaintext ? Number.parseInt(row.valuePlaintext, 10) : NaN;
  if (Number.isFinite(fromDb) && fromDb > 0) return fromDb;
  const fromEnv = Number.parseInt(process.env.LLM_MAX_COMPLETION_TOKENS ?? '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_LLM_MAX_TOKENS;
};

// Anthropic default text model, mirrored from AnthropicProvider's own fallback.
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

// Resolve the model tag a provider WOULD use for an extraction call, by the same
// DB → env → default precedence the provider constructors apply — without
// building the provider or making any network call. Used to label "which model
// is in use" on the statement row the moment extraction starts, so the live
// processing UI can show it before the first LLM call returns telemetry.
export const resolveModelLabelForProvider = async (
  db: Db,
  providerId: ProviderId,
): Promise<string> => {
  if (providerId === 'anthropic') {
    const row = await readSetting(db, KEY_ANTHROPIC_MODEL);
    return row?.valuePlaintext ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
  }
  const row = await readSetting(db, KEY_OLLAMA_MODEL);
  return row?.valuePlaintext ?? process.env.LLM_MODEL_ID ?? DEFAULT_TEXT_MODEL;
};

const DIRECT_ANTHROPIC = 'https://api.anthropic.com';

export type ProviderId = 'local' | 'anthropic';

// Effective Anthropic base URL: operator-set (system_settings) wins, then
// the ANTHROPIC_BASE_URL env, then the direct Anthropic API. A non-default
// value routes the (text-only) extraction LLM through an operator-configured
// proxy that speaks the Messages API.
export const resolveAnthropicBaseUrl = async (db: Db): Promise<string> => {
  const row = await readSetting(db, KEY_ANTHROPIC_BASE_URL);
  const fromDb = row?.valuePlaintext?.trim();
  if (fromDb && fromDb.length > 0) return fromDb.replace(/\/$/, '');
  const fromEnv = process.env.ANTHROPIC_BASE_URL?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv.replace(/\/$/, '');
  return DIRECT_ANTHROPIC;
};

// True when the effective base URL is NOT the direct Anthropic API, i.e.
// extraction is proxied through an operator-configured Messages-API proxy.
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
  // Ollama base URL + text/vision model tags are operator-configurable from
  // /admin/llm-provider. Each falls back to its env default in the provider
  // constructor when the DB has no override.
  const baseUrl = (await readSetting(db, KEY_OLLAMA_BASE_URL))?.valuePlaintext ?? undefined;
  const modelId = (await readSetting(db, KEY_OLLAMA_MODEL))?.valuePlaintext ?? undefined;
  const visionModelId =
    (await readSetting(db, KEY_OLLAMA_VISION_MODEL))?.valuePlaintext ?? undefined;
  const timeoutMs = await resolveLlmTimeoutMs(db);
  // Operator-tunable vision knobs (DB → env → default), passed through so the
  // /admin/llm-provider tuning controls take effect without a restart.
  const ai = await resolveAiSettings(db);
  return new LocalGatewayProvider({
    ...(baseUrl ? { baseUrl } : {}),
    ...(modelId ? { modelId } : {}),
    ...(visionModelId ? { visionModelId } : {}),
    timeoutMs,
    structuredOutputMode: ai.localStructuredOutput,
    visionTimeoutMs: ai.visionTimeoutMs,
    visionMaxTokens: ai.visionMaxTokens,
    keepAlive: ai.keepAlive,
    ...(ai.numCtx != null ? { numCtx: ai.numCtx } : {}),
    ...(ai.visionThink != null ? { visionThink: ai.visionThink } : {}),
  });
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
  // Operator-set base URL so an optional Messages-API proxy is configurable
  // from /admin/llm-provider instead of an env-only ANTHROPIC_BASE_URL.
  const baseUrl = await resolveAnthropicBaseUrl(db);
  const timeoutMs = await resolveLlmTimeoutMs(db);
  const maxTokens = await resolveLlmMaxTokens(db);
  return new AnthropicProvider({ apiKey, model, priceTable, baseUrl, timeoutMs, maxTokens });
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
