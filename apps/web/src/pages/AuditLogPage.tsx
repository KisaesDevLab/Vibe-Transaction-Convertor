// Phase 25 audit log viewer. The audit_log table is append-only at the
// DB grant level; this page is a read-only forensic surface for admins.
//
// Filters: entity-type chips, entity-id (click-through from a row),
// actor dropdown, since/until date pickers, action substring search,
// "show only mutations" toggle. Downloads: filtered set as JSON or CSV.
// Each row's payload renders as a collapsible JSON tree.

import { type FormEvent, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';

import { useToast } from '../components/Toast';
import { ApiError, api } from '../lib/api';

interface AuditRow {
  id: number;
  at: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorDisplayName: string | null;
  entityType: string;
  entityId: string;
  action: string;
  payload: unknown;
  correlationId: string | null;
}

interface ActorsResponse {
  actors: Array<{ id: string; email: string; displayName: string }>;
  hasSystemActor: boolean;
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
  'system',
] as const;

const csrfHeader = (): Record<string, string> => ({
  'x-csrf-token':
    document.cookie
      .split('; ')
      .find((c) => c.startsWith('vibetc_csrf='))
      ?.split('=')[1] ?? '',
});

export function AuditLogPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();

  const entityType = searchParams.get('entityType') ?? '';
  const entityId = searchParams.get('entityId') ?? '';
  const actorUserId = searchParams.get('actorUserId') ?? '';
  const since = searchParams.get('since') ?? '';
  const until = searchParams.get('until') ?? '';
  const actionContains = searchParams.get('actionContains') ?? '';
  const mutationsOnly = searchParams.get('mutationsOnly') === '1';

  const [actionInput, setActionInput] = useState(actionContains);

  const queryParams: Record<string, string> = {};
  if (entityType) queryParams.entityType = entityType;
  if (entityId) queryParams.entityId = entityId;
  if (actorUserId) queryParams.actorUserId = actorUserId;
  if (since) queryParams.since = since;
  if (until) queryParams.until = until;
  if (actionContains) queryParams.actionContains = actionContains;
  if (mutationsOnly) queryParams.mutationsOnly = '1';

  const list = useQuery({
    queryKey: ['audit', queryParams],
    queryFn: () => api.get<{ rows: AuditRow[]; total: number }>('/api/audit', queryParams),
  });
  const actors = useQuery({
    queryKey: ['audit', '_actors'],
    queryFn: () => api.get<ActorsResponse>('/api/audit/_actors'),
  });

  const setFilter = (next: Record<string, string | null>): void => {
    const sp = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') sp.delete(k);
      else sp.set(k, v);
    }
    setSearchParams(sp);
  };

  const onSearchSubmit = (e: FormEvent): void => {
    e.preventDefault();
    setFilter({ actionContains: actionInput || null });
  };

  const onClearAll = (): void => {
    setActionInput('');
    setSearchParams(new URLSearchParams());
  };

  const onDownload = async (kind: 'json' | 'csv'): Promise<void> => {
    const qs = new URLSearchParams(queryParams).toString();
    const url = `/api/audit/export.${kind}${qs ? `?${qs}` : ''}`;
    try {
      const res = await fetch(url, { credentials: 'include', headers: csrfHeader() });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new ApiError(res.status, body);
      }
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') ?? '';
      const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? `audit.${kind}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success(`Downloaded ${filename}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'download failed');
    }
  };

  const hasFilters =
    entityType.length > 0 ||
    entityId.length > 0 ||
    actorUserId.length > 0 ||
    since.length > 0 ||
    until.length > 0 ||
    actionContains.length > 0 ||
    mutationsOnly;

  return (
    <section className="mx-auto max-w-6xl space-y-4">
      <Link to="/admin" className="text-sm text-ink-muted hover:text-ink">
        ← Admin
      </Link>
      <header>
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="text-sm text-ink-muted">
          {list.data ? `${list.data.total} total event${list.data.total === 1 ? '' : 's'}` : ''}
          {hasFilters ? ' · filtered' : ''}
        </p>
      </header>

      <div className="space-y-3 rounded-lg border border-surface-muted bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          {ENTITY_TYPES.map((t) => (
            <button
              key={t || 'all'}
              type="button"
              onClick={() => setFilter({ entityType: t || null, entityId: null })}
              className={`rounded-full border px-3 py-1 text-xs ${
                entityType === t
                  ? 'border-accent bg-accent text-accent-fg'
                  : 'border-surface-muted hover:bg-surface-subtle'
              }`}
            >
              {t || 'All'}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            Actor
            <select
              value={actorUserId}
              onChange={(e) => setFilter({ actorUserId: e.target.value || null })}
              className="rounded-md border border-surface-muted bg-white px-2 py-1 text-sm"
            >
              <option value="">All</option>
              {actors.data?.hasSystemActor ? (
                <option value="system">— System (no actor) —</option>
              ) : null}
              {actors.data?.actors.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName} · {a.email}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            Since
            <input
              type="datetime-local"
              value={since}
              onChange={(e) => setFilter({ since: e.target.value || null })}
              className="rounded-md border border-surface-muted px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            Until
            <input
              type="datetime-local"
              value={until}
              onChange={(e) => setFilter({ until: e.target.value || null })}
              className="rounded-md border border-surface-muted px-2 py-1 text-sm"
            />
          </label>

          <form className="flex flex-col gap-1 text-xs text-ink-muted" onSubmit={onSearchSubmit}>
            Action contains
            <div className="flex gap-1">
              <input
                type="search"
                placeholder="e.g. statement.export"
                value={actionInput}
                onChange={(e) => setActionInput(e.target.value)}
                className="rounded-md border border-surface-muted px-2 py-1 text-sm"
              />
              <button
                type="submit"
                className="rounded-md border border-surface-muted px-2 py-1 text-xs"
              >
                Search
              </button>
            </div>
          </form>

          <label className="ml-2 flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={mutationsOnly}
              onChange={(e) => setFilter({ mutationsOnly: e.target.checked ? '1' : null })}
            />
            Mutations only
          </label>

          {hasFilters ? (
            <button
              type="button"
              onClick={onClearAll}
              className="rounded-md border border-surface-muted px-2 py-1 text-xs"
            >
              Clear all
            </button>
          ) : null}

          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => void onDownload('json')}
              className="rounded-md border border-surface-muted px-3 py-1 text-xs"
            >
              ↓ JSON
            </button>
            <button
              type="button"
              onClick={() => void onDownload('csv')}
              className="rounded-md border border-surface-muted px-3 py-1 text-xs"
            >
              ↓ CSV
            </button>
          </div>
        </div>
      </div>

      {list.isPending ? <p className="text-sm text-ink-muted">Loading…</p> : null}

      {list.data ? (
        <div className="overflow-hidden rounded-lg border border-surface-muted bg-white">
          <table className="w-full text-sm">
            <thead className="bg-surface-subtle text-left">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Actor</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Entity</th>
                <th className="px-3 py-2 font-medium">Payload</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-muted">
              {list.data.rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-muted tabular-nums">
                    {new Date(r.at).toLocaleString()}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">
                    {r.actorEmail ? (
                      <span title={r.actorUserId ?? ''}>
                        <span className="font-medium">{r.actorDisplayName ?? r.actorEmail}</span>
                        <span className="block text-ink-subtle">{r.actorEmail}</span>
                      </span>
                    ) : (
                      <span className="italic text-ink-subtle">Vibe System</span>
                    )}
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
                  <td className="px-3 py-2">
                    <PayloadCell payload={r.payload} />
                  </td>
                </tr>
              ))}
              {list.data.rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-sm text-ink-muted">
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

// Phase 25 #5: collapsible JSON tree. Default closed; click to expand.
// For nested objects/arrays, recurses.
function PayloadCell({ payload }: { payload: unknown }) {
  const [open, setOpen] = useState(false);
  if (payload === null || payload === undefined) {
    return <span className="text-xs text-ink-subtle">—</span>;
  }
  if (typeof payload !== 'object') {
    return <span className="font-mono text-xs">{String(payload)}</span>;
  }
  const isArray = Array.isArray(payload);
  const entries = isArray
    ? (payload as unknown[]).map((v, i) => [i, v] as const)
    : Object.entries(payload as Record<string, unknown>);
  const summary = isArray
    ? `[${entries.length}]`
    : `{${entries
        .slice(0, 3)
        .map(([k]) => k)
        .join(', ')}${entries.length > 3 ? ', …' : ''}}`;
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="font-mono text-ink-muted hover:text-ink"
      >
        {open ? '▾' : '▸'} {summary}
      </button>
      {open ? (
        <ul className="ml-4 mt-1 list-none space-y-0.5 border-l border-surface-muted pl-3">
          {entries.map(([k, v]) => (
            <li key={String(k)}>
              <span className="font-mono text-ink-muted">{String(k)}:</span>{' '}
              {typeof v === 'object' && v !== null ? (
                <PayloadCell payload={v} />
              ) : (
                <span className="font-mono">{JSON.stringify(v)}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
