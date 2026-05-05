import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { useToast } from '../components/Toast';
import { api, ApiError } from '../lib/api';

interface QueueStats {
  redis: 'configured' | 'unconfigured';
  extraction?: {
    waiting: number;
    active: number;
    delayed: number;
    completed: number;
    failed: number;
  };
}

export function MaintenanceAdminPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const stats = useQuery({
    queryKey: ['admin', 'queue-stats'],
    queryFn: () => api.get<QueueStats>('/api/admin/maintenance/queue-stats'),
    refetchInterval: 5_000,
  });
  const pruneSessions = useMutation({
    mutationFn: () => api.post<{ deleted: number }>('/api/admin/maintenance/prune-sessions'),
  });
  const cleanTmp = useMutation({
    mutationFn: () =>
      api.post<{ removed: number; kept: number; tmpDir: string }>(
        '/api/admin/maintenance/clean-tmp',
      ),
  });
  const refreshFidir = useMutation({
    mutationFn: () => api.post('/api/admin/fidir/refresh'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'fidir', 'status'] }),
  });

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <Link to="/admin" className="text-sm text-ink-muted hover:text-ink">
        ← Admin
      </Link>
      <h1 className="text-2xl font-semibold">Maintenance</h1>

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-base font-medium">Extraction queue (BullMQ)</h2>
        {stats.data ? (
          stats.data.redis === 'unconfigured' ? (
            <p className="mt-2 text-sm text-ink-muted">
              REDIS_URL is not configured — extraction queue is offline. Inline workers run in the
              API process when Redis becomes available.
            </p>
          ) : (
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
              {Object.entries(stats.data.extraction ?? {}).map(([k, v]) => (
                <div key={k}>
                  <dt className="text-ink-muted">{k}</dt>
                  <dd className="font-mono">{v}</dd>
                </div>
              ))}
            </dl>
          )
        ) : null}
      </section>

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-base font-medium">Sessions</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Server-side session rows (Phase 6). Expired rows are pruned daily by the maintenance
          worker; trigger a one-shot prune below.
        </p>
        <button
          type="button"
          disabled={pruneSessions.isPending}
          onClick={async () => {
            try {
              const r = await pruneSessions.mutateAsync();
              toast.success(`Pruned ${r.deleted} expired session${r.deleted === 1 ? '' : 's'}`);
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'failed');
            }
          }}
          className="mt-3 rounded-md border border-surface-muted px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {pruneSessions.isPending ? 'Pruning…' : 'Prune expired sessions'}
        </button>
      </section>

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-base font-medium">Disk: tmp directory</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Removes any subdirectory under <code>$DATA_DIR/tmp</code> older than 6 hours (Phase 9 item
          21).
        </p>
        <button
          type="button"
          disabled={cleanTmp.isPending}
          onClick={async () => {
            try {
              const r = await cleanTmp.mutateAsync();
              toast.success(
                `Cleaned ${r.removed} tmp entr${r.removed === 1 ? 'y' : 'ies'} (${r.kept} kept).`,
              );
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'failed');
            }
          }}
          className="mt-3 rounded-md border border-surface-muted px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {cleanTmp.isPending ? 'Cleaning…' : 'Clean stale tmp entries'}
        </button>
      </section>

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-base font-medium">FIDIR</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Re-import banks from <code>data/fidir/fidir-us.txt</code>. Operators replace the file
          quarterly; this just re-runs the seeder.
        </p>
        <button
          type="button"
          disabled={refreshFidir.isPending}
          onClick={async () => {
            try {
              await refreshFidir.mutateAsync();
              toast.success('FIDIR re-imported');
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'failed');
            }
          }}
          className="mt-3 rounded-md border border-surface-muted px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {refreshFidir.isPending ? 'Refreshing…' : 'Refresh FIDIR'}
        </button>
      </section>
    </section>
  );
}
