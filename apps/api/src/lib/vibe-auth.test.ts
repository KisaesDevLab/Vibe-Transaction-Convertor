import { describe, expect, it } from 'vitest';

import { stripUnsafeReturnTo } from './vibe-auth.js';

const START = '/auth/oidc/start';

describe('stripUnsafeReturnTo', () => {
  it('leaves URLs without return_to, or with a same-origin path, untouched', () => {
    expect(stripUnsafeReturnTo(START)).toBe(START);
    expect(stripUnsafeReturnTo(`${START}?test=1`)).toBe(`${START}?test=1`);
    const keep = `${START}?return_to=%2Fstatements%2Fabc%3Ftab%3Dreview`;
    expect(stripUnsafeReturnTo(keep)).toBe(keep);
  });

  it.each([
    ['a tab browsers strip from Location', '/%09/evil.example/x'],
    ['a protocol-relative URL', '//evil.example/x'],
    ['a backslash browsers read as a slash', '/%5Cevil.example/x'],
    ['an absolute URL', 'https://evil.example/x'],
    ['CR/LF', '/%0D%0ASet-Cookie:%20x=1'],
    ['a relative path', 'evil.example/x'],
  ])('drops return_to carrying %s', (_label, value) => {
    expect(stripUnsafeReturnTo(`${START}?return_to=${value}`)).toBe(START);
    expect(stripUnsafeReturnTo(`${START}?test=1&return_to=${value}`)).toBe(`${START}?test=1`);
  });

  it('drops every return_to when any one of them is unsafe', () => {
    expect(stripUnsafeReturnTo(`${START}?return_to=/ok&return_to=//evil.example`)).toBe(START);
  });
});
