// Page-image batching for local Ollama Qwen-VL vision extraction (ADR-023).
//
// A multi-page statement is not sent in one /api/chat call: a large base64
// payload + the schema would strain the model's context window and memory.
// So we pack pages into small batches (≤ maxPagesPerBatch and ≤ maxBatchBytes,
// measured as the base64 size that actually lands in the JSON body), extract
// each batch, then merge (see merge-extraction.ts). The default is 1–3 pages
// per call, which keeps each request comfortably within Qwen-VL's context.

export interface BatchImage {
  data: Buffer;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

export interface ImageBatch {
  images: BatchImage[];
  // 1-based global page number of images[0]. The model numbers the images
  // it sees 1..k within the batch, so merge offsets each row's source_page
  // by (startPage - 1) to recover the global page.
  startPage: number;
}

export interface BatchPagesOptions {
  // Hard page cap per call. Default 3 (keeps each vision call's prompt +
  // image payload bounded for memory + context window).
  maxPagesPerBatch?: number;
  // base64-size budget per call. Default from VIBETC_OCR_IMAGE_BATCH_BYTES
  // or DEFAULT_MAX_BATCH_BYTES — keeps each /api/chat request modest so a
  // batch fits comfortably in the model's context window.
  maxBatchBytes?: number;
}

// Conservative default: ~750 KB of base64 per batch, leaving headroom for the
// schema + system + text prompt in the same request. Operators can raise it.
export const DEFAULT_MAX_BATCH_BYTES = 750_000;

// base64 inflates bytes by 4/3 (plus padding) — this is what counts against
// the JSON body cap, not the raw image size.
const base64Size = (rawBytes: number): number => Math.ceil(rawBytes / 3) * 4;

const resolveMaxBytes = (opt?: number): number => {
  if (opt && opt > 0) return opt;
  const fromEnv = Number(process.env.VIBETC_OCR_IMAGE_BATCH_BYTES);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_MAX_BATCH_BYTES;
};

// Greedily pack ordered pages into batches. A page is added to the current
// batch unless doing so would exceed the page cap or the byte budget, in
// which case it starts a new batch. A single page larger than the byte
// budget still goes in its own batch (we cannot split one page) — keep page
// images small enough upstream (rasterize to JPEG at a modest DPI).
export const batchPageImages = (
  pages: BatchImage[],
  opts: BatchPagesOptions = {},
): ImageBatch[] => {
  const maxPages = Math.max(1, Math.floor(opts.maxPagesPerBatch ?? 3));
  const maxBytes = resolveMaxBytes(opts.maxBatchBytes);

  const batches: ImageBatch[] = [];
  let current: BatchImage[] = [];
  let currentBytes = 0;
  let startPage = 1;

  pages.forEach((page, i) => {
    const pageBytes = base64Size(page.data.length);
    const exceedsBytes = current.length > 0 && currentBytes + pageBytes > maxBytes;
    const exceedsPages = current.length >= maxPages;
    if (current.length > 0 && (exceedsBytes || exceedsPages)) {
      batches.push({ images: current, startPage });
      current = [];
      currentBytes = 0;
      startPage = i + 1;
    }
    current.push(page);
    currentBytes += pageBytes;
  });
  if (current.length > 0) batches.push({ images: current, startPage });
  return batches;
};
