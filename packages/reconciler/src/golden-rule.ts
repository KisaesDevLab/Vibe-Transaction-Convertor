// The Golden Rule of bank-statement reconciliation (ADR-010):
//   opening_balance + sum(transactions) = closing_balance
// Cents-exact comparison. Anything else is a discrepancy and blocks
// export by default.

export interface ReconcileInput {
  openingBalanceCents: bigint;
  closingBalanceCents: bigint;
  transactions: Array<{ amountCents: bigint; runningBalanceCents?: bigint | null }>;
  // Optional period bounds for defense-in-depth (ADR-014).
  periodStart?: string | null | undefined; // YYYY-MM-DD
  periodEnd?: string | null | undefined; // YYYY-MM-DD
  transactionDates?: string[] | undefined; // posted_date for each row, in order
}

// Phase 16 item 3: a row is "suspect" when its running balance disagrees
// with the prior row's runningBalance + this row's amount. Useful both
// for the repair-pass prompt (give the LLM a precise hint) and for the
// review UI (surface a per-row "off by $X" badge).
export interface SuspectRow {
  index: number;
  expectedRunningCents: bigint;
  actualRunningCents: bigint;
  deltaCents: bigint;
}

export const findSuspectRows = (
  openingBalanceCents: bigint,
  txs: Array<{ amountCents: bigint; runningBalanceCents?: bigint | null }>,
): SuspectRow[] => {
  const out: SuspectRow[] = [];
  let priorRunning = openingBalanceCents;
  for (let i = 0; i < txs.length; i += 1) {
    const tx = txs[i]!;
    const expected = priorRunning + tx.amountCents;
    if (tx.runningBalanceCents !== null && tx.runningBalanceCents !== undefined) {
      const delta = tx.runningBalanceCents - expected;
      if (delta !== 0n) {
        out.push({
          index: i,
          expectedRunningCents: expected,
          actualRunningCents: tx.runningBalanceCents,
          deltaCents: delta,
        });
      }
      priorRunning = tx.runningBalanceCents;
    } else {
      priorRunning = expected;
    }
  }
  return out;
};

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

  // Verified is a CONJUNCTION (BuildPlan Phase 16 #2): the balances must tie
  // to the cent AND every row must fall inside the statement period. A
  // consistent MDY/DMY misdetection moves rows across the period banner
  // without changing the sum, so a balance-perfect statement with
  // out-of-period rows is still a discrepancy.
  if (delta === 0n && violations === 0) {
    return {
      status: 'verified',
      expectedClosingCents: expected,
      actualClosingCents: input.closingBalanceCents,
      deltaCents: 0n,
      periodBoundsViolations: 0,
    };
  }
  return {
    status: 'discrepancy',
    expectedClosingCents: expected,
    actualClosingCents: input.closingBalanceCents,
    deltaCents: delta,
    periodBoundsViolations: violations,
    message:
      delta !== 0n
        ? `discrepancy of ${delta} cents (expected ${expected}, actual ${input.closingBalanceCents})`
        : `${violations} transaction(s) dated outside ${input.periodStart}..${input.periodEnd}`,
  };
};

// Repair pass — a cheap heuristic tried before giving up on a balance
// discrepancy. Returns the modified transaction list AND a description of the
// fix, or null when no UNAMBIGUOUS fix exists. A wrong fix is worse than none:
// the worker re-reconciles the candidate and, when it ties, persists the
// statement as `verified`, which un-gates export without anyone looking. So
// neither rule guesses:
//
//   1. Sign flip — applied only when EXACTLY ONE row's sign flip closes the
//      delta. Two or more qualifying rows → we can't tell which is mis-signed.
//   2. Drop duplicate — applied only when the qualifying row has an exact twin
//      earlier in the list (same amount, same description compared trimmed and
//      case-insensitive, same posted date when both carry one, same printed
//      running balance when both carry one): the classic double-captured OCR
//      line. Two legitimate same-day, same-merchant, same-amount rows print
//      DIFFERENT running balances, so they are never twins. A row with no twin
//      is never dropped — a statement short by $500 is far more likely missing
//      a $500 deposit than carrying a phantom $500 withdrawal. Qualifying twins
//      from more than one distinct group are ambiguous → null.
//   3. delta == 0 → nothing to do (null). Rules 1 and 2 both producing a
//      candidate is also ambiguous → null.
export interface RepairTx {
  amountCents: bigint;
  description?: string | undefined;
  postedDate?: string | null | undefined;
  runningBalanceCents?: bigint | null | undefined;
}

export interface RepairCandidate<T extends RepairTx = RepairTx> {
  transactions: T[];
  fixDescription: string;
}

const normalizedDescription = (tx: RepairTx): string => (tx.description ?? '').trim().toLowerCase();

const hasRunningBalance = (tx: RepairTx): boolean =>
  tx.runningBalanceCents !== null && tx.runningBalanceCents !== undefined;

const isExactDuplicate = (a: RepairTx, b: RepairTx): boolean =>
  a.amountCents === b.amountCents &&
  normalizedDescription(a) === normalizedDescription(b) &&
  (!a.postedDate || !b.postedDate || a.postedDate === b.postedDate) &&
  (!hasRunningBalance(a) ||
    !hasRunningBalance(b) ||
    a.runningBalanceCents === b.runningBalanceCents);

export const repairPass = <T extends RepairTx>(
  txs: T[],
  delta: bigint,
): RepairCandidate<T> | null => {
  if (delta === 0n) return null;

  // delta = actual_closing - expected_closing = actual - (opening + sum)
  // After flipping txs[i] from a to -a:
  //   new_sum = sum - a + (-a) = sum - 2a
  //   new_expected = opening + new_sum
  //   new_delta = actual - new_expected = delta + 2a
  const flipCandidates: number[] = [];
  for (let i = 0; i < txs.length; i += 1) {
    if (delta + 2n * txs[i]!.amountCents === 0n) flipCandidates.push(i);
  }

  // After dropping txs[i] with amount a:
  //   new_sum = sum - a; new_expected = expected - a; new_delta = delta + a
  // Only the LATER member of a duplicate pair qualifies (twin j < i), so the
  // first occurrence always survives.
  const dropCandidates: Array<{ index: number; twin: number }> = [];
  for (let i = 0; i < txs.length; i += 1) {
    const tx = txs[i]!;
    if (delta + tx.amountCents !== 0n) continue;
    const twin = txs.findIndex((other, j) => j < i && isExactDuplicate(tx, other));
    if (twin !== -1) dropCandidates.push({ index: i, twin });
  }

  if (flipCandidates.length === 1 && dropCandidates.length === 0) {
    const i = flipCandidates[0]!;
    const tx = txs[i]!;
    return {
      transactions: txs.map((t, j) => (j === i ? { ...t, amountCents: -t.amountCents } : t)),
      fixDescription: `flip-sign on row ${i} (${tx.description ?? 'n/a'})`,
    };
  }

  if (flipCandidates.length === 0 && dropCandidates.length > 0) {
    const drop = dropCandidates[0]!;
    const tx = txs[drop.index]!;
    // Every qualifying row must be a copy of the same line; two different
    // duplicated lines of the same amount leave the choice ambiguous.
    if (!dropCandidates.every((c) => isExactDuplicate(txs[c.index]!, tx))) return null;
    return {
      transactions: txs.filter((_, j) => j !== drop.index),
      fixDescription: `drop duplicate row ${drop.index} (${tx.description ?? 'n/a'}; twin of row ${drop.twin})`,
    };
  }

  return null;
};
