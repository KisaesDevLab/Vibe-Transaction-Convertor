// Phase 18 #19 — embeddable audit-log panel. Drop this into any
// detail page where seeing "what changed and who did it" is useful
// (statement review, account detail, company detail, export page).
// Hits the admin-only `/api/audit/:entityType/:entityId` endpoint, so
// non-admins see a graceful empty state instead of a 403 toast.

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useMe } from '../hooks/useAuth';
import { api, ApiError } from '../lib/api';

interface AuditRow {
  id: string;
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

interface AuditResponse {
  rows: AuditRow[];
}

const fmtTime = (iso: string): string => {
  // Compact "MMM d, HH:mm" — readers scanning a row of changes don't
  // need year unless the entity is genuinely old, and the locale
  // version eats too much horizontal space.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const actorLabel = (r: AuditRow): string => {
  if (!r.actorUserId) return 'system';
  return r.actorDisplayName ?? r.actorEmail ?? r.actorUserId.slice(0, 8);
};

export function EntityAuditLog({
  entityType,
  entityId,
  limit = 50,
  title = 'Audit log',
}: {
  entityType: string;
  entityId: string;
  limit?: number;
  title?: string;
}) {
  const me = useMe();
  const isAdmin = me.data?.role === 'admin';
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const q = useQuery({
    queryKey: ['audit', entityType, entityId, limit],
    queryFn: () =>
      api.get<AuditResponse>(`/api/audit/${entityType}/${entityId}`, { limit: String(limit) }),
    enabled: isAdmin && entityId.length > 0,
    // Audit rows are append-only; the only churn is "did a new event
    // arrive?" Keep stale-while-revalidate behavior but don't hammer.
    staleTime: 10_000,
  });

  if (!isAdmin) {
    return (
      <section className="rounded-md border border-surface-muted bg-surface-subtle p-3 text-xs text-ink-muted">
        {title} is admin-only.
      </section>
    );
  }

  if (q.isPending) {
    return (
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">{title}</h2>
        <p className="text-xs text-ink-muted">Loading…</p>
      </section>
    );
  }

  if (q.isError) {
    return (
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">{title}</h2>
        <p className="text-xs text-danger">
          {q.error instanceof ApiError ? q.error.message : 'failed to load audit log'}
        </p>
      </section>
    );
  }

  const rows = q.data?.rows ?? [];
  const toggle = (id: string): void => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">{title}</h2>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-surface-muted bg-surface-subtle p-3 text-xs text-ink-muted">
          No audit events recorded for this {entityType}.
        </p>
      ) : (
        <ol className="overflow-hidden rounded-md border border-surface-muted">
          {rows.map((r) => {
            const open = expanded.has(r.id);
            const hasPayload =
              r.payload !== null &&
              r.payload !== undefined &&
              !(typeof r.payload === 'object' && Object.keys(r.payload).length === 0);
            return (
              <li key={r.id} className="border-t border-surface-muted bg-white first:border-t-0">
                <button
                  type="button"
                  onClick={() => hasPayload && toggle(r.id)}
                  className={`flex w-full items-baseline gap-2 px-3 py-2 text-left text-xs ${
                    hasPayload ? 'hover:bg-surface-subtle' : 'cursor-default'
                  }`}
                >
                  <span className="font-mono text-ink-muted tabular-nums">{fmtTime(r.at)}</span>
                  <span className="font-mono">{r.action}</span>
                  <span className="ml-auto text-ink-subtle">{actorLabel(r)}</span>
                  {hasPayload ? <span className="text-ink-subtle">{open ? '▾' : '▸'}</span> : null}
                </button>
                {open && hasPayload ? (
                  <pre className="border-t border-surface-muted bg-surface-subtle px-3 py-2 font-mono text-[11px] text-ink-muted overflow-auto">
                    {JSON.stringify(r.payload, null, 2)}
                  </pre>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
