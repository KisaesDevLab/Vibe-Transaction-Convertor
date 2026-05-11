import { createHash } from 'node:crypto';

// Assumed GLM-OCR HTTP contract (QUESTIONS.md Q-005 — operator must
// confirm against the actual upstream image before production):
//
//   POST {GLM_OCR_URL}/ocr
//     content-type: application/json
//     body: { pages: [{ image_base64: string }, ...] }
//   200 OK:
//     { pages: [{ index: number, markdown: string, confidence: number }, ...],
//       engine_version: string }
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

export interface OcrResponse {
  pages: OcrPageResult[];
  engineVersion: string;
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
  };
};

const ocrPage = async (
  cfg: InternalConfig,
  image: Buffer,
  pageIndex: number,
): Promise<{ result: OcrPageResult; cached: boolean }> => {
  const key = hashImage(image);
  const hit = await cfg.cache.get(key);
  if (hit) return { result: { ...hit, index: pageIndex }, cached: true };

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
      const body = (await res.json()) as { pages?: OcrPageResult[] };
      const page = body.pages?.[0];
      if (!page)
        throw new GlmOcrError(`GLM-OCR POST ${url} → response missing page`, undefined, url);
      const normalized: OcrPageResult = {
        index: pageIndex,
        markdown: page.markdown,
        confidence: page.confidence,
      };
      await cfg.cache.set(key, normalized, cfg.cacheTtlSeconds);
      onSuccess();
      return { result: normalized, cached: false };
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
  const pages = await runWithConcurrency(images, cfg.concurrency, async (img, i) => {
    const { result } = await ocrPage(cfg, img, i);
    return result;
  });
  const engineVersion = await probeGlmOcrVersion(opts);
  return { pages, engineVersion };
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
