import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDb, getDb, getPool } from '../db/client.js';
import { createApp } from '../server.js';
import { AUDIT_EXPORT_MAX_ROWS } from './audit.js';

const databaseUrl = process.env.DATABASE_URL;
const live = describe.skipIf(!databaseUrl);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsFolder = join(__dirname, '..', 'db', 'migrations');

live('Audit export downloads (live Postgres)', () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-bytes-long-XXXX';
  }
  let agent: request.Agent;

  beforeAll(async () => {
    const pool = getPool();
    await pool.query('DROP SCHEMA IF EXISTS vibetc CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrate(getDb(), { migrationsFolder });

    agent = request.agent(createApp());
    const csrfToken = (await agent.get('/api/auth/csrf').expect(200)).body.token;
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

    // One more matching event than an export returns (and far more than the
    // list endpoint's 500-row page cap).
    await pool.query(
      `INSERT INTO vibetc.audit_log (entity_type, entity_id, action, payload)
       SELECT 'fx-export', 'e' || g, 'fx.seed', jsonb_build_object('i', g)
       FROM generate_series(1, $1::int) AS g`,
      [AUDIT_EXPORT_MAX_ROWS + 1],
    );
  }, 60_000);

  afterAll(async () => {
    await closeDb();
  });

  it('JSON export returns up to the cap and says when it truncated', async () => {
    const res = await agent
      .get('/api/audit/export.json')
      .query({ entityType: 'fx-export' })
      .expect(200);
    expect(res.headers['x-audit-export-truncated']).toBe('true');
    expect(res.body.truncated).toBe(true);
    expect(res.body.rows).toHaveLength(AUDIT_EXPORT_MAX_ROWS);
    expect(res.body.filters).toEqual({ entityType: 'fx-export' });

    const narrow = await agent
      .get('/api/audit/export.json')
      .query({ entityType: 'fx-export', entityId: 'e7' })
      .expect(200);
    expect(narrow.headers['x-audit-export-truncated']).toBe('false');
    expect(narrow.body.truncated).toBe(false);
    expect(narrow.body.rows).toHaveLength(1);
  });

  it('CSV export carries the truncation flag in a header', async () => {
    const res = await agent
      .get('/api/audit/export.csv')
      .query({ entityType: 'fx-export' })
      .buffer(true)
      .expect(200);
    expect(res.headers['x-audit-export-truncated']).toBe('true');
    // Header line + one line per row.
    expect(res.text.trim().split('\r\n')).toHaveLength(AUDIT_EXPORT_MAX_ROWS + 1);
  });
});
