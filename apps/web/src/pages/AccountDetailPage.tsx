import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ACCOUNT_TYPE_LABELS, type AccountTypeCode } from '@vibe-tx-converter/shared';

import { StatusBadge, ReconciliationBadge } from '../components/StatusBadge';
import { UploadDropzone } from '../components/UploadDropzone';
import { useToast } from '../components/Toast';
import { fetchRevealedAccount } from '../hooks/useAccounts';
import { useMe } from '../hooks/useAuth';
import { useAccount } from '../hooks/useStatements';
import { useStatementsByAccount } from '../hooks/useStatementsList';
import { ApiError } from '../lib/api';

const REVEAL_DURATION_MS = 30_000;

export function AccountDetailPage() {
  const { accountId = '' } = useParams();
  const account = useAccount(accountId);
  const statements = useStatementsByAccount(accountId);
  const me = useMe();
  const toast = useToast();
  const [revealedNumber, setRevealedNumber] = useState<string | null>(null);
  const [revealMsRemaining, setRevealMsRemaining] = useState<number>(0);

  useEffect(() => {
    if (!revealedNumber) return;
    setRevealMsRemaining(REVEAL_DURATION_MS);
    const interval = setInterval(() => {
      setRevealMsRemaining((ms) => {
        if (ms <= 1000) {
          setRevealedNumber(null);
          clearInterval(interval);
          return 0;
        }
        return ms - 1000;
      });
    }, 1_000);
    return () => clearInterval(interval);
  }, [revealedNumber]);

  if (account.isPending) return <p className="text-sm text-ink-muted">Loading…</p>;
  if (!account.data) {
    return (
      <section>
        <h1 className="text-2xl font-semibold">Account not found</h1>
      </section>
    );
  }

  const a = account.data;
  const isAdmin = me.data?.role === 'admin';

  const onReveal = async (): Promise<void> => {
    try {
      const full = await fetchRevealedAccount(a.id);
      setRevealedNumber(full.accountNumber);
      toast.info('Account number revealed for 30 seconds (audit-logged).');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'reveal failed');
    }
  };

  return (
    <section className="mx-auto max-w-4xl">
      <Link to={`/companies/${a.companyId}`} className="text-sm text-ink-muted hover:text-ink">
        ← Company
      </Link>
      <header className="mt-2 mb-6">
        <h1 className="flex flex-wrap items-baseline gap-2 text-2xl font-semibold">
          {a.nickname}{' '}
          <span className="font-mono text-base font-normal text-ink-muted">
            {revealedNumber ?? a.accountNumberMasked}
          </span>
          {isAdmin ? (
            revealedNumber ? (
              <span className="text-xs text-ink-subtle">
                · re-masking in {Math.ceil(revealMsRemaining / 1000)}s
              </span>
            ) : (
              <button
                type="button"
                onClick={onReveal}
                className="text-xs text-accent hover:underline"
              >
                reveal
              </button>
            )
          ) : null}
        </h1>
        <p className="text-sm text-ink-subtle">
          {a.financialInstitution} · BID {a.intuBid} ·{' '}
          {ACCOUNT_TYPE_LABELS[a.accountType as AccountTypeCode] ?? a.accountType}
        </p>
      </header>

      <h2 className="mb-2 text-lg font-medium">Upload statements</h2>
      <UploadDropzone accountId={a.id} />

      <section className="mt-8">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Statements</h2>
          <Link to={`/accounts/${a.id}/statements`} className="text-sm text-accent hover:underline">
            See all →
          </Link>
        </div>
        {statements.isPending ? (
          <p className="text-sm text-ink-muted">Loading…</p>
        ) : !statements.data || statements.data.length === 0 ? (
          <p className="rounded-lg border border-dashed border-surface-muted bg-surface-subtle p-4 text-sm text-ink-muted">
            No statements yet. Upload a PDF above to get started.
          </p>
        ) : (
          <ul className="divide-y divide-surface-muted rounded-lg border border-surface-muted bg-white">
            {statements.data.slice(0, 10).map((s) => {
              const period =
                s.periodStart && s.periodEnd
                  ? `${s.periodStart} → ${s.periodEnd}`
                  : 'period pending…';
              return (
                <li key={s.id}>
                  <Link
                    to={`/statements/${s.id}`}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-surface-subtle"
                  >
                    <div className="min-w-0">
                      <p className="font-mono text-sm text-ink">{period}</p>
                      <p className="text-xs text-ink-muted">
                        {s.sourcePdfPages} pages · uploaded {new Date(s.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={s.status} />
                      {s.status === 'review' || s.status === 'exported' ? (
                        <ReconciliationBadge status={s.reconciliationStatus} />
                      ) : null}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
