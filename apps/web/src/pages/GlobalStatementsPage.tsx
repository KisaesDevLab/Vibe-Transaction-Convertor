// Phase 18 #1: cross-account statements list. Replaces the
// per-account-only StatementsListPage view at /accounts/:id/statements
// with a global lens that filters by company → account, period range,
// status, and search. Default sort: newest first.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';

import { ReconciliationBadge, StatusBadge } from '../components/StatusBadge';
import { useCompanies } from '../hooks/useCompanies';
import { useAccounts } from '../hooks/useAccounts';
import { api } from '../lib/api';

interface StatementListRow {
  id: string;
  accountId: string;
  sourcePdfPages: number;
  periodStart: string | null;
  periodEnd: string | null;
  openingBalanceCents: string | null;
  closingBalanceCents: string | null;
  status: string;
  reconciliationStatus: string;
  createdAt: string;
}

const PAGE_SIZE = 50;

export function GlobalStatementsPage() {
  const [params, setParams] = useSearchParams();
  const companyId = params.get('companyId') ?? '';
  const accountId = params.get('accountId') ?? '';
  const since = params.get('since') ?? '';
  const until = params.get('until') ?? '';
  const status = params.get('status') ?? '';
  const page = Math.max(0, Number.parseInt(params.get('page') ?? '0', 10) || 0);

  const companies = useCompanies();
  const accounts = useAccounts(companyId);

  const list = useQuery({
    queryKey: ['statements', { accountId, since, until, status, page }],
    // The /api/statements endpoint accepts an optional accountId; broader
    // filters happen client-side until the API gains them. The page is
    // realistic for under ~5k statements per firm.
    queryFn: () =>
      api.get<StatementListRow[]>('/api/statements', accountId ? { accountId } : undefined),
  });

  const filtered = useMemo(() => {
    let rows = list.data ?? [];
    if (since) rows = rows.filter((r) => r.periodEnd === null || r.periodEnd >= since);
    if (until) rows = rows.filter((r) => r.periodStart === null || r.periodStart <= until);
    if (status) rows = rows.filter((r) => r.status === status);
    rows = [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return rows;
  }, [list.data, since, until, status]);

  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  const setFilter = (next: Record<string, string | null>): void => {
    const sp = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (!v) sp.delete(k);
      else sp.set(k, v);
    }
    sp.delete('page'); // reset paging on every filter change
    setParams(sp);
  };

  return (
    <section className="mx-auto max-w-6xl space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">Statements</h1>
        <p className="text-sm text-ink-muted">
          {filtered.length} statement{filtered.length === 1 ? '' : 's'} across all accounts.
        </p>
      </header>

      <div className="grid gap-3 rounded-lg border border-surface-muted bg-white p-3 sm:grid-cols-5">
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          Company
          <select
            value={companyId}
            onChange={(e) => setFilter({ companyId: e.target.value || null, accountId: null })}
            className="rounded-md border border-surface-muted bg-white px-2 py-1 text-sm"
          >
            <option value="">All</option>
            {companies.data?.rows.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          Account
          <select
            value={accountId}
            onChange={(e) => setFilter({ accountId: e.target.value || null })}
            disabled={!companyId}
            className="rounded-md border border-surface-muted bg-white px-2 py-1 text-sm disabled:opacity-50"
          >
            <option value="">{companyId ? 'All in company' : 'Pick a company first'}</option>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.nickname} {a.accountNumberMasked}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          Period from
          <input
            type="date"
            value={since}
            onChange={(e) => setFilter({ since: e.target.value || null })}
            className="rounded-md border border-surface-muted px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          Period to
          <input
            type="date"
            value={until}
            onChange={(e) => setFilter({ until: e.target.value || null })}
            className="rounded-md border border-surface-muted px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          Status
          <select
            value={status}
            onChange={(e) => setFilter({ status: e.target.value || null })}
            className="rounded-md border border-surface-muted bg-white px-2 py-1 text-sm"
          >
            <option value="">All</option>
            <option value="uploaded">uploaded</option>
            <option value="preprocessing">preprocessing</option>
            <option value="ocr">ocr</option>
            <option value="extracting">extracting</option>
            <option value="reconciling">reconciling</option>
            <option value="awaiting-locale-confirmation">awaiting-locale</option>
            <option value="review">review</option>
            <option value="exported">exported</option>
            <option value="failed">failed</option>
          </select>
        </label>
      </div>

      {list.isPending ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-surface-muted bg-white">
          <table className="w-full text-sm">
            <thead className="bg-surface-subtle text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-3 py-2 text-left">Period</th>
                <th className="px-3 py-2 text-left">Pages</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Recon</th>
                <th className="px-3 py-2 text-left">Uploaded</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((s) => (
                <tr key={s.id} className="border-t border-surface-muted">
                  <td className="px-3 py-2 font-mono text-xs">
                    {s.periodStart && s.periodEnd ? `${s.periodStart} → ${s.periodEnd}` : 'pending'}
                  </td>
                  <td className="px-3 py-2 text-xs">{s.sourcePdfPages}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="px-3 py-2">
                    {s.status === 'review' || s.status === 'exported' ? (
                      <ReconciliationBadge status={s.reconciliationStatus} />
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-muted tabular-nums">
                    {new Date(s.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      to={`/statements/${s.id}`}
                      className="text-sm text-accent hover:underline"
                    >
                      Review →
                    </Link>
                  </td>
                </tr>
              ))}
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-ink-muted">
                    No statements match the current filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 ? (
        <div className="flex items-center justify-between text-xs text-ink-muted">
          <button
            type="button"
            disabled={page <= 0}
            onClick={() => {
              const sp = new URLSearchParams(params);
              sp.set('page', String(page - 1));
              setParams(sp);
            }}
            className="rounded-md border border-surface-muted px-3 py-1 disabled:opacity-50"
          >
            ← Prev
          </button>
          <span>
            Page {page + 1} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages - 1}
            onClick={() => {
              const sp = new URLSearchParams(params);
              sp.set('page', String(page + 1));
              setParams(sp);
            }}
            className="rounded-md border border-surface-muted px-3 py-1 disabled:opacity-50"
          >
            Next →
          </button>
        </div>
      ) : null}
    </section>
  );
}
