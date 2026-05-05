import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';

import { api } from '../lib/api';

interface AuditRow {
  id: number;
  at: string;
  actorUserId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  payload: unknown;
}

const ENTITY_TYPES = [
  '',
  'user',
  'session',
  'company',
  'account',
  'statement',
  'transaction',
  'system_settings',
  'fidir',
] as const;

export function AuditLogPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [actionSearch, setActionSearch] = useState('');
  const entityType = searchParams.get('entityType') ?? '';
  const entityId = searchParams.get('entityId') ?? '';

  const list = useQuery({
    queryKey: ['audit', entityType, entityId],
    queryFn: () =>
      api.get<{ rows: AuditRow[]; total: number }>(
        '/api/audit',
        Object.fromEntries(
          (
            [
              ['entityType', entityType],
              ['entityId', entityId],
            ] as const
          ).filter(([, v]) => v && v.length > 0),
        ),
      ),
  });

  const filtered = useMemo(() => {
    if (!list.data) return [];
    const q = actionSearch.trim().toLowerCase();
    return q.length > 0
      ? list.data.rows.filter((r) => r.action.toLowerCase().includes(q))
      : list.data.rows;
  }, [list.data, actionSearch]);

  const setFilter = (next: { entityType?: string; entityId?: string }): void => {
    const sp = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(next)) {
      if (!v) sp.delete(k);
      else sp.set(k, v);
    }
    setSearchParams(sp);
  };

  return (
    <section className="mx-auto max-w-6xl space-y-4">
      <Link to="/admin" className="text-sm text-ink-muted hover:text-ink">
        ← Admin
      </Link>
      <header>
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="text-sm text-ink-muted">
          {list.data ? `${list.data.total} total event${list.data.total === 1 ? '' : 's'}` : ''}
          {entityType
            ? ` · filtered to ${entityType}${entityId ? ` ${entityId.slice(0, 8)}` : ''}`
            : ''}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {ENTITY_TYPES.map((t) => (
          <button
            key={t || 'all'}
            type="button"
            onClick={() => setFilter({ entityType: t, entityId: '' })}
            className={`rounded-full border px-3 py-1 text-xs ${
              entityType === t
                ? 'border-accent bg-accent text-accent-fg'
                : 'border-surface-muted hover:bg-surface-subtle'
            }`}
          >
            {t || 'All'}
          </button>
        ))}
        <input
          type="search"
          placeholder="Search actions…"
          className="ml-auto rounded-md border border-surface-muted px-3 py-1.5 text-xs"
          value={actionSearch}
          onChange={(e) => setActionSearch(e.target.value)}
        />
        {entityId ? (
          <button
            type="button"
            onClick={() => setFilter({ entityId: '' })}
            className="rounded-full border border-surface-muted px-3 py-1 text-xs"
          >
            Clear entity-id
          </button>
        ) : null}
      </div>

      {list.isPending ? <p className="text-sm text-ink-muted">Loading…</p> : null}

      {list.data ? (
        <div className="overflow-hidden rounded-lg border border-surface-muted bg-white">
          <table className="w-full text-sm">
            <thead className="bg-surface-subtle text-left">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Entity</th>
                <th className="px-3 py-2 font-medium">Payload</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-muted">
              {filtered.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-ink-muted">
                    {new Date(r.at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 font-medium">{r.action}</td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setFilter({ entityType: r.entityType, entityId: r.entityId })}
                      className="text-left hover:underline"
                      title="Filter by this entity"
                    >
                      <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-xs">
                        {r.entityType}
                      </span>
                      <span className="ml-2 font-mono text-xs">{r.entityId.slice(0, 12)}</span>
                    </button>
                  </td>
                  <td className="max-w-md break-words px-3 py-2 text-xs text-ink-subtle">
                    {r.payload ? JSON.stringify(r.payload) : '—'}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-sm text-ink-muted">
                    No audit events match the current filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
