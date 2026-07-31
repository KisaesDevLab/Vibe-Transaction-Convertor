// Phase 26 #6/#7/#8/#9: real backup admin page. Trigger pg_dump via the
// API, list dumps under $DATA_DIR/backups, download, restore, or delete
// each. Replaces the prior documentation-only stub.
//
// Restore is the destructive one: it replaces the whole vibetc schema.
// The server takes a safety dump of the current database first and runs
// the restore in a single transaction, so the two things this UI must
// get right are (a) making the operator type the phrase before it fires
// and (b) not silently swallowing the warnings that come back.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog';
import { useToast } from '../components/Toast';
import { ApiError, api, withBase } from '../lib/api';

interface BackupSummary {
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

interface BackupsResponse {
  backups: BackupSummary[];
  retentionDays: number;
}

interface RestoreResult {
  restoredFrom: string;
  safetyBackup: BackupSummary | null;
  schemas: string[];
  migrated: boolean;
  warnings: string[];
  durationMs: number;
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
  const [pendingRestore, setPendingRestore] = useState<BackupSummary | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
  // Multipart, so it bypasses the JSON api helper the same way the PDF
  // upload hook does — same CSRF-header + error-shape contract.
  const upload = useMutation({
    mutationFn: async (file: File): Promise<BackupSummary> => {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(withBase('/api/admin/backups/upload'), {
        method: 'POST',
        credentials: 'include',
        headers: csrfHeader(),
        body: form,
      });
      const body = (await res.json().catch(() => ({}))) as BackupSummary & { message?: string };
      if (!res.ok) throw new ApiError(res.status, body);
      return body;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'backups'] }),
  });

  const restore = useMutation({
    mutationFn: (filename: string) =>
      api.post<RestoreResult>(`/api/admin/backups/${encodeURIComponent(filename)}/restore`, {
        confirm: 'RESTORE',
      }),
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

  const onUpload = async (): Promise<void> => {
    if (!uploadFile) return;
    setUploadError(null);
    try {
      const result = await upload.mutateAsync(uploadFile);
      setUploadFile(null);
      if (fileRef.current) fileRef.current.value = '';
      toast.success(`Uploaded ${result.filename} (${formatBytes(result.sizeBytes)})`);
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : 'upload failed');
    }
  };

  // Deliberately does NOT refetch anything on success. The restore
  // replaces the `sessions` table too, so the current session may no
  // longer exist — any follow-up request would 401 and bounce us to
  // /login before the operator has read the result. We patch the new
  // safety backup into the cached list instead and let them reload
  // when they've read it.
  const onRestore = async (): Promise<void> => {
    const target = pendingRestore;
    if (!target) return;
    setRestoreError(null);
    try {
      const result = await restore.mutateAsync(target.filename);
      setPendingRestore(null);
      setRestoreResult(result);
      if (result.safetyBackup) {
        const safety = result.safetyBackup;
        qc.setQueryData<BackupsResponse>(['admin', 'backups'], (prev) =>
          prev && !prev.backups.some((b) => b.filename === safety.filename)
            ? { ...prev, backups: [safety, ...prev.backups] }
            : prev,
        );
      }
      toast.success(`Restored ${result.restoredFrom}`);
    } catch (err) {
      setRestoreError(err instanceof ApiError ? err.message : 'restore failed');
    }
  };

  const onDownload = async (filename: string): Promise<void> => {
    try {
      const res = await fetch(withBase(`/api/admin/backups/${encodeURIComponent(filename)}/file`), {
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
          Trigger a <code>pg_dump</code> of the <code>vibetc</code> schema, download the resulting
          file, restore from it, and prune older dumps. Files live under{' '}
          <code>$DATA_DIR/backups</code>.
        </p>
      </header>

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-base font-medium">Create backup</h2>
        <p className="mt-1 text-xs text-ink-subtle">
          Runs <code>pg_dump --no-owner --schema=vibetc --schema=drizzle --format=custom</code> —
          the data plus the migration bookkeeping, so a restore can be brought forward to this
          build. Takes seconds for a small statement set, may take a minute on a busy database.
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
        <h2 className="text-base font-medium">Upload a backup</h2>
        <p className="mt-1 text-xs text-ink-subtle">
          Add a <code>.dump</code> downloaded from another install (or kept off-box) so it can be
          restored here. The file is checked before it is accepted — it must be a readable
          custom-format dump containing a <code>vibetc</code> schema.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".dump,application/octet-stream"
            onChange={(e) => {
              setUploadError(null);
              setUploadFile(e.target.files?.[0] ?? null);
            }}
            className="text-xs file:mr-3 file:rounded-md file:border file:border-surface-muted file:bg-surface-subtle file:px-3 file:py-1.5 file:text-xs"
          />
          <button
            type="button"
            onClick={() => void onUpload()}
            disabled={!uploadFile || upload.isPending}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            {upload.isPending ? 'Uploading…' : 'Upload'}
          </button>
          {uploadFile ? (
            <span className="text-xs text-ink-muted">{formatBytes(uploadFile.size)}</span>
          ) : null}
        </div>
        {uploadError ? (
          <p className="mt-3 whitespace-pre-wrap rounded-md border border-danger bg-danger/5 p-2 text-xs text-danger">
            {uploadError}
          </p>
        ) : null}
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
                          title="Download"
                          className="rounded-md border border-surface-muted px-2 py-1 text-xs"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRestoreError(null);
                            setRestoreResult(null);
                            setPendingRestore(b);
                          }}
                          disabled={restore.isPending}
                          className="rounded-md border border-amber-300 px-2 py-1 text-xs text-amber-800 hover:bg-amber-50 disabled:opacity-50"
                        >
                          Restore
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

      {restoreResult ? (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <h2 className="text-base font-medium">
            Restored {restoreResult.restoredFrom} ({(restoreResult.durationMs / 1000).toFixed(1)}s)
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
            {restoreResult.safetyBackup ? (
              <li>
                The pre-restore database was dumped to{' '}
                <code className="font-mono">{restoreResult.safetyBackup.filename}</code>. Restore
                that file to undo this.
              </li>
            ) : null}
            <li>
              Replaced schema{restoreResult.schemas.length > 1 ? 's' : ''}:{' '}
              <code className="font-mono">{restoreResult.schemas.join(', ')}</code>
              {restoreResult.migrated ? ' · migrations re-applied afterwards' : ''}
            </li>
            {restoreResult.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
            <li>
              Sessions came from the backup, so you may be signed out. Reload to pick up the
              restored data.
            </li>
          </ul>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg"
          >
            Reload
          </button>
        </section>
      ) : null}

      <section className="rounded-lg border border-surface-muted bg-white p-4 text-sm">
        <h2 className="text-base font-medium">Restore</h2>
        <p className="mt-1 text-ink-muted">
          Use the <strong>Restore</strong> button on any backup above. It replaces the entire{' '}
          <code>vibetc</code> schema with that dump — every company, statement, transaction, user,
          and audit row goes back to the state it was in when the backup was taken. The server dumps
          the current database first, so a restore is itself undoable.
        </p>
        <p className="mt-2 text-xs text-ink-subtle">
          Equivalent from the host shell:{' '}
          <code>pnpm --filter @vibe-tx-converter/api db:restore &lt;file&gt;</code>. Both run the
          same code.
        </p>
      </section>

      <DeleteConfirmDialog
        open={pendingRestore !== null}
        title="Restore from backup"
        confirmText="RESTORE"
        confirmButtonLabel="Restore"
        busyLabel="Restoring…"
        busy={restore.isPending}
        onClose={() => {
          if (!restore.isPending) setPendingRestore(null);
        }}
        onConfirm={onRestore}
        description={
          <div className="space-y-2 text-sm text-ink-muted">
            <p>
              This replaces <strong>all</strong> data in the <code>vibetc</code> schema with the
              contents of this backup. Anything created since it was taken — statements, exports,
              users, audit history — is gone.
            </p>
            <p className="text-xs">
              A safety dump of the current database is taken first, and the restore runs in a single
              transaction: if it fails, nothing changes. You may be signed out afterwards.
            </p>
          </div>
        }
        preview={
          pendingRestore ? (
            <div className="space-y-3">
              <div>
                <p className="font-mono">{pendingRestore.filename}</p>
                <p className="mt-1 text-ink-muted">
                  {formatBytes(pendingRestore.sizeBytes)} ·{' '}
                  {new Date(pendingRestore.createdAt).toLocaleString()} (
                  {ageDescription(pendingRestore.createdAt)})
                </p>
              </div>
              {restoreError ? (
                <p className="whitespace-pre-wrap rounded-md border border-danger bg-danger/5 p-2 text-danger">
                  {restoreError}
                </p>
              ) : null}
            </div>
          ) : null
        }
      />
    </section>
  );
}
