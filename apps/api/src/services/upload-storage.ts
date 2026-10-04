import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { logger } from '../lib/logger.js';

export interface StoreResult {
  hash: string;
  path: string;
  bytes: number;
}

export const dataDir = (): string => process.env.DATA_DIR ?? './data';

const uploadRoot = (): string => join(dataDir(), 'uploads');

const yyyyMm = (now = new Date()): { yyyy: string; mm: string } => ({
  yyyy: String(now.getUTCFullYear()),
  mm: String(now.getUTCMonth() + 1).padStart(2, '0'),
});

export const pathForHash = (hash: string, when = new Date()): string => {
  const { yyyy, mm } = yyyyMm(when);
  return join(uploadRoot(), yyyy, mm, `${hash}.pdf`);
};

export const sha256Of = (buffer: Buffer): string =>
  createHash('sha256').update(buffer).digest('hex');

export const isPdfMagicBytes = (buffer: Buffer): boolean =>
  buffer.length >= 5 && buffer.subarray(0, 5).toString('utf8') === '%PDF-';

// Phase 9 #12: uploads are refused when DATA_DIR has less than this free,
// and a warning is logged below WARN_FREE_MB.
export const MIN_FREE_MB = 500;
export const WARN_FREE_MB = 2048;

export interface FreeSpace {
  freeMb: number; // -1 when the probe itself failed
  warn: boolean;
  refuse: boolean;
}

export const checkFreeSpace = async (): Promise<FreeSpace> => {
  let freeMb: number;
  try {
    const stats = await statfs(dataDir());
    freeMb = Math.floor((Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024));
  } catch (err) {
    // A failed probe (statfs unsupported, DATA_DIR not created yet) must not
    // block every upload — fail open.
    logger.warn({ err }, 'free-space check failed');
    return { freeMb: -1, warn: false, refuse: false };
  }
  return { freeMb, warn: freeMb < WARN_FREE_MB, refuse: freeMb < MIN_FREE_MB };
};

export const storePdf = async (buffer: Buffer): Promise<StoreResult> => {
  if (!isPdfMagicBytes(buffer)) {
    throw new Error('not a PDF (magic bytes)');
  }
  const hash = sha256Of(buffer);
  const path = pathForHash(hash);
  await mkdir(dirname(path), { recursive: true });

  // No-op if already on disk (re-upload of same content).
  try {
    const s = await stat(path);
    if (s.size === buffer.length) {
      return { hash, path, bytes: buffer.length };
    }
  } catch {
    // not there yet
  }

  // Per-writer temp name: two concurrent uploads of the same PDF must not
  // share (and race to rename) one temp file. Keeps the `.tmp` suffix so
  // the maintenance sweep still reaps orphans from a crashed writer.
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, buffer);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    // A concurrent store of the same bytes may have renamed its copy into
    // place first (Windows refuses to replace a file mid-rename). The path is
    // content-addressed, so a same-size file there is this PDF.
    const existing = await stat(path).catch(() => null);
    if (existing?.size === buffer.length) return { hash, path, bytes: buffer.length };
    throw err;
  }
  return { hash, path, bytes: buffer.length };
};
