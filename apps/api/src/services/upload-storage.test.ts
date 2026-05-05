import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isPdfMagicBytes, sha256Of, storePdf } from './upload-storage.js';

const FAKE_PDF = Buffer.concat([Buffer.from('%PDF-1.4\n', 'utf8'), Buffer.alloc(64, 0)]);

describe('upload-storage', () => {
  let tmp: string;
  const originalDataDir = process.env.DATA_DIR;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'vibetc-upload-'));
    process.env.DATA_DIR = tmp;
  });

  afterEach(async () => {
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir;
    } else {
      delete process.env.DATA_DIR;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it('isPdfMagicBytes accepts valid PDFs and rejects others', () => {
    expect(isPdfMagicBytes(FAKE_PDF)).toBe(true);
    expect(isPdfMagicBytes(Buffer.from('not a pdf'))).toBe(false);
    expect(isPdfMagicBytes(Buffer.alloc(0))).toBe(false);
  });

  it('sha256Of is deterministic', () => {
    expect(sha256Of(Buffer.from('hello'))).toBe(sha256Of(Buffer.from('hello')));
  });

  it('storePdf writes by hash and dedupes a re-store', async () => {
    const a = await storePdf(FAKE_PDF);
    const b = await storePdf(FAKE_PDF);
    expect(a.hash).toBe(b.hash);
    expect(a.path).toBe(b.path);
    const onDisk = await readFile(a.path);
    expect(onDisk.equals(FAKE_PDF)).toBe(true);
  });

  it('storePdf rejects non-PDF input', async () => {
    await expect(storePdf(Buffer.from('not a pdf'))).rejects.toThrow();
  });
});
