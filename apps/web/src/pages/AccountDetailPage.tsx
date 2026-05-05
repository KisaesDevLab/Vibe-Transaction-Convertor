import { Link, useParams } from 'react-router-dom';

import { ACCOUNT_TYPE_LABELS, type AccountTypeCode } from '@vibe-tx-converter/shared';

import { UploadDropzone } from '../components/UploadDropzone';
import { useAccount } from '../hooks/useStatements';

export function AccountDetailPage() {
  const { accountId = '' } = useParams();
  const account = useAccount(accountId);

  if (account.isPending) return <p className="text-sm text-ink-muted">Loading…</p>;
  if (!account.data) {
    return (
      <section>
        <h1 className="text-2xl font-semibold">Account not found</h1>
      </section>
    );
  }

  const a = account.data;
  return (
    <section className="mx-auto max-w-4xl">
      <Link to={`/companies/${a.companyId}`} className="text-sm text-ink-muted hover:text-ink">
        ← Company
      </Link>
      <header className="mt-2 mb-6">
        <h1 className="text-2xl font-semibold">
          {a.nickname} <span className="font-normal text-ink-muted">{a.accountNumberMasked}</span>
        </h1>
        <p className="text-sm text-ink-subtle">
          {a.financialInstitution} · BID {a.intuBid} ·{' '}
          {ACCOUNT_TYPE_LABELS[a.accountType as AccountTypeCode] ?? a.accountType}
        </p>
      </header>

      <h2 className="mb-2 text-lg font-medium">Upload statements</h2>
      <UploadDropzone accountId={a.id} />

      <p className="mt-4 text-sm">
        <Link to={`/accounts/${a.id}/statements`} className="text-accent hover:underline">
          View statements →
        </Link>
      </p>
    </section>
  );
}
