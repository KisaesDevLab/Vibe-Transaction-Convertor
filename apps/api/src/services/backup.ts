// Phase 26 #6/#7/#8/#9: backup service. Shells out to pg_dump and
// writes a single-file dump under $DATA_DIR/backups/{ISO-timestamp}.dump.
// pg_dump must be on PATH; we surface a helpful ENOENT message when not.
//
// Format choice: --format=custom (compressed, restorable via pg_restore).
// Scope: --schema=vibetc plus --schema=drizzle. vibetc is the data;
// drizzle is the migration bookkeeping, dumped alongside it so a restore
// rolls the schema version back with the rows it belongs to (see the
// RESTORE section). Keeping the dump to these two schemas means
// restoring into a fresh database touches nothing else on a shared
// Postgres instance.

import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';

import { closeDb } from '../db/client.js';
import { logger } from '../lib/logger.js';

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

// Reject path-traversal attempts and any filename that doesn't match
// the exact shape `newFilename()` emits: `vibetc-{ISO-with-:-and-.
// swapped-for--}.dump`. This is stricter than necessary for security
// (the original /[\w-]+/ already blocked `..`, `/`, and `\`), but
// means the routes only ever surface filenames they could plausibly
// have created, which simplifies reasoning.
export const assertSafeFilename = (name: string): void => {
  if (!/^vibetc-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{1,4}Z\.dump$/.test(name)) {
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
    if (!/^vibetc-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{1,4}Z\.dump$/.test(f)) continue;
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
  'in Docker, update to an image that bundles postgresql-client-16; on a dev host, install it (Linux: apt install postgresql-client-16; macOS: brew install libpq && brew link --force libpq; Windows: EDB binaries zip — the client major must be >= the Postgres 16 server)';

// Parse the DSN so we can pass --host/--port/--username/--dbname
// explicitly and put the password in PGPASSWORD env. Otherwise the
// tool's argv (visible to `ps`/Get-Process) would leak the password to
// anyone with a process listing on the host. Shared by pg_dump, psql and
// pg_restore so all three stay consistent.
export const pgConnectionArgs = (): {
  args: string[];
  env: Record<string, string | undefined>;
} => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const parsed = (() => {
    try {
      return new URL(url);
    } catch {
      throw new Error('DATABASE_URL is not a valid URL');
    }
  })();
  const args = [
    `--host=${parsed.hostname}`,
    `--port=${parsed.port || '5432'}`,
    `--dbname=${parsed.pathname.replace(/^\//, '') || 'postgres'}`,
  ];
  if (parsed.username) args.push(`--username=${decodeURIComponent(parsed.username)}`);
  const env: Record<string, string | undefined> = { ...process.env };
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
  return { args, env };
};

// Turn an execFile rejection from pg_dump/pg_restore into an operator-
// readable Error. ENOENT gets the install hint; everything else surfaces
// the tool's own stderr, which is where Postgres puts the real reason.
const pgToolError = (tool: string, err: unknown): Error => {
  const e = err as { code?: string; message?: string; stderr?: Buffer | string };
  if (e.code === 'ENOENT') {
    return new Error(`${tool} not found on PATH — ${PG_INSTALL_HINT}`);
  }
  const detail = (
    typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf8') ?? e.message)
  )?.trim();
  return new Error(`${tool} failed: ${detail || 'unknown error'}`);
};

// A schema entry in `pg_restore --list` output looks like:
//   9; 2615 16395 SCHEMA - vibetc vibetc
// i.e. `id; oid oid SCHEMA - <name> <owner>`. The ACL entry that follows
// it ("3938; 0 0 ACL - SCHEMA vibetc vibetc") deliberately does NOT
// match: we want the dump's grants replayed onto the schema we create.
const SCHEMA_TOC_LINE = /^\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+(\S+)\s/;

export const parseDumpSchemas = (tocListing: string): string[] => {
  const found = new Set<string>();
  for (const line of tocListing.split(/\r?\n/)) {
    const m = SCHEMA_TOC_LINE.exec(line);
    if (m?.[1]) found.add(m[1]);
  }
  return [...found].sort();
};

// Comment out the CREATE SCHEMA entries so the restore doesn't collide
// with the schemas its preamble just created. pg_restore treats a
// leading ';' in a --use-list file as "skip this entry".
export const filterSchemaEntries = (tocListing: string): string =>
  tocListing
    .split(/\r?\n/)
    .map((line) => (SCHEMA_TOC_LINE.test(line) ? `;${line}` : line))
    .join('\n');

// The schemas a backup captures. `vibetc` is the app's data; `drizzle`
// holds __drizzle_migrations, so restoring returns the schema version to
// the point the backup was taken and post-restore migrations can bring
// it forward cleanly.
export const BACKUP_SCHEMAS = ['vibetc', 'drizzle'] as const;

export const createBackup = async (): Promise<BackupSummary> => {
  const dir = await ensureDir();
  const filename = newFilename();
  const path = join(dir, filename);
  const { args: connArgs, env } = pgConnectionArgs();
  const args: string[] = [
    '--no-owner',
    ...BACKUP_SCHEMAS.map((s) => `--schema=${s}`),
    '--format=custom',
    '--file',
    path,
    ...connArgs,
  ];
  try {
    await execFileP('pg_dump', args, { maxBuffer: 64 * 1024 * 1024, env });
  } catch (err) {
    throw pgToolError('pg_dump', err);
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

// ---------------------------------------------------------------------
// IMPORT (upload a dump taken elsewhere)
//
// The other half of download: move a backup between installs, or seed a
// rebuilt host from a dump kept off-box. The uploaded file lands in
// $DATA_DIR/tmp and only becomes a restorable backup once we've proven
// pg_restore can read it — an unreadable dump discovered at restore time
// is a much worse place to find out.
// ---------------------------------------------------------------------

// Custom-format archives start with the literal "PGDMP". Plain-SQL
// (--format=plain) and tar dumps don't, and neither does a PDF someone
// picked by mistake, so this rejects the common wrong-file cases before
// we bother spawning pg_restore.
export const isPgCustomDump = (head: Buffer): boolean =>
  head.length >= 5 && head.subarray(0, 5).toString('latin1') === 'PGDMP';

export const uploadMaxBytes = (): number => {
  const mb = Number.parseInt(process.env.BACKUP_UPLOAD_MAX_MB ?? '2048', 10);
  return Math.max(1, Number.isFinite(mb) ? mb : 2048) * 1024 * 1024;
};

// Adopt a dump sitting at `tempPath` into the backups directory.
//
// `originalName` is untrusted: it is used ONLY to decide whether the
// file can keep its own name (when it already matches the exact shape
// createBackup() emits, so the backup keeps its identity across a move
// between hosts) or gets a fresh one. It is never joined to a path
// before assertSafeFilename has vetted it.
export const importBackup = async (
  tempPath: string,
  originalName: string,
): Promise<BackupSummary> => {
  const head = Buffer.alloc(5);
  const fh = await open(tempPath, 'r');
  try {
    await fh.read(head, 0, 5, 0);
  } finally {
    await fh.close();
  }
  if (!isPgCustomDump(head)) {
    throw new Error(
      'not a PostgreSQL custom-format dump (missing the PGDMP header). Upload the .dump file produced by this app, not a plain-SQL or tar dump.',
    );
  }

  // Reading the table of contents proves the archive is intact and is
  // one of ours: it is the same check the restore does first, and it
  // catches truncated/corrupt uploads here rather than mid-restore.
  const { env } = pgConnectionArgs();
  let tocListing: string;
  try {
    const { stdout } = await execFileP('pg_restore', ['--list', tempPath], {
      maxBuffer: 64 * 1024 * 1024,
      env,
    });
    tocListing = stdout;
  } catch (err) {
    throw new Error(
      `${pgToolError('pg_restore --list', err).message}\n\nThe upload is not a readable dump — it may have been truncated in transit.`,
    );
  }
  const schemas = parseDumpSchemas(tocListing);
  if (!schemas.includes('vibetc')) {
    throw new Error(
      `this dump contains no "vibetc" schema (found: ${
        schemas.join(', ') || 'nothing'
      }). It is a backup of some other database.`,
    );
  }

  const dir = await ensureDir();
  // Keep the original name when it is one of ours, so a dump downloaded
  // from another install keeps the timestamp it was taken at.
  let filename: string;
  try {
    assertSafeFilename(originalName);
    filename = originalName;
  } catch {
    filename = newFilename();
  }
  const target = join(dir, filename);
  const exists = await stat(target).then(
    () => true,
    () => false,
  );
  if (exists) {
    throw new Error(
      `a backup named ${filename} already exists here. Delete it first, or rename the file you are uploading.`,
    );
  }

  try {
    await rename(tempPath, target);
  } catch (err) {
    // $DATA_DIR/tmp and $DATA_DIR/backups are normally the same volume,
    // but a bind-mounted tmp would make rename() EXDEV. Fall back to a
    // copy so the upload still lands.
    if ((err as { code?: string }).code !== 'EXDEV') throw err;
    await copyFile(tempPath, target);
    await rm(tempPath, { force: true });
  }

  const s = await stat(target);
  return { filename, sizeBytes: s.size, createdAt: s.mtime.toISOString() };
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
    if (!/^vibetc-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{1,4}Z\.dump$/.test(f)) continue;
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

// ---------------------------------------------------------------------
// RESTORE
//
// Replacing the contents of a live schema from a dump is fiddlier than
// `pg_restore --clean` suggests, because of one fact about this app:
// `CREATE EXTENSION pg_trgm` / `btree_gist` (migrations 0001 and 0006)
// run with no explicit SCHEMA, so they land in the first schema on
// search_path — which for the standard `vibetc` DB user is the `vibetc`
// schema itself. That breaks both of the obvious approaches:
//
//   * `pg_restore --clean` fails outright: its `DROP SCHEMA vibetc`
//     cannot run while extensions depend on the schema.
//   * A plain `DROP SCHEMA vibetc CASCADE` takes the extensions with it,
//     and the dump does NOT contain `CREATE EXTENSION` (pg_dump omits
//     extensions when dumping specific schemas). The restore then dies
//     on the first index referencing `vibetc.gin_trgm_ops`.
//
// So we drive the restore ourselves:
//
//   1) Read the dump's table of contents to learn which schemas it
//      carries, and note which extensions currently live in them.
//   2) Feed psql a preamble that drops and recreates exactly those
//      schemas and re-creates those extensions inside them, followed by
//      the dump rendered as SQL with its own `CREATE SCHEMA` entries
//      filtered out (we just made them).
//   3) Wrap preamble and dump in ONE transaction we open and commit by
//      hand. `COMMIT` is written only once pg_restore has exited 0, so a
//      dump that fails halfway through streaming cannot leave a
//      half-restored database committed: psql disconnects with the
//      transaction still open and Postgres rolls it back.
//
// Everything else is belt and braces — a safety dump of the current
// database first (so a restore is itself undoable), the extraction queue
// paused, and lock_timeout set so a worker mid-query makes the restore
// fail fast instead of hanging the request.
// ---------------------------------------------------------------------

// How long to wait for the ACCESS EXCLUSIVE locks the DROPs need before
// giving up. Anything still querying the schema blocks them.
const RESTORE_LOCK_TIMEOUT_MS = 30_000;

export interface RestoreOptions {
  // Dump the current database before touching it. On by default.
  safetyBackup?: boolean;
  // Pause the extraction queue for the duration so the worker isn't
  // holding locks (or writing into a database being swapped out). On by
  // default; best-effort — an unreachable Redis is a warning, not a
  // failure.
  pauseQueue?: boolean;
  // Re-run drizzle migrations after a successful restore. Matters when
  // the backup predates an app upgrade: the dump carries the `drizzle`
  // bookkeeping schema alongside `vibetc`, so restoring rolls the
  // migration state back too and this replays whatever is newer. A no-op
  // for a same-version backup. On by default.
  migrate?: boolean;
}

export interface RestoreResult {
  restoredFrom: string;
  safetyBackup: BackupSummary | null;
  // Schemas the dump replaced: ['vibetc'] for dumps taken before
  // migration bookkeeping was captured, ['drizzle', 'vibetc'] after.
  schemas: string[];
  migrated: boolean;
  warnings: string[];
  durationMs: number;
}

// Best-effort pause of the extraction queue. Returns a resume fn that is
// safe to call unconditionally, plus any warning to show the operator.
const pauseExtraction = async (): Promise<{
  resume: () => Promise<void>;
  warnings: string[];
}> => {
  const warnings: string[] = [];
  try {
    const { extractionQueue } = await import('../jobs/queues.js');
    const queue = extractionQueue();
    await queue.pause();
    const counts = await queue.getJobCounts('active', 'waiting', 'delayed');
    const pending = (counts.active ?? 0) + (counts.waiting ?? 0) + (counts.delayed ?? 0);
    if (pending > 0) {
      warnings.push(
        `${pending} extraction job(s) were queued in Redis when the restore ran. They reference statements from the pre-restore database and will fail; cancel or re-upload them.`,
      );
    }
    return {
      resume: async () => {
        try {
          await queue.resume();
        } catch (err) {
          logger.warn({ err }, 'failed to resume extraction queue after restore');
        }
      },
      warnings,
    };
  } catch (err) {
    logger.warn({ err }, 'could not pause extraction queue for restore');
    warnings.push('Extraction queue could not be paused (Redis unreachable?); restore continued.');
    return { resume: async () => {}, warnings };
  }
};

// Drop the app's Postgres pool so no connection outlives the swap. The
// next db access lazily builds a fresh one (see db/client.ts).
const recyclePool = async (): Promise<string[]> => {
  try {
    await Promise.race([
      closeDb(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('pool close timed out')), 5_000),
      ),
    ]);
    return [];
  } catch (err) {
    logger.warn({ err }, 'could not recycle pg pool after restore');
    return [
      'Database connection pool could not be recycled; restart the API if queries misbehave.',
    ];
  }
};

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

// Extensions living inside one of the schemas we're about to drop, so
// the preamble can put them back before the dump needs them.
const extensionsInSchemas = async (
  schemas: string[],
): Promise<{ name: string; schema: string }[]> => {
  if (schemas.length === 0) return [];
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const res = await client.query<{ extname: string; nspname: string }>(
      `SELECT e.extname, n.nspname
         FROM pg_extension e
         JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE n.nspname = ANY($1::text[])`,
      [schemas],
    );
    return res.rows.map((r) => ({ name: r.extname, schema: r.nspname }));
  } finally {
    await client.end();
  }
};

export const buildPreamble = (
  schemas: string[],
  extensions: { name: string; schema: string }[],
): string =>
  [
    'BEGIN;',
    `SET lock_timeout = ${RESTORE_LOCK_TIMEOUT_MS};`,
    // DROP ... CASCADE is chatty; without this the real error is buried
    // under a page of "drop cascades to ..." notices on stderr.
    'SET client_min_messages = warning;',
    ...schemas.flatMap((s) => [
      `DROP SCHEMA IF EXISTS ${quoteIdent(s)} CASCADE;`,
      `CREATE SCHEMA ${quoteIdent(s)};`,
    ]),
    // Re-created inside the schema they were in, because the dump's
    // indexes reference their operator classes schema-qualified.
    ...extensions.map(
      (e) =>
        `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(e.name)} WITH SCHEMA ${quoteIdent(e.schema)};`,
    ),
    '',
  ].join('\n');

// psql writes ERRORs, the statement that caused them, and any surviving
// NOTICE/WARNING chatter to the same stream. Lead with the ERROR lines
// so the operator reads the cause first, then append the rest.
export const summarizeSqlError = (stderr: string): string => {
  const lines = stderr.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return 'no output';
  const errors = lines.filter((l) => /\b(ERROR|FATAL|PANIC):/.test(l));
  if (errors.length === 0) return lines.join('\n');
  const rest = lines.filter((l) => !errors.includes(l));
  return [...errors, ...rest].join('\n');
};

// Stream `pg_restore --file -` into psql, with the preamble ahead of it
// and COMMIT appended only if pg_restore finished cleanly. Resolves on a
// committed restore; rejects with the failing tool's stderr otherwise.
const runPipedRestore = async (
  dumpPath: string,
  tocPath: string,
  preamble: string,
  connArgs: string[],
  env: Record<string, string | undefined>,
): Promise<void> => {
  const restoreArgs = ['--no-owner', '--use-list', tocPath, '--file', '-', dumpPath];
  const psqlArgs = [...connArgs, '--no-psqlrc', '--quiet', '-v', 'ON_ERROR_STOP=1', '--file', '-'];

  await new Promise<void>((resolve, reject) => {
    const restore = spawn('pg_restore', restoreArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const psql = spawn('psql', psqlArgs, { env, stdio: ['pipe', 'ignore', 'pipe'] });

    let restoreErr = '';
    let psqlErr = '';
    let restoreCode: number | null = null;
    let psqlCode: number | null = null;
    let settled = false;

    restore.stderr.on('data', (d: Buffer) => {
      restoreErr += d.toString('utf8');
    });
    psql.stderr.on('data', (d: Buffer) => {
      psqlErr += d.toString('utf8');
    });

    // psql exiting early (ON_ERROR_STOP) turns these writes into EPIPE.
    // The exit codes below are what we actually report on.
    const swallow = (): void => {};
    psql.stdin.on('error', swallow);
    restore.stdout.on('error', swallow);

    const finish = (): void => {
      if (settled || restoreCode === null || psqlCode === null) return;
      settled = true;
      if (restoreCode !== 0) {
        reject(
          new Error(
            `pg_restore failed reading the dump (exit ${restoreCode}), so no COMMIT was sent: ${
              restoreErr.trim() || 'no output'
            }`,
          ),
        );
      } else if (psqlCode !== 0) {
        reject(
          new Error(
            `psql failed applying the dump (exit ${psqlCode}): ${summarizeSqlError(psqlErr)}`,
          ),
        );
      } else {
        resolve();
      }
    };

    const onSpawnError =
      (tool: string) =>
      (err: Error & { code?: string }): void => {
        if (settled) return;
        settled = true;
        restore.kill();
        psql.kill();
        reject(
          err.code === 'ENOENT'
            ? new Error(`${tool} not found on PATH — ${PG_INSTALL_HINT}`)
            : new Error(`${tool} error: ${err.message}`),
        );
      };
    restore.on('error', onSpawnError('pg_restore'));
    psql.on('error', onSpawnError('psql'));

    psql.stdin.write(preamble);
    restore.stdout.pipe(psql.stdin, { end: false });

    restore.on('close', (code) => {
      restoreCode = code ?? 1;
      // Committing by hand is the whole point: if pg_restore died
      // mid-stream we close stdin without a COMMIT, psql disconnects
      // with the transaction open, and Postgres rolls it back.
      if (restoreCode === 0) psql.stdin.end('\nCOMMIT;\n');
      else psql.stdin.end();
      finish();
    });
    psql.on('close', (code) => {
      psqlCode = code ?? 1;
      finish();
    });
  });
};

// pg_restore/psql stderr is accurate but terse. Add the one sentence
// that tells the operator what to do next for failures we recognise.
export const annotateRestoreError = (message: string): Error => {
  const hints: string[] = [];
  if (/lock timeout|canceling statement/i.test(message)) {
    hints.push(
      'Something is still querying the database. Stop the worker (or wait for the in-flight extraction to finish) and retry.',
    );
  }
  if (/role ".*" does not exist/i.test(message)) {
    hints.push(
      'The dump grants privileges to a role that does not exist on this server. Create the role, or restore into the cluster the backup came from.',
    );
  }
  hints.push('The restore ran in one transaction and rolled back — the database is unchanged.');
  return new Error(`${message}\n\n${hints.join(' ')}`);
};

export const restoreBackup = async (
  filename: string,
  opts: RestoreOptions = {},
): Promise<RestoreResult> => {
  const startedAt = Date.now();
  const dumpPath = backupFilePath(filename); // throws on an unsafe filename
  try {
    await stat(dumpPath);
  } catch {
    throw new Error(`backup ${filename} not found`);
  }
  const { args: connArgs, env: baseEnv } = pgConnectionArgs();
  const env = {
    ...baseEnv,
    PGOPTIONS: [baseEnv.PGOPTIONS, `-c lock_timeout=${RESTORE_LOCK_TIMEOUT_MS}`]
      .filter(Boolean)
      .join(' '),
  };

  // Read the dump's TOC first. It tells us which schemas we're
  // replacing — and a dump we can't even list is one we must not start
  // dropping schemas for.
  let tocListing: string;
  try {
    const { stdout } = await execFileP('pg_restore', ['--list', dumpPath], {
      maxBuffer: 64 * 1024 * 1024,
      env,
    });
    tocListing = stdout;
  } catch (err) {
    throw pgToolError('pg_restore --list', err);
  }
  const schemas = parseDumpSchemas(tocListing);
  if (schemas.length === 0) {
    throw new Error(
      `${filename} contains no schema definition — it is not a vibetc backup, or it is truncated.`,
    );
  }

  const warnings: string[] = [];
  if (!schemas.includes('drizzle')) {
    warnings.push(
      'This backup predates migration-state capture, so it restored data only — the recorded schema version stayed where it is. If the backup was taken before a schema migration, the database will not match this build.',
    );
  }

  let safety: BackupSummary | null = null;
  if (opts.safetyBackup !== false) {
    // Deliberately NOT best-effort: if we can't dump, we don't restore.
    // A restore with no way back is the one outcome worth refusing.
    safety = await createBackup();
  }

  const { resume, warnings: queueWarnings } =
    opts.pauseQueue === false
      ? { resume: async (): Promise<void> => {}, warnings: [] as string[] }
      : await pauseExtraction();
  warnings.push(...queueWarnings);

  const tmpDir = join(process.env.DATA_DIR ?? './data', 'tmp');
  await mkdir(tmpDir, { recursive: true });
  const tocPath = join(tmpDir, `restore-toc-${process.pid}-${startedAt}.list`);

  try {
    await writeFile(tocPath, filterSchemaEntries(tocListing), 'utf8');
    const extensions = await extensionsInSchemas(schemas);
    try {
      await runPipedRestore(dumpPath, tocPath, buildPreamble(schemas, extensions), connArgs, env);
    } catch (err) {
      throw annotateRestoreError((err as Error).message);
    }
  } finally {
    await rm(tocPath, { force: true }).catch(() => {});
    warnings.push(...(await recyclePool()));
    await resume();
  }

  // The restore rolled the drizzle bookkeeping back with the data, so a
  // pre-upgrade backup lands on an old schema that this build's
  // migrations then bring forward. No-op for a same-version backup.
  let migrated = false;
  if (opts.migrate !== false) {
    try {
      const [{ runMigrations }, { db }] = await Promise.all([
        import('../db/migrate.js'),
        import('../db/client.js'),
      ]);
      await runMigrations(db);
      migrated = true;
    } catch (err) {
      logger.error({ err }, 'post-restore migration failed');
      warnings.push(
        `The data was restored, but re-applying migrations afterwards failed: ${
          (err as Error).message
        }. Run \`pnpm db:migrate\` before using the app.`,
      );
    }
  }

  return {
    restoredFrom: filename,
    safetyBackup: safety,
    schemas,
    migrated,
    warnings,
    durationMs: Date.now() - startedAt,
  };
};
