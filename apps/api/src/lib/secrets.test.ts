import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unwrapSecret, wrapSecret } from './secrets.js';

describe('secrets (AES-256-GCM via HKDF from SESSION_SECRET)', () => {
  const original = process.env.SESSION_SECRET;
  beforeEach(() => {
    process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-bytes-long-XXXX';
  });
  afterEach(() => {
    if (original !== undefined) process.env.SESSION_SECRET = original;
    else delete process.env.SESSION_SECRET;
  });

  it('round-trips a wrapped secret', () => {
    const blob = wrapSecret('sk-ant-secret-key-1234');
    expect(unwrapSecret(blob)).toBe('sk-ant-secret-key-1234');
  });

  it('produces fresh nonces each call (different ciphertexts)', () => {
    const a = wrapSecret('same plaintext');
    const b = wrapSecret('same plaintext');
    expect(a.equals(b)).toBe(false);
    expect(unwrapSecret(a)).toBe(unwrapSecret(b));
  });

  it('rejects tamper of the auth tag', () => {
    const blob = wrapSecret('hello');
    blob[12] = blob[12]! ^ 0xff; // flip a bit in the auth tag
    expect(() => unwrapSecret(blob)).toThrow();
  });

  it('refuses when SESSION_SECRET is too short', () => {
    process.env.SESSION_SECRET = 'tiny';
    expect(() => wrapSecret('x')).toThrow(/SESSION_SECRET/);
  });
});
