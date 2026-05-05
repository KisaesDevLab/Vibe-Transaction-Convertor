import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

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

export function AuditLogPage() {
  const list = useQuery({
    queryKey: ['audit'],
    queryFn: () => api.get<{ rows: AuditRow[]; total: number }>('/api/audit'),
  });

  return (
    <section className="mx-auto max-w-5xl">
      <Link to="/admin" className="text-sm text-ink-muted hover:text-ink">
        ← Admin
      </Link>
      <h1 className="mt-2 mb-6 text-2xl font-semibold">Audit log</h1>

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
              {list.data.rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="px-3 py-2 text-ink-muted">{new Date(r.at).toLocaleString()}</td>
                  <td className="px-3 py-2 font-medium">{r.action}</td>
                  <td className="px-3 py-2">
                    <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-xs">
                      {r.entityType}
                    </span>
                    <span className="ml-2 font-mono text-xs">{r.entityId.slice(0, 12)}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-subtle">
                    {r.payload ? JSON.stringify(r.payload) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
