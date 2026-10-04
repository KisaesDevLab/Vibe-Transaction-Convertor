import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// Hard ceiling on one pdftoppm run. BullMQ keeps renewing the job lock, so a
// pathological PDF could otherwise render for hours and block the worker.
// PDFTOPPM_TIMEOUT_MS overrides (default 10 min — generous for 300 DPI scans).
const DEFAULT_PDFTOPPM_TIMEOUT_MS = 600_000;
const pdftoppmTimeoutMs = (): number => {
  const n = Number(process.env.PDFTOPPM_TIMEOUT_MS ?? DEFAULT_PDFTOPPM_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PDFTOPPM_TIMEOUT_MS;
};

// pdfjs-dist's legacy build is the right one for Node — no DOM, no
// canvas required for text-only paths.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  TextItem,
  TextMarkedContent,
} from 'pdfjs-dist/types/src/display/api';

export interface PageAnalysis {
  index: number;
  hasText: boolean;
  charCount: number;
}

export interface PdfAnalysis {
  pageCount: number;
  hasTextLayer: boolean;
  textLayerCoverage: number; // share of pages with text
  avgCharsPerPage: number;
  suspectedScan: boolean;
  pages: PageAnalysis[];
}

export type ExtractionMethod = 'text' | 'ocr' | 'hybrid';

const TEXT_LAYER_PAGE_THRESHOLD = 0.5;
const TEXT_AVG_CHAR_THRESHOLD = 100;
const PER_PAGE_HAS_TEXT_THRESHOLD = 30;

const loadPdfFromBuffer = async (buffer: Uint8Array): Promise<PDFDocumentProxy> => {
  const task = getDocument({
    data: buffer,
    isEvalSupported: false,
    useSystemFonts: false,
  });
  return task.promise;
};

const loadPdfFromPath = async (path: string): Promise<PDFDocumentProxy> => {
  const file = await readFile(path);
  return loadPdfFromBuffer(new Uint8Array(file.buffer, file.byteOffset, file.byteLength));
};

export const analyzePdfFromPath = async (path: string): Promise<PdfAnalysis> => {
  const doc = await loadPdfFromPath(path);
  return analyzeLoaded(doc);
};

export const analyzePdfFromBuffer = async (buffer: Buffer): Promise<PdfAnalysis> => {
  const doc = await loadPdfFromBuffer(
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  );
  return analyzeLoaded(doc);
};

const isTextItem = (item: TextItem | TextMarkedContent): item is TextItem =>
  (item as TextItem).str !== undefined;

const analyzeLoaded = async (doc: PDFDocumentProxy): Promise<PdfAnalysis> => {
  const pageCount = doc.numPages;
  const pages: PageAnalysis[] = [];
  let totalChars = 0;
  let pagesWithText = 0;

  for (let i = 1; i <= pageCount; i += 1) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    let charCount = 0;
    for (const item of textContent.items) {
      if (isTextItem(item)) charCount += item.str.length;
    }
    const hasText = charCount >= PER_PAGE_HAS_TEXT_THRESHOLD;
    if (hasText) pagesWithText += 1;
    totalChars += charCount;
    pages.push({ index: i - 1, hasText, charCount });
    page.cleanup();
  }

  await doc.destroy();

  const textLayerCoverage = pageCount === 0 ? 0 : pagesWithText / pageCount;
  const avgCharsPerPage = pageCount === 0 ? 0 : totalChars / pageCount;
  const hasTextLayer =
    textLayerCoverage > TEXT_LAYER_PAGE_THRESHOLD && avgCharsPerPage > TEXT_AVG_CHAR_THRESHOLD;
  const suspectedScan = !hasTextLayer && pageCount > 0;

  return { pageCount, hasTextLayer, textLayerCoverage, avgCharsPerPage, suspectedScan, pages };
};

export const routePdf = (analysis: PdfAnalysis): ExtractionMethod => {
  // Phase 10 #18: VIBETC_FORCE_OCR=true forces the OCR path even when a
  // text layer is present. Useful when a text-layer PDF has corrupt or
  // garbled glyph mappings (some bank PDFs do this) and OCR would
  // produce a cleaner extraction.
  if (process.env.VIBETC_FORCE_OCR === 'true') return 'ocr';
  if (analysis.pageCount === 0) return 'ocr';
  if (analysis.hasTextLayer && analysis.pages.every((p) => p.hasText)) return 'text';
  if (analysis.textLayerCoverage === 0) return 'ocr';
  return 'hybrid';
};

export interface PageWord {
  text: string;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] in PDF user space
}

export interface PageText {
  index: number;
  text: string;
  width: number;
  height: number;
  words: PageWord[];
}

const extractFromLoaded = async (doc: PDFDocumentProxy): Promise<PageText[]> => {
  const out: PageText[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page: PDFPageProxy = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const words: PageWord[] = [];
    const parts: string[] = [];
    for (const item of tc.items) {
      if (!isTextItem(item)) continue;
      const t = item as TextItem;
      const text = t.str;
      if (text.length === 0) continue;
      const tx = t.transform;
      const x = tx[4] ?? 0;
      const y = tx[5] ?? 0;
      const width = t.width ?? 0;
      const height = t.height ?? 0;
      words.push({ text, bbox: [x, y, x + width, y + height] });
      parts.push(text);
      if ((t as { hasEOL?: boolean }).hasEOL) parts.push('\n');
      else parts.push(' ');
    }
    out.push({
      index: i - 1,
      text: parts
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .trim(),
      width: viewport.width,
      height: viewport.height,
      words,
    });
    page.cleanup();
  }
  await doc.destroy();
  return out;
};

export const extractTextLayer = async (path: string): Promise<PageText[]> => {
  const doc = await loadPdfFromPath(path);
  return extractFromLoaded(doc);
};

export const extractTextLayerFromBuffer = async (buffer: Buffer): Promise<PageText[]> => {
  const doc = await loadPdfFromBuffer(
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  );
  return extractFromLoaded(doc);
};

// ---- Rasterization ----------------------------------------------------------

export interface RasterizeOptions {
  dpi?: number;
  // Render into this directory instead of a fresh private DATA_DIR/tmp dir. It
  // is WIPED first and owned by rasterizePdf (removeRasterDir deletes it).
  outDir?: string;
  // Output codec. JPEG is dramatically smaller than PNG for scanned pages,
  // which matters for vision extraction through Shield: the gateway's
  // MAX_REQUEST_BYTES caps the JSON body and base64 PNG pages blow past it.
  // Default stays 'png' for back-compat; the vision path passes 'jpeg'.
  format?: 'png' | 'jpeg';
  // JPEG quality 1–100 (pdftoppm -jpegopt quality=N). Default 80 — a good
  // legibility/size trade for statement text. Ignored for PNG.
  jpegQuality?: number;
  // Restrict to a page range (pdftoppm -f / -l, 1-based). Used by the
  // statement-model header-crop, which only needs page 1.
  firstPage?: number;
  lastPage?: number;
  // Crop the rendered page to the top N pixels (pdftoppm -H). The header-crop
  // renders just the top band of page 1 so the OCR reads the bank/account/
  // period/balance prose without the dense transaction table beneath it.
  cropHeightPx?: number;
}

export interface RasterizedPage {
  index: number;
  // Path to the rasterized image. `pngPath` is retained as a back-compat
  // alias (equal to `path`) even when the codec is JPEG.
  path: string;
  pngPath: string;
  mediaType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

// DATA_DIR/tmp — scratch space swept by the maintenance worker (entries older
// than 6 h are removed).
const tmpRoot = (): string => join(process.env.DATA_DIR ?? './data', 'tmp');

// Written into every directory rasterizePdf renders into. removeRasterDir only
// ever deletes a directory carrying it, so a stray/mocked page path can never
// turn into an rm -rf of an unrelated parent directory.
const RASTER_DIR_MARKER = '.vibetc-raster';

// Shells out to `pdftoppm` from poppler-utils. The standalone Dockerfile
// installs poppler; on host machines the operator needs `brew install
// poppler` (or apt/choco equivalent). One invocation produces one PNG per
// page named `<prefix>-NNNN.png` at the given DPI.
//
// Output location: by default a FRESH private directory per call under
// DATA_DIR/tmp (never the uploads tree) — rendered pages (check images,
// signatures, account numbers) must not outlive Delete-PDF or the retention
// sweep, and two concurrent runs on the same PDF must not share (and rm) each
// other's output. Callers delete it with removeRasterDir(pages) once the images
// are consumed; anything a crashed run leaves behind is swept after 6 h.
export const rasterizePdf = async (
  path: string,
  opts: RasterizeOptions = {},
): Promise<RasterizedPage[]> => {
  const dpi = opts.dpi ?? 300;
  const format = opts.format ?? 'png';
  const jpegQuality = Math.min(100, Math.max(1, Math.floor(opts.jpegQuality ?? 80)));
  const pdfBase = basename(path, '.pdf');
  const ownsDir = !opts.outDir;
  let outDir: string;
  if (opts.outDir) {
    outDir = opts.outDir;
    // Caller-chosen dir: wipe any leftovers from an aborted prior run before
    // glob-matching the fresh output.
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
  } else {
    await mkdir(tmpRoot(), { recursive: true });
    outDir = await mkdtemp(join(tmpRoot(), `raster-${pdfBase.slice(0, 16)}-`));
  }
  await writeFile(join(outDir, RASTER_DIR_MARKER), '');
  const prefix = join(outDir, 'page');
  const codecArgs = format === 'jpeg' ? ['-jpeg', '-jpegopt', `quality=${jpegQuality}`] : ['-png'];
  const rangeArgs = [
    ...(opts.firstPage ? ['-f', String(opts.firstPage)] : []),
    ...(opts.lastPage ? ['-l', String(opts.lastPage)] : []),
    ...(opts.cropHeightPx && opts.cropHeightPx > 0
      ? ['-H', String(Math.floor(opts.cropHeightPx))]
      : []),
  ];
  const timeoutMs = pdftoppmTimeoutMs();
  try {
    await execFileP('pdftoppm', [...codecArgs, ...rangeArgs, '-r', String(dpi), path, prefix], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
  } catch (err) {
    // A failed run hands the caller no pages to clean up — drop our temp dir.
    if (ownsDir) await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    const e = err as { code?: string | number | null; message?: string; killed?: boolean };
    if (e.code === 'ENOENT') {
      throw new Error(
        'pdftoppm not found on PATH — install poppler-utils to enable PDF rasterization. ' +
          '(brew install poppler / apt install poppler-utils / choco install poppler)',
      );
    }
    if (e.killed === true && e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new Error(
        `pdftoppm timed out after ${timeoutMs} ms and was killed — the PDF may be malformed ` +
          'or unusually large; split it, or raise PDFTOPPM_TIMEOUT_MS',
      );
    }
    throw new Error(`pdftoppm failed: ${e.message ?? String(err)}`);
  }
  const entries = await readdir(outDir);
  // pdftoppm writes .jpg for -jpeg, .png for -png.
  const ext = format === 'jpeg' ? '.jpg' : '.png';
  const mediaType = format === 'jpeg' ? ('image/jpeg' as const) : ('image/png' as const);
  const pageFiles = entries.filter((f) => f.startsWith('page-') && f.endsWith(ext)).sort();
  if (pageFiles.length === 0 && ownsDir) {
    await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return pageFiles.map((file, i) => {
    const filePath = join(outDir, file);
    return {
      index: i,
      path: filePath,
      pngPath: filePath,
      mediaType,
      width: 0,
      height: 0,
    };
  });
};

// ---- Cleanup ----------------------------------------------------------------

// Delete the directory a rasterizePdf() call rendered into (pass the pages it
// returned, or any subset). Rendered pages carry check images / account
// numbers, so callers remove them as soon as they've been read. Best-effort:
// a no-op for an empty list or a directory rasterizePdf didn't create (no
// ownership marker), and errors are swallowed — the maintenance sweep reclaims
// DATA_DIR/tmp leftovers after 6 h.
export const removeRasterDir = async (
  pages: ReadonlyArray<Pick<RasterizedPage, 'path'>>,
): Promise<void> => {
  const first = pages[0];
  if (!first) return;
  const dir = dirname(first.path);
  try {
    await access(join(dir, RASTER_DIR_MARKER));
    await rm(dir, { recursive: true, force: true });
  } catch {
    // not ours / already gone — nothing to do
  }
};

export const tmpDirForHash = (hash: string): string => join(tmpRoot(), hash);

export const ensureTmpDirForHash = async (hash: string): Promise<string> => {
  const dir = tmpDirForHash(hash);
  await mkdir(dir, { recursive: true });
  return dir;
};

export const cleanupRasterTmp = async (hash: string): Promise<void> => {
  const dir = tmpDirForHash(hash);
  await rm(dir, { recursive: true, force: true });
};

// Dump a buffer to a per-hash tmp path; useful for tests and Phase 11.
export const tmpPdfPath = (hash: string): string => join(tmpRoot(), `${hash}.pdf`);

export { dirname };
