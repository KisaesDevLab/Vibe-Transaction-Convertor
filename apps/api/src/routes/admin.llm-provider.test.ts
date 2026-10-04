// /api/admin/llm-provider routes against a live Postgres. Skipped unless
// DATABASE_URL is set (same convention as the other live route suites).

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEXT_MODEL } from '@vibe-tx-converter/extractor';

import { closeDb, getDb, getPool } from '../db/client.js';
import { createApp } from '../server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(__dirname, '..', 'db', 'migrations');

const live = describe.skipIf(!process.env.DATABASE_URL);

live('Admin LLM provider routes (live Postgres)', () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-bytes-long-XXXX';
  }
  const ENV_KEYS = ['ANTHROPIC_API_KEY', 'LLM_MODEL_ID', 'OLLAMA_BASE_URL', 'LLM_GATEWAY_URL'];
  let savedEnv: Record<string, string | undefined>;

  let app: ReturnType<typeof createApp>;
  let agent: request.Agent;
  let csrfToken: string;

  const setting = async (key: string): Promise<string | null> => {
    const res = await getPool().query(
      'SELECT value_plaintext FROM vibetc.system_settings WHERE key = $1',
      [key],
    );
    return (res.rows[0]?.value_plaintext as string | undefined) ?? null;
  };

  beforeAll(async () => {
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
  });

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const post = (path: string, body: object) =>
    agent.post(`/api/admin${path}`).set('x-csrf-token', csrfToken).send(body);

  it('reports the model extraction actually defaults to', async () => {
    const res = await agent.get('/api/admin/llm-provider').expect(200);
    expect(res.body.ollamaModel).toBe(DEFAULT_TEXT_MODEL);
  });

  it('routes back to local when the only Anthropic key is cleared', async () => {
    await post('/llm-provider', { policy: 'anthropic-first' }).expect(200);
    await post('/llm-provider/ai-setting', { id: 'extractionProvider', value: 'anthropic' }).expect(
      200,
    );
    await post('/llm-provider/ai-setting', { id: 'cleanseProvider', value: 'local' }).expect(200);
    await post('/llm-provider/anthropic-key', { apiKey: 'sk-ant-test-0000000000000000' }).expect(
      200,
    );

    const res = await agent
      .delete('/api/admin/llm-provider/anthropic-key')
      .set('x-csrf-token', csrfToken)
      .expect(200);
    expect(res.body.policyReset).toEqual({
      from: 'anthropic-first',
      to: 'local-only',
      resetProcesses: ['extraction'],
    });
    expect(await setting('llm.provider')).toBe('local-only');
    expect(await setting('llm.process.extraction.provider')).toBeNull();
    // A process pinned to local is not Anthropic's to reset.
    expect(await setting('llm.process.cleanse.provider')).toBe('local');

    // Both the key clear and the routing change it forced are on the trail.
    const audit = await getPool().query(
      `SELECT action, payload FROM vibetc.audit_log
        WHERE action = 'anthropic-key.clear'
           OR (action = 'llm-provider.change' AND payload->>'reason' = 'anthropic-key.clear')
        ORDER BY id`,
    );
    expect(audit.rows).toEqual([
      { action: 'anthropic-key.clear', payload: null },
      {
        action: 'llm-provider.change',
        payload: {
          policy: 'local-only',
          reason: 'anthropic-key.clear',
          resetProcesses: ['extraction'],
        },
      },
    ]);
  });

  it('leaves routing alone while ANTHROPIC_API_KEY still provides a key', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-0000000000000000';
    await post('/llm-provider', { policy: 'anthropic-only' }).expect(200);
    const res = await agent
      .delete('/api/admin/llm-provider/anthropic-key')
      .set('x-csrf-token', csrfToken)
      .expect(200);
    expect(res.body.policyReset).toBeNull();
    expect(await setting('llm.provider')).toBe('anthropic-only');
    await post('/llm-provider', { policy: 'local-only' }).expect(200);
  });

  // The route has no `next`: a rejected settings read used to escape as an
  // unhandled rejection, which terminates the process.
  it('lists local models without crashing when the settings read fails', async () => {
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:1';
    await getPool().query('ALTER TABLE vibetc.system_settings RENAME TO system_settings_moved');
    try {
      const res = await agent.get('/api/admin/llm-provider/local-models').expect(200);
      expect(res.body).toMatchObject({ models: [], ok: false });
    } finally {
      await getPool().query('ALTER TABLE vibetc.system_settings_moved RENAME TO system_settings');
    }
  });
});
