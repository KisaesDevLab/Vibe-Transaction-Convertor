// Integration test that boots createApp() with the env each deployment
// mode actually ships and hits the routes the appliance orchestrator and
// SPA depend on. This is the regression net for the install-time
// breakages that have bitten Phase 28/29 — defaults that look fine in
// isolation but mismatch each other at runtime.

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { performHandshake, readManifest } from './lib/manifest.js';
import { createApp } from './server.js';

const TRACKED_KEYS = [
  'APPLIANCE_MODE',
  'APPLIANCE_VERSION',
  'WEB_BASE_URL',
  'SESSION_SECURE',
  'SESSION_COOKIE_DOMAIN',
  'WORKER_INLINE',
  'NODE_ENV',
] as const;

const snapshot = (): Partial<Record<(typeof TRACKED_KEYS)[number], string | undefined>> => {
  const out: Partial<Record<(typeof TRACKED_KEYS)[number], string | undefined>> = {};
  for (const k of TRACKED_KEYS) out[k] = process.env[k];
  return out;
};

const restore = (
  saved: Partial<Record<(typeof TRACKED_KEYS)[number], string | undefined>>,
): void => {
  for (const k of TRACKED_KEYS) {
    const v = saved[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
};

describe('createApp() — standalone mode env', () => {
  let saved: ReturnType<typeof snapshot>;

  beforeEach(() => {
    saved = snapshot();
    delete process.env.APPLIANCE_MODE;
    delete process.env.APPLIANCE_VERSION;
    process.env.WEB_BASE_URL = 'http://localhost';
    process.env.SESSION_SECURE = 'false';
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => restore(saved));

  it('boots and serves liveness + version', async () => {
    const app = createApp();
    const live = await request(app).get('/api/health/live');
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: 'ok' });

    const version = await request(app).get('/api/version');
    expect(version.status).toBe(200);
    expect(version.body.name).toBe('@vibe-tx-converter/api');
  });

  it('issues session-aligned cookies without a Domain attribute (host-only)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/auth/csrf');
    expect(res.status).toBe(200);
    const setCookie = res.headers['set-cookie'];
    const header = Array.isArray(setCookie) ? setCookie.join('\n') : (setCookie ?? '');
    expect(header).toMatch(/vibetc_csrf=/);
    expect(header).not.toMatch(/Domain=/i);
    expect(header).toMatch(/Path=\//);
  });

  it('appliance handshake reports standalone when APPLIANCE_MODE is unset', () => {
    const result = performHandshake();
    expect(result.applianceMode).toBe(false);
    expect(result.status).toBe('standalone');
  });

  it('CORS allowlist reflects WEB_BASE_URL', async () => {
    const app = createApp();
    const preflight = await request(app)
      .options('/api/version')
      .set('Origin', 'http://localhost')
      .set('Access-Control-Request-Method', 'GET');
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost');
  });

  it('omits upgrade-insecure-requests from CSP when WEB_BASE_URL is HTTP', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health/live');
    const csp = res.headers['content-security-policy'] ?? '';
    // The directive would force the browser to silently rewrite every
    // asset request to https://, which on a LAN HTTP-only appliance
    // means every <script>/<link> fails with ERR_SSL_PROTOCOL_ERROR
    // before any JS runs.
    expect(csp).not.toMatch(/upgrade-insecure-requests/);
  });
});

describe('createApp() — appliance mode env', () => {
  let saved: ReturnType<typeof snapshot>;

  beforeEach(() => {
    saved = snapshot();
    const manifest = readManifest();
    process.env.APPLIANCE_MODE = 'true';
    process.env.APPLIANCE_VERSION = manifest.version ?? '0.1.1';
    process.env.WEB_BASE_URL = 'https://tx.appliance.local';
    process.env.SESSION_SECURE = 'true';
    process.env.WORKER_INLINE = 'true';
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => restore(saved));

  it('manifest handshake reports both the appliance platform version and the app manifest version', () => {
    const result = performHandshake();
    expect(result.applianceMode).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.applianceVersion).toBe(process.env.APPLIANCE_VERSION);
    expect(result.manifestVersion).toBeTruthy();
  });

  it('boots and the internal handshake endpoint serves over loopback', async () => {
    const app = createApp();
    // requireInternalNetwork allows loopback (supertest hits 127.0.0.1).
    const res = await request(app).get('/api/internal/appliance/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      app: expect.any(String),
      version: expect.any(String),
      applianceMode: true,
      applianceVersion: process.env.APPLIANCE_VERSION,
      dbSchema: 'vibetc',
      handshake: expect.objectContaining({ status: 'ok', applianceMode: true }),
    });
  });

  it('CORS allowlist follows the appliance-injected WEB_BASE_URL', async () => {
    const app = createApp();
    const preflight = await request(app)
      .options('/api/version')
      .set('Origin', 'https://tx.appliance.local')
      .set('Access-Control-Request-Method', 'GET');
    expect(preflight.headers['access-control-allow-origin']).toBe('https://tx.appliance.local');
  });

  it('does not flag a mismatch when APPLIANCE_VERSION (platform) differs from the manifest (app) version', () => {
    // Two separate concepts — the appliance is on platform v2 while the
    // app image is at 0.1.x. No comparison is meaningful.
    process.env.APPLIANCE_VERSION = '2';
    const result = performHandshake();
    expect(result.status).toBe('ok');
    expect(result.applianceVersion).toBe('2');
  });

  it('keeps upgrade-insecure-requests in CSP when WEB_BASE_URL is HTTPS', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health/live');
    const csp = res.headers['content-security-policy'] ?? '';
    expect(csp).toMatch(/upgrade-insecure-requests/);
  });
});
