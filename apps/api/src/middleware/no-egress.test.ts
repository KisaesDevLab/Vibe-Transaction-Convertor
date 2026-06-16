// Phase 27 — invariant from CLAUDE.md ("Zero outbound network calls at
// runtime by default") and from the BuildPlan ("FIDIR is mirrored at
// build/admin time, never fetched live"). This test installs a fetch
// monkey-patch that throws if the API process makes an outbound HTTP
// request to a non-allowlisted host during a normal request lifecycle.
//
// Allowlisted hosts (set inside the firm's perimeter):
//   * 127.0.0.1, localhost, ::1
//   * postgres:// and redis:// connection URIs (handled by their own
//     drivers, not fetch — but we allow them defensively in case a
//     future code path proxies through fetch)
//   * the VIBE_SHIELD_URL host (default 'vibe-shield-gateway') — the
//     on-appliance Shield gateway the OCR/extraction calls flow through
//   * the LLM_GATEWAY_URL host (default 'llm-gateway')
//
// Anything else (api.anthropic.com, api.intuit.com, ofxhome.com, etc.)
// must NOT be reached by a typical request. The optional Anthropic
// provider is opt-in and is exercised by its own provider tests, never
// by the public health endpoint.

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../server.js';

const ALLOWED_HOST_PATTERNS: RegExp[] = [
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i,
  /^https?:\/\/vibe-shield-gateway(:|\/|$)/i,
  /^https?:\/\/llm-gateway(:|\/|$)/i,
  // pg and redis schemes — listed for completeness; pg/ioredis don't
  // route through fetch, but if some future code path did, we wouldn't
  // want to block its localhost-shaped target.
  /^postgres(ql)?:\/\//i,
  /^redis(s)?:\/\//i,
];

const isAllowed = (urlLike: string): boolean =>
  ALLOWED_HOST_PATTERNS.some((re) => re.test(urlLike));

const ENV_KEYS = ['DATABASE_URL', 'REDIS_URL', 'VIBE_SHIELD_URL', 'LLM_GATEWAY_URL'] as const;

describe('no-egress invariant — /api/health/ready makes no outbound requests', () => {
  const original: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  let originalFetch: typeof globalThis.fetch | undefined;
  let outboundAttempts: string[] = [];

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      original[k] = process.env[k];
      delete process.env[k];
    }
    originalFetch = globalThis.fetch;
    outboundAttempts = [];

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (!isAllowed(url)) {
        outboundAttempts.push(url);
        const err = new Error(`disallowed outbound fetch to ${url}`);
        // Tag so the test can distinguish from legitimate dependency errors.
        (err as Error & { code?: string }).code = 'NO_EGRESS_VIOLATION';
        throw err;
      }
      // Configured but unreachable allowlisted dependencies — return a
      // network-error-shaped rejection that the readiness check tolerates
      // (it sets status='fail' but does not throw upward).
      const e = new Error(`stub: ${url} not actually wired in test`);
      throw e;
    }) as typeof fetch;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = original[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (originalFetch !== undefined) globalThis.fetch = originalFetch;
  });

  it('readiness with no deps configured triggers zero outbound calls', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(200); // all unconfigured → ready
    expect(outboundAttempts).toEqual([]);
  });

  it('readiness with allowlisted VIBE_SHIELD + LLM_GATEWAY hosts does not call any disallowed URL', async () => {
    process.env.VIBE_SHIELD_URL = 'http://vibe-shield-gateway:8080';
    process.env.LLM_GATEWAY_URL = 'http://llm-gateway:8081';
    const app = createApp();
    // The two configured deps will fail (no real server) but their URLs
    // are inside the allowlist — the readiness handler converts that
    // into status='fail' / 503 without rethrowing. We assert the
    // allowlist-violation tracker stayed empty.
    const res = await request(app).get('/api/health/ready');
    expect([200, 503]).toContain(res.status);
    expect(outboundAttempts).toEqual([]);
  });

  it('a request to /api/health/live triggers zero outbound calls', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health/live');
    expect(res.status).toBe(200);
    expect(outboundAttempts).toEqual([]);
  });

  it('a request to /api/version triggers zero outbound calls', async () => {
    const app = createApp();
    const res = await request(app).get('/api/version');
    expect(res.status).toBe(200);
    expect(outboundAttempts).toEqual([]);
  });

  it('a 404 path triggers zero outbound calls', async () => {
    const app = createApp();
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(outboundAttempts).toEqual([]);
  });

  it('the allowlist correctly classifies common URLs', () => {
    expect(isAllowed('http://127.0.0.1:5432/x')).toBe(true);
    expect(isAllowed('http://localhost:6379/')).toBe(true);
    expect(isAllowed('http://vibe-shield-gateway:8080/health')).toBe(true);
    expect(isAllowed('http://llm-gateway:8081/v1/chat/completions')).toBe(true);
    expect(isAllowed('postgres://user:pass@db:5432/vibetc')).toBe(true);
    expect(isAllowed('redis://redis:6379/0')).toBe(true);
    // Disallowed examples — these are the egress targets we never want
    // to see leaving the firm's perimeter at runtime.
    expect(isAllowed('https://api.anthropic.com/v1/messages')).toBe(false);
    expect(isAllowed('https://api.intuit.com/')).toBe(false);
    expect(isAllowed('https://ofxhome.com/api.json')).toBe(false);
    expect(isAllowed('https://www.fficert.org/fficert/dyn/index.do')).toBe(false);
  });
});
