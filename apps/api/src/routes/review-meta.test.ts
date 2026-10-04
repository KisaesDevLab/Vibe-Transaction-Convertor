import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb, getDb, getPool } from '../db/client.js';
import { businessCategories } from '../db/schema.js';
import { createApp } from '../server.js';

const databaseUrl = process.env.DATABASE_URL;
const live = describe.skipIf(!databaseUrl);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsFolder = join(__dirname, '..', 'db', 'migrations');

live('Review-page metadata for non-admin reviewers (live Postgres)', () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-bytes-long-XXXX';
  }
  let app: ReturnType<typeof createApp>;
  let admin: request.Agent;
  let staff: request.Agent;

  beforeAll(async () => {
    const pool = getPool();
    await pool.query('DROP SCHEMA IF EXISTS vibetc CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrate(getDb(), { migrationsFolder });

    app = createApp();
    admin = request.agent(app);
    const adminCsrf = (await admin.get('/api/auth/csrf').expect(200)).body.token;
    await admin
      .post('/api/auth/register')
      .set('x-csrf-token', adminCsrf)
      .send({
        email: 'admin@example.com',
        password: 'correcthorsebatterystaple',
        displayName: 'Admin',
      })
      .expect(201);
    await admin
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'correcthorsebatterystaple' })
      .expect(200);
    await admin
      .post('/api/users')
      .set('x-csrf-token', adminCsrf)
      .send({ email: 'staff@example.com', password: 'staffpassword12345', displayName: 'Staff' })
      .expect(201);

    staff = request.agent(app);
    await staff.get('/api/auth/csrf').expect(200);
    await staff
      .post('/api/auth/login')
      .send({ email: 'staff@example.com', password: 'staffpassword12345' })
      .expect(200);

    await getDb()
      .insert(businessCategories)
      .values([
        { name: 'ZZ Review Later', sortOrder: 1 },
        { name: 'ZZ Review Earlier', sortOrder: 0 },
        { name: 'ZZ Review Archived', sortOrder: 0, archived: true },
      ]);
  }, 60_000);

  afterAll(async () => {
    await closeDb();
  });

  it('staff read the active categories in the admin list shape', async () => {
    const res = await staff.get('/api/review-meta/categories').expect(200);
    const names = (res.body as Array<{ name: string; archived: boolean }>).map((c) => c.name);
    expect(names).toContain('ZZ Review Earlier');
    expect(names).not.toContain('ZZ Review Archived');
    expect(names.indexOf('ZZ Review Earlier')).toBeLessThan(names.indexOf('ZZ Review Later'));

    const adminList = await admin.get('/api/admin/categories').expect(200);
    expect(res.body).toEqual(adminList.body);
    // The admin CRUD surface itself stays admin-only.
    await staff.get('/api/admin/categories').expect(403);
  });

  it('staff read the enrichment toggles', async () => {
    const res = await staff.get('/api/review-meta/enrichment').expect(200);
    const adminView = await admin.get('/api/admin/enrichment').expect(200);
    expect(res.body).toEqual(adminView.body);
    expect(typeof res.body.cleanseEnabled).toBe('boolean');
    expect(typeof res.body.categoryEnabled).toBe('boolean');
  });

  it('requires a session', async () => {
    await request(app).get('/api/review-meta/categories').expect(401);
  });
});
