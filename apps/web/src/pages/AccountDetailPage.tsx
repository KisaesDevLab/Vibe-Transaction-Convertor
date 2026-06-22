import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { ACCOUNT_TYPE_LABELS, type AccountTypeCode } from '@vibe-tx-converter/shared';

import { EntityAuditLog } from '../components/EntityAuditLog';
import { ProcessingStepper, isInFlight } from '../components/ProcessingStepper';
import { StatusBadge, ReconciliationBadge } from '../components/StatusBadge';
import { UploadDropzone } from '../components/UploadDropzone';
import { useToast } from '../components/Toast';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import {
  fetchRevealedAccount,
  useDeleteAccount,
  useUpdateAccount,
  type CsvTemplate,
} from '../hooks/useAccounts';
import { hasFeature, useMe } from '../hooks/useAuth';
import { FEATURE } from '../lib/features';
import { useAccount } from '../hooks/useStatements';
import { useStatementsByAccount } from '../hooks/useStatementsList';
import { ApiError } from '../lib/api';

const REVEAL_DURATION_MS = 30_000;

export function AccountDetailPage() {
  const { accountId = '' } = useParams();
  const navigate = useNavigate();
  const account = useAccount(accountId);
  const statements = useStatementsByAccount(accountId);
  const me = useMe();
  const toast = useToast();
  const copy = useCopyToClipboard();
  const [revealedNumber, setRevealedNumber] = useState<string | null>(null);
  const [revealMsRemaining, setRevealMsRemaining] = useState<number>(0);
  const [editOpen, setEditOpen] = useState(false);
  const [editNickname, setEditNickname] = useState('');
  const [editTemplate, setEditTemplate] = useState<CsvTemplate>('qbo3');
  const [editRouting, setEditRouting] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [confirmDeleteText, setConfirmDeleteText] = useState('');
  const updateAccount = useUpdateAccount(account.data?.companyId ?? '');
  const deleteAccount = useDeleteAccount(account.data?.companyId ?? '');

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
  const canUpload = hasFeature(me.data?.features, FEATURE.uploads);

  const openEdit = (): void => {
    setEditNickname(a.nickname);
    setEditTemplate(a.defaultCsvTemplate);
    setEditRouting(a.routingNumber ?? '');
    setEditError(null);
    setEditOpen(true);
  };

  const onSaveEdit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = editNickname.trim();
    if (trimmed.length === 0) {
      setEditError('Nickname is required');
      return;
    }
    try {
      await updateAccount.mutateAsync({
        id: a.id,
        patch: {
          nickname: trimmed,
          defaultCsvTemplate: editTemplate,
          routingNumber: editRouting.trim().length === 0 ? null : editRouting.trim(),
        },
      });
      setEditOpen(false);
      toast.success('Account updated');
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'update failed');
    }
  };

  const onDeleteAccount = async (): Promise<void> => {
    if (confirmDeleteText !== a.nickname) return;
    try {
      await deleteAccount.mutateAsync({ id: a.id });
      toast.success(`Deleted ${a.nickname}`);
      navigate(`/companies/${a.companyId}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'delete failed');
    }
  };

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
              <>
                <button
                  type="button"
                  onClick={() => void copy(revealedNumber, 'Account number copied')}
                  className="text-xs text-accent hover:underline"
                  title="Copy the revealed account number"
                >
                  copy
                </button>
                <span className="text-xs text-ink-subtle">
                  · re-masking in {Math.ceil(revealMsRemaining / 1000)}s
                </span>
              </>
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
          {ACCOUNT_TYPE_LABELS[a.accountType as AccountTypeCode] ?? a.accountType} ·{' '}
          {a.defaultCsvTemplate}
          {a.routingNumber ? ` · routing ${a.routingNumber}` : ''}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={openEdit}
            className="rounded-md border border-surface-muted px-3 py-1.5 text-sm hover:bg-surface-subtle"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirmDeleteText('');
              const dlg = document.getElementById(
                'delete-account-dialog',
              ) as HTMLDialogElement | null;
              dlg?.showModal();
            }}
            className="rounded-md border border-danger px-3 py-1.5 text-sm text-danger hover:bg-danger/5"
          >
            Delete
          </button>
        </div>
      </header>

      {editOpen ? (
        <form
          onSubmit={onSaveEdit}
          className="mb-6 rounded-lg border border-surface-muted bg-white p-4"
        >
          <h2 className="text-base font-medium">Edit account</h2>
          <p className="mt-1 text-xs text-ink-subtle">
            Account type, account number, and FI/BID are immutable — the FITID derivation depends on
            them. Re-create the account to change those.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-ink-muted">
              Nickname
              <input
                type="text"
                value={editNickname}
                onChange={(e) => setEditNickname(e.target.value)}
                className="mt-1 w-full rounded-md border border-surface-muted px-3 py-1.5 text-sm"
                autoFocus
              />
            </label>
            <label className="block text-xs text-ink-muted">
              Default CSV template
              <select
                value={editTemplate}
                onChange={(e) => setEditTemplate(e.target.value as CsvTemplate)}
                className="mt-1 w-full rounded-md border border-surface-muted bg-white px-3 py-1.5 text-sm"
              >
                <option value="qbo3">qbo3 — Date, Description, Amount</option>
                <option value="qbo4">qbo4 — Date, Description, Credit, Debit</option>
                <option value="xero">xero — *Date, *Amount, Payee, …</option>
                <option value="generic">generic — full denormalized row</option>
              </select>
            </label>
            <label className="block text-xs text-ink-muted sm:col-span-2">
              Routing number (optional)
              <input
                type="text"
                value={editRouting}
                onChange={(e) => setEditRouting(e.target.value)}
                placeholder="9-digit ABA — leave blank for credit cards"
                className="mt-1 w-full rounded-md border border-surface-muted px-3 py-1.5 text-sm font-mono tabular-nums"
                inputMode="numeric"
              />
            </label>
          </div>
          {editError ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              {editError}
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <button
              type="submit"
              disabled={updateAccount.isPending}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              {updateAccount.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditOpen(false)}
              className="rounded-md border border-surface-muted px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <dialog
        id="delete-account-dialog"
        className="rounded-xl p-0 backdrop:bg-ink/40"
        onClose={() => setConfirmDeleteText('')}
      >
        <form
          method="dialog"
          className="w-full max-w-md space-y-3 p-6"
          onSubmit={(e) => {
            e.preventDefault();
            void onDeleteAccount();
          }}
        >
          <h2 className="text-lg font-semibold">Delete account</h2>
          <p className="text-sm text-ink-muted">
            This permanently removes <strong>{a.nickname}</strong>. Accounts with statements on file
            return 409 — delete the statements first, or pass <code>force=true</code>
            via the API. Type the nickname to confirm.
          </p>
          <input
            type="text"
            value={confirmDeleteText}
            onChange={(e) => setConfirmDeleteText(e.target.value)}
            placeholder={a.nickname}
            className="w-full rounded-md border border-surface-muted px-3 py-2 text-sm"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                const dlg = document.getElementById(
                  'delete-account-dialog',
                ) as HTMLDialogElement | null;
                dlg?.close();
              }}
              className="rounded-md border border-surface-muted px-3 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={confirmDeleteText !== a.nickname || deleteAccount.isPending}
              className="rounded-md bg-danger px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {deleteAccount.isPending ? 'Deleting…' : 'Delete account'}
            </button>
          </div>
        </form>
      </dialog>

      {canUpload ? (
        <>
          <h2 className="mb-2 text-lg font-medium">Upload statements</h2>
          <UploadDropzone accountId={a.id} />
        </>
      ) : null}

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
                      {isInFlight(s.status) ? (
                        <ProcessingStepper
                          compact
                          status={s.status}
                          method={s.extractionMethod}
                          provider={s.llmProvider}
                          model={s.llmModelVersion}
                        />
                      ) : (
                        <StatusBadge status={s.status} />
                      )}
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

      <EntityAuditLog entityType="account" entityId={accountId} />
    </section>
  );
}
