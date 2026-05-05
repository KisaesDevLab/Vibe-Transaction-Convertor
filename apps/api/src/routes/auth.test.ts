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

interface CsrfBundle {
  agent: request.Agent;
  token: string;
}

const freshAgent = async (app: ReturnType<typeof createApp>): Promise<CsrfBundle> => {
  const agent = request.agent(app);
  const res = await agent.get('/api/auth/csrf').expect(200);
  return { agent, token: res.body.token as string };
};

live('Auth — register, login, sessions, admin gating (live Postgres)', () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-bytes-long-XXXX';
  }

  beforeAll(async () => {
    const pool = getPool();
    await pool.query('DROP SCHEMA IF EXISTS vibetc CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrate(getDb(), { migrationsFolder });
  }, 60_000);

  afterAll(async () => {
    await closeDb();
  });

  it('first register creates an admin; second register without auth is forbidden', async () => {
    const app = createApp();
    const exists0 = await request(app).get('/api/auth/users-exist');
    expect(exists0.body.exists).toBe(false);

    const { agent: a1, token: t1 } = await freshAgent(app);
    const r1 = await a1
      .post('/api/auth/register')
      .set('x-csrf-token', t1)
      .send({
        email: 'admin@example.com',
        password: 'correcthorsebatterystaple',
        displayName: 'Admin',
      });
    expect(r1.status).toBe(201);
    expect(r1.body.role).toBe('admin');

    const exists1 = await request(app).get('/api/auth/users-exist');
    expect(exists1.body.exists).toBe(true);

    const { agent: a2, token: t2 } = await freshAgent(app);
    const r2 = await a2
      .post('/api/auth/register')
      .set('x-csrf-token', t2)
      .send({
        email: 'sneaky@example.com',
        password: 'correcthorsebatterystaple',
        displayName: 'Sneaky',
      });
    expect(r2.status).toBe(403);
  });

  it('login → me → logout flow', async () => {
    const app = createApp();
    const { agent } = await freshAgent(app);
    const login = await agent
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'correcthorsebatterystaple' });
    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe('admin@example.com');

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('admin');

    const csrf = await agent.get('/api/auth/csrf');
    const out = await agent.post('/api/auth/logout').set('x-csrf-token', csrf.body.token);
    expect(out.status).toBe(200);

    const meAfter = await agent.get('/api/auth/me');
    expect(meAfter.status).toBe(401);
  });

  it('login with wrong password fails with 401', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'wrongwrongwrong' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH');
  });

  it('admin can create staff via POST /api/users', async () => {
    const app = createApp();
    const { agent, token } = await freshAgent(app);
    await agent
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'correcthorsebatterystaple' })
      .expect(200);
    const res = await agent
      .post('/api/users')
      .set('x-csrf-token', token)
      .send({ email: 'staff@example.com', password: 'staffpassword12345', displayName: 'Staff' });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('staff');
  });

  it('staff cannot list users (admin gate)', async () => {
    const app = createApp();
    const { agent } = await freshAgent(app);
    await agent
      .post('/api/auth/login')
      .send({ email: 'staff@example.com', password: 'staffpassword12345' })
      .expect(200);
    const res = await agent.get('/api/users');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});
