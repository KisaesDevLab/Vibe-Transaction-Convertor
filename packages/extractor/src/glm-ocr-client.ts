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
//   GET {GLM_OCR_URL}/health
//     200 OK if alive
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

export interface GlmOcrClientOptions {
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  concurrency?: number | undefined;
  maxAttempts?: number | undefined;
  fetcher?: typeof fetch | undefined;
}

export class GlmOcrError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GlmOcrError';
    this.status = status;
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
}

const resolveConfig = (opts: GlmOcrClientOptions = {}): InternalConfig => {
  const baseUrl = (opts.baseUrl ?? process.env.GLM_OCR_URL ?? '').replace(/\/$/, '');
  if (!baseUrl) throw new GlmOcrError('GLM_OCR_URL is not set');
  return {
    baseUrl,
    timeoutMs: opts.timeoutMs ?? Number(process.env.GLM_OCR_TIMEOUT_MS ?? 60_000),
    concurrency: opts.concurrency ?? Number(process.env.GLM_OCR_CONCURRENCY ?? 2),
    maxAttempts: opts.maxAttempts ?? 3,
    fetcher: opts.fetcher ?? fetch,
  };
};

// Simple in-memory cache keyed on image-hash. Phase 26 swaps this for a
// system_settings-backed durable cache when the operator enables it.
const cache = new Map<string, OcrPageResult>();

export const clearOcrCache = (): void => cache.clear();

const ocrPage = async (
  cfg: InternalConfig,
  image: Buffer,
  pageIndex: number,
): Promise<{ result: OcrPageResult; cached: boolean }> => {
  const key = hashImage(image);
  const hit = cache.get(key);
  if (hit) return { result: { ...hit, index: pageIndex }, cached: true };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await cfg.fetcher(`${cfg.baseUrl}/ocr`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pages: [{ image_base64: image.toString('base64') }] }),
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status >= 500 && attempt < cfg.maxAttempts) {
          throw new GlmOcrError(`HTTP ${res.status}`, res.status);
        }
        throw new GlmOcrError(`HTTP ${res.status}`, res.status);
      }
      const body = (await res.json()) as { pages?: OcrPageResult[] };
      const page = body.pages?.[0];
      if (!page) throw new GlmOcrError('OCR response missing page');
      const normalized: OcrPageResult = {
        index: pageIndex,
        markdown: page.markdown,
        confidence: page.confidence,
      };
      cache.set(key, normalized);
      return { result: normalized, cached: false };
    } catch (err) {
      lastErr = err;
      if (attempt < cfg.maxAttempts) {
        const backoffMs = 200 * 2 ** (attempt - 1);
        await sleep(backoffMs);
      }
    } finally {
      clearTimeout(timer);
    }
  }
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

export const ocrPdfPages = async (
  images: Buffer[],
  opts: GlmOcrClientOptions = {},
): Promise<OcrResponse> => {
  const cfg = resolveConfig(opts);
  const pages = await runWithConcurrency(images, cfg.concurrency, async (img, i) => {
    const { result } = await ocrPage(cfg, img, i);
    return result;
  });
  // engine_version isn't available per-page; fetched from /health on first
  // call via a second probe in production. Placeholder for the contract.
  return { pages, engineVersion: 'glm-ocr/unknown' };
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
