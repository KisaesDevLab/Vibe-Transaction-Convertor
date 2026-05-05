// The Golden Rule of bank-statement reconciliation (ADR-010):
//   opening_balance + sum(transactions) = closing_balance
// Cents-exact comparison. Anything else is a discrepancy and blocks
// export by default.

export interface ReconcileInput {
  openingBalanceCents: bigint;
  closingBalanceCents: bigint;
  transactions: Array<{ amountCents: bigint }>;
  // Optional period bounds for defense-in-depth (ADR-014).
  periodStart?: string | null | undefined; // YYYY-MM-DD
  periodEnd?: string | null | undefined; // YYYY-MM-DD
  transactionDates?: string[] | undefined; // posted_date for each row, in order
}

export type ReconciliationStatus = 'verified' | 'discrepancy' | 'failed';

export interface ReconcileResult {
  status: ReconciliationStatus;
  expectedClosingCents: bigint;
  actualClosingCents: bigint;
  deltaCents: bigint;
  periodBoundsViolations: number;
  message?: string;
}

export const reconcileGoldenRule = (input: ReconcileInput): ReconcileResult => {
  let sum = 0n;
  for (const tx of input.transactions) sum += tx.amountCents;
  const expected = input.openingBalanceCents + sum;
  const delta = input.closingBalanceCents - expected;

  let violations = 0;
  if (input.periodStart && input.periodEnd && input.transactionDates) {
    for (const d of input.transactionDates) {
      if (d < input.periodStart || d > input.periodEnd) violations += 1;
    }
  }

  if (delta === 0n) {
    return {
      status: 'verified',
      expectedClosingCents: expected,
      actualClosingCents: input.closingBalanceCents,
      deltaCents: 0n,
      periodBoundsViolations: violations,
    };
  }
  return {
    status: 'discrepancy',
    expectedClosingCents: expected,
    actualClosingCents: input.closingBalanceCents,
    deltaCents: delta,
    periodBoundsViolations: violations,
    message: `discrepancy of ${delta} cents (expected ${expected}, actual ${input.closingBalanceCents})`,
  };
};

// Repair pass — try a small set of corrections that often resolve a
// single-cent or sign-flip discrepancy. Returns the modified transaction
// list AND a description of the fix; if no fix found, returns null.
//
// Repair rules (in order):
//   1. If exactly one transaction's amount has the wrong sign such that
//      flipping it closes delta exactly, flip it.
//   2. If delta == amount of exactly one transaction, drop that
//      transaction (likely a duplicate header/footer line picked up).
//   3. If delta == 0 nothing to do.
export interface RepairCandidate {
  transactions: Array<{ amountCents: bigint; description?: string }>;
  fixDescription: string;
}

export const repairPass = (
  txs: Array<{ amountCents: bigint; description?: string }>,
  delta: bigint,
): RepairCandidate | null => {
  if (delta === 0n) return null;

  // delta = actual_closing - expected_closing = actual - (opening + sum)
  // After flipping txs[i] from a to -a:
  //   new_sum = sum - a + (-a) = sum - 2a
  //   new_expected = opening + new_sum
  //   new_delta = actual - new_expected = delta + 2a
  for (let i = 0; i < txs.length; i += 1) {
    const tx = txs[i]!;
    if (delta + 2n * tx.amountCents === 0n) {
      const next = txs.map((t, j) => (j === i ? { ...t, amountCents: -tx.amountCents } : t));
      return {
        transactions: next,
        fixDescription: `flip-sign on row ${i} (${tx.description ?? 'n/a'})`,
      };
    }
  }

  // After dropping txs[i] with amount a:
  //   new_sum = sum - a; new_expected = expected - a; new_delta = delta + a
  for (let i = 0; i < txs.length; i += 1) {
    const tx = txs[i]!;
    if (delta + tx.amountCents === 0n) {
      const next = txs.filter((_, j) => j !== i);
      return {
        transactions: next,
        fixDescription: `drop row ${i} (${tx.description ?? 'n/a'})`,
      };
    }
  }

  return null;
};
