import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb, getDb, getPool } from '../db/client.js';
import { users } from '../db/schema.js';
import { BREAKGLASS_EMAIL } from '../lib/breakglass.js';
import { hashPassword } from '../services/auth.js';
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

const signIn = async (
  app: ReturnType<typeof createApp>,
  email: string,
  password: string,
): Promise<CsrfBundle> => {
  const bundle = await freshAgent(app);
  await bundle.agent.post('/api/auth/login').send({ email, password }).expect(200);
  return bundle;
};

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'correcthorsebatterystaple';

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
    const r1 = await a1.post('/api/auth/register').set('x-csrf-token', t1).send({
      email: 'admin@example.com',
      password: 'correcthorsebatterystaple',
      displayName: 'Admin',
    });
    expect(r1.status).toBe(201);
    expect(r1.body.role).toBe('admin');

    const exists1 = await request(app).get('/api/auth/users-exist');
    expect(exists1.body.exists).toBe(true);

    const { agent: a2, token: t2 } = await freshAgent(app);
    const r2 = await a2.post('/api/auth/register').set('x-csrf-token', t2).send({
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

  it('an unknown email gets the same 401 as a wrong password', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrongwrongwrong' });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH', message: 'invalid email or password' });
  });

  it('a signed-in admin cannot create users through /api/auth/register (bootstrap only)', async () => {
    const app = createApp();
    const { agent, token } = await signIn(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await agent
      .post('/api/auth/register')
      .set('x-csrf-token', token)
      .send({ email: 'viaregister@example.com', password: 'staffpassword12345', displayName: 'X' });
    expect(res.status).toBe(403);
    const rows = await getPool().query('SELECT 1 FROM vibetc.users WHERE email = $1', [
      'viaregister@example.com',
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('change-password ends the other sessions and keeps the current one', async () => {
    const app = createApp();
    const admin = await signIn(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    await admin.agent
      .post('/api/users')
      .set('x-csrf-token', admin.token)
      .send({ email: 'pw@example.com', password: 'originalpassword1', displayName: 'Pw' })
      .expect(201);

    const here = await signIn(app, 'pw@example.com', 'originalpassword1');
    const elsewhere = await signIn(app, 'pw@example.com', 'originalpassword1');

    await here.agent
      .post('/api/auth/change-password')
      .set('x-csrf-token', here.token)
      .send({ currentPassword: 'originalpassword1', newPassword: 'brandnewpassword2' })
      .expect(200);

    expect((await here.agent.get('/api/auth/me')).status).toBe(200);
    expect((await elsewhere.agent.get('/api/auth/me')).status).toBe(401);
  });

  it('admin reset-password ends every session of the target and audits it', async () => {
    const app = createApp();
    const admin = await signIn(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const created = await admin.agent
      .post('/api/users')
      .set('x-csrf-token', admin.token)
      .send({ email: 'reset@example.com', password: 'resetpassword123', displayName: 'Reset' })
      .expect(201);
    const targetId = created.body.id as string;

    const target = await signIn(app, 'reset@example.com', 'resetpassword123');

    const reset = await admin.agent
      .post(`/api/users/${targetId}/reset-password`)
      .set('x-csrf-token', admin.token);
    expect(reset.status).toBe(200);
    const temporaryPassword = reset.body.temporaryPassword as string;
    expect(temporaryPassword).toBeTypeOf('string');

    expect((await target.agent.get('/api/auth/me')).status).toBe(401);
    await signIn(app, 'reset@example.com', temporaryPassword);

    const audit = await getPool().query(
      `SELECT payload FROM vibetc.audit_log
        WHERE action = 'user.admin-reset-password' AND entity_id = $1`,
      [targetId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].payload).toEqual({ sessionsRevoked: true });
  });

  it('admin reset-password refuses the break-glass account and unknown users', async () => {
    const [bg] = await getDb()
      .insert(users)
      .values({
        email: BREAKGLASS_EMAIL,
        displayName: 'Break-glass',
        role: 'admin',
        passwordHash: await hashPassword('breakglasspassword1'),
      })
      .returning();
    const app = createApp();
    const admin = await signIn(app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const refused = await admin.agent
      .post(`/api/users/${bg!.id}/reset-password`)
      .set('x-csrf-token', admin.token);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    const after = await getPool().query('SELECT password_hash FROM vibetc.users WHERE id = $1', [
      bg!.id,
    ]);
    expect(after.rows[0].password_hash).toBe(bg!.passwordHash);

    const unknownId = '00000000-0000-4000-8000-000000000000';
    for (const id of [unknownId, 'not-a-uuid']) {
      const res = await admin.agent
        .post(`/api/users/${id}/reset-password`)
        .set('x-csrf-token', admin.token);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    const audit = await getPool().query(
      `SELECT 1 FROM vibetc.audit_log
        WHERE action = 'user.admin-reset-password' AND entity_id = ANY($1)`,
      [[bg!.id, unknownId, 'not-a-uuid']],
    );
    expect(audit.rowCount).toBe(0);
  });

  // Runs last: it empties the users table to re-open first-admin bootstrap.
  it('concurrent first registrations produce exactly one admin', async () => {
    await getPool().query('TRUNCATE vibetc.users CASCADE');
    const app = createApp();
    const attempt = async (email: string) => {
      const { agent, token } = await freshAgent(app);
      return agent
        .post('/api/auth/register')
        .set('x-csrf-token', token)
        .send({ email, password: 'correcthorsebatterystaple', displayName: email });
    };
    const results = await Promise.all(
      ['first-a@example.com', 'first-b@example.com', 'first-c@example.com'].map(attempt),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403]);
    const roles = await getPool().query('SELECT role FROM vibetc.users');
    expect(roles.rows).toEqual([{ role: 'admin' }]);
  });
});
