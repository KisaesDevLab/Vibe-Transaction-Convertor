import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  useCompanies,
  useCreateCompany,
  useDeleteCompany,
  useUpdateCompany,
  type Company,
} from '../hooks/useCompanies';
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog';
import { useToast } from '../components/Toast';
import { ApiError } from '../lib/api';

const PAGE_SIZE = 50;

export function CompaniesPage() {
  const [searchInput, setSearchInput] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [page, setPage] = useState(0);

  // Debounce search → 250ms — avoid hammering the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearchDebounced(searchInput.trim());
      setPage(0);
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const list = useCompanies({
    q: searchDebounced.length > 0 ? searchDebounced : undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const create = useCreateCompany();
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const toast = useToast();
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const onCreate = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setCreateError(null);
    try {
      await create.mutateAsync({ name: newName });
      toast.success('Company created');
      setNewName('');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'create failed';
      setCreateError(msg);
      toast.error(msg);
    }
  };

  return (
    <section className="mx-auto max-w-5xl">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Companies</h1>
          <p className="text-sm text-ink-muted">
            {total} total · page {page + 1}/{totalPages}
          </p>
        </div>
        <input
          type="search"
          placeholder="Search…"
          className="rounded-md border border-surface-muted px-3 py-2 text-sm"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
      </header>

      <form
        onSubmit={onCreate}
        className="mb-6 flex items-start gap-2 rounded-lg border border-surface-muted bg-white p-4"
      >
        <div className="flex-1">
          <label className="block text-sm font-medium" htmlFor="newCompany">
            New company
          </label>
          <input
            id="newCompany"
            required
            maxLength={120}
            placeholder="Acme LLC"
            className="mt-1 w-full rounded-md border border-surface-muted px-3 py-2"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          {createError ? (
            <p role="alert" className="mt-1 text-sm text-danger">
              {createError}
            </p>
          ) : null}
        </div>
        <button
          type="submit"
          disabled={create.isPending || newName.trim().length === 0}
          className="mt-6 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {create.isPending ? 'Creating…' : 'Create'}
        </button>
      </form>

      {list.isPending ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : list.error ? (
        <p role="alert" className="text-sm text-danger">
          {(list.error as Error).message}
        </p>
      ) : list.data && list.data.rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-surface-muted p-8 text-center">
          <p className="text-sm text-ink-muted">
            No companies yet — create your first company above.
          </p>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-surface-muted overflow-hidden rounded-lg border border-surface-muted bg-white">
            {list.data?.rows.map((c) => (
              <CompanyRow key={c.id} company={c} />
            ))}
          </ul>
          {totalPages > 1 ? (
            <div className="mt-3 flex items-center justify-between text-sm">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="rounded-md border border-surface-muted px-3 py-1.5 disabled:opacity-50"
              >
                ← Prev
              </button>
              <span className="text-ink-muted">
                Page {page + 1} of {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                className="rounded-md border border-surface-muted px-3 py-1.5 disabled:opacity-50"
              >
                Next →
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function CompanyRow({ company }: { company: Company }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(company.name);
  const update = useUpdateCompany();
  const del = useDeleteCompany();
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const onSave = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    try {
      await update.mutateAsync({ id: company.id, name });
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'update failed');
    }
  };

  const confirmDelete = async (): Promise<void> => {
    setError(null);
    try {
      await del.mutateAsync({ id: company.id, force: company.accountCount > 0 });
      setDeleteOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'delete failed');
    }
  };

  return (
    <li className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        {editing ? (
          <form onSubmit={onSave} className="flex flex-1 items-center gap-2">
            <input
              required
              maxLength={120}
              className="flex-1 rounded-md border border-surface-muted px-3 py-1.5"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <button
              type="submit"
              disabled={update.isPending}
              className="rounded-md bg-accent px-3 py-1.5 text-sm text-accent-fg disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setName(company.name);
                setError(null);
              }}
              className="rounded-md border border-surface-muted px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <div>
              <Link to={`/companies/${company.id}`} className="font-medium hover:underline">
                {company.name}
              </Link>
              <p className="text-xs text-ink-subtle">
                {company.accountCount} account{company.accountCount === 1 ? '' : 's'}
                {' · '}created {new Date(company.createdAt).toLocaleDateString()}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-md border border-surface-muted px-3 py-1.5 text-sm hover:bg-surface-subtle"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => setDeleteOpen(true)}
                disabled={del.isPending}
                className="rounded-md border border-danger px-3 py-1.5 text-sm text-danger hover:bg-danger/5 disabled:opacity-50"
              >
                {del.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <DeleteConfirmDialog
        open={deleteOpen}
        title={`Delete company "${company.name}"?`}
        description={
          company.accountCount > 0
            ? `This will also delete all ${company.accountCount} account${company.accountCount === 1 ? '' : 's'} under it, and every statement / export they own. The audit log row stays.`
            : 'The company has no accounts; this is reversible only via a backup restore.'
        }
        confirmText={company.name}
        busy={del.isPending}
        onClose={() => setDeleteOpen(false)}
        onConfirm={confirmDelete}
      />
    </li>
  );
}
