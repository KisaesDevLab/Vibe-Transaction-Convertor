import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ReconciliationBadge, StatusBadge } from '../components/StatusBadge';
import { useStatementsByAccount } from '../hooks/useStatementsList';
import { useAccount } from '../hooks/useStatements';

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All' },
  { value: 'review', label: 'Review' },
  { value: 'extracting,reconciling,preprocessing,ocr', label: 'In flight' },
  { value: 'awaiting-locale-confirmation', label: 'Locale check' },
  { value: 'exported', label: 'Exported' },
  { value: 'failed', label: 'Failed' },
];

export function StatementsListPage() {
  const { accountId = '' } = useParams();
  const account = useAccount(accountId);
  const list = useStatementsByAccount(accountId);
  const [statusFilter, setStatusFilter] = useState('');
  const [violationsOnly, setViolationsOnly] = useState(false);
  const [search, setSearch] = useState('');

  const rows = useMemo(() => {
    if (!list.data) return [];
    let filtered = list.data;
    if (statusFilter.length > 0) {
      const wanted = new Set(statusFilter.split(','));
      filtered = filtered.filter((s) => wanted.has(s.status));
    }
    if (violationsOnly) filtered = filtered.filter((s) => (s.periodBoundsViolations ?? 0) > 0);
    if (search.trim().length > 0) {
      const q = search.trim().toLowerCase();
      filtered = filtered.filter((s) => s.id.toLowerCase().includes(q));
    }
    return [...filtered].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [list.data, statusFilter, violationsOnly, search]);

  if (account.isPending || list.isPending)
    return <p className="text-sm text-ink-muted">Loading…</p>;
  if (!account.data) return <p>Account not found</p>;

  return (
    <section className="mx-auto max-w-5xl space-y-4">
      <Link to={`/accounts/${accountId}`} className="text-sm text-ink-muted hover:text-ink">
        ← Account
      </Link>
      <header>
        <h1 className="text-2xl font-semibold">Statements — {account.data.nickname}</h1>
        <p className="text-sm text-ink-muted">
          {(list.data ?? []).length} total · {rows.length} shown
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setStatusFilter(f.value)}
            className={`rounded-full border px-3 py-1 text-xs ${
              statusFilter === f.value
                ? 'border-accent bg-accent text-accent-fg'
                : 'border-surface-muted hover:bg-surface-subtle'
            }`}
          >
            {f.label}
          </button>
        ))}
        <label className="ml-2 flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={violationsOnly}
            onChange={(e) => setViolationsOnly(e.target.checked)}
          />
          Has period-bounds violations
        </label>
        <input
          type="search"
          placeholder="Search by id…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ml-auto rounded-md border border-surface-muted px-3 py-1.5 text-xs"
        />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-surface-muted p-8 text-center">
          <p className="text-sm text-ink-muted">
            {(list.data ?? []).length === 0
              ? 'No statements yet — upload one on the account page.'
              : 'No statements match the current filters.'}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-surface-muted overflow-hidden rounded-lg border border-surface-muted bg-white">
          {rows.map((s) => (
            <li key={s.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <Link to={`/statements/${s.id}`} className="font-medium hover:underline">
                  {s.periodStart && s.periodEnd
                    ? `${s.periodStart} → ${s.periodEnd}`
                    : `Statement ${s.id.slice(0, 8)}`}
                </Link>
                <div className="flex items-center gap-2">
                  <StatusBadge status={s.status} />
                  <ReconciliationBadge
                    status={s.reconciliationStatus}
                    periodBoundsViolations={s.periodBoundsViolations}
                  />
                </div>
              </div>
              <p className="mt-1 text-xs text-ink-subtle">
                {s.sourcePdfPages} page{s.sourcePdfPages === 1 ? '' : 's'} · uploaded{' '}
                {new Date(s.createdAt).toLocaleString()}
                {s.errorMessage ? ` · ${s.errorMessage}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
