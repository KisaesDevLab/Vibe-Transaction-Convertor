import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { ACCOUNT_TYPE_LABELS } from '@vibe-tx-converter/shared';

import { AccountFormDialog } from '../components/AccountFormDialog';
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog';
import { useAccounts, useDeleteAccount, type Account } from '../hooks/useAccounts';
import { useCompany, useDeleteCompany, useUpdateCompany } from '../hooks/useCompanies';
import { ApiError } from '../lib/api';

export function CompanyDetailPage() {
  const { companyId = '' } = useParams();
  const navigate = useNavigate();
  const companyQ = useCompany(companyId);
  const company = companyQ.data;
  const accounts = useAccounts(companyId);
  const del = useDeleteAccount(companyId);
  const updateCompany = useUpdateCompany();
  const deleteCompany = useDeleteCompany();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState('');
  // Active per-account delete dialog. Holds the row so the dialog
  // can show the account nickname in the confirmation phrase.
  const [pendingDelete, setPendingDelete] = useState<Account | null>(null);

  const onEdit = (): void => {
    setEditName(company?.name ?? '');
    setEditOpen(true);
    setError(null);
  };

  const onSaveEdit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = editName.trim();
    if (trimmed.length === 0) {
      setError('Name is required');
      return;
    }
    try {
      await updateCompany.mutateAsync({ id: companyId, name: trimmed });
      setEditOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'update failed');
    }
  };

  const onDeleteCompany = async (): Promise<void> => {
    if (confirmDelete !== company?.name) return;
    try {
      await deleteCompany.mutateAsync({ id: companyId });
      navigate('/companies');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'delete failed');
    }
  };

  if (companyQ.isPending || accounts.isPending) {
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
      <header className="mt-2 mb-6 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold">{company.name}</h1>
          <p className="text-sm text-ink-muted">
            {accounts.data?.length ?? 0} account{(accounts.data?.length ?? 0) === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onEdit}
            className="rounded-md border border-surface-muted px-3 py-2 text-sm hover:bg-surface-subtle"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirmDelete('');
              setError(null);
              setEditOpen(false);
              const dlg = document.getElementById(
                'delete-company-dialog',
              ) as HTMLDialogElement | null;
              dlg?.showModal();
            }}
            className="rounded-md border border-danger px-3 py-2 text-sm text-danger hover:bg-danger/5"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg"
          >
            Add account
          </button>
        </div>
      </header>

      {editOpen ? (
        <form
          onSubmit={onSaveEdit}
          className="mb-4 rounded-lg border border-surface-muted bg-white p-4"
        >
          <h2 className="text-base font-medium">Rename company</h2>
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            className="mt-2 w-full rounded-md border border-surface-muted px-3 py-2 text-sm"
            autoFocus
          />
          <div className="mt-3 flex gap-2">
            <button
              type="submit"
              disabled={updateCompany.isPending}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              {updateCompany.isPending ? 'Saving…' : 'Save'}
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
        id="delete-company-dialog"
        className="rounded-xl p-0 backdrop:bg-ink/40"
        onClose={() => setConfirmDelete('')}
      >
        <form
          method="dialog"
          className="w-full max-w-md space-y-3 p-6"
          onSubmit={(e) => {
            e.preventDefault();
            void onDeleteCompany();
          }}
        >
          <h2 className="text-lg font-semibold">Delete company</h2>
          <p className="text-sm text-ink-muted">
            This permanently removes <strong>{company.name}</strong>. Companies with accounts cannot
            be deleted (the API returns 409); delete the accounts first or use the forced cascade
            endpoint via the API. Type the company name to confirm.
          </p>
          <input
            type="text"
            value={confirmDelete}
            onChange={(e) => setConfirmDelete(e.target.value)}
            placeholder={company.name}
            className="w-full rounded-md border border-surface-muted px-3 py-2 text-sm"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                const dlg = document.getElementById(
                  'delete-company-dialog',
                ) as HTMLDialogElement | null;
                dlg?.close();
              }}
              className="rounded-md border border-surface-muted px-3 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={confirmDelete !== company.name || deleteCompany.isPending}
              className="rounded-md bg-danger px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {deleteCompany.isPending ? 'Deleting…' : 'Delete company'}
            </button>
          </div>
        </form>
      </dialog>

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
                onClick={() => {
                  setError(null);
                  setPendingDelete(a);
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

      <DeleteConfirmDialog
        open={pendingDelete !== null}
        title={`Delete account "${pendingDelete?.nickname ?? ''}"?`}
        description="All statements, transactions, and exports linked to this account will be removed. The audit log row stays — audit_log is append-only."
        confirmText={pendingDelete?.nickname ?? 'DELETE'}
        busy={del.isPending}
        onClose={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return;
          try {
            await del.mutateAsync({ id: pendingDelete.id });
            setPendingDelete(null);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'delete failed');
          }
        }}
      />
    </section>
  );
}
