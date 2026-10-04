import { mkdtemp, readFile, readdir, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkFreeSpace, isPdfMagicBytes, sha256Of, storePdf } from './upload-storage.js';

// statfs is wrapped (real by default) so the free-space thresholds can be
// driven without filling a disk.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});

const FAKE_PDF = Buffer.concat([Buffer.from('%PDF-1.4\n', 'utf8'), Buffer.alloc(64, 0)]);

// statfs result with `freeMb` MiB available.
const statfsWithFreeMb = (freeMb: number) =>
  ({ bavail: freeMb, bsize: 1024 * 1024 }) as unknown as Awaited<ReturnType<typeof statfs>>;

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

  it('storePdf survives concurrent stores of the same PDF and leaves no temp files', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => storePdf(FAKE_PDF)));
    expect(new Set(results.map((r) => r.path)).size).toBe(1);
    const path = results[0]!.path;
    expect((await readFile(path)).equals(FAKE_PDF)).toBe(true);
    expect((await readdir(dirname(path))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('storePdf rejects non-PDF input', async () => {
    await expect(storePdf(Buffer.from('not a pdf'))).rejects.toThrow();
  });

  it('checkFreeSpace refuses below 500 MB and warns below 2 GB', async () => {
    vi.mocked(statfs).mockResolvedValueOnce(statfsWithFreeMb(499));
    expect(await checkFreeSpace()).toEqual({ freeMb: 499, warn: true, refuse: true });

    vi.mocked(statfs).mockResolvedValueOnce(statfsWithFreeMb(500));
    expect(await checkFreeSpace()).toEqual({ freeMb: 500, warn: true, refuse: false });

    vi.mocked(statfs).mockResolvedValueOnce(statfsWithFreeMb(4096));
    expect(await checkFreeSpace()).toEqual({ freeMb: 4096, warn: false, refuse: false });
  });

  it('checkFreeSpace fails open when the probe itself errors', async () => {
    vi.mocked(statfs).mockRejectedValueOnce(new Error('ENOSYS'));
    expect(await checkFreeSpace()).toEqual({ freeMb: -1, warn: false, refuse: false });
  });
});
