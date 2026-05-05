import type { FidirEntry } from './types.js';

// The vendored FIDIR file is line-oriented `KEY=value` records separated by
// one or more blank lines. Recognized keys: INTU.BID, INTU.ORG, BANK_NAME,
// URL. Unknown keys are kept under `raw` so format extensions don't lose data.
//
// A record is considered valid only if it has at least INTU.BID, INTU.ORG,
// and BANK_NAME. Malformed lines are skipped with a warning callback.

export interface ParseFidirOptions {
  onWarning?: (msg: string, lineNumber: number) => void;
}

const trimEol = (s: string): string => s.replace(/\r$/, '');

export const parseFidir = (input: string, opts: ParseFidirOptions = {}): FidirEntry[] => {
  const lines = input.split('\n').map(trimEol);
  const entries: FidirEntry[] = [];
  let current: Record<string, string> = {};
  let lineNumber = 0;
  const warn = opts.onWarning ?? (() => {});

  const flush = (): void => {
    const intuBid = current['INTU.BID'];
    const intuOrg = current['INTU.ORG'];
    const bankName = current['BANK_NAME'];
    if (intuBid && intuOrg && bankName) {
      const entry: FidirEntry = {
        intuBid: intuBid.trim(),
        intuOrg: intuOrg.trim(),
        bankName: bankName.trim(),
        country: 'US',
        raw: { ...current },
      };
      const url = current['URL']?.trim();
      if (url) entry.url = url;
      entries.push(entry);
    } else if (Object.keys(current).length > 0) {
      warn(
        `record skipped: missing one of INTU.BID/INTU.ORG/BANK_NAME (had ${Object.keys(current).join(',')})`,
        lineNumber,
      );
    }
    current = {};
  };

  for (const raw of lines) {
    lineNumber += 1;
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) {
      flush();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) {
      warn(`malformed line (no '='): ${line.slice(0, 120)}`, lineNumber);
      continue;
    }
    const key = line.slice(0, eq).trim().toUpperCase();
    const value = line.slice(eq + 1).trim();
    current[key] = value;
  }
  flush();

  return entries;
};
