import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
  outDir?: string;
}

export interface RasterizedPage {
  index: number;
  pngPath: string;
  width: number;
  height: number;
}

// pdfjs-dist + node-canvas is the closest pure-JS rasterization path. The
// canonical choice in this project is pdftoppm from poppler-utils, called
// over the shell. The Phase 11 GLM-OCR client wires this up; for Phase 10
// we expose the contract and a stub so callers can be typed and tested.
//
// QUESTIONS.md Q-004 captures the open call: rasterize via shell-out to
// pdftoppm (small + fast, requires the operator install poppler) vs.
// rasterize via pdfjs + node-canvas (pure JS, heavier dep, slower).

export const rasterizePdf = async (
  _path: string,
  _opts: RasterizeOptions = {},
): Promise<RasterizedPage[]> => {
  throw new Error(
    'rasterizePdf is not implemented yet — wired up by Phase 11 (GLM-OCR client). See QUESTIONS.md Q-004.',
  );
};

// ---- Cleanup ----------------------------------------------------------------

const tmpRoot = (): string => join(process.env.DATA_DIR ?? './data', 'tmp');

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
