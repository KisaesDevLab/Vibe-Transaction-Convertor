// Split-multi-account modal. Shown when the worker detected multiple
// account numbers in one PDF and the operator chooses "Split" instead of
// "Acknowledge". Each detected segment gets a dropdown of accounts in the
// parent's company; when submitted we POST one entry per segment to
// /api/statements/:id/split.
//
// Phase 14 #14.

import { useState } from 'react';

import type { SplitInput } from '../hooks/useStatementsList';

interface DetectedSplit {
  last4: string;
  pageStart: number; // 0-based index per multi-account-detector
  pageEnd: number; // 0-based index inclusive
}

interface DetectedSplits {
  multiAccount: boolean;
  uniqueLast4: string[];
  splits: DetectedSplit[];
}

interface AccountOption {
  id: string;
  nickname: string;
  accountNumberMasked: string;
  financialInstitution: string;
}

export function SplitStatementModal({
  detectedSplits,
  accounts,
  parentAccountId,
  isPending,
  onClose,
  onSubmit,
}: {
  detectedSplits: DetectedSplits;
  accounts: AccountOption[];
  parentAccountId: string;
  isPending: boolean;
  onClose: () => void;
  onSubmit: (input: SplitInput) => Promise<void>;
}) {
  // Each row corresponds to one detected segment; operator picks the
  // accountId. Default the first segment to the parent account so the
  // common case is a single click.
  const [picks, setPicks] = useState<Array<string | ''>>(() =>
    detectedSplits.splits.map((_, i) => (i === 0 ? parentAccountId : '')),
  );
  const [error, setError] = useState<string | null>(null);

  const allChosen = picks.every((p) => p.length > 0);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (!allChosen) {
      setError('Pick an account for every segment.');
      return;
    }
    const splits = detectedSplits.splits.map((sp, i) => ({
      accountId: picks[i]!,
      pageStart: sp.pageStart + 1, // detector is 0-based; API is 1-based
      pageEnd: sp.pageEnd + 1,
    }));
    await onSubmit({ splits });
  };

  return (
    <div
      role="dialog"
      aria-modal
      className="fixed inset-0 z-30 grid place-items-center bg-ink/40 px-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form className="w-full max-w-2xl space-y-4 rounded-xl bg-white p-6" onSubmit={handleSubmit}>
        <div>
          <h2 className="text-lg font-semibold">Split into per-account statements</h2>
          <p className="mt-1 text-sm text-ink-muted">
            We detected {detectedSplits.uniqueLast4.length} account numbers in this PDF. Pick which
            account each segment belongs to. Each segment becomes its own statement; extraction
            re-runs against just those pages so reconciliation isn&apos;t cross-account.
          </p>
        </div>

        <div className="overflow-hidden rounded-md border border-surface-muted">
          <table className="w-full text-sm">
            <thead className="bg-surface-subtle text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-3 py-2 text-left">Detected last4</th>
                <th className="px-3 py-2 text-left">Pages</th>
                <th className="px-3 py-2 text-left">Account</th>
              </tr>
            </thead>
            <tbody>
              {detectedSplits.splits.map((sp, i) => (
                <tr key={i} className="border-t border-surface-muted">
                  <td className="px-3 py-2 font-mono">••••{sp.last4}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {sp.pageStart + 1}–{sp.pageEnd + 1}
                  </td>
                  <td className="px-3 py-2">
                    <select
                      required
                      value={picks[i] ?? ''}
                      onChange={(e) => {
                        const next = [...picks];
                        next[i] = e.target.value;
                        setPicks(next);
                      }}
                      className="w-full rounded-md border border-surface-muted bg-white px-2 py-1.5 text-sm"
                    >
                      <option value="">— choose account —</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.nickname} {a.accountNumberMasked} ({a.financialInstitution})
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        <p className="text-xs text-ink-subtle">
          The original statement is kept as an audit marker (status: <code>failed</code> with a
          superseded message). All its transactions are wiped — extraction re-runs on each slice
          independently.
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-surface-muted px-3 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!allChosen || isPending}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            {isPending ? 'Splitting…' : `Split into ${detectedSplits.splits.length} statements`}
          </button>
        </div>
      </form>
    </div>
  );
}
