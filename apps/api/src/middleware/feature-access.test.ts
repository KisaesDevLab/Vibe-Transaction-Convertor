// Unit tests for the requireFeature route guard. Pure middleware — no DB
// needed; req.user / req.featureAccess are injected by a stub.

import express, { type Request } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { errorHandler } from './error-handler.js';
import { requireFeature } from './feature-access.js';

const buildApp = (opts: {
  user?: { id: string } | null;
  featureAccess?: Record<string, boolean>;
}): express.Express => {
  const app = express();
  app.use((req: Request, _res, next) => {
    if (opts.user) req.user = opts.user as Request['user'];
    if (opts.featureAccess) req.featureAccess = opts.featureAccess;
    next();
  });
  app.get('/guarded', requireFeature('exports'), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
};

describe('requireFeature', () => {
  it('passes when the feature is explicitly enabled', async () => {
    const app = buildApp({ user: { id: 'u1' }, featureAccess: { exports: true } });
    const res = await request(app).get('/guarded');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('passes when the feature is absent (default-on)', async () => {
    const app = buildApp({ user: { id: 'u1' }, featureAccess: {} });
    const res = await request(app).get('/guarded');
    expect(res.status).toBe(200);
  });

  it('403s when the feature is explicitly disabled', async () => {
    const app = buildApp({ user: { id: 'u1' }, featureAccess: { exports: false } });
    const res = await request(app).get('/guarded');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('401s when there is no authenticated user', async () => {
    const app = buildApp({ user: null, featureAccess: { exports: true } });
    const res = await request(app).get('/guarded');
    expect(res.status).toBe(401);
  });
});
