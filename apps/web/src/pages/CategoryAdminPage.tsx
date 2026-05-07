import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';

import { useToast } from '../components/Toast';
import {
  useArchiveCategory,
  useCategories,
  useCreateCategory,
  useEnrichmentToggles,
  useSetEnrichmentToggle,
  useUpdateCategory,
  type BusinessCategory,
} from '../hooks/useCategories';
import { ApiError } from '../lib/api';

// Phase 33 — operator-editable business-category list. The LLM
// "Assign categories" button on the review page picks exactly one of
// these names; the dropdown in the transaction grid reads the same
// (non-archived) list. Soft-delete via `archived` so historical
// assignments stay valid even when a category is retired.
export function CategoryAdminPage() {
  const cats = useCategories({ includeArchived: true });
  const toggles = useEnrichmentToggles();
  const create = useCreateCategory();
  const update = useUpdateCategory();
  const archive = useArchiveCategory();
  const setToggle = useSetEnrichmentToggle();
  const toast = useToast();

  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onCreate = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    const name = newName.trim();
    if (name.length === 0) {
      setError('name is required');
      return;
    }
    try {
      await create.mutateAsync({
        name,
        ...(newDescription.trim() ? { description: newDescription.trim() } : {}),
      });
      setNewName('');
      setNewDescription('');
      toast.success(`Created "${name}"`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed');
    }
  };

  const sorted = (cats.data ?? []).slice().sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.name.localeCompare(b.name);
  });

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <Link to="/admin" className="text-sm text-ink-muted hover:text-ink">
        ← Admin
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Business categories</h1>
        <p className="text-sm text-ink-muted">
          Categories the LLM can assign on the review page. Edits take effect on the next "Assign
          categories" run; existing transaction assignments are unchanged.
        </p>
      </header>

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-base font-medium">Enrichment toggles</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Hide either button on the review page when its toggle is off. The LLM provider settings
          and monthly cap still apply when the toggles are on.
        </p>
        {toggles.data ? (
          <div className="mt-3 space-y-2 text-sm">
            <ToggleRow
              label="Cleanse descriptions"
              enabled={toggles.data.cleanseEnabled}
              busy={setToggle.isPending}
              onToggle={async (enabled) => {
                try {
                  await setToggle.mutateAsync({ which: 'cleanse', enabled });
                  toast.success(`Cleanse descriptions ${enabled ? 'enabled' : 'disabled'}`);
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.message : 'failed');
                }
              }}
            />
            <ToggleRow
              label="Assign categories"
              enabled={toggles.data.categoryEnabled}
              busy={setToggle.isPending}
              onToggle={async (enabled) => {
                try {
                  await setToggle.mutateAsync({ which: 'category', enabled });
                  toast.success(`Assign categories ${enabled ? 'enabled' : 'disabled'}`);
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.message : 'failed');
                }
              }}
            />
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-base font-medium">Add category</h2>
        <form onSubmit={onCreate} className="mt-3 space-y-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name (e.g., Software & Subscriptions)"
            className="w-full rounded-md border border-surface-muted px-3 py-2 text-sm"
            maxLength={80}
          />
          <input
            type="text"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            placeholder="Description (optional, shown to the LLM as prompt context)"
            className="w-full rounded-md border border-surface-muted px-3 py-2 text-sm"
            maxLength={500}
          />
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={create.isPending || newName.trim().length === 0}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            {create.isPending ? 'Adding…' : 'Add category'}
          </button>
        </form>
      </section>

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-base font-medium">Categories</h2>
        {cats.isPending ? (
          <p className="mt-2 text-sm text-ink-muted">Loading…</p>
        ) : sorted.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">No categories yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-surface-muted">
            {sorted.map((c) => (
              <CategoryRow
                key={c.id}
                cat={c}
                onSave={async (patch) => {
                  try {
                    await update.mutateAsync({ id: c.id, patch });
                    toast.success(`Updated "${c.name}"`);
                  } catch (err) {
                    toast.error(err instanceof ApiError ? err.message : 'update failed');
                  }
                }}
                onArchive={async () => {
                  try {
                    await archive.mutateAsync(c.id);
                    toast.success(`Archived "${c.name}"`);
                  } catch (err) {
                    toast.error(err instanceof ApiError ? err.message : 'archive failed');
                  }
                }}
                onUnarchive={async () => {
                  try {
                    await update.mutateAsync({ id: c.id, patch: { archived: false } });
                    toast.success(`Restored "${c.name}"`);
                  } catch (err) {
                    toast.error(err instanceof ApiError ? err.message : 'restore failed');
                  }
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function ToggleRow({
  label,
  enabled,
  busy,
  onToggle,
}: {
  label: string;
  enabled: boolean;
  busy: boolean;
  onToggle: (next: boolean) => Promise<void>;
}) {
  return (
    <label className="flex items-center justify-between gap-3 py-1">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={busy}
        onClick={() => void onToggle(!enabled)}
        className={`relative h-6 w-11 rounded-full transition-colors ${
          enabled ? 'bg-emerald-500' : 'bg-surface-muted'
        } disabled:opacity-50`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
            enabled ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>
    </label>
  );
}

function CategoryRow({
  cat,
  onSave,
  onArchive,
  onUnarchive,
}: {
  cat: BusinessCategory;
  onSave: (patch: {
    name?: string;
    description?: string | null;
    sort_order?: number;
  }) => Promise<void>;
  onArchive: () => Promise<void>;
  onUnarchive: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(cat.name);
  const [description, setDescription] = useState(cat.description ?? '');
  const [sortOrder, setSortOrder] = useState(String(cat.sortOrder));

  const reset = (): void => {
    setName(cat.name);
    setDescription(cat.description ?? '');
    setSortOrder(String(cat.sortOrder));
  };

  if (editing) {
    return (
      <li className="space-y-2 py-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-md border border-surface-muted px-2 py-1 text-sm"
          maxLength={80}
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          className="w-full rounded-md border border-surface-muted px-2 py-1 text-sm"
          maxLength={500}
        />
        <div className="flex items-center gap-2">
          <label className="text-xs text-ink-muted">Sort:</label>
          <input
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            inputMode="numeric"
            className="w-20 rounded-md border border-surface-muted px-2 py-1 text-xs"
          />
          <span className="ml-auto" />
          <button
            type="button"
            onClick={async () => {
              const patch: Parameters<typeof onSave>[0] = {};
              if (name.trim() !== cat.name) patch.name = name.trim();
              if ((description.trim() || null) !== (cat.description ?? null))
                patch.description = description.trim() || null;
              const so = Number.parseInt(sortOrder, 10);
              if (Number.isFinite(so) && so !== cat.sortOrder) patch.sort_order = so;
              if (Object.keys(patch).length > 0) await onSave(patch);
              setEditing(false);
            }}
            className="rounded-md bg-accent px-3 py-1 text-xs text-accent-fg"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              reset();
              setEditing(false);
            }}
            className="rounded-md border border-surface-muted px-3 py-1 text-xs"
          >
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-baseline gap-3 py-2 text-sm">
      <span className="w-10 font-mono text-xs text-ink-subtle tabular-nums">{cat.sortOrder}</span>
      <div className="min-w-0 flex-1">
        <p className={cat.archived ? 'text-ink-subtle line-through' : ''}>{cat.name}</p>
        {cat.description ? <p className="text-xs text-ink-subtle">{cat.description}</p> : null}
      </div>
      {cat.archived ? (
        <button
          type="button"
          onClick={() => void onUnarchive()}
          className="rounded-md border border-surface-muted px-2 py-1 text-xs"
        >
          Restore
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-md border border-surface-muted px-2 py-1 text-xs"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => void onArchive()}
            className="rounded-md border border-surface-muted px-2 py-1 text-xs text-danger"
          >
            Archive
          </button>
        </>
      )}
    </li>
  );
}
