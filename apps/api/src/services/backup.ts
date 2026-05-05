// Phase 26 #6/#7/#8/#9: backup service. Shells out to pg_dump and
// writes a single-file dump under $DATA_DIR/backups/{ISO-timestamp}.dump.
// pg_dump must be on PATH; we surface a helpful ENOENT message when not.
//
// Format choice: --format=custom (compressed, restorable via pg_restore).
// Scope: --schema=vibetc keeps the dump narrow — restoring into a fresh
// database creates exactly the schema the app expects without touching
// other Postgres state on shared instances.

import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const backupDir = (): string => join(process.env.DATA_DIR ?? './data', 'backups');

const ensureDir = async (): Promise<string> => {
  const dir = backupDir();
  await mkdir(dir, { recursive: true });
  return dir;
};

// Filenames are ISO timestamps with `:` swapped for `-` so they're
// Windows-friendly. We never accept caller-supplied filenames in the
// route — see assertSafeFilename.
const newFilename = (): string => {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  return `vibetc-${iso}.dump`;
};

// Reject path-traversal attempts and any filename that doesn't match the
// shape we generate. Routes call this before fs.stat / fs.unlink.
export const assertSafeFilename = (name: string): void => {
  if (!/^vibetc-[\w-]+\.dump$/.test(name)) {
    throw new Error(`unsafe backup filename: ${name}`);
  }
};

export interface BackupSummary {
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

export const listBackups = async (): Promise<BackupSummary[]> => {
  const dir = backupDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: BackupSummary[] = [];
  for (const f of entries) {
    if (!/^vibetc-.+\.dump$/.test(f)) continue;
    try {
      const s = await stat(join(dir, f));
      out.push({
        filename: f,
        sizeBytes: s.size,
        createdAt: s.mtime.toISOString(),
      });
    } catch {
      // ignore
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
};

export const backupFilePath = (filename: string): string => {
  assertSafeFilename(filename);
  return join(backupDir(), filename);
};

const PG_INSTALL_HINT =
  'install postgresql-client (Linux: apt install postgresql-client; macOS: brew install libpq && brew link --force libpq; Windows: choco install postgresql)';

export const createBackup = async (): Promise<BackupSummary> => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const dir = await ensureDir();
  const filename = newFilename();
  const path = join(dir, filename);
  try {
    // --no-owner: dump doesn't reference local OS users; restore is portable.
    // --schema=vibetc: only the app schema, not the entire database.
    // --format=custom: compressed binary format restorable via pg_restore.
    await execFileP(
      'pg_dump',
      ['--no-owner', '--schema=vibetc', '--format=custom', '--file', path, url],
      { maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    const e = err as { code?: string; message?: string; stderr?: Buffer | string };
    if (e.code === 'ENOENT') {
      throw new Error(`pg_dump not found on PATH — ${PG_INSTALL_HINT}`);
    }
    const detail = (
      typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf8') ?? e.message)
    )?.trim();
    throw new Error(`pg_dump failed: ${detail ?? 'unknown error'}`);
  }
  const s = await stat(path);
  return {
    filename,
    sizeBytes: s.size,
    createdAt: s.mtime.toISOString(),
  };
};

export const deleteBackup = async (filename: string): Promise<void> => {
  const path = backupFilePath(filename);
  await rm(path, { force: true });
};

// Phase 26 #21: nightly sweep of backups older than retention. Default
// 90 days; operators override via BACKUP_RETENTION_DAYS env var.
export const cleanupExpiredBackups = async (): Promise<{ removed: number }> => {
  const days = Number.parseInt(process.env.BACKUP_RETENTION_DAYS ?? '90', 10);
  if (!Number.isFinite(days) || days <= 0) return { removed: 0 };
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const dir = backupDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { removed: 0 };
  }
  let removed = 0;
  for (const f of entries) {
    if (!/^vibetc-.+\.dump$/.test(f)) continue;
    const path = join(dir, f);
    try {
      const s = await stat(path);
      if (s.mtimeMs < cutoff) {
        await rm(path, { force: true });
        removed += 1;
      }
    } catch {
      // skip
    }
  }
  return { removed };
};
