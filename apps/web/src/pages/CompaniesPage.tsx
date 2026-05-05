import { type FormEvent, useState } from 'react';

import {
  useCompanies,
  useCreateCompany,
  useDeleteCompany,
  useUpdateCompany,
  type Company,
} from '../hooks/useCompanies';
import { ApiError } from '../lib/api';

export function CompaniesPage() {
  const [search, setSearch] = useState('');
  const list = useCompanies(search.trim().length > 0 ? search.trim() : undefined);
  const create = useCreateCompany();
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const onCreate = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setCreateError(null);
    try {
      await create.mutateAsync({ name: newName });
      setNewName('');
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'create failed');
    }
  };

  return (
    <section className="mx-auto max-w-5xl">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Companies</h1>
          <p className="text-sm text-ink-muted">Each company holds one or more accounts.</p>
        </div>
        <input
          type="search"
          placeholder="Search…"
          className="rounded-md border border-surface-muted px-3 py-2 text-sm"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
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
        <ul className="divide-y divide-surface-muted overflow-hidden rounded-lg border border-surface-muted bg-white">
          {list.data?.rows.map((c) => (
            <CompanyRow key={c.id} company={c} />
          ))}
        </ul>
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

  const onDelete = async (): Promise<void> => {
    setError(null);
    const typed = window.prompt(`Type the company name to confirm deletion: "${company.name}"`);
    if (typed !== company.name) return;
    try {
      await del.mutateAsync({ id: company.id, force: company.accountCount > 0 });
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
              <p className="font-medium">{company.name}</p>
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
                onClick={onDelete}
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
    </li>
  );
}
