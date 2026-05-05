import { describe, expect, it } from 'vitest';
import { isValidAbaRouting } from './aba.js';

describe('isValidAbaRouting', () => {
  it('accepts known-good routing numbers', () => {
    // Wells Fargo 121000248 — passes ABA mod-10
    expect(isValidAbaRouting('121000248')).toBe(true);
    // Chase 021000021 — passes
    expect(isValidAbaRouting('021000021')).toBe(true);
  });

  it('rejects mangled checksums', () => {
    expect(isValidAbaRouting('121000249')).toBe(false);
    expect(isValidAbaRouting('000000000')).toBe(true); // edge case: all zeros checksums to 0
    expect(isValidAbaRouting('123456789')).toBe(false);
  });

  it('rejects non-9-digit input', () => {
    expect(isValidAbaRouting('12100024')).toBe(false);
    expect(isValidAbaRouting('1210002488')).toBe(false);
    expect(isValidAbaRouting('abcdefghi')).toBe(false);
    expect(isValidAbaRouting('')).toBe(false);
  });
});
