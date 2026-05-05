import { migrate } from 'drizzle-orm/node-postgres/migrator';
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

live('Companies CRUD (live Postgres)', () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-bytes-long-XXXX';
  }
  let app: ReturnType<typeof createApp>;
  let agent: request.Agent;
  let csrfToken: string;

  beforeAll(async () => {
    const pool = getPool();
    await pool.query('DROP SCHEMA IF EXISTS vibetc CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrate(getDb(), { migrationsFolder });

    app = createApp();
    agent = request.agent(app);
    const csrf = await agent.get('/api/auth/csrf').expect(200);
    csrfToken = csrf.body.token;
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
  }, 60_000);

  afterAll(async () => {
    await closeDb();
  });

  let companyId: string;

  it('POST /api/companies creates a company', async () => {
    const res = await agent
      .post('/api/companies')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'Acme LLC' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Acme LLC');
    companyId = res.body.id;
  });

  it('GET /api/companies returns the new company with accountCount=0', async () => {
    const res = await agent.get('/api/companies');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].name).toBe('Acme LLC');
    expect(res.body.rows[0].accountCount).toBe(0);
  });

  it('PATCH /api/companies/:id updates the name', async () => {
    const res = await agent
      .patch(`/api/companies/${companyId}`)
      .set('x-csrf-token', csrfToken)
      .send({ name: 'Acme Corporation' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Acme Corporation');
  });

  it('GET /api/companies/:id returns counts', async () => {
    const res = await agent.get(`/api/companies/${companyId}`);
    expect(res.status).toBe(200);
    expect(res.body.accountCount).toBe(0);
  });

  it('rejects empty-name update with 400', async () => {
    const res = await agent
      .patch(`/api/companies/${companyId}`)
      .set('x-csrf-token', csrfToken)
      .send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
  });

  it('DELETE /api/companies/:id removes when empty', async () => {
    const res = await agent.delete(`/api/companies/${companyId}`).set('x-csrf-token', csrfToken);
    expect(res.status).toBe(204);
  });

  it('GET 404 after delete', async () => {
    const res = await agent.get(`/api/companies/${companyId}`);
    expect(res.status).toBe(404);
  });

  it('without auth → 401', async () => {
    const res = await request(app).get('/api/companies');
    expect(res.status).toBe(401);
  });
});
