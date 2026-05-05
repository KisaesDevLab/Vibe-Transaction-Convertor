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
  const grouped = new Map<string, T[]>();
  for (const r of rows) {
    const list = grouped.get(r.postedDate) ?? [];
    list.push(r);
    grouped.set(r.postedDate, list);
  }
  const out: Array<T & { seqInDay: number }> = [];
  for (const [, group] of grouped) {
    group.sort((a, b) => {
      const lineA = a.sourceLine ?? Number.MAX_SAFE_INTEGER;
      const lineB = b.sourceLine ?? Number.MAX_SAFE_INTEGER;
      if (lineA !== lineB) return lineA - lineB;
      const amtA = typeof a.amountCents === 'bigint' ? a.amountCents : BigInt(a.amountCents);
      const amtB = typeof b.amountCents === 'bigint' ? b.amountCents : BigInt(b.amountCents);
      if (amtA !== amtB) return amtA < amtB ? -1 : 1;
      return a.description.localeCompare(b.description);
    });
    let seq = 0;
    for (const row of group) {
      out.push({ ...row, seqInDay: seq });
      seq += 1;
    }
  }
  // preserve the original input ordering for downstream stability
  out.sort((a, b) => {
    const idxA = rows.indexOf(a as T);
    const idxB = rows.indexOf(b as T);
    return idxA - idxB;
  });
  return out;
};
