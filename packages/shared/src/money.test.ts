import { describe, expect, it } from 'vitest';
import { cents, formatUsd, decimalString, parseDecimalToCents, sumCents } from './money.js';

describe('money', () => {
  it('cents() rejects non-integer numbers', () => {
    expect(() => cents(1.5)).toThrow();
    expect(cents(123)).toBe(123n);
  });

  it('formatUsd renders with $ and two decimals', () => {
    expect(formatUsd(0n)).toBe('$0.00');
    expect(formatUsd(50n)).toBe('$0.50');
    expect(formatUsd(12345n)).toBe('$123.45');
    expect(formatUsd(-450n)).toBe('-$4.50');
  });

  it('decimalString omits the dollar sign', () => {
    expect(decimalString(12345n)).toBe('123.45');
    expect(decimalString(-450n)).toBe('-4.50');
  });

  it('parseDecimalToCents round-trips with decimalString', () => {
    expect(parseDecimalToCents('123.45')).toBe(12345n);
    expect(parseDecimalToCents('-4.50')).toBe(-450n);
    expect(parseDecimalToCents('$1,234.56')).toBe(123456n);
    expect(() => parseDecimalToCents('abc')).toThrow();
  });

  it('sumCents adds bigints exactly (no float drift)', () => {
    expect(sumCents(10n, 20n)).toBe(30n);
    expect(sumCents(...Array<bigint>(10).fill(10n))).toBe(100n);
  });
});
