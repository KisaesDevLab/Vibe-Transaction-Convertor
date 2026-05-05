import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ACCOUNT_TYPE_LABELS } from '@vibe-tx-converter/shared';

import { AccountFormDialog } from '../components/AccountFormDialog';
import { useAccounts, useDeleteAccount } from '../hooks/useAccounts';
import { useCompanies } from '../hooks/useCompanies';
import { ApiError } from '../lib/api';

export function CompanyDetailPage() {
  const { companyId = '' } = useParams();
  const list = useCompanies();
  const company = list.data?.rows.find((c) => c.id === companyId);
  const accounts = useAccounts(companyId);
  const del = useDeleteAccount(companyId);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (list.isPending || accounts.isPending) {
    return <p className="text-sm text-ink-muted">Loading…</p>;
  }
  if (!company) {
    return (
      <section className="mx-auto max-w-3xl">
        <Link to="/companies" className="text-sm text-ink-muted hover:text-ink">
          ← Companies
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Company not found</h1>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-5xl">
      <Link to="/companies" className="text-sm text-ink-muted hover:text-ink">
        ← Companies
      </Link>
      <header className="mt-2 mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{company.name}</h1>
          <p className="text-sm text-ink-muted">
            {accounts.data?.length ?? 0} account{(accounts.data?.length ?? 0) === 1 ? '' : 's'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg"
        >
          Add account
        </button>
      </header>

      {error ? (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {accounts.data && accounts.data.length === 0 ? (
        <div className="rounded-lg border border-dashed border-surface-muted p-8 text-center">
          <p className="text-sm text-ink-muted">
            No accounts yet — add your first account to start uploading statements.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-surface-muted overflow-hidden rounded-lg border border-surface-muted bg-white">
          {accounts.data?.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <Link to={`/accounts/${a.id}`} className="font-medium hover:underline">
                  {a.nickname}{' '}
                  <span className="font-normal text-ink-muted">{a.accountNumberMasked}</span>
                </Link>
                <p className="text-xs text-ink-subtle">
                  {a.financialInstitution} · BID {a.intuBid} · {ACCOUNT_TYPE_LABELS[a.accountType]}{' '}
                  · {a.defaultCsvTemplate}
                </p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  if (!window.confirm(`Delete "${a.nickname}"?`)) return;
                  setError(null);
                  try {
                    await del.mutateAsync({ id: a.id });
                  } catch (err) {
                    setError(err instanceof ApiError ? err.message : 'delete failed');
                  }
                }}
                className="rounded-md border border-danger px-3 py-1.5 text-sm text-danger hover:bg-danger/5"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      {open ? <AccountFormDialog companyId={companyId} onClose={() => setOpen(false)} /> : null}
    </section>
  );
}
