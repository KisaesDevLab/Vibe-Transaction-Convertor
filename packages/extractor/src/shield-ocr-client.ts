import { createHash } from 'node:crypto';

import { computeAnthropicCostMicros, type AnthropicPriceTable } from './llm-client.js';

// Vibe Shield OCR client.
//
// Replaces the former local GLM-OCR path: instead of POSTing each page
// image to a local GLM-OCR server, we send it to the Vibe Shield gateway
// (Anthropic Messages-shaped, `POST {baseUrl}/v1/messages`). Shield
// redacts PII in the image (masking each region with its `<ENTITY_N>`
// token under the token-overlay masker policy), forwards the masked
// image to Claude, and Claude transcribes the page to markdown. With the
// `cpa-converter-output` policy (reid.mode='none') the markdown comes
// back STILL TOKENIZED — tokens resolve to cleartext only at export via
// the Shield materialize endpoint.
//
// Request (one POST per page; parallelised via the `concurrency` knob):
//   POST {baseUrl}/v1/messages
//     authorization: Bearer <vs_live_… key>
//     content-type: application/json
//     body: {
//       "model": "<claude model>",
//       "max_tokens": <cap>,
//       "messages": [{ "role": "user", "content": [
//         { "type": "image", "source": { "type": "base64",
//           "media_type": "image/png", "data": "<base64>" } },
//         { "type": "text", "text": "<OCR prompt>" }
//       ] }],
//       "temperature": 0,
//       "session_id": "<conversion session>",     // Shield extension
//       "policy_name": "cpa-converter-output"      // Shield extension
//     }
//
// Response: standard Anthropic Message. The OCR'd markdown is the
// concatenation of every `content[]` block whose `type === 'text'`.
// `usage` carries Claude's token counts (Shield passes them through
// unchanged) so we can roll up OCR cost the same way the extractor does.
//
//   GET {baseUrl}{healthPath}  — default /health ; 200 OK if alive.
//
// All inputs are PNG/JPEG buffers (raster output of pdftoppm). Unlike the
// old local-only OCR, page images now egress to Shield→Claude — but only
// AFTER Shield masks PII. This is the deliberate trade documented in the
// OCR-via-Shield ADR.

export interface OcrPageResult {
  index: number;
  markdown: string;
  confidence: number;
}

// Narrow to the two outcomes this path produces. We keep the
// `OcrParseDiagnostic` shape stable so the worker's
// `summarizeOcrDiagnostics` keeps compiling unchanged.
export type OcrParseVariant = 'anthropic-messages' | 'from-cache';

export interface OcrParseDiagnostic {
  pageIndex: number;
  variant: OcrParseVariant;
  // Claude returns the transcription across one-or-more `text` content
  // blocks; `none` is only used when no text block was present.
  textFieldUsed: 'content' | 'none';
  // Claude doesn't report a per-page OCR confidence, so we always stamp
  // `assumed-default` and let the caller's defaultConfidence govern.
  confidenceSource: 'assumed-default';
  emptyText: boolean;
  // Top-level keys of the raw HTTP body — kept for the audit trail so an
  // unexpected response shape can be diagnosed without re-running.
  bodyTopLevelKeys: string[];
}

// Token usage rolled up across every page in a batch, so the worker can
// fold OCR cost into the statement's LLM cost columns (OCR was free under
// local GLM-OCR; via Shield→Claude it now costs vision tokens).
export interface OcrUsage {
  inputTokens: number;
  outputTokens: number;
  costMicros: bigint;
}

export interface OcrResponse {
  pages: OcrPageResult[];
  engineVersion: string;
  parseDiagnostics: OcrParseDiagnostic[];
  usage: OcrUsage;
}

// Pluggable cache store. The leaf extractor package can't take an ioredis
// dep directly, so callers pass an adapter satisfying this minimal
// interface. Default is an in-memory Map.
export interface OcrCacheStore {
  get(key: string): Promise<OcrPageResult | null>;
  set(key: string, value: OcrPageResult, ttlSeconds: number): Promise<void>;
}

export interface ShieldOcrClientOptions {
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  concurrency?: number | undefined;
  maxAttempts?: number | undefined;
  fetcher?: typeof fetch | undefined;
  cache?: OcrCacheStore | undefined;
  cacheTtlSeconds?: number | undefined;
  // Fallback confidence stamped on every successful page (Claude reports
  // none). 0.9 by default; override via VIBE_SHIELD_DEFAULT_CONFIDENCE.
  defaultConfidence?: number | undefined;
  healthPath?: string | undefined;
  // Claude model id + the per-page OCR instruction. `prompt` is the text
  // block placed AFTER the image (Anthropic's recommended ordering).
  model?: string | undefined;
  prompt?: string | undefined;
  maxTokens?: number | undefined;
  // The Shield tenant key (`vs_live_…`). REQUIRED — Shield's gateway
  // rejects unauthenticated calls. Empty string is treated as unset so a
  // misconfiguration fails loud instead of sending an anonymous request.
  apiKey?: string | undefined;
  // Shield extensions: the per-conversion session (so OCR + extraction
  // tokens share one vault) and the policy that governs redaction/reid.
  sessionId?: string | undefined;
  policyName?: string | undefined;
  // Operator-mergeable Anthropic price table for cost rollup.
  priceTable?: AnthropicPriceTable | undefined;
}

export class ShieldOcrError extends Error {
  readonly status: number | undefined;
  readonly url: string | undefined;
  constructor(message: string, status?: number, url?: string) {
    super(message);
    this.name = 'ShieldOcrError';
    this.status = status;
    this.url = url;
  }
}

export class ShieldOcrCircuitOpenError extends ShieldOcrError {
  constructor(message: string) {
    super(message);
    this.name = 'ShieldOcrCircuitOpenError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const hashImage = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

interface InternalConfig {
  baseUrl: string;
  timeoutMs: number;
  concurrency: number;
  maxAttempts: number;
  fetcher: typeof fetch;
  cache: OcrCacheStore;
  cacheTtlSeconds: number;
  defaultConfidence: number;
  healthPath: string;
  model: string;
  prompt: string;
  maxTokens: number;
  apiKey: string;
  sessionId: string | null;
  policyName: string;
  // True when baseUrl is the direct Anthropic API (bypass Shield).
  direct: boolean;
  priceTable: AnthropicPriceTable | undefined;
}

class MemoryCacheStore implements OcrCacheStore {
  private map = new Map<string, { value: OcrPageResult; expiresAt: number }>();
  async get(key: string): Promise<OcrPageResult | null> {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expiresAt < Date.now()) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }
  async set(key: string, value: OcrPageResult, ttlSeconds: number): Promise<void> {
    this.map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
  clear(): void {
    this.map.clear();
  }
}

const defaultCache = new MemoryCacheStore();
export const clearOcrCache = (): void => defaultCache.clear();

// Circuit breaker. Module-scoped so multiple ocrPdfPages callers share
// state. Trips after THRESHOLD consecutive failures and stays open for
// OPEN_MS; in half-open the next request is allowed and either resets or
// re-trips the breaker.
const CB_THRESHOLD = 10;
const CB_OPEN_MS = 60_000;
let cbConsecutiveFailures = 0;
let cbOpenedAt = 0;

const circuitState = (): 'closed' | 'open' | 'half-open' => {
  if (cbOpenedAt === 0) return 'closed';
  const elapsed = Date.now() - cbOpenedAt;
  return elapsed > CB_OPEN_MS ? 'half-open' : 'open';
};

const onSuccess = (): void => {
  cbConsecutiveFailures = 0;
  cbOpenedAt = 0;
};

const onFailure = (): void => {
  cbConsecutiveFailures += 1;
  if (cbConsecutiveFailures >= CB_THRESHOLD) cbOpenedAt = Date.now();
};

export const resetOcrCircuit = (): void => {
  cbConsecutiveFailures = 0;
  cbOpenedAt = 0;
};

const resolvePath = (override: string | undefined, fallback: string): string => {
  const raw = override ?? '';
  if (raw.length === 0) return fallback;
  const withLead = raw.startsWith('/') ? raw : `/${raw}`;
  return withLead.replace(/\/+$/, '') || fallback;
};

// The Shield gateway's address on the appliance/docker network. Used as
// the final fallback so OCR works out of the box once the operator sets
// the vs_live_ key (no need to also type the URL).
const DEFAULT_VIBE_SHIELD_URL = 'http://vibe-shield-gateway:8080';

// When the engine URL is the direct Anthropic API, OCR bypasses Vibe
// Shield entirely: x-api-key auth (not Bearer), no policy_name/session_id
// fields (Anthropic rejects unknown body params), and the /v1/models
// health probe. NOTE: in this mode page images egress UNREDACTED to
// Anthropic — Shield's PII masking is not applied.
const ANTHROPIC_DIRECT = 'https://api.anthropic.com';

const resolveConfig = (opts: ShieldOcrClientOptions = {}): InternalConfig => {
  const baseUrl = (opts.baseUrl ?? process.env.VIBE_SHIELD_URL ?? DEFAULT_VIBE_SHIELD_URL).replace(
    /\/$/,
    '',
  );
  const apiKey = opts.apiKey ?? process.env.VIBE_SHIELD_API_KEY ?? '';
  if (apiKey.length === 0) {
    throw new ShieldOcrError(
      'VIBE_SHIELD_API_KEY is not set — Shield rejects unauthenticated calls',
    );
  }
  return {
    baseUrl,
    // Claude vision per page is slower than a local OCR call and adds a
    // network hop through Shield; 120s keeps headroom for large pages.
    timeoutMs: opts.timeoutMs ?? Number(process.env.VIBE_SHIELD_TIMEOUT_MS ?? 120_000),
    concurrency: opts.concurrency ?? Number(process.env.VIBE_SHIELD_CONCURRENCY ?? 2),
    maxAttempts: opts.maxAttempts ?? 3,
    fetcher: opts.fetcher ?? fetch,
    cache: opts.cache ?? defaultCache,
    cacheTtlSeconds:
      opts.cacheTtlSeconds ?? Number(process.env.VIBE_SHIELD_CACHE_TTL_DAYS ?? 7) * 86_400,
    defaultConfidence:
      opts.defaultConfidence ?? Number(process.env.VIBE_SHIELD_DEFAULT_CONFIDENCE ?? 0.9),
    healthPath: resolvePath(opts.healthPath ?? process.env.VIBE_SHIELD_HEALTH_PATH, '/health'),
    model: opts.model ?? process.env.VIBE_SHIELD_MODEL ?? 'claude-sonnet-4-6',
    prompt:
      opts.prompt ??
      process.env.VIBE_SHIELD_OCR_PROMPT ??
      'Transcribe this bank/credit-card statement page to GitHub-flavored Markdown. ' +
        'Preserve every transaction row, date, description, and amount exactly as printed, ' +
        'including any <ENTITY_N> placeholder tokens. Do not summarize, infer, or omit rows. ' +
        'Output only the transcription.',
    maxTokens: opts.maxTokens ?? Number(process.env.VIBE_SHIELD_MAX_OCR_TOKENS ?? 8_000),
    apiKey,
    sessionId: opts.sessionId && opts.sessionId.length > 0 ? opts.sessionId : null,
    policyName: opts.policyName ?? process.env.VIBE_SHIELD_POLICY ?? 'cpa-converter-output',
    direct: baseUrl === ANTHROPIC_DIRECT,
    priceTable: opts.priceTable,
  };
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const topLevelKeys = (body: unknown): string[] => (isPlainObject(body) ? Object.keys(body) : []);

// Pure parser for the Anthropic Messages response shape. The OCR'd
// markdown is the concatenation of every `text` content block. Exported
// for unit tests; not part of the public API surface.
export const parseAnthropicOcrResponse = (
  body: unknown,
  pageIndex: number,
  defaultConfidence: number,
): {
  result: OcrPageResult;
  diagnostic: OcrParseDiagnostic;
  inputTokens: number;
  outputTokens: number;
} => {
  const keys = topLevelKeys(body);
  if (!isPlainObject(body)) {
    throw new ShieldOcrError(
      `Shield response: expected JSON object, got ${typeof body} (top-level keys: ${keys.join(',') || '<none>'})`,
    );
  }
  // Surface Anthropic/Shield error envelopes loudly so the circuit
  // breaker reacts and the audit log records the cause.
  if (isPlainObject(body.error)) {
    const e = body.error as Record<string, unknown>;
    throw new ShieldOcrError(
      `Shield response error: ${String(e.type ?? 'error')} — ${String(e.message ?? '')}`,
    );
  }
  const content = body.content;
  if (!Array.isArray(content)) {
    throw new ShieldOcrError(
      `Shield response: missing "content" array (top-level keys: ${keys.join(',') || '<none>'})`,
    );
  }
  // Truncation guard. Anthropic reports stop_reason='max_tokens' when the
  // completion hit the cap before finishing — treating that as success
  // would silently feed truncated markdown to the extractor. Fail loud so
  // the audit row names the page and the cap.
  if (body.stop_reason === 'max_tokens') {
    throw new ShieldOcrError(
      `Shield/Claude OCR truncated by max_tokens on page ${pageIndex + 1} ` +
        `(stop_reason='max_tokens'). Raise VIBE_SHIELD_MAX_OCR_TOKENS or lower page DPI.`,
    );
  }
  const text = content
    .map((p) => (isPlainObject(p) && p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
    .join('');
  const empty = text.length === 0;
  const usage = isPlainObject(body.usage) ? (body.usage as Record<string, unknown>) : {};
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  return {
    result: {
      index: pageIndex,
      markdown: text,
      confidence: empty ? 0 : defaultConfidence,
    },
    diagnostic: {
      pageIndex,
      variant: 'anthropic-messages',
      textFieldUsed: empty ? 'none' : 'content',
      confidenceSource: 'assumed-default',
      emptyText: empty,
      bodyTopLevelKeys: keys,
    },
    inputTokens,
    outputTokens,
  };
};

// Build the Shield (Anthropic Messages) request body for one page image.
// Pulled out so tests can assert the exact wire shape without the full
// retry/cache stack. Image-first, text-last per Anthropic's guidance.
export const buildShieldOcrRequestBody = (
  image: Buffer,
  cfg: {
    model: string;
    prompt: string;
    maxTokens: number;
    sessionId: string | null;
    policyName: string;
    // Direct-Anthropic mode omits the Shield extension fields, which the
    // real Anthropic API would reject as unknown body params.
    direct?: boolean;
  },
): Record<string, unknown> => ({
  model: cfg.model,
  max_tokens: cfg.maxTokens,
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') },
        },
        { type: 'text', text: cfg.prompt },
      ],
    },
  ],
  temperature: 0,
  ...(cfg.direct
    ? {}
    : { policy_name: cfg.policyName, ...(cfg.sessionId ? { session_id: cfg.sessionId } : {}) }),
});

const ocrPage = async (
  cfg: InternalConfig,
  image: Buffer,
  pageIndex: number,
): Promise<{
  result: OcrPageResult;
  cached: boolean;
  diagnostic: OcrParseDiagnostic;
  inputTokens: number;
  outputTokens: number;
}> => {
  // Cache key includes the session: the same image redacted under a
  // different session yields different token IDs, so results aren't
  // interchangeable across sessions.
  const key = `${cfg.sessionId ?? 'no-session'}:${hashImage(image)}`;
  const hit = await cfg.cache.get(key);
  if (hit) {
    return {
      result: { ...hit, index: pageIndex },
      cached: true,
      diagnostic: {
        pageIndex,
        variant: 'from-cache',
        textFieldUsed: 'content',
        confidenceSource: 'assumed-default',
        emptyText: hit.markdown.length === 0,
        bodyTopLevelKeys: [],
      },
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  if (circuitState() === 'open') {
    throw new ShieldOcrCircuitOpenError(
      `Shield OCR circuit open (${cbConsecutiveFailures} consecutive failures); retrying after cooldown`,
    );
  }

  const url = `${cfg.baseUrl}/v1/messages`;
  const requestBody = buildShieldOcrRequestBody(image, {
    model: cfg.model,
    prompt: cfg.prompt,
    maxTokens: cfg.maxTokens,
    sessionId: cfg.sessionId,
    policyName: cfg.policyName,
    direct: cfg.direct,
  });
  // Shield gateway → Bearer; direct Anthropic → x-api-key + version.
  const authHeaders: Record<string, string> = cfg.direct
    ? { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${cfg.apiKey}` };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await cfg.fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new ShieldOcrError(`Shield POST ${url} → HTTP ${res.status}`, res.status, url);
      }
      const body = (await res.json()) as unknown;
      const parsed = parseAnthropicOcrResponse(body, pageIndex, cfg.defaultConfidence);
      await cfg.cache.set(key, parsed.result, cfg.cacheTtlSeconds);
      onSuccess();
      return {
        result: parsed.result,
        cached: false,
        diagnostic: parsed.diagnostic,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
      };
    } catch (err) {
      lastErr = err;
      // 4xx (except 429) is a config/contract bug — retrying won't help.
      // Retry on 5xx, 429 (rate limit), timeouts, and network failures.
      if (
        err instanceof ShieldOcrError &&
        err.status !== undefined &&
        err.status < 500 &&
        err.status !== 429
      ) {
        clearTimeout(timer);
        onFailure();
        throw err;
      }
      if (attempt < cfg.maxAttempts) {
        const backoffMs = 200 * 2 ** (attempt - 1);
        await sleep(backoffMs);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  onFailure();
  if (
    lastErr instanceof Error &&
    (lastErr.name === 'AbortError' || lastErr.name === 'TimeoutError')
  ) {
    const wrapped = new ShieldOcrError(
      `Shield POST ${url} timed out after ${cfg.timeoutMs} ms (page ${pageIndex + 1}, ${cfg.maxAttempts} attempt${cfg.maxAttempts === 1 ? '' : 's'} exhausted)`,
      undefined,
      url,
    );
    (wrapped as Error & { cause?: unknown }).cause = lastErr;
    throw wrapped;
  }
  throw lastErr instanceof Error
    ? lastErr
    : new ShieldOcrError(
        `OCR failed after ${cfg.maxAttempts} attempts (page ${pageIndex + 1})`,
        undefined,
        url,
      );
};

const runWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Array<Promise<void>> = [];
  const cap = Math.max(1, Math.min(limit, items.length));
  for (let w = 0; w < cap; w += 1) {
    workers.push(
      (async () => {
        while (true) {
          const i = cursor;
          cursor += 1;
          if (i >= items.length) return;
          out[i] = await fn(items[i]!, i);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
};

export const ocrPdfPages = async (
  images: Buffer[],
  opts: ShieldOcrClientOptions = {},
): Promise<OcrResponse> => {
  const cfg = resolveConfig(opts);
  const perPage = await runWithConcurrency(images, cfg.concurrency, async (img, i) => {
    const { result, diagnostic, inputTokens, outputTokens } = await ocrPage(cfg, img, i);
    return { result, diagnostic, inputTokens, outputTokens };
  });
  const pages: OcrPageResult[] = new Array(perPage.length);
  const parseDiagnostics: OcrParseDiagnostic[] = new Array(perPage.length);
  let inputTokens = 0;
  let outputTokens = 0;
  for (let i = 0; i < perPage.length; i += 1) {
    pages[i] = perPage[i]!.result;
    parseDiagnostics[i] = perPage[i]!.diagnostic;
    inputTokens += perPage[i]!.inputTokens;
    outputTokens += perPage[i]!.outputTokens;
  }
  return {
    pages,
    engineVersion: `${cfg.direct ? 'anthropic' : 'vibe-shield'}/${cfg.model}`,
    parseDiagnostics,
    usage: {
      inputTokens,
      outputTokens,
      costMicros: computeAnthropicCostMicros(cfg.model, inputTokens, outputTokens, cfg.priceTable),
    },
  };
};

export const probeShieldHealth = async (
  opts: ShieldOcrClientOptions = {},
): Promise<{ ok: boolean; status?: number; detail?: string }> => {
  try {
    const cfg = resolveConfig(opts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      // Direct Anthropic has no /health — probe /v1/models (no token cost)
      // with x-api-key. Shield gateway → its /health with the Bearer key.
      const res = cfg.direct
        ? await cfg.fetcher(`${cfg.baseUrl}/v1/models`, {
            headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
            signal: controller.signal,
          })
        : await cfg.fetcher(`${cfg.baseUrl}${cfg.healthPath}`, {
            headers: { authorization: `Bearer ${cfg.apiKey}` },
            signal: controller.signal,
          });
      return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
};
