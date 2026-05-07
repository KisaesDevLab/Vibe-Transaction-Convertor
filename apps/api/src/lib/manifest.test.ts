// Appliance manifest handshake tests — BuildPlan §29.11, §29.12, §29.20.
// Boot-time verification that APPLIANCE_VERSION (set by the installer)
// matches the manifest version baked into the image.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { performHandshake, readManifest } from './manifest.js';

const ENV_KEYS = ['APPLIANCE_MODE', 'APPLIANCE_VERSION'] as const;

describe('manifest', () => {
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

  describe('readManifest()', () => {
    it('finds vibe-app.yaml and parses the version field', () => {
      const result = readManifest();
      expect(result.path).toBeTruthy();
      expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(result.error).toBeUndefined();
    });
  });

  describe('performHandshake()', () => {
    it('returns "standalone" when APPLIANCE_MODE is unset', () => {
      const result = performHandshake();
      expect(result.applianceMode).toBe(false);
      expect(result.status).toBe('standalone');
    });

    it('returns "standalone" when APPLIANCE_MODE is anything other than the literal "true"', () => {
      process.env.APPLIANCE_MODE = '1';
      const result = performHandshake();
      expect(result.status).toBe('standalone');
    });

    it('returns "ok" when the installer-injected version matches the manifest', () => {
      const manifest = readManifest();
      expect(manifest.version).toBeTruthy();
      process.env.APPLIANCE_MODE = 'true';
      process.env.APPLIANCE_VERSION = manifest.version!;
      const result = performHandshake();
      expect(result.applianceMode).toBe(true);
      expect(result.status).toBe('ok');
      expect(result.expectedVersion).toBe(manifest.version);
      expect(result.manifestVersion).toBe(manifest.version);
    });

    it('returns "mismatch" when installer version disagrees with the manifest', () => {
      process.env.APPLIANCE_MODE = 'true';
      process.env.APPLIANCE_VERSION = '99.99.99';
      const result = performHandshake();
      expect(result.status).toBe('mismatch');
      expect(result.expectedVersion).toBe('99.99.99');
      expect(result.detail).toMatch(/installer expected 99\.99\.99/);
    });

    it('returns "unknown" when APPLIANCE_VERSION is missing in appliance mode', () => {
      process.env.APPLIANCE_MODE = 'true';
      const result = performHandshake();
      expect(result.status).toBe('unknown');
      expect(result.detail).toMatch(/APPLIANCE_VERSION/);
    });
  });
});
