import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb, getDb, getPool } from '../db/client.js';
import { seedFidir } from '../services/fidir-seeder.js';
import { createApp } from '../server.js';

const databaseUrl = process.env.DATABASE_URL;
const live = describe.skipIf(!databaseUrl);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsFolder = join(__dirname, '..', 'db', 'migrations');

live('FIDIR — seeder + routes (live Postgres)', () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-bytes-long-XXXX';
  }
  let app: ReturnType<typeof createApp>;
  let agent: request.Agent;

  beforeAll(async () => {
    const pool = getPool();
    await pool.query('DROP SCHEMA IF EXISTS vibetc CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrate(getDb(), { migrationsFolder });
    await seedFidir(getDb());
    app = createApp();
    agent = request.agent(app);
    const csrf = await agent.get('/api/auth/csrf').expect(200);
    const token = csrf.body.token as string;
    await agent
      .post('/api/auth/register')
      .set('x-csrf-token', token)
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

  it('seeded > 100 entries from the vendored file', async () => {
    const res = await agent.get('/api/fidir/status');
    expect(res.status).toBe(200);
    expect(res.body.entriesCount).toBeGreaterThan(100);
    expect(res.body.lastRefreshedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('finds Wells Fargo by name', async () => {
    const res = await agent.get('/api/fidir/search?q=wells');
    expect(res.status).toBe(200);
    const orgs = (res.body.results as Array<{ intuOrg: string }>).map((r) => r.intuOrg);
    expect(orgs).toContain('Wells Fargo');
  });

  it('finds Chase by name', async () => {
    const res = await agent.get('/api/fidir/search?q=chase');
    expect(res.status).toBe(200);
    const orgs = (res.body.results as Array<{ intuOrg: string }>).map((r) => r.intuOrg);
    expect(orgs).toContain('Chase');
  });

  it('GET /api/fidir/by-bid/3000 returns the Wells Fargo fallback', async () => {
    const res = await agent.get('/api/fidir/by-bid/3000');
    expect(res.status).toBe(200);
    expect(res.body.intuOrg).toBe('Wells Fargo');
  });

  it('GET /api/fidir/by-bid/missing returns 404', async () => {
    const res = await agent.get('/api/fidir/by-bid/00000');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('without a session, /api/fidir/status returns 401', async () => {
    const res = await request(app).get('/api/fidir/status');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH');
  });
});
