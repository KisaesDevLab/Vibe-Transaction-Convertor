// Page-image batching for Shield-routed vision extraction.
//
// Shield's /v1/messages imposes no image-count cap, but the gateway's
// MAX_REQUEST_BYTES (default 1 MB) bounds the JSON request body — and a
// base64 page image blows past that fast. So a multi-page statement cannot
// go in one call: we pack pages into small batches (≤ maxPagesPerBatch and
// ≤ maxBatchBytes, measured as the base64 size that actually lands in the
// body), extract each batch, then merge (see merge-extraction.ts). Shield's
// own guidance is 1–3 pages per call; Anthropic's limits (≤100 images/req,
// ≤5 MB/image) are never the binding constraint at these batch sizes.

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
  // Hard page cap per call. Default 3 (Shield guidance: 1–3 pages).
  maxPagesPerBatch?: number;
  // base64-size budget per call. Default from VIBE_SHIELD_IMAGE_BATCH_BYTES
  // or DEFAULT_MAX_BATCH_BYTES — sized to sit under the gateway's default
  // 1 MB MAX_REQUEST_BYTES with headroom for the tool schema + prompt.
  maxBatchBytes?: number;
}

// Conservative default: under the 1 MB MAX_REQUEST_BYTES default, leaving
// ~250 KB of headroom for the tool/schema + system + text prompt JSON.
// Operators who raise MAX_REQUEST_BYTES on the gateway can raise this.
export const DEFAULT_MAX_BATCH_BYTES = 750_000;

// base64 inflates bytes by 4/3 (plus padding) — this is what counts against
// the JSON body cap, not the raw image size.
const base64Size = (rawBytes: number): number => Math.ceil(rawBytes / 3) * 4;

const resolveMaxBytes = (opt?: number): number => {
  if (opt && opt > 0) return opt;
  const fromEnv = Number(process.env.VIBE_SHIELD_IMAGE_BATCH_BYTES);
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
