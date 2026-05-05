// Phase 26 #9: pg_restore CLI wrapper. Operator-only — never invoked
// from the API or browser. Run by hand on the host shell when you need
// to recover from a backup created by the admin UI.
//
// Usage: pnpm --filter @vibe-tx-converter/api db:restore <backup-filename>
//
// The filename is resolved relative to $DATA_DIR/backups so operators
// don't need to specify a full path. --no-owner ensures the dump's
// pre-restore role assignments don't leak in. --clean --if-exists
// drops existing objects so we restore into a clean schema; pair with
// pnpm db:reset:dev first if you want a brand-new database.

/* eslint-disable no-console */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const main = async (): Promise<void> => {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: db:restore <backup-filename-or-path>');
    process.exit(2);
  }
  const dataDir = process.env.DATA_DIR ?? './data';
  const candidate = arg.includes('/') || arg.includes('\\') ? arg : join(dataDir, 'backups', arg);
  const path = resolve(candidate);
  try {
    await stat(path);
  } catch {
    console.error(`backup not found: ${path}`);
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }
  console.error(`restoring from ${path} into ${url.replace(/:[^@/]*@/, ':***@')}`);
  const proc = spawn(
    'pg_restore',
    ['--no-owner', '--clean', '--if-exists', '--dbname', url, path],
    { stdio: 'inherit' },
  );
  proc.on('error', (err: Error & { code?: string }) => {
    if (err.code === 'ENOENT') {
      console.error('pg_restore not found on PATH. install postgresql-client (apt / brew / choco)');
      process.exit(2);
    }
    console.error(`pg_restore error: ${err.message}`);
    process.exit(1);
  });
  proc.on('exit', (code) => {
    process.exit(code ?? 0);
  });
};

void main();
