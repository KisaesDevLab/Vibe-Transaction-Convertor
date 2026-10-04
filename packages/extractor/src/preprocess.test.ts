import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  analyzePdfFromBuffer,
  cleanupRasterTmp,
  extractTextLayerFromBuffer,
  rasterizePdf,
  removeRasterDir,
  routePdf,
  tmpDirForHash,
  ensureTmpDirForHash,
} from './preprocess.js';

// Real-render tests need poppler's pdftoppm; skip them where it isn't installed.
const hasPdftoppm = !spawnSync('pdftoppm', ['-v']).error;

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
  let dataDir: string;
  const originalDataDir = process.env.DATA_DIR;
  beforeAll(async () => {
    // Renders land under DATA_DIR/tmp — point it at a throwaway dir.
    dataDir = await mkdtemp(join(tmpdir(), 'vibetc-raster-'));
    process.env.DATA_DIR = dataDir;
  });
  afterAll(async () => {
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir;
    else delete process.env.DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('errors helpfully when pdftoppm is missing from PATH (and leaves no temp dir)', async () => {
    // Force ENOENT by pointing PATH at empty.
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      await expect(rasterizePdf(join(dataDir, 'anywhere.pdf'))).rejects.toThrow(
        /pdftoppm not found/,
      );
    } finally {
      process.env.PATH = originalPath;
    }
    expect(await readdir(join(dataDir, 'tmp'))).toEqual([]);
  });

  it.skipIf(!hasPdftoppm)(
    'renders into a private DATA_DIR/tmp dir (never beside the upload) that removeRasterDir deletes',
    async () => {
      const uploadDir = join(dataDir, 'uploads', '2026', '10');
      await mkdir(uploadDir, { recursive: true });
      const pdfPath = join(uploadDir, 'abc123.pdf');
      await writeFile(pdfPath, await buildDigitalPdf([['page one'], ['page two']]));

      const a = await rasterizePdf(pdfPath, { dpi: 20 });
      const b = await rasterizePdf(pdfPath, { dpi: 20 }); // concurrent-style second run
      expect(a).toHaveLength(2);
      const dirA = dirname(a[0]!.path);
      const dirB = dirname(b[0]!.path);
      expect(dirname(dirA)).toBe(join(dataDir, 'tmp'));
      expect(dirA).not.toBe(dirB); // runs never share (or rm) each other's output
      expect(existsSync(join(uploadDir, 'pages'))).toBe(false); // nothing under uploads
      expect(existsSync(a[1]!.path)).toBe(true); // a's pages survived b's run

      await removeRasterDir(a);
      expect(existsSync(dirA)).toBe(false);
      expect(existsSync(dirB)).toBe(true);
      await removeRasterDir(b);
      expect(existsSync(dirB)).toBe(false);
    },
  );

  it.skipIf(!hasPdftoppm)('kills a pdftoppm run that exceeds PDFTOPPM_TIMEOUT_MS', async () => {
    const pdfPath = join(dataDir, 'slow.pdf');
    await writeFile(
      pdfPath,
      await buildDigitalPdf(Array.from({ length: 20 }, (_, i) => [`page ${i + 1}`])),
    );
    const prev = process.env.PDFTOPPM_TIMEOUT_MS;
    process.env.PDFTOPPM_TIMEOUT_MS = '1';
    try {
      await expect(rasterizePdf(pdfPath, { dpi: 150 })).rejects.toThrow(
        /pdftoppm timed out after 1 ms/,
      );
    } finally {
      if (prev === undefined) delete process.env.PDFTOPPM_TIMEOUT_MS;
      else process.env.PDFTOPPM_TIMEOUT_MS = prev;
    }
  });
});

describe('removeRasterDir', () => {
  it('is a no-op for an empty page list', async () => {
    await expect(removeRasterDir([])).resolves.toBeUndefined();
  });

  it('never deletes a directory rasterizePdf did not create (no ownership marker)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'not-a-raster-dir-'));
    try {
      await writeFile(join(dir, 'page-1.png'), 'x');
      await removeRasterDir([{ path: join(dir, 'page-1.png') }]);
      expect(existsSync(join(dir, 'page-1.png'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('swallows errors for a path that no longer exists', async () => {
    await expect(
      removeRasterDir([{ path: join(tmpdir(), 'vibetc-gone', 'page-1.png') }]),
    ).resolves.toBeUndefined();
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
