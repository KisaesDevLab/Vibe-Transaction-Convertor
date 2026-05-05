import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb, getDb, getPool } from '../db/client.js';
import { createApp } from '../server.js';

const databaseUrl = process.env.DATABASE_URL;
const live = describe.skipIf(!databaseUrl);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsFolder = join(__dirname, '..', 'db', 'migrations');

live('Uploads — multipart, magic-byte gate, dedup (live Postgres)', () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-bytes-long-XXXX';
  }
  let app: ReturnType<typeof createApp>;
  let agent: request.Agent;
  let csrfToken: string;
  let accountId: string;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'vibetc-uploads-test-'));
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
    const company = await agent
      .post('/api/companies')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'Acme LLC' })
      .expect(201);
    const account = await agent
      .post(`/api/companies/${company.body.id}/accounts`)
      .set('x-csrf-token', csrfToken)
      .send({
        nickname: 'Operating',
        financialInstitution: 'Wells Fargo',
        intuBid: '3000',
        intuOrg: 'Wells Fargo',
        accountType: 'CHECKING',
        accountNumber: '1234567890',
      })
      .expect(201);
    accountId = account.body.id;
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rejects non-PDF magic bytes per file (errors[]) but does not 500', async () => {
    const res = await agent
      .post(`/api/accounts/${accountId}/uploads`)
      .set('x-csrf-token', csrfToken)
      .attach('files', Buffer.from('not a pdf at all'), 'fake.pdf');
    expect(res.status).toBe(201);
    expect(res.body.statements).toEqual([]);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].error).toBe('not a PDF');
  });

  it('400 when no files are sent', async () => {
    const res = await agent
      .post(`/api/accounts/${accountId}/uploads`)
      .set('x-csrf-token', csrfToken);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
  });

  it('without auth → 401 or 403 (CSRF fires first for mutating requests)', async () => {
    const res = await request(app).post(`/api/accounts/${accountId}/uploads`);
    expect([401, 403]).toContain(res.status);
  });

  it('GET /api/uploads/:hash/raw rejects bad hash format with 400', async () => {
    const res = await agent.get('/api/uploads/not-a-hash/raw');
    expect(res.status).toBe(400);
  });

  it('GET /api/uploads/:hash/raw 404s when no statement matches', async () => {
    const sixtyFour = '0'.repeat(64);
    const res = await agent.get(`/api/uploads/${sixtyFour}/raw`);
    expect(res.status).toBe(404);
  });
});
