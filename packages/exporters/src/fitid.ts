import { createHash } from 'node:crypto';

import { normalizeDescription } from './trntype-rules.js';

// FITID derivation per ADR-005:
//   FITID = "VTC-" + sha1(date | amount_cents | normalized_desc | seq_in_day).slice(0, 16)
// Total length: 4 + 16 = 20 chars. Stable across re-imports of the same
// PDF; disambiguates same-day-same-amount transactions via seq_in_day.

export interface FitidInput {
  postedDate: string; // YYYY-MM-DD
  amountCents: bigint | number;
  description: string;
  seqInDay: number; // 0-based ordinal within the day
}

export const computeFitid = (input: FitidInput): string => {
  const norm = normalizeDescription(input.description);
  const amt = (
    typeof input.amountCents === 'bigint' ? input.amountCents : BigInt(input.amountCents)
  ).toString();
  const payload = `${input.postedDate}|${amt}|${norm}|${input.seqInDay}`;
  const hash = createHash('sha1').update(payload).digest('hex').slice(0, 16);
  return `VTC-${hash}`;
};

// Compute seq_in_day for a list of transactions sharing a posted_date.
// Order them deterministically by (sourceLine, amount, description) so
// re-extraction produces stable seqs (ADR-016 determinism).
export interface SeqInputRow {
  postedDate: string;
  amountCents: bigint | number;
  description: string;
  sourceLine?: number;
}

export const assignSeqInDay = <T extends SeqInputRow>(
  rows: T[],
): Array<T & { seqInDay: number }> => {
  // Group by date carrying the original index so we can restore input
  // order after computing seq within each group. The previous
  // implementation tried to restore order via rows.indexOf() on spread
  // copies — which always returns -1 — so output was grouped-by-date
  // not input-order. Worker code assumes seqAssigned[i] aligns with
  // rows[i]; now it does.
  const byDate = new Map<string, Array<{ row: T; originalIndex: number }>>();
  rows.forEach((row, originalIndex) => {
    const list = byDate.get(row.postedDate) ?? [];
    list.push({ row, originalIndex });
    byDate.set(row.postedDate, list);
  });

  const seqByOriginalIndex = new Map<number, number>();
  for (const [, group] of byDate) {
    group.sort((a, b) => {
      const lineA = a.row.sourceLine ?? Number.MAX_SAFE_INTEGER;
      const lineB = b.row.sourceLine ?? Number.MAX_SAFE_INTEGER;
      if (lineA !== lineB) return lineA - lineB;
      const amtA =
        typeof a.row.amountCents === 'bigint' ? a.row.amountCents : BigInt(a.row.amountCents);
      const amtB =
        typeof b.row.amountCents === 'bigint' ? b.row.amountCents : BigInt(b.row.amountCents);
      if (amtA !== amtB) return amtA < amtB ? -1 : 1;
      return a.row.description.localeCompare(b.row.description);
    });
    group.forEach((item, seq) => {
      seqByOriginalIndex.set(item.originalIndex, seq);
    });
  }

  return rows.map((row, idx) => ({ ...row, seqInDay: seqByOriginalIndex.get(idx) ?? 0 }));
};
