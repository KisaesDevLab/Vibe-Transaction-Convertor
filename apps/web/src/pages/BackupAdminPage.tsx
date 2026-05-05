// Phase 26 #6/#7/#8/#9: real backup admin page. Trigger pg_dump via the
// API, list dumps under $DATA_DIR/backups, download or delete each.
// Replaces the prior documentation-only stub.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { useToast } from '../components/Toast';
import { ApiError, api } from '../lib/api';

interface BackupSummary {
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

interface BackupsResponse {
  backups: BackupSummary[];
  retentionDays: number;
}

const csrfHeader = (): Record<string, string> => ({
  'x-csrf-token':
    document.cookie
      .split('; ')
      .find((c) => c.startsWith('vibetc_csrf='))
      ?.split('=')[1] ?? '',
});

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const ageDescription = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h ago`;
  const mins = Math.max(1, Math.floor(ms / 60_000));
  return `${mins}m ago`;
};

export function BackupAdminPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({
    queryKey: ['admin', 'backups'],
    queryFn: () => api.get<BackupsResponse>('/api/admin/backups'),
  });

  const create = useMutation({
    mutationFn: () => api.post<BackupSummary>('/api/admin/backup'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'backups'] }),
  });
  const remove = useMutation({
    mutationFn: (filename: string) =>
      api.delete<void>(`/api/admin/backups/${encodeURIComponent(filename)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'backups'] }),
  });

  const onCreate = async (): Promise<void> => {
    if (!window.confirm('Create a new database backup now? This may take a minute.')) return;
    try {
      const result = await create.mutateAsync();
      toast.success(`Created ${result.filename} (${formatBytes(result.sizeBytes)})`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'backup failed');
    }
  };

  const onDelete = async (filename: string): Promise<void> => {
    if (!window.confirm(`Delete ${filename}? This cannot be undone.`)) return;
    try {
      await remove.mutateAsync(filename);
      toast.success(`Deleted ${filename}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'delete failed');
    }
  };

  const onDownload = async (filename: string): Promise<void> => {
    try {
      const res = await fetch(`/api/admin/backups/${encodeURIComponent(filename)}/file`, {
        credentials: 'include',
        headers: csrfHeader(),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new ApiError(res.status, body);
      }
      const blob = await res.blob();
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

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <Link to="/admin" className="text-sm text-ink-muted hover:text-ink">
        ← Admin
      </Link>
      <header>
        <h1 className="text-2xl font-semibold">Backup</h1>
        <p className="text-sm text-ink-subtle">
          Trigger a <code>pg_dump</code> against the <code>vibetc</code> schema, download the
          resulting file, and prune older dumps. Files live under <code>$DATA_DIR/backups</code>.
        </p>
      </header>

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-base font-medium">Create backup</h2>
        <p className="mt-1 text-xs text-ink-subtle">
          Runs <code>pg_dump --no-owner --schema=vibetc --format=custom</code>. Takes seconds for a
          small statement set, may take a minute on a busy database.
        </p>
        <button
          type="button"
          onClick={() => void onCreate()}
          disabled={create.isPending}
          className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {create.isPending ? 'Creating…' : 'Create backup now'}
        </button>
      </section>

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-base font-medium">Existing backups</h2>
          {list.data ? (
            <p className="text-xs text-ink-subtle">
              Retention: {list.data.retentionDays}d (override via <code>BACKUP_RETENTION_DAYS</code>
              )
            </p>
          ) : null}
        </div>

        {list.isPending ? (
          <p className="text-xs text-ink-muted">Loading…</p>
        ) : !list.data || list.data.backups.length === 0 ? (
          <p className="rounded-md border border-dashed border-surface-muted bg-surface-subtle p-4 text-xs text-ink-muted">
            No backups yet. Create the first one above.
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-surface-muted">
            <table className="w-full text-sm">
              <thead className="bg-surface-subtle text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Filename</th>
                  <th className="px-3 py-2 text-right">Size</th>
                  <th className="px-3 py-2 text-left">Age</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {list.data.backups.map((b) => (
                  <tr key={b.filename} className="border-t border-surface-muted">
                    <td className="px-3 py-2 font-mono text-xs">{b.filename}</td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums">
                      {formatBytes(b.sizeBytes)}
                    </td>
                    <td className="px-3 py-2 text-xs text-ink-muted">
                      {ageDescription(b.createdAt)}
                      <span className="block text-[10px] text-ink-subtle">
                        {new Date(b.createdAt).toLocaleString()}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex gap-1">
                        <button
                          type="button"
                          onClick={() => void onDownload(b.filename)}
                          className="rounded-md border border-surface-muted px-2 py-1 text-xs"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => void onDelete(b.filename)}
                          disabled={remove.isPending}
                          className="rounded-md border border-danger px-2 py-1 text-xs text-danger hover:bg-danger/5 disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-surface-muted bg-white p-4 text-sm">
        <h2 className="text-base font-medium">Restore</h2>
        <p className="mt-1 text-ink-muted">
          Restore is operator-only — run on the host shell, not from the browser. The dump file
          downloaded above is restorable via <code>pg_restore</code>:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-md bg-surface-subtle p-3 font-mono text-xs">
          {`pg_restore --no-owner --clean --if-exists \\
  --dbname=$DATABASE_URL \\
  vibetc-2026-05-05T....dump`}
        </pre>
        <p className="mt-2 text-xs text-ink-subtle">
          The companion script{' '}
          <code>pnpm --filter @vibe-tx-converter/api db:restore &lt;file&gt;</code> wraps this with
          the configured <code>DATABASE_URL</code>.
        </p>
      </section>
    </section>
  );
}
