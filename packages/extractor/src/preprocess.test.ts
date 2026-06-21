import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  analyzePdfFromBuffer,
  cleanupRasterTmp,
  extractTextLayerFromBuffer,
  rasterizePdf,
  routePdf,
  tmpDirForHash,
  ensureTmpDirForHash,
} from './preprocess.js';

const buildDigitalPdf = async (lines: string[][]): Promise<Buffer> => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const pageLines of lines) {
    const page = doc.addPage([612, 792]);
    let y = 720;
    for (const line of pageLines) {
      page.drawText(line, { x: 50, y, size: 11, font });
      y -= 16;
    }
  }
  return Buffer.from(await doc.save());
};

const buildEmptyPdf = async (pageCount: number): Promise<Buffer> => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
};

describe('analyzePdf + routePdf', () => {
  it('reports 2 pages with text for a digital 2-page PDF', async () => {
    const lines = [
      'STATEMENT OF ACCOUNT',
      'Period 2026-01-01 to 2026-01-31',
      'Opening balance: $1,000.00',
      '2026-01-03 ATM Withdrawal -$60.00',
      '2026-01-08 Direct Deposit +$3,200.00',
      '2026-01-12 Grocery Store -$74.21',
      '2026-01-19 Wire Transfer +$50.00',
      'Closing balance: $4,115.79',
    ];
    const pdf = await buildDigitalPdf([lines, lines]);
    const analysis = await analyzePdfFromBuffer(pdf);
    expect(analysis.pageCount).toBe(2);
    expect(analysis.pages.every((p) => p.hasText)).toBe(true);
    expect(analysis.avgCharsPerPage).toBeGreaterThan(100);
    expect(analysis.hasTextLayer).toBe(true);
    expect(analysis.suspectedScan).toBe(false);
    expect(routePdf(analysis)).toBe('text');
  });

  it('routes empty (no-text) PDF as ocr', async () => {
    const pdf = await buildEmptyPdf(2);
    const analysis = await analyzePdfFromBuffer(pdf);
    expect(analysis.pageCount).toBe(2);
    expect(analysis.hasTextLayer).toBe(false);
    expect(analysis.suspectedScan).toBe(true);
    expect(routePdf(analysis)).toBe('ocr');
  });

  it('forces ocr when VIBETC_FORCE_OCR=true even for a clean text layer', async () => {
    const lines = [
      'STATEMENT OF ACCOUNT',
      'Period 2026-01-01 to 2026-01-31',
      'Opening balance: $1,000.00',
      '2026-01-03 ATM Withdrawal -$60.00',
      '2026-01-08 Direct Deposit +$3,200.00',
      'Closing balance: $4,115.79',
    ];
    const pdf = await buildDigitalPdf([lines, lines]);
    const analysis = await analyzePdfFromBuffer(pdf);
    expect(routePdf(analysis)).toBe('text'); // baseline
    const prev = process.env.VIBETC_FORCE_OCR;
    process.env.VIBETC_FORCE_OCR = 'true';
    try {
      expect(routePdf(analysis)).toBe('ocr');
    } finally {
      if (prev === undefined) delete process.env.VIBETC_FORCE_OCR;
      else process.env.VIBETC_FORCE_OCR = prev;
    }
  });

  it('routes a zero-page analysis as ocr (degenerate PDF)', () => {
    const analysis = {
      pageCount: 0,
      hasTextLayer: false,
      textLayerCoverage: 0,
      avgCharsPerPage: 0,
      suspectedScan: false,
      pages: [],
    } as unknown as Parameters<typeof routePdf>[0];
    expect(routePdf(analysis)).toBe('ocr');
  });

  it('routes mixed-content (some pages empty, some with text) as hybrid', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // 3 pages: 1 with text, 2 empty → coverage 1/3 → not text-layer, not 0 → hybrid
    const p1 = doc.addPage([612, 792]);
    let y = 720;
    for (const line of [
      'STATEMENT OF ACCOUNT',
      'Period 2026-01-01 to 2026-01-31',
      'Opening balance: $1,000.00',
      'Closing balance: $1,500.00',
      'Several transactions listed here.',
      'More transactions listed here.',
    ]) {
      p1.drawText(line, { x: 50, y, size: 11, font });
      y -= 16;
    }
    doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    const buf = Buffer.from(await doc.save());
    const analysis = await analyzePdfFromBuffer(buf);
    expect(analysis.pageCount).toBe(3);
    expect(routePdf(analysis)).toBe('hybrid');
  });
});

describe('extractTextLayer', () => {
  it('returns per-page text and word bboxes', async () => {
    const pdf = await buildDigitalPdf([['Acme Bank Statement 2026']]);
    const pages = await extractTextLayerFromBuffer(pdf);
    expect(pages).toHaveLength(1);
    const page = pages[0]!;
    expect(page.index).toBe(0);
    expect(page.text).toContain('Acme');
    expect(page.text).toContain('Bank');
    expect(page.words.length).toBeGreaterThan(0);
    for (const w of page.words) {
      expect(w.bbox[2]).toBeGreaterThanOrEqual(w.bbox[0]);
      expect(w.bbox[3]).toBeGreaterThanOrEqual(w.bbox[1]);
    }
    expect(page.width).toBeGreaterThan(0);
    expect(page.height).toBeGreaterThan(0);
  });
});

describe('rasterizePdf', () => {
  it('errors helpfully when pdftoppm is missing from PATH', async () => {
    // Force ENOENT by pointing PATH at empty. Note: we have to give
    // rasterizePdf a path under a writable directory because it
    // mkdir's <dirname>/pages BEFORE execing pdftoppm — using a
    // non-writable parent (e.g. "/anywhere.pdf" resolving to "/pages"
    // on Linux) fails with EACCES before pdftoppm is ever called.
    const tmp = await mkdtemp(join(tmpdir(), 'rasterize-pathtest-'));
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      await expect(rasterizePdf(join(tmp, 'anywhere.pdf'))).rejects.toThrow(/pdftoppm not found/);
    } finally {
      process.env.PATH = originalPath;
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('tmp helpers', () => {
  let dataDir: string;
  const original = process.env.DATA_DIR;
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'vibetc-tmp-'));
    process.env.DATA_DIR = dataDir;
  });
  afterAll(async () => {
    if (original !== undefined) process.env.DATA_DIR = original;
    else delete process.env.DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('ensureTmpDirForHash creates the dir; cleanup removes it', async () => {
    const hash = 'abc'.repeat(20).slice(0, 60);
    const dir = await ensureTmpDirForHash(hash);
    expect(dir).toBe(tmpDirForHash(hash));
    await writeFile(join(dir, 'page-0001.png'), 'placeholder');
    await cleanupRasterTmp(hash);
  });
});
