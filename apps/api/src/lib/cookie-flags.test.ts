// Cookie scoping tests — BuildPlan §29.16, §29.17.
// Host-only cookies (no `Domain` attribute) are the strictest scoping
// the browser offers and the right default for sibling Vibe apps on a
// shared appliance. SESSION_COOKIE_DOMAIN is the explicit override.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cookieDomain, cookiePath, cookieSecure } from './cookie-flags.js';

const ENV_KEYS = ['SESSION_COOKIE_DOMAIN', 'SESSION_SECURE', 'NODE_ENV'] as const;

describe('cookie-flags', () => {
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

  describe('cookieDomain()', () => {
    it('returns undefined by default — host-only cookies for per-subdomain scoping', () => {
      expect(cookieDomain()).toBeUndefined();
    });

    it('returns SESSION_COOKIE_DOMAIN when set', () => {
      process.env.SESSION_COOKIE_DOMAIN = 'tx.appliance.local';
      expect(cookieDomain()).toBe('tx.appliance.local');
    });

    it('treats empty/whitespace SESSION_COOKIE_DOMAIN as unset', () => {
      process.env.SESSION_COOKIE_DOMAIN = '   ';
      expect(cookieDomain()).toBeUndefined();
    });

    it('trims surrounding whitespace', () => {
      process.env.SESSION_COOKIE_DOMAIN = '  tx.appliance.local  ';
      expect(cookieDomain()).toBe('tx.appliance.local');
    });
  });

  describe('cookiePath()', () => {
    it('always returns "/"', () => {
      expect(cookiePath()).toBe('/');
    });
  });

  describe('cookieSecure()', () => {
    it('defaults to false outside production', () => {
      expect(cookieSecure()).toBe(false);
    });

    it('respects explicit SESSION_SECURE=true', () => {
      process.env.SESSION_SECURE = 'true';
      expect(cookieSecure()).toBe(true);
    });

    it('respects explicit SESSION_SECURE=false in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.SESSION_SECURE = 'false';
      expect(cookieSecure()).toBe(false);
    });

    it('falls back to NODE_ENV=production when SESSION_SECURE is unset', () => {
      process.env.NODE_ENV = 'production';
      expect(cookieSecure()).toBe(true);
    });
  });
});
