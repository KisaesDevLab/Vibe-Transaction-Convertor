import { describe, expect, it } from 'vitest';
import { ok, err, isOk, isErr, unwrap, unwrapOr, map, mapErr } from './result.js';

describe('result', () => {
  it('ok / err narrow correctly', () => {
    const r = ok(42);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    expect(unwrap(r)).toBe(42);
  });

  it('unwrap on Err throws; unwrapOr returns the fallback', () => {
    const r = err('boom');
    expect(() => unwrap(r)).toThrow();
    expect(unwrapOr(r, 7)).toBe(7);
  });

  it('map only applies on Ok; mapErr only on Err', () => {
    expect(map(ok(2), (n) => n * 3)).toEqual(ok(6));
    expect(map(err('x'), (n: number) => n * 3)).toEqual(err('x'));
    expect(mapErr(err('x'), (s) => s.toUpperCase())).toEqual(err('X'));
  });
});
