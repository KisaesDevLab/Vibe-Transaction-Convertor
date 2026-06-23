// Reconciliation discrepancy analysis (client-side, deterministic).
//
// When the Golden Rule fails (delta = actual_closing − expected_closing ≠ 0),
// these helpers point the operator at the likely misread instead of leaving
// them to hunt through every row:
//   - firstChainBreak: the first row whose PRINTED running balance disagrees
//     with prior_running + amount — the most precise locator when the statement
//     prints a running-balance column.
//   - analyzeDelta: cheap heuristics that explain the net delta (single-row
//     match, sign flip, decimal/digit misread, two-row sum).
//
// All amounts are integer cents (bigint). Nothing here mutates data.

import { formatUsd } from '@vibe-tx-converter/shared';

export interface DiscrepancyTx {
  amountCents: bigint;
  description: string;
  postedDate: string;
  // Present only when the statement prints a per-row running balance; equals
  // actual_running − (prior_running + amount) for this row.
  runningBalanceDeltaCents?: bigint | null;
}

export type DiscrepancyKind =
  | 'chain-break'
  | 'missing-or-dup'
  | 'sign-flip'
  | 'decimal-shift'
  | 'pair-sum';

export interface DiscrepancyHint {
  kind: DiscrepancyKind;
  // 1-based row numbers for display (matches the grid's row numbering).
  rows: number[];
  message: string;
}

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

// The first row where the printed running-balance chain diverges. That row (or
// the one just before it) is where the misread is.
export const firstChainBreak = (
  txs: DiscrepancyTx[],
): { row: number; deltaCents: bigint; tx: DiscrepancyTx } | null => {
  for (let i = 0; i < txs.length; i += 1) {
    const d = txs[i]?.runningBalanceDeltaCents;
    if (d !== null && d !== undefined && d !== 0n) {
      return { row: i + 1, deltaCents: d, tx: txs[i]! };
    }
  }
  return null;
};

// Heuristics explaining `deltaCents` (actual_closing − expected_closing). Ordered
// most-specific first; returns every match so the operator can weigh them.
export const analyzeDelta = (deltaCents: bigint, txs: DiscrepancyTx[]): DiscrepancyHint[] => {
  if (deltaCents === 0n) return [];
  const target = abs(deltaCents);
  const hints: DiscrepancyHint[] = [];

  txs.forEach((t, i) => {
    const a = abs(t.amountCents);
    if (a === 0n) return;
    const label = `row ${i + 1} (${t.description || '—'}, ${formatUsd(t.amountCents)})`;
    if (a === target) {
      hints.push({
        kind: 'missing-or-dup',
        rows: [i + 1],
        message: `Δ equals ${label} — that row may be missing, duplicated, or off by its full amount.`,
      });
    } else if (a * 2n === target) {
      hints.push({
        kind: 'sign-flip',
        rows: [i + 1],
        message: `Δ is 2× ${label} — its sign may be flipped (deposit ↔ withdrawal).`,
      });
    } else if (a * 9n === target) {
      hints.push({
        kind: 'decimal-shift',
        rows: [i + 1],
        message: `Δ is 9× ${label} — likely a decimal/digit misread (value read ~10× too small).`,
      });
    } else if (target * 10n === a * 9n) {
      hints.push({
        kind: 'decimal-shift',
        rows: [i + 1],
        message: `${label} may be ~10× too large (decimal/digit misread).`,
      });
    }
  });

  // Two-row sum — a pair that's collectively missing/duplicated. Bounded so a
  // pathological statement can't hang the UI; single-row hints already cover 1.
  if (hints.length === 0 && txs.length <= 600) {
    outer: for (let i = 0; i < txs.length; i += 1) {
      for (let j = i + 1; j < txs.length; j += 1) {
        if (abs(txs[i]!.amountCents + txs[j]!.amountCents) === target) {
          hints.push({
            kind: 'pair-sum',
            rows: [i + 1, j + 1],
            message: `Δ equals rows ${i + 1} + ${j + 1} combined — that pair may be missing or duplicated.`,
          });
          break outer;
        }
      }
    }
  }

  return hints;
};
