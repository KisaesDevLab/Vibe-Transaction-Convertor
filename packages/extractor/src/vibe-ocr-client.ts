// VibeOCR HTTP client (ADR-026).
//
// VibeOCR is the on-appliance, PDF-native OCR service (default port 8099). It
// accepts a PDF or image as a multipart upload, rasterizes + OCRs each page
// server-side (it fronts the GLM-OCR VLM), and returns per-page markdown via an
// async job API. The app sends the whole PDF once instead of rasterizing and
// calling the VLM per page, so the OCR stage is one upload → poll → result.
//
//   POST   {VIBE_OCR_URL}/ocr                 — multipart form, field `file`;
//                                                header `x-api-key` (any value)
//          → { job_id, status: "queued" }
//   GET    {VIBE_OCR_URL}/ocr/{job_id}         → { status: queued|processing|
//                                                  completed|failed, … }
//   GET    {VIBE_OCR_URL}/ocr/{job_id}/result  → { total_pages, processed_pages,
//                                                  pages: [{ page_num, markdown }] }
//   GET    {VIBE_OCR_URL}/healthz              → { service, vlm_backend, … }
//
// Page images are processed on-appliance and never egress (ADR-023/026). On any
// failure the worker falls back to the direct GLM-OCR per-page path.

export interface VibeOcrPage {
  pageNum: number; // 1-based
  markdown: string;
}

export interface VibeOcrResult {
  pages: VibeOcrPage[];
  totalPages: number;
}

export interface VibeOcrClientOptions {
  baseUrl?: string | undefined; // VIBE_OCR_URL; may include or omit a trailing /v1
  apiKey?: string | undefined; // x-api-key header; the service accepts any value
  // Overall budget for the whole job (submit + poll + result). A multi-page
  // scan legitimately takes minutes on a slow OCR backend.
  timeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  // Per-HTTP-request timeout (submit/poll/result) — guards a hung socket
  // without ending the whole job.
  requestTimeoutMs?: number | undefined;
  fetcher?: typeof fetch | undefined;
}

export class VibeOcrError extends Error {
  readonly status: number | undefined;
  readonly url: string | undefined;
  constructor(message: string, status?: number, url?: string) {
    super(message);
    this.name = 'VibeOcrError';
    this.status = status;
    this.url = url;
  }
}

interface InternalConfig {
  baseUrl: string;
  apiKey: string | null;
  timeoutMs: number;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  fetcher: typeof fetch;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const resolveConfig = (opts: VibeOcrClientOptions = {}): InternalConfig => {
  const baseUrl = (opts.baseUrl ?? process.env.VIBE_OCR_URL ?? '')
    // Tolerate an operator pasting the /v1 form; the job API lives at the root.
    .replace(/\/v1\/?$/, '')
    .replace(/\/$/, '');
  const apiKey = ((): string | null => {
    const raw = opts.apiKey ?? process.env.VIBE_OCR_API_KEY ?? '';
    return raw.length > 0 ? raw : null;
  })();
  return {
    baseUrl,
    apiKey,
    timeoutMs: opts.timeoutMs ?? Number(process.env.VIBE_OCR_TIMEOUT_MS ?? 300_000),
    pollIntervalMs: opts.pollIntervalMs ?? 1_500,
    requestTimeoutMs: opts.requestTimeoutMs ?? 30_000,
    fetcher: opts.fetcher ?? fetch,
  };
};

const authHeaders = (cfg: InternalConfig): Record<string, string> =>
  cfg.apiKey ? { 'x-api-key': cfg.apiKey } : {};

// fetch with a per-request abort timeout; translates an abort into a labelled
// VibeOcrError so the worker's audit trail names the call that hung.
const fetchWithTimeout = async (
  cfg: InternalConfig,
  url: string,
  init: RequestInit,
): Promise<Response> => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), cfg.requestTimeoutMs);
  try {
    return await cfg.fetcher(url, { ...init, signal: ctl.signal });
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new VibeOcrError(
        `VibeOCR ${url} timed out after ${cfg.requestTimeoutMs} ms`,
        undefined,
        url,
      );
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
};

export const probeVibeOcrHealth = async (
  opts: VibeOcrClientOptions = {},
): Promise<{ ok: boolean; detail?: string }> => {
  const cfg = resolveConfig(opts);
  if (!cfg.baseUrl) return { ok: false, detail: 'VIBE_OCR_URL not set' };
  try {
    const res = await fetchWithTimeout(cfg, `${cfg.baseUrl}/healthz`, {
      headers: authHeaders(cfg),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as {
      service?: string;
      vlm_backend?: string;
    };
    // Surface a degraded VLM backend even when the front service is up.
    if (body.vlm_backend && body.vlm_backend !== 'ok') {
      return { ok: false, detail: `vlm_backend=${body.vlm_backend}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
};

const TERMINAL_OK = new Set(['completed', 'done', 'succeeded']);
const TERMINAL_FAIL = new Set(['failed', 'error', 'cancelled', 'canceled']);

// Submit a PDF or image and return per-page markdown. Throws VibeOcrError on
// any failure (unreachable, bad key, job failure, timeout) so the worker can
// fall back to the GLM-OCR per-page path.
export const vibeOcrFile = async (
  file: Buffer,
  filename: string,
  mediaType: string,
  opts: VibeOcrClientOptions = {},
): Promise<VibeOcrResult> => {
  const cfg = resolveConfig(opts);
  if (!cfg.baseUrl) throw new VibeOcrError('VIBE_OCR_URL is not set');

  // 1) Submit.
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file)], { type: mediaType }), filename);
  const submitUrl = `${cfg.baseUrl}/ocr`;
  const sub = await fetchWithTimeout(cfg, submitUrl, {
    method: 'POST',
    headers: authHeaders(cfg),
    body: form,
  });
  if (!sub.ok) {
    const detail = await sub.text().catch(() => '');
    throw new VibeOcrError(
      `VibeOCR POST ${submitUrl} → HTTP ${sub.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      sub.status,
      submitUrl,
    );
  }
  const jobId = ((await sub.json()) as { job_id?: string }).job_id;
  if (!jobId) throw new VibeOcrError('VibeOCR submit returned no job_id', undefined, submitUrl);

  // 2) Poll until terminal or the overall budget is exhausted.
  const statusUrl = `${cfg.baseUrl}/ocr/${jobId}`;
  const start = Date.now();
  for (;;) {
    if (Date.now() - start > cfg.timeoutMs) {
      throw new VibeOcrError(
        `VibeOCR job ${jobId} did not finish within ${cfg.timeoutMs} ms`,
        undefined,
        statusUrl,
      );
    }
    await sleep(cfg.pollIntervalMs);
    const stRes = await fetchWithTimeout(cfg, statusUrl, { headers: authHeaders(cfg) });
    if (!stRes.ok) {
      throw new VibeOcrError(
        `VibeOCR GET ${statusUrl} → HTTP ${stRes.status}`,
        stRes.status,
        statusUrl,
      );
    }
    const status = String(((await stRes.json()) as { status?: string }).status ?? '').toLowerCase();
    if (TERMINAL_OK.has(status)) break;
    if (TERMINAL_FAIL.has(status)) {
      throw new VibeOcrError(
        `VibeOCR job ${jobId} ended with status='${status}'`,
        undefined,
        statusUrl,
      );
    }
    // queued / processing / running → keep polling.
  }

  // 3) Fetch the per-page result.
  const resultUrl = `${cfg.baseUrl}/ocr/${jobId}/result`;
  const res = await fetchWithTimeout(cfg, resultUrl, { headers: authHeaders(cfg) });
  if (!res.ok) {
    throw new VibeOcrError(`VibeOCR GET ${resultUrl} → HTTP ${res.status}`, res.status, resultUrl);
  }
  const body = (await res.json()) as {
    total_pages?: number;
    pages?: Array<{ page_num?: number; markdown?: unknown }>;
  };
  const pages: VibeOcrPage[] = (body.pages ?? [])
    .map((p, i) => ({
      pageNum: typeof p.page_num === 'number' ? p.page_num : i + 1,
      markdown: typeof p.markdown === 'string' ? p.markdown : '',
    }))
    .sort((a, b) => a.pageNum - b.pageNum);
  if (pages.length === 0) {
    throw new VibeOcrError(`VibeOCR job ${jobId} returned no pages`, undefined, resultUrl);
  }
  return { pages, totalPages: body.total_pages ?? pages.length };
};
