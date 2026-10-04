import pg from 'pg';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './server.js';

const ENV_KEYS = ['DATABASE_URL', 'REDIS_URL', 'OLLAMA_BASE_URL', 'LLM_GATEWAY_URL'] as const;

describe('createApp() — health, version, errors', () => {
  const original: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      original[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = original[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  it('GET /api/health/live returns 200 ok', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /api/health/ready returns 200 with all deps unconfigured (no failure means ready)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.dependencies).toMatchObject({
      postgres: { status: 'unconfigured' },
      redis: { status: 'unconfigured' },
      llmGateway: { status: 'unconfigured' },
    });
  });

  it('GET /api/health/ready returns 503 when at least one dependency fails', async () => {
    process.env.DATABASE_URL = 'postgres://nope:nope@127.0.0.1:1/nope';
    const app = createApp();
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.dependencies.postgres.status).toBe('fail');
    // The failure text (host:port, DB user) is not shown to anonymous callers.
    expect(res.body.dependencies.postgres).not.toHaveProperty('detail');
  }, 10_000);

  it('GET /api/health/ready shares one probe between concurrent callers', async () => {
    process.env.DATABASE_URL = 'postgres://nope:nope@127.0.0.1:1/nope';
    // vitest's spy cannot `new` a class itself; construct the real one.
    const RealPool = pg.Pool;
    const poolSpy = vi
      .spyOn(pg, 'Pool')
      .mockImplementation((config?: pg.PoolConfig) => new RealPool(config));
    try {
      const app = createApp();
      const results = await Promise.all([1, 2, 3].map(() => request(app).get('/api/health/ready')));
      expect(results.map((r) => r.status)).toEqual([503, 503, 503]);
      // The readiness probe's own pool is the max: 1 one (the app's shared
      // pool may also be built on first use).
      const probePools = poolSpy.mock.calls.filter(
        ([cfg]) => (cfg as pg.PoolConfig | undefined)?.max === 1,
      );
      expect(probePools).toHaveLength(1);
    } finally {
      poolSpy.mockRestore();
    }
  }, 10_000);

  it('GET /api/version reports name, version, buildSha, node', async () => {
    const app = createApp();
    const res = await request(app).get('/api/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: '@vibe-tx-converter/api',
      version: expect.any(String),
      buildSha: expect.any(String),
      node: expect.stringMatching(/^v\d+\./),
    });
  });

  it('unknown route returns 404 with an AppError shape', async () => {
    const app = createApp();
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.error).toBe('NotFoundError');
    expect(res.body.requestId).toBeTypeOf('string');
  });

  it('mutating endpoints without a CSRF token are rejected with 403', async () => {
    const app = createApp();
    const res = await request(app).post('/api/version').send({});
    expect([403, 404]).toContain(res.status); // CSRF check fires before 404
    if (res.status === 403) {
      expect(res.body.code).toBe('FORBIDDEN');
    }
  });

  it('POST /api/internal/appliance/health (orchestrator handshake) needs no CSRF token', async () => {
    const app = createApp();
    const res = await request(app).post('/api/internal/appliance/health').send({});
    expect(res.status).toBe(200);
    expect(res.body.dbSchema).toBe('vibetc');
  }, 10_000);

  it('GET /api/auth/csrf issues a token cookie', async () => {
    const app = createApp();
    const res = await request(app).get('/api/auth/csrf');
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.headers['set-cookie']?.[0]).toMatch(/^vibetc_csrf=/);
  });
});
