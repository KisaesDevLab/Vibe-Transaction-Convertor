// Merge per-batch vision extractions into one statement-level result.
//
// When a multi-page statement is extracted in page-range batches (see
// image-batch.ts), each batch returns its own ExtractionResult covering only
// the pages it saw. This stitches them back into a single result:
//
//   - transactions: concatenated in page order; each row's batch-local
//     `source_page` is offset to its global page number.
//   - balances: opening from the FIRST batch (it has the statement header),
//     closing from the LAST batch (it has the footer). Middle batches cannot
//     see either, so whatever they emit for balances is intentionally dropped.
//   - period: the widest span across batches (min start, max end) — ISO
//     YYYY-MM-DD compares lexicographically = chronologically.
//   - account / institution: the first batch that actually carries a value.
//   - source_date_format: the batch that reported it with the highest
//     confidence (the header batch usually wins).
//   - notes: all non-empty batch notes joined.
//
// A single-batch statement returns its sole result unchanged (startPage is 1,
// so the source_page offset is a no-op).

import { schemas } from '@vibe-tx-converter/shared';

type ExtractionResult = schemas.extraction.ExtractionResult;

export interface MergePart {
  data: ExtractionResult;
  // 1-based global page number of the batch's first image (from ImageBatch).
  startPage: number;
}

const NOTES_MAX = 2000;

export const mergeExtractionResults = (parts: MergePart[]): ExtractionResult => {
  if (parts.length === 0) {
    throw new Error('mergeExtractionResults: no parts to merge');
  }
  if (parts.length === 1 && parts[0]!.startPage <= 1) {
    return parts[0]!.data;
  }

  const first = parts[0]!.data;
  const last = parts[parts.length - 1]!.data;

  // Transactions in page order, with source_page lifted from batch-local to
  // global. startPage is 1-based and source_page is 1-based within the batch,
  // so the global page is source_page + (startPage - 1).
  const transactions = parts.flatMap(({ data, startPage }) =>
    data.transactions.map((t) => ({
      ...t,
      source_page: t.source_page + (startPage - 1),
    })),
  );

  // First batch that carries an account masked number / type hint.
  const account =
    parts.find((p) => p.data.account.masked_number != null || p.data.account.type_hint != null)
      ?.data.account ?? first.account;
  const institution =
    parts.find((p) => {
      const n = p.data.institution.name;
      return n != null && n.length > 0;
    })?.data.institution ?? first.institution;

  // Widest period across batches.
  const period = {
    start: parts.reduce(
      (min, p) => (p.data.period.start < min ? p.data.period.start : min),
      first.period.start,
    ),
    end: parts.reduce(
      (max, p) => (p.data.period.end > max ? p.data.period.end : max),
      first.period.end,
    ),
  };

  // Opening from the first batch (header), closing from the last (footer).
  const balances = {
    opening_cents: first.balances.opening_cents,
    closing_cents: last.balances.closing_cents,
  };

  // Highest-confidence source_date_format wins.
  const source_date_format = parts.reduce(
    (best, p) =>
      p.data.source_date_format.confidence > best.confidence ? p.data.source_date_format : best,
    first.source_date_format,
  );

  const noteList = parts
    .map((p) => p.data.notes)
    .filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
  const notes = noteList.length > 0 ? noteList.join(' ').slice(0, NOTES_MAX) : undefined;

  const merged: ExtractionResult = {
    account,
    institution,
    period,
    balances,
    transactions,
    source_date_format,
    ...(notes !== undefined ? { notes } : {}),
  };
  return merged;
};
