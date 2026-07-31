// Backup + restore through the admin API, against a live Postgres.
// Skipped unless DATABASE_URL is set (same convention as the other live
// route suites) and unless pg_dump/pg_restore/psql are on PATH, since
// the whole feature is a wrapper around them.
//
// What this is really guarding: restoring must put the data back, must
// be gated behind the typed confirmation, and — the property that took
// the most care to get right — a failure part way through must leave the
// database exactly as it was rather than half-restored.

import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb, getDb, getPool } from '../db/client.js';
import { createApp } from '../server.js';

const execFileP = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsFolder = join(__dirname, '..', 'db', 'migrations');

const hasTools = async (): Promise<boolean> => {
  try {
    await Promise.all(['pg_dump', 'pg_restore', 'psql'].map((t) => execFileP(t, ['--version'])));
    return true;
  } catch {
    return false;
  }
};

const toolsAvailable = await hasTools();
const live = describe.skipIf(!process.env.DATABASE_URL || !toolsAvailable);

live('Admin backup + restore (live Postgres)', () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-bytes-long-XXXX';
  }
  // Keep dumps out of the repo's data dir. Set in beforeAll rather than
  // here so it doesn't leak into the other suites — vitest runs this
  // package's files sequentially in one fork (see vitest.config.ts).
  const dataDir = join(__dirname, '..', '..', '.tmp-backup-test');
  const savedDataDir = process.env.DATA_DIR;

  let app: ReturnType<typeof createApp>;
  let agent: request.Agent;
  let csrfToken: string;

  const companyNames = async (): Promise<string[]> => {
    const res = await getPool().query('SELECT name FROM vibetc.companies ORDER BY name');
    return res.rows.map((r: { name: string }) => r.name);
  };

  beforeAll(async () => {
    process.env.DATA_DIR = dataDir;
    const pool = getPool();
    await pool.query('DROP SCHEMA IF EXISTS vibetc CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrate(getDb(), { migrationsFolder });

    app = createApp();
    agent = request.agent(app);
    csrfToken = (await agent.get('/api/auth/csrf').expect(200)).body.token;
    await agent
      .post('/api/auth/register')
      .set('x-csrf-token', csrfToken)
      .send({
        email: 'admin@example.com',
        password: 'correcthorsebatterystaple',
        displayName: 'Admin',
      })
      .expect(201);
    await agent
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'correcthorsebatterystaple' })
      .expect(200);
  }, 120_000);

  afterAll(async () => {
    await closeDb();
    await rm(dataDir, { recursive: true, force: true });
    if (savedDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedDataDir;
  });

  let filename: string;

  it('POST /api/admin/backup writes a dump', async () => {
    await agent
      .post('/api/companies')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'Before Backup' })
      .expect(201);

    const res = await agent.post('/api/admin/backup').set('x-csrf-token', csrfToken);
    expect(res.status).toBe(201);
    expect(res.body.filename).toMatch(/^vibetc-.*\.dump$/);
    expect(res.body.sizeBytes).toBeGreaterThan(1000);
    filename = res.body.filename;
  }, 120_000);

  it('refuses to restore without the typed confirmation', async () => {
    const res = await agent
      .post(`/api/admin/backups/${filename}/restore`)
      .set('x-csrf-token', csrfToken)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
  });

  it('rejects a traversal filename with 400, not 404', async () => {
    const res = await agent
      .post(`/api/admin/backups/${encodeURIComponent('../../etc/passwd')}/restore`)
      .set('x-csrf-token', csrfToken)
      .send({ confirm: 'RESTORE' });
    expect(res.status).toBe(400);
  });

  it('404s for a well-formed filename that does not exist', async () => {
    const res = await agent
      .post('/api/admin/backups/vibetc-2020-01-01T00-00-00-000Z.dump/restore')
      .set('x-csrf-token', csrfToken)
      .send({ confirm: 'RESTORE' });
    expect(res.status).toBe(404);
  });

  it('restores the database to the state the dump captured', async () => {
    await agent
      .post('/api/companies')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'After Backup' })
      .expect(201);
    expect(await companyNames()).toEqual(['After Backup', 'Before Backup']);

    const res = await agent
      .post(`/api/admin/backups/${filename}/restore`)
      .set('x-csrf-token', csrfToken)
      .send({ confirm: 'RESTORE' });

    expect(res.status).toBe(200);
    expect(res.body.restoredFrom).toBe(filename);
    // Migration bookkeeping travels with the data so a pre-upgrade
    // backup can be migrated forward afterwards.
    expect(res.body.schemas).toEqual(['drizzle', 'vibetc']);
    expect(res.body.migrated).toBe(true);
    // A restore is itself undoable.
    expect(res.body.safetyBackup?.filename).toMatch(/^vibetc-.*\.dump$/);

    expect(await companyNames()).toEqual(['Before Backup']);
  }, 120_000);

  it('leaves the extensions the restored indexes depend on in place', async () => {
    // pg_dump --schema does not emit CREATE EXTENSION, so a restore that
    // drops the schema naively takes pg_trgm/btree_gist with it and then
    // dies on the first index that references vibetc.gin_trgm_ops.
    const ext = await getPool().query(
      `SELECT e.extname, n.nspname FROM pg_extension e
         JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname IN ('pg_trgm', 'btree_gist')`,
    );
    expect(ext.rows.map((r: { extname: string }) => r.extname).sort()).toEqual([
      'btree_gist',
      'pg_trgm',
    ]);
    const idx = await getPool().query(
      `SELECT 1 FROM pg_indexes
        WHERE schemaname = 'vibetc' AND indexname = 'fidir_bank_name_trgm_idx'`,
    );
    expect(idx.rowCount).toBe(1);
  });

  it('keeps audit_log append-only after a restore (ADR-013)', async () => {
    await expect(getPool().query('DELETE FROM vibetc.audit_log')).rejects.toThrow(/append-only/);
  });

  it('rolls back completely when the restore fails part way through', async () => {
    // The dump grants to vibetc_app; dropping the role makes psql fail
    // after the preamble has already dropped and recreated the schemas.
    const pool = getPool();
    await pool.query('GRANT USAGE ON SCHEMA vibetc TO vibetc_app');
    await pool.query('GRANT SELECT ON ALL TABLES IN SCHEMA vibetc TO vibetc_app');
    const fresh = (await agent.post('/api/admin/backup').set('x-csrf-token', csrfToken).expect(201))
      .body.filename as string;

    await agent
      .post('/api/companies')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'Survives The Failure' })
      .expect(201);
    const before = await companyNames();

    await pool.query('DROP OWNED BY vibetc_app');
    await pool.query('DROP ROLE vibetc_app');
    try {
      const res = await agent
        .post(`/api/admin/backups/${fresh}/restore`)
        .set('x-csrf-token', csrfToken)
        .send({ confirm: 'RESTORE' });

      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/role "vibetc_app" does not exist/);
      expect(res.body.message).toMatch(/rolled back/);
      // Nothing committed: rows and schema exactly as they were.
      // NB: getPool() is re-read here because a restore recycles the
      // pool, so the handle captured above is already ended.
      expect(await companyNames()).toEqual(before);
      const tables = await getPool().query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'vibetc'`,
      );
      expect(tables.rows[0].n).toBeGreaterThan(5);
    } finally {
      await getPool().query('CREATE ROLE vibetc_app NOLOGIN');
    }
  }, 120_000);

  it('requires an authenticated admin', async () => {
    // A CSRF token but no session — isolates the auth check from the
    // CSRF check, which would otherwise reject first with a 403.
    const anon = request.agent(app);
    const token = (await anon.get('/api/auth/csrf').expect(200)).body.token;
    const res = await anon
      .post(`/api/admin/backups/${filename}/restore`)
      .set('x-csrf-token', token)
      .send({ confirm: 'RESTORE' });
    expect(res.status).toBe(401);
  });

  it('rejects a request with no CSRF token', async () => {
    const res = await request(app)
      .post(`/api/admin/backups/${filename}/restore`)
      .send({ confirm: 'RESTORE' });
    expect(res.status).toBe(403);
  });
});
