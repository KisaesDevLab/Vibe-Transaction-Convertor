// Base-path-strip middleware tests — Vibe-Appliance LAN/Tailscale path-
// prefix forwarding. Standalone mode (VITE_BASE_PATH unset) should be a
// pure no-op so this can't regress single-host deploys.

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { stripBasePath } from './base-path.js';

const buildApp = (basePath: string | undefined): express.Express => {
  const app = express();
  app.use(stripBasePath(basePath));
  app.get('/api/echo', (req, res) => {
    res.json({ url: req.url, originalUrl: req.originalUrl });
  });
  app.get('/api/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/', (_req, res) => {
    res.json({ root: true });
  });
  return app;
};

describe('stripBasePath', () => {
  it('is a no-op when basePath is undefined', async () => {
    const app = buildApp(undefined);
    const res = await request(app).get('/api/echo');
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('/api/echo');
  });

  it('is a no-op when basePath is "/"', async () => {
    const app = buildApp('/');
    const res = await request(app).get('/api/echo');
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('/api/echo');
  });

  it('strips a single-segment prefix from API requests', async () => {
    const app = buildApp('/vibe-tx-converter/');
    const res = await request(app).get('/vibe-tx-converter/api/echo');
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('/api/echo');
  });

  it('strips the prefix from /api/health/live so health probes survive', async () => {
    const app = buildApp('/vibe-tx-converter/');
    const res = await request(app).get('/vibe-tx-converter/api/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('rewrites bare prefix (no trailing slash) to "/"', async () => {
    const app = buildApp('/vibe-tx-converter/');
    const res = await request(app).get('/vibe-tx-converter');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ root: true });
  });

  it('rewrites prefix-with-trailing-slash to "/"', async () => {
    const app = buildApp('/vibe-tx-converter/');
    const res = await request(app).get('/vibe-tx-converter/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ root: true });
  });

  it('does not strip a prefix that only happens to share a leading substring', async () => {
    const app = buildApp('/vibe-tx-converter/');
    // Sibling app `vibe-tx-converter-extra` must not be matched.
    const res = await request(app).get('/vibe-tx-converter-extra/api/echo');
    // No matching route — the strip should not have fired.
    expect(res.status).toBe(404);
  });

  it('normalizes a basePath without a leading slash', async () => {
    const app = buildApp('vibe-tx-converter');
    const res = await request(app).get('/vibe-tx-converter/api/echo');
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('/api/echo');
  });

  it('preserves originalUrl for downstream logging / proxy use', async () => {
    const app = buildApp('/vibe-tx-converter/');
    const res = await request(app).get('/vibe-tx-converter/api/echo');
    expect(res.body.originalUrl).toBe('/vibe-tx-converter/api/echo');
    expect(res.body.url).toBe('/api/echo');
  });
});
