import { createHash } from 'node:crypto';

// GLM-OCR HTTP contract.
//
// The vibe-glm-ocr image (used in both standalone and appliance modes)
// runs llama.cpp's llama-server hosting the GLM-OCR multimodal model.
// It exposes an OpenAI-compatible chat-completions API; there is no
// native /ocr endpoint. Sibling apps reach it by service name on port
// 8090 (e.g. http://vibe-glm-ocr:8090).
//
// Request (one POST per page — llama-server isn't batched, so we
// parallelise via the `concurrency` knob instead):
//   POST {GLM_OCR_URL}{ocrPath}    — default ocrPath = /v1/chat/completions
//     content-type: application/json
//     body: {
//       "model": "GLM-OCR",
//       "messages": [{ "role": "user", "content": [
//         { "type": "image_url",
//           "image_url": { "url": "data:image/png;base64,<base64>" } },
//         { "type": "text", "text": "Text Recognition:" }
//       ] }],
//       "temperature": 0.02
//     }
//
// Response: standard OpenAI chat completion. The OCR'd markdown is in
// `choices[0].message.content` (a single string). llama-server does
// not report per-image confidence, so we stamp `defaultConfidence` on
// every successful response — empty content rolls down to 0 so the
// trace can distinguish "got nothing" from "got something".
//
//   GET {GLM_OCR_URL}{healthPath}   — default /health  ; 200 OK if alive
//   GET {GLM_OCR_URL}{versionPath}  — default /version ; { version }, cached 5 min
//     (llama-server doesn't actually serve /version — the probe degrades
//      gracefully to an "unknown" engine version.)
//
// Sub-paths, the prompt mode (`Text Recognition:` / `Table Recognition:`),
// and the model id stay configurable via per-call options or the
// GLM_OCR_OCR_PATH / GLM_OCR_HEALTH_PATH / GLM_OCR_VERSION_PATH /
// GLM_OCR_MODEL / GLM_OCR_PROMPT env vars. Paths must start with `/`.
//
// All inputs are PNG/JPEG buffers (raster output of pdftoppm). Raw PDFs
// and source bytes are NOT sent. The page-level confidence rolls up to
// the per-row confidence in the LLM extractor's repair pass.

export interface OcrPageResult {
  index: number;
  markdown: string;
  confidence: number;
}

// Narrow to the two outcomes the OpenAI-shape path produces. We keep
// the `OcrParseDiagnostic` shape stable across the rewrite so the
// worker's `summarizeOcrDiagnostics` keeps compiling unchanged.
export type OcrParseVariant = 'openai-chat' | 'from-cache';

export interface OcrParseDiagnostic {
  pageIndex: number;
  variant: OcrParseVariant;
  // The OpenAI shape always carries the text in
  // `choices[0].message.content`; `none` is only used when content was
  // missing entirely (degenerate response).
  textFieldUsed: 'content' | 'none';
  // llama-server never reports a per-image confidence number, so we
  // always stamp `assumed-default` and let the caller's defaultConfidence
  // setting govern the magnitude. Kept as a union for future-proofing.
  confidenceSource: 'assumed-default';
  emptyText: boolean;
  // Top-level keys of the raw HTTP body — kept for the audit trail so
  // an unexpected response shape can be diagnosed without re-running.
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
  // Endpoint sub-paths. Default to `/v1/chat/completions`, `/health`,
  // `/version` — matching the vibe-glm-ocr image (llama.cpp llama-
  // server). Override when a deployment puts the OCR behind a path
  // prefix (e.g. `/ocr/v1/chat/completions`). Paths must start with `/`.
  ocrPath?: string | undefined;
  healthPath?: string | undefined;
  versionPath?: string | undefined;
  // OpenAI-shape request fields. `model` matches the model id the
  // upstream serves (vibe-glm-ocr advertises "GLM-OCR"). `prompt` is
  // the second message-content part — either `Text Recognition:`
  // (general OCR; bank-statement default) or `Table Recognition:`
  // (forces structured markdown tables, better for pure tabular
  // statements but strips prose headers).
  model?: string | undefined;
  prompt?: string | undefined;
  // Optional bearer token. vibe-glm-ocr's entrypoint accepts
  // `OCR_API_KEY` to gate the server; when set, every request needs
  // `Authorization: Bearer <key>` or llama-server returns 401. Empty
  // string is treated as "unset" so dev / standalone keeps working.
  apiKey?: string | undefined;
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
  ocrPath: string;
  healthPath: string;
  versionPath: string;
  model: string;
  prompt: string;
  // null when no key is configured (skips the Authorization header).
  apiKey: string | null;
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

// Normalise a sub-path option to a leading-slash, no-trailing-slash
// form so concatenation with baseUrl is predictable. Returns the
// fallback when the input is undefined/empty.
const resolvePath = (override: string | undefined, fallback: string): string => {
  const raw = override ?? '';
  if (raw.length === 0) return fallback;
  const withLead = raw.startsWith('/') ? raw : `/${raw}`;
  return withLead.replace(/\/+$/, '') || fallback;
};

const resolveConfig = (opts: GlmOcrClientOptions = {}): InternalConfig => {
  const baseUrl = (opts.baseUrl ?? process.env.GLM_OCR_URL ?? '').replace(/\/$/, '');
  if (!baseUrl) throw new GlmOcrError('GLM_OCR_URL is not set');
  return {
    baseUrl,
    // 120s gives ~2× headroom over the vibe-glm-ocr README's published
    // CPU inference time (40–60s per page). 60s was right at the edge
    // and every slow page would time out + retry × 3 = ~3 minutes of
    // wasted wall time per page. Operators on GPU can drop this back
    // to 30000 via the env / engines admin field.
    timeoutMs: opts.timeoutMs ?? Number(process.env.GLM_OCR_TIMEOUT_MS ?? 120_000),
    concurrency: opts.concurrency ?? Number(process.env.GLM_OCR_CONCURRENCY ?? 2),
    maxAttempts: opts.maxAttempts ?? 3,
    fetcher: opts.fetcher ?? fetch,
    cache: opts.cache ?? defaultCache,
    // Phase 11 #5: 7-day default cache TTL. Override via
    // GLM_OCR_CACHE_TTL_DAYS env or per-call option.
    cacheTtlSeconds:
      opts.cacheTtlSeconds ?? Number(process.env.GLM_OCR_CACHE_TTL_DAYS ?? 7) * 86_400,
    defaultConfidence:
      opts.defaultConfidence ?? Number(process.env.GLM_OCR_DEFAULT_CONFIDENCE ?? 0.9),
    ocrPath: resolvePath(opts.ocrPath ?? process.env.GLM_OCR_OCR_PATH, '/v1/chat/completions'),
    healthPath: resolvePath(opts.healthPath ?? process.env.GLM_OCR_HEALTH_PATH, '/health'),
    versionPath: resolvePath(opts.versionPath ?? process.env.GLM_OCR_VERSION_PATH, '/version'),
    model: opts.model ?? process.env.GLM_OCR_MODEL ?? 'GLM-OCR',
    prompt: opts.prompt ?? process.env.GLM_OCR_PROMPT ?? 'Text Recognition:',
    apiKey: ((): string | null => {
      const raw = opts.apiKey ?? process.env.GLM_OCR_API_KEY ?? '';
      return raw.length > 0 ? raw : null;
    })(),
  };
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const topLevelKeys = (body: unknown): string[] => (isPlainObject(body) ? Object.keys(body) : []);

// Pure parser for the llama-server (OpenAI-compatible) response shape.
// The OCR'd markdown lives in `choices[0].message.content`. Anything
// else is treated as a contract violation and surfaced via GlmOcrError
// so the circuit breaker can react and the audit log records what
// actually came back. Exported for unit tests; not part of the public
// API surface.
export const parseOpenAiChatResponse = (
  body: unknown,
  pageIndex: number,
  defaultConfidence: number,
): { result: OcrPageResult; diagnostic: OcrParseDiagnostic } => {
  const keys = topLevelKeys(body);
  if (!isPlainObject(body)) {
    throw new GlmOcrError(
      `GLM-OCR response: expected JSON object, got ${typeof body} (top-level keys: ${keys.join(',') || '<none>'})`,
    );
  }
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new GlmOcrError(
      `GLM-OCR response: missing or empty "choices" array (top-level keys: ${keys.join(',') || '<none>'})`,
    );
  }
  const first = choices[0];
  if (!isPlainObject(first)) {
    throw new GlmOcrError('GLM-OCR response: choices[0] is not an object');
  }
  // Truncation guard. llama-server reports finish_reason='length' when
  // the model hit max_tokens / n_predict before completing. Treating
  // that as success would silently feed truncated markdown to the LLM
  // extractor — the operator never sees the discrepancy at the OCR
  // boundary, only as missing transactions downstream. Fail loud here
  // so the audit row names the page and the cap. 'stop' and (rare)
  // 'eos' / 'tool_calls' are fine; anything else is suspect but we
  // pass it through with the diagnostic for forensics.
  const finishReason = (first as Record<string, unknown>).finish_reason;
  if (finishReason === 'length') {
    throw new GlmOcrError(
      `GLM-OCR response truncated by output-token cap on page ${pageIndex + 1} ` +
        `(finish_reason='length'). Raise --n-predict / max_tokens on the OCR ` +
        `server, or shrink page DPI so each image needs fewer output tokens.`,
    );
  }
  const message = (first as Record<string, unknown>).message;
  if (!isPlainObject(message)) {
    throw new GlmOcrError('GLM-OCR response: choices[0].message is missing');
  }
  const rawContent = (message as Record<string, unknown>).content;
  // llama-server returns a string. Some OpenAI variants stream an array
  // of content parts — handle both defensively by joining string-typed
  // parts.
  let text: string;
  let textFieldUsed: OcrParseDiagnostic['textFieldUsed'];
  if (typeof rawContent === 'string') {
    text = rawContent;
    textFieldUsed = 'content';
  } else if (Array.isArray(rawContent)) {
    text = rawContent
      .map((p) =>
        typeof p === 'string' ? p : isPlainObject(p) && typeof p.text === 'string' ? p.text : '',
      )
      .join('');
    textFieldUsed = text.length > 0 ? 'content' : 'none';
  } else {
    text = '';
    textFieldUsed = 'none';
  }
  const empty = text.length === 0;
  return {
    result: {
      index: pageIndex,
      markdown: text,
      confidence: empty ? 0 : defaultConfidence,
    },
    diagnostic: {
      pageIndex,
      variant: 'openai-chat',
      textFieldUsed,
      confidenceSource: 'assumed-default',
      emptyText: empty,
      bodyTopLevelKeys: keys,
    },
  };
};

// Build the OpenAI vision request body for a single page image. Pulled
// out so the test can assert on the exact shape we put on the wire
// without re-running the full retry/cache stack.
export const buildOpenAiOcrRequestBody = (
  image: Buffer,
  cfg: { model: string; prompt: string },
): Record<string, unknown> => ({
  model: cfg.model,
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${image.toString('base64')}` },
        },
        { type: 'text', text: cfg.prompt },
      ],
    },
  ],
  // llama-server's GLM-OCR sample uses 0.02; matches the entrypoint
  // default in vibe-glm-ocr. Locks the model to near-greedy decoding,
  // which is what you want for OCR.
  temperature: 0.02,
});

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
        textFieldUsed: 'content',
        confidenceSource: 'assumed-default',
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

  const url = `${cfg.baseUrl}${cfg.ocrPath}`;
  const requestBody = buildOpenAiOcrRequestBody(image, { model: cfg.model, prompt: cfg.prompt });
  let lastErr: unknown;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
      const res = await cfg.fetcher(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new GlmOcrError(`GLM-OCR POST ${url} → HTTP ${res.status}`, res.status, url);
      }
      const body = (await res.json()) as unknown;
      const { result: normalized, diagnostic } = parseOpenAiChatResponse(
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
  // Translate a final DOMException("This operation was aborted") into a
  // GlmOcrError that names the URL, the timeout, and the page — without
  // this, the worker only sees `errorClass: 'DOMException'` and has to
  // guess which call timed out. The original is attached as `.cause`
  // so the underlying stack is still recoverable.
  if (
    lastErr instanceof Error &&
    (lastErr.name === 'AbortError' || lastErr.name === 'TimeoutError')
  ) {
    const wrapped = new GlmOcrError(
      `GLM-OCR POST ${url} timed out after ${cfg.timeoutMs} ms (page ${pageIndex + 1}, ${cfg.maxAttempts} attempt${cfg.maxAttempts === 1 ? '' : 's'} exhausted)`,
      undefined,
      url,
    );
    (wrapped as Error & { cause?: unknown }).cause = lastErr;
    throw wrapped;
  }
  throw lastErr instanceof Error
    ? lastErr
    : new GlmOcrError(
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

// Phase 11 #6: cache the GLM-OCR engine version with a 5-min TTL so
// every batch doesn't refetch /version. Cleared on engine restart by
// the operator running ocr-test.ts.
let cachedEngineVersion: { value: string; expiresAt: number } | null = null;
const ENGINE_VERSION_TTL_MS = 5 * 60_000;

// Test-only escape hatch — drops the engine-version cache so each test
// sees a fresh probe. Equivalent to a process restart.
export const resetEngineVersionCache = (): void => {
  cachedEngineVersion = null;
};

export const probeGlmOcrVersion = async (opts: GlmOcrClientOptions = {}): Promise<string> => {
  if (cachedEngineVersion && cachedEngineVersion.expiresAt > Date.now()) {
    return cachedEngineVersion.value;
  }
  try {
    const cfg = resolveConfig(opts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const headers: Record<string, string> = {};
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
      const res = await cfg.fetcher(`${cfg.baseUrl}${cfg.versionPath}`, {
        headers,
        signal: controller.signal,
      });
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
      const headers: Record<string, string> = {};
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
      const res = await cfg.fetcher(`${cfg.baseUrl}${cfg.healthPath}`, {
        headers,
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
