import { createHash } from 'node:crypto';

// GLM-OCR HTTP contract.
//
// Request (we always send this exact shape):
//   POST {GLM_OCR_URL}/ocr
//     content-type: application/json
//     body: { pages: [{ image_base64: string }, ...] }
//
// Response (we accept any of the variants below — see parseOcrResponse):
//   1. { pages: [{ markdown|text|content|output|ocr_text|raw, confidence|score|conf }, ...] }
//   2. { data: { pages: [ ... ] } }
//   3. { result: { ...page... } }   or   { result: "raw markdown" }
//   4. { markdown|text|...: ..., confidence|...: ... }            (single-page flat)
//   5. "raw markdown string"                                       (bare-string body)
// Confidence is coerced from strings, percent (0..100), missing → defaultConfidence.
// Unrecognized shapes throw GlmOcrError; the error carries the top-level
// key names (not values) so operators can adjust without leaking PII.
//
//   GET {GLM_OCR_URL}/health   — 200 OK if alive
//   GET {GLM_OCR_URL}/version  — { version: string }, cached 5 min
//
// All inputs are PNG/JPEG buffers (raster output of pdftoppm). Raw PDFs
// and source bytes are NOT sent. The page-level confidence rolls up to
// the per-row confidence in the LLM extractor's repair pass.

export interface OcrPageResult {
  index: number;
  markdown: string;
  confidence: number;
}

export type OcrParseVariant =
  | 'pages-array'
  | 'data-pages'
  | 'result-wrapper'
  | 'flat-page'
  | 'output-string'
  | 'from-cache';

export interface OcrParseDiagnostic {
  pageIndex: number;
  variant: OcrParseVariant;
  textFieldUsed: 'markdown' | 'text' | 'content' | 'output' | 'ocr_text' | 'raw' | 'none';
  confidenceSource: 'present-number' | 'coerced-string' | 'coerced-percent' | 'assumed-default';
  emptyText: boolean;
  bodyTopLevelKeys: string[];
}

export interface OcrResponse {
  pages: OcrPageResult[];
  engineVersion: string;
  parseDiagnostics: OcrParseDiagnostic[];
}

// Phase 11 #5: pluggable cache store. The leaf extractor package can't
// take an ioredis dep directly, so callers pass an adapter that
// satisfies this minimal interface. Default is an in-memory Map.
export interface OcrCacheStore {
  get(key: string): Promise<OcrPageResult | null>;
  set(key: string, value: OcrPageResult, ttlSeconds: number): Promise<void>;
}

export interface GlmOcrClientOptions {
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  concurrency?: number | undefined;
  maxAttempts?: number | undefined;
  fetcher?: typeof fetch | undefined;
  cache?: OcrCacheStore | undefined;
  cacheTtlSeconds?: number | undefined;
  // Fallback when GLM-OCR omits a confidence value. 0.5 ("unknown")
  // by default; override via GLM_OCR_DEFAULT_CONFIDENCE.
  defaultConfidence?: number | undefined;
}

export class GlmOcrError extends Error {
  readonly status: number | undefined;
  readonly url: string | undefined;
  constructor(message: string, status?: number, url?: string) {
    super(message);
    this.name = 'GlmOcrError';
    this.status = status;
    this.url = url;
  }
}

export class GlmOcrCircuitOpenError extends GlmOcrError {
  constructor(message: string) {
    super(message);
    this.name = 'GlmOcrCircuitOpenError';
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
}

// In-memory fallback. Honors a soft TTL but doesn't cleanly expire — the
// process bound caps memory usage in practice.
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

// Phase 11 #11: circuit breaker. Module-scoped so multiple ocrPdfPages
// callers share state. Trips after `THRESHOLD` consecutive failures and
// stays open for `OPEN_MS`; in half-open, the next request is allowed
// and either resets the breaker or trips it again.
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

const resolveConfig = (opts: GlmOcrClientOptions = {}): InternalConfig => {
  const baseUrl = (opts.baseUrl ?? process.env.GLM_OCR_URL ?? '').replace(/\/$/, '');
  if (!baseUrl) throw new GlmOcrError('GLM_OCR_URL is not set');
  return {
    baseUrl,
    timeoutMs: opts.timeoutMs ?? Number(process.env.GLM_OCR_TIMEOUT_MS ?? 60_000),
    concurrency: opts.concurrency ?? Number(process.env.GLM_OCR_CONCURRENCY ?? 2),
    maxAttempts: opts.maxAttempts ?? 3,
    fetcher: opts.fetcher ?? fetch,
    cache: opts.cache ?? defaultCache,
    // Phase 11 #5: 7-day default cache TTL. Override via
    // GLM_OCR_CACHE_TTL_DAYS env or per-call option.
    cacheTtlSeconds:
      opts.cacheTtlSeconds ?? Number(process.env.GLM_OCR_CACHE_TTL_DAYS ?? 7) * 86_400,
    defaultConfidence:
      opts.defaultConfidence ?? Number(process.env.GLM_OCR_DEFAULT_CONFIDENCE ?? 0.5),
  };
};

// First non-null present alias wins; order is significant.
const TEXT_FIELD_ALIASES = ['markdown', 'text', 'content', 'output', 'ocr_text', 'raw'] as const;
type TextField = (typeof TEXT_FIELD_ALIASES)[number];

const CONFIDENCE_FIELD_ALIASES = ['confidence', 'score', 'conf'] as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const topLevelKeys = (body: unknown): string[] => (isPlainObject(body) ? Object.keys(body) : []);

const resolveText = (
  candidate: Record<string, unknown>,
): { text: string; field: TextField | 'none'; empty: boolean } => {
  for (const alias of TEXT_FIELD_ALIASES) {
    if (alias in candidate) {
      const raw = candidate[alias];
      if (raw === null || raw === undefined) {
        return { text: '', field: alias, empty: true };
      }
      const str = typeof raw === 'string' ? raw : String(raw);
      return { text: str, field: alias, empty: str.length === 0 };
    }
  }
  return { text: '', field: 'none', empty: true };
};

const coerceConfidence = (
  raw: unknown,
  defaultConfidence: number,
): { value: number; source: OcrParseDiagnostic['confidenceSource'] } => {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw >= 0 && raw <= 1) return { value: raw, source: 'present-number' };
    if (raw > 1 && raw <= 100) return { value: raw / 100, source: 'coerced-percent' };
    return { value: defaultConfidence, source: 'assumed-default' };
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      const recursed = coerceConfidence(n, defaultConfidence);
      // Preserve the "string was parsed" provenance only when the value
      // was actually accepted from the number it parsed to.
      if (recursed.source === 'present-number' || recursed.source === 'coerced-percent') {
        return { value: recursed.value, source: 'coerced-string' };
      }
      return recursed;
    }
  }
  return { value: defaultConfidence, source: 'assumed-default' };
};

const resolveConfidence = (
  candidate: Record<string, unknown>,
  defaultConfidence: number,
): { value: number; source: OcrParseDiagnostic['confidenceSource'] } => {
  for (const alias of CONFIDENCE_FIELD_ALIASES) {
    if (alias in candidate) {
      return coerceConfidence(candidate[alias], defaultConfidence);
    }
  }
  return { value: defaultConfidence, source: 'assumed-default' };
};

// Pure parser. Walks shape variants in order until one yields a page-like
// object; never throws on missing fields within a recognized shape (those
// degrade to defaults). Only throws when no shape matches — that error
// path counts toward the circuit breaker.
export const parseOcrResponse = (
  body: unknown,
  pageIndex: number,
  defaultConfidence: number,
): { result: OcrPageResult; diagnostic: OcrParseDiagnostic } => {
  const keys = topLevelKeys(body);

  const fromString = (
    str: string,
    variant: OcrParseVariant,
    bodyKeys: string[],
  ): { result: OcrPageResult; diagnostic: OcrParseDiagnostic } => {
    const empty = str.length === 0;
    return {
      result: { index: pageIndex, markdown: str, confidence: empty ? 0 : defaultConfidence },
      diagnostic: {
        pageIndex,
        variant,
        textFieldUsed: 'none',
        confidenceSource: 'assumed-default',
        emptyText: empty,
        bodyTopLevelKeys: bodyKeys,
      },
    };
  };

  const fromCandidate = (
    candidate: Record<string, unknown>,
    variant: OcrParseVariant,
    bodyKeys: string[],
  ): { result: OcrPageResult; diagnostic: OcrParseDiagnostic } => {
    const { text, field, empty } = resolveText(candidate);
    const { value: confValue, source: confSource } = resolveConfidence(
      candidate,
      defaultConfidence,
    );
    // Empty markdown overrides confidence to 0 so the trace
    // distinguishes "we got nothing" from "we got something but no
    // quality signal".
    const confidence = empty ? 0 : confValue;
    const confidenceSource: OcrParseDiagnostic['confidenceSource'] = empty
      ? 'assumed-default'
      : confSource;
    return {
      result: { index: pageIndex, markdown: text, confidence },
      diagnostic: {
        pageIndex,
        variant,
        textFieldUsed: field,
        confidenceSource,
        emptyText: empty,
        bodyTopLevelKeys: bodyKeys,
      },
    };
  };

  if (typeof body === 'string') return fromString(body, 'output-string', []);

  if (!isPlainObject(body)) {
    throw new GlmOcrError(
      `GLM-OCR response: unrecognized shape (top-level keys: ${keys.join(',') || '<none>'})`,
      undefined,
      undefined,
    );
  }

  if (Array.isArray(body.pages) && body.pages.length > 0 && isPlainObject(body.pages[0])) {
    return fromCandidate(body.pages[0] as Record<string, unknown>, 'pages-array', keys);
  }

  if (isPlainObject(body.data)) {
    const inner = body.data as Record<string, unknown>;
    if (Array.isArray(inner.pages) && inner.pages.length > 0 && isPlainObject(inner.pages[0])) {
      return fromCandidate(inner.pages[0] as Record<string, unknown>, 'data-pages', keys);
    }
  }

  if ('result' in body) {
    const r = body.result;
    if (typeof r === 'string') return fromString(r, 'result-wrapper', keys);
    if (isPlainObject(r)) {
      return fromCandidate(r as Record<string, unknown>, 'result-wrapper', keys);
    }
  }

  const hasTextOrConfAlias =
    TEXT_FIELD_ALIASES.some((a) => a in body) || CONFIDENCE_FIELD_ALIASES.some((a) => a in body);
  if (hasTextOrConfAlias) return fromCandidate(body, 'flat-page', keys);

  throw new GlmOcrError(
    `GLM-OCR response: unrecognized shape (top-level keys: ${keys.join(',') || '<none>'})`,
    undefined,
    undefined,
  );
};

const ocrPage = async (
  cfg: InternalConfig,
  image: Buffer,
  pageIndex: number,
): Promise<{ result: OcrPageResult; cached: boolean; diagnostic: OcrParseDiagnostic }> => {
  const key = hashImage(image);
  const hit = await cfg.cache.get(key);
  if (hit) {
    return {
      result: { ...hit, index: pageIndex },
      cached: true,
      diagnostic: {
        pageIndex,
        variant: 'from-cache',
        textFieldUsed: 'markdown',
        confidenceSource: 'present-number',
        emptyText: hit.markdown.length === 0,
        bodyTopLevelKeys: [],
      },
    };
  }

  if (circuitState() === 'open') {
    throw new GlmOcrCircuitOpenError(
      `GLM-OCR circuit open (${cbConsecutiveFailures} consecutive failures); retrying after cooldown`,
    );
  }

  const url = `${cfg.baseUrl}/ocr`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await cfg.fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pages: [{ image_base64: image.toString('base64') }] }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new GlmOcrError(`GLM-OCR POST ${url} → HTTP ${res.status}`, res.status, url);
      }
      const body = (await res.json()) as unknown;
      const { result: normalized, diagnostic } = parseOcrResponse(
        body,
        pageIndex,
        cfg.defaultConfidence,
      );
      await cfg.cache.set(key, normalized, cfg.cacheTtlSeconds);
      onSuccess();
      return { result: normalized, cached: false, diagnostic };
    } catch (err) {
      lastErr = err;
      // 4xx is a config/contract bug (wrong URL, bad auth, malformed
      // payload) — retrying doesn't change the outcome and wastes a
      // visible amount of wall time on a multi-page statement. Only
      // retry on 5xx, timeouts (AbortError), and network failures.
      if (err instanceof GlmOcrError && err.status !== undefined && err.status < 500) {
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
  throw lastErr instanceof Error
    ? lastErr
    : new GlmOcrError(`OCR failed after ${cfg.maxAttempts} attempts`);
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

// Phase 11 #6: cache the GLM-OCR engine version with a 5-min TTL so
// every batch doesn't refetch /version. Cleared on engine restart by
// the operator running ocr-test.ts.
let cachedEngineVersion: { value: string; expiresAt: number } | null = null;
const ENGINE_VERSION_TTL_MS = 5 * 60_000;

export const probeGlmOcrVersion = async (opts: GlmOcrClientOptions = {}): Promise<string> => {
  if (cachedEngineVersion && cachedEngineVersion.expiresAt > Date.now()) {
    return cachedEngineVersion.value;
  }
  try {
    const cfg = resolveConfig(opts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await cfg.fetcher(`${cfg.baseUrl}/version`, { signal: controller.signal });
      if (!res.ok) return 'glm-ocr/unknown';
      const body = (await res.json()) as { version?: string };
      const version = body.version ?? 'glm-ocr/unknown';
      cachedEngineVersion = { value: version, expiresAt: Date.now() + ENGINE_VERSION_TTL_MS };
      return version;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return 'glm-ocr/unknown';
  }
};

export const ocrPdfPages = async (
  images: Buffer[],
  opts: GlmOcrClientOptions = {},
): Promise<OcrResponse> => {
  const cfg = resolveConfig(opts);
  const perPage = await runWithConcurrency(images, cfg.concurrency, async (img, i) => {
    const { result, diagnostic } = await ocrPage(cfg, img, i);
    return { result, diagnostic };
  });
  const engineVersion = await probeGlmOcrVersion(opts);
  const pages: OcrPageResult[] = new Array(perPage.length);
  const parseDiagnostics: OcrParseDiagnostic[] = new Array(perPage.length);
  for (let i = 0; i < perPage.length; i += 1) {
    pages[i] = perPage[i]!.result;
    parseDiagnostics[i] = perPage[i]!.diagnostic;
  }
  return { pages, engineVersion, parseDiagnostics };
};

export const probeGlmOcrHealth = async (
  opts: GlmOcrClientOptions = {},
): Promise<{ ok: boolean; status?: number; detail?: string }> => {
  try {
    const cfg = resolveConfig(opts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await cfg.fetcher(`${cfg.baseUrl}/health`, { signal: controller.signal });
      return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
};
