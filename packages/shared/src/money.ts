export type Cents = bigint;

export const cents = (n: number | bigint | string): Cents => {
  if (typeof n === 'bigint') return n;
  if (typeof n === 'number') {
    if (!Number.isInteger(n)) {
      throw new Error(`cents() expects an integer, got ${n}`);
    }
    return BigInt(n);
  }
  return BigInt(n);
};

export const dollars = (c: Cents): string => formatUsd(c);

export const addCents = (a: Cents, b: Cents): Cents => a + b;

export const sumCents = (...values: Cents[]): Cents => values.reduce((acc, v) => acc + v, 0n);

export const negateCents = (c: Cents): Cents => -c;

export const isZeroCents = (c: Cents): boolean => c === 0n;

const ONE_HUNDRED = 100n;

export const formatUsd = (c: Cents): string => {
  const negative = c < 0n;
  const abs = negative ? -c : c;
  const whole = abs / ONE_HUNDRED;
  const frac = abs % ONE_HUNDRED;
  const fracStr = frac.toString().padStart(2, '0');
  return `${negative ? '-' : ''}$${whole.toString()}.${fracStr}`;
};

export const decimalString = (c: Cents): string => {
  const negative = c < 0n;
  const abs = negative ? -c : c;
  const whole = abs / ONE_HUNDRED;
  const frac = abs % ONE_HUNDRED;
  return `${negative ? '-' : ''}${whole.toString()}.${frac.toString().padStart(2, '0')}`;
};

export const parseDecimalToCents = (input: string): Cents => {
  const trimmed = input.trim().replace(/[$,]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error(`parseDecimalToCents: invalid input "${input}"`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ''] = unsigned.split('.') as [string, string?];
  const fracPadded = (frac ?? '').padEnd(2, '0').slice(0, 2);
  const total = BigInt(whole) * ONE_HUNDRED + BigInt(fracPadded);
  return negative ? -total : total;
};
