import { Link, useParams } from 'react-router-dom';

import { useStatementsByAccount } from '../hooks/useStatementsList';
import { useAccount } from '../hooks/useStatements';

export function StatementsListPage() {
  const { accountId = '' } = useParams();
  const account = useAccount(accountId);
  const list = useStatementsByAccount(accountId);

  if (account.isPending || list.isPending)
    return <p className="text-sm text-ink-muted">Loading…</p>;
  if (!account.data) return <p>Account not found</p>;

  return (
    <section className="mx-auto max-w-5xl">
      <Link to={`/accounts/${accountId}`} className="text-sm text-ink-muted hover:text-ink">
        ← Account
      </Link>
      <header className="mt-2 mb-6">
        <h1 className="text-2xl font-semibold">Statements — {account.data.nickname}</h1>
        <p className="text-sm text-ink-muted">{(list.data ?? []).length} statement(s)</p>
      </header>

      {!list.data || list.data.length === 0 ? (
        <div className="rounded-lg border border-dashed border-surface-muted p-8 text-center">
          <p className="text-sm text-ink-muted">
            No statements yet — upload one on the account page.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-surface-muted overflow-hidden rounded-lg border border-surface-muted bg-white">
          {list.data.map((s) => (
            <li key={s.id} className="px-4 py-3">
              <Link to={`/statements/${s.id}`} className="font-medium hover:underline">
                {s.periodStart && s.periodEnd
                  ? `${s.periodStart} → ${s.periodEnd}`
                  : `Statement ${s.id.slice(0, 8)}`}
              </Link>
              <p className="text-xs text-ink-subtle">
                Status: {s.status} · Reconciliation: {s.reconciliationStatus}
                {s.errorMessage ? ` · ${s.errorMessage}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
