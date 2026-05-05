// Phase 18 #6a/#6b: locale-confirmation banner shown when the LLM
// returned source_date_format = AMBIGUOUS. Operators see a parse preview
// for each candidate format applied to a representative ambiguous date,
// so they can pick the right one without flipping back to the source PDF.

import { useState } from 'react';

const SAMPLE = '03/04/2026';

const monthName = (m: number): string =>
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1] ??
  '?';

interface ParseResult {
  iso: string;
  human: string;
  invalid?: string;
}

const parseAs = (sample: string, format: 'MDY' | 'DMY' | 'YMD'): ParseResult => {
  const parts = sample.split(/[/\-.]/);
  if (parts.length !== 3) return { iso: '', human: '', invalid: 'unparseable' };
  const [a, b, c] = parts;
  let yyyy: string;
  let mm: string;
  let dd: string;
  if (format === 'MDY') {
    [mm, dd, yyyy] = [a!, b!, c!];
  } else if (format === 'DMY') {
    [dd, mm, yyyy] = [a!, b!, c!];
  } else {
    [yyyy, mm, dd] = [a!, b!, c!];
  }
  const m = Number(mm);
  const d = Number(dd);
  if (m < 1 || m > 12) return { iso: '', human: '', invalid: `month ${m} out of range` };
  if (d < 1 || d > 31) return { iso: '', human: '', invalid: `day ${d} out of range` };
  return {
    iso: `${yyyy.padStart(4, '20')}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`,
    human: `${monthName(m)} ${d}, ${yyyy}`,
  };
};

export function LocaleConfirmBanner({
  onConfirm,
  isPending,
}: {
  onConfirm: (fmt: 'MDY' | 'DMY' | 'YMD') => Promise<void>;
  isPending: boolean;
}) {
  const [showWhy, setShowWhy] = useState(false);

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <h2 className="text-base font-semibold">Date format ambiguous</h2>
      <p className="mt-1">
        We extracted dates from this PDF but couldn&apos;t tell whether the day or the month comes
        first. Pick the right one — extraction will re-run and exports unblock once reconciliation
        is verified.
      </p>

      <div className="mt-3 overflow-hidden rounded-md border border-amber-200 bg-white">
        <table className="w-full text-xs">
          <thead className="bg-amber-100/60 text-left">
            <tr>
              <th className="px-3 py-1.5 font-medium">Format</th>
              <th className="px-3 py-1.5 font-medium">
                <code>{SAMPLE}</code> would parse as
              </th>
              <th className="px-3 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {(['MDY', 'DMY', 'YMD'] as const).map((fmt) => {
              const r = parseAs(SAMPLE, fmt);
              return (
                <tr key={fmt} className="border-t border-amber-200">
                  <td className="px-3 py-2 font-mono">{fmt}</td>
                  <td className="px-3 py-2">
                    {r.invalid ? (
                      <span className="text-red-700">invalid — {r.invalid}</span>
                    ) : (
                      <>
                        <span className="font-mono">{r.iso}</span>{' '}
                        <span className="text-ink-muted">({r.human})</span>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      disabled={isPending || !!r.invalid}
                      onClick={() => void onConfirm(fmt)}
                      className={
                        fmt === 'MDY'
                          ? 'rounded-md bg-amber-700 px-3 py-1 text-xs font-medium text-white disabled:opacity-50'
                          : 'rounded-md border border-amber-700 px-3 py-1 text-xs font-medium text-amber-900 disabled:opacity-50'
                      }
                    >
                      Use {fmt}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <button
        type="button"
        onClick={() => setShowWhy((v) => !v)}
        className="mt-3 text-xs text-amber-900 underline"
      >
        {showWhy ? 'Hide' : 'Why is this ambiguous?'}
      </button>
      {showWhy ? (
        <div className="mt-2 rounded-md bg-white/60 p-3 text-xs text-amber-900">
          <p>
            The LLM saw dates where every day could have been the month and vice versa (every value
            ≤ 12) and no textual disambiguators (no month names like &ldquo;Mar&rdquo;, no period
            banner like &ldquo;January 2026&rdquo;). Common culprits:
          </p>
          <ul className="mt-1 ml-5 list-disc">
            <li>European banks using DD/MM/YYYY without a year qualifier.</li>
            <li>Statements where every transaction in the period was on day 1–12.</li>
            <li>OCR that lost the textual month header.</li>
          </ul>
          <p className="mt-1">
            If you have the source PDF in front of you, look for a date that&apos;s unambiguous (day
            &gt; 12) — that disambiguates the rest.
          </p>
        </div>
      ) : null}
    </div>
  );
}
