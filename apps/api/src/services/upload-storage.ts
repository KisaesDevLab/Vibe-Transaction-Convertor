import { createHash } from 'node:crypto';
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

export const checkFreeSpace = async (): Promise<{ freeMb: number; warn: boolean }> => {
  try {
    const stats = await statfs(dataDir());
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const freeMb = Math.floor(freeBytes / (1024 * 1024));
    if (freeMb < 500) throw new Error(`Disk free below 500 MB threshold (${freeMb} MB)`);
    return { freeMb, warn: freeMb < 2048 };
  } catch (err) {
    logger.warn({ err }, 'free-space check failed');
    return { freeMb: -1, warn: false };
  }
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

  const tmp = `${path}.tmp`;
  await writeFile(tmp, buffer);
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  return { hash, path, bytes: buffer.length };
};
