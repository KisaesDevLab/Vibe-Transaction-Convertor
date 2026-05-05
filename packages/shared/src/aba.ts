// ABA routing-number checksum (mod-10 weighted). Returns true when the
// 9-digit number satisfies the standard ABA validity rule.
//
//   sum = 3*(d1+d4+d7) + 7*(d2+d5+d8) + 1*(d3+d6+d9)
//   sum mod 10 === 0
//
// Per ADR-014 / Phase 8 item 8: failures surface a non-blocking warning;
// the schema does not reject — QuickBooks itself doesn't validate the
// BANKID field.
export const isValidAbaRouting = (input: string): boolean => {
  const trimmed = input.trim();
  if (!/^\d{9}$/.test(trimmed)) return false;
  const d = trimmed.split('').map((c) => Number.parseInt(c, 10));
  const sum =
    3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + 1 * (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
};
