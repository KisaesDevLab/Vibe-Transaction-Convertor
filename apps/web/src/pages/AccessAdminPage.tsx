import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ToggleLeft, ToggleRight } from 'lucide-react';

import { useToast } from '../components/Toast';
import {
  useFeatureAccessMatrix,
  useFeatureRegistry,
  useSetFeatureAccess,
  type FeatureDef,
} from '../hooks/useFeatureAccess';
import { ApiError } from '../lib/api';

export function AccessAdminPage() {
  const matrix = useFeatureAccessMatrix();
  const registry = useFeatureRegistry();
  const setAccess = useSetFeatureAccess();
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const users = matrix.data ?? [];
  // Default the selection to the first user once data arrives. Depend on
  // the query data (stable ref) rather than the per-render `users` array.
  useEffect(() => {
    if (!selectedId && matrix.data && matrix.data.length > 0) {
      setSelectedId(matrix.data[0]!.id);
    }
  }, [selectedId, matrix.data]);

  const selected = users.find((u) => u.id === selectedId) ?? null;
  const defs = registry.data ?? [];
  const coreDefs = defs.filter((d) => d.area === 'core');
  const adminDefs = defs.filter((d) => d.area === 'admin');

  const onToggle = async (featureKey: string, next: boolean): Promise<void> => {
    if (!selected) return;
    try {
      await setAccess.mutateAsync({ userId: selected.id, featureKey, enabled: next });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to update access');
    }
  };

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <Link to="/admin" className="text-sm text-ink-muted hover:text-ink">
        ← Admin
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">Access management</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Turn individual features on or off per user. Everyone starts with full access; disabling a
          feature hides it and blocks the matching API. At least one admin must keep Access
          Management.
        </p>
      </div>

      {matrix.isPending || registry.isPending ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : (
        <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
          {/* User picker */}
          <aside className="space-y-1 rounded-lg border border-surface-muted bg-white p-2">
            {users.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => setSelectedId(u.id)}
                className={`flex w-full flex-col rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  u.id === selectedId
                    ? 'bg-accent/10 text-ink'
                    : 'text-ink-muted hover:bg-surface-subtle'
                }`}
              >
                <span className="font-medium">{u.displayName}</span>
                <span className="text-xs text-ink-subtle">
                  {u.email} · {u.role}
                </span>
              </button>
            ))}
          </aside>

          {/* Feature toggles for the selected user */}
          {selected ? (
            <div className="space-y-6">
              <FeatureGroup
                title="Core features"
                defs={coreDefs}
                features={selected.features}
                busy={setAccess.isPending}
                onToggle={onToggle}
              />
              <FeatureGroup
                title="Admin features"
                defs={adminDefs}
                features={selected.features}
                busy={setAccess.isPending}
                onToggle={onToggle}
              />
            </div>
          ) : (
            <p className="text-sm text-ink-muted">Select a user to manage their access.</p>
          )}
        </div>
      )}
    </section>
  );
}

function FeatureGroup({
  title,
  defs,
  features,
  busy,
  onToggle,
}: {
  title: string;
  defs: FeatureDef[];
  features: Record<string, boolean>;
  busy: boolean;
  onToggle: (featureKey: string, next: boolean) => Promise<void>;
}) {
  if (defs.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-lg border border-surface-muted bg-white">
      <h2 className="border-b border-surface-muted bg-surface-subtle px-4 py-2 text-sm font-medium">
        {title}
      </h2>
      <ul className="divide-y divide-surface-muted">
        {defs.map((d) => {
          const enabled = features[d.key] !== false;
          return (
            <li key={d.key} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{d.label}</p>
                <p className="text-xs text-ink-subtle">{d.description}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={`${enabled ? 'Disable' : 'Enable'} ${d.label}`}
                title={enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                disabled={busy}
                onClick={() => void onToggle(d.key, !enabled)}
                className={`shrink-0 rounded-md p-1 transition-colors disabled:opacity-50 ${
                  enabled
                    ? 'text-emerald-600 hover:text-emerald-700'
                    : 'text-ink-subtle hover:text-ink'
                }`}
              >
                {enabled ? <ToggleRight className="h-7 w-7" /> : <ToggleLeft className="h-7 w-7" />}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
