// Phase 24 ExportPage. Mounted at /statements/:id/export. Operators land
// here from the review page's "Export…" link or directly from the audit
// log (when re-downloading an old export). The inline format buttons on
// the review page still exist for the quick-and-dirty path; this page is
// for the considered path where you want a preview, want to pick a
// subset of formats, or want to grab a prior export.

import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog';
import { EntityAuditLog } from '../components/EntityAuditLog';
import { useToast } from '../components/Toast';
import {
  useDeleteExportJob,
  useExportJobs,
  useExportPreview,
  useStatement,
} from '../hooks/useStatementsList';
import { useMe } from '../hooks/useAuth';
import { ApiError, downloadFile } from '../lib/api';

const FORMATS: Array<{ value: string; label: string; description: string }> = [
  { value: 'csv-qbo3', label: 'CSV (QBO 3-col)', description: 'Date, Description, Amount' },
  {
    value: 'csv-qbo4',
    label: 'CSV (QBO 4-col)',
    description: 'Date, Description, Credit, Debit',
  },
  { value: 'csv-xero', label: 'CSV (Xero)', description: '*Date, *Amount, Payee, …' },
  {
    value: 'csv-generic',
    label: 'CSV (Generic)',
    description: 'Date, Description, Amount, RunningBalance, …',
  },
  { value: 'ofx', label: 'OFX 2.x XML', description: 'Standalone OFX, modern parsers' },
  { value: 'qbo', label: 'QBO Web Connect', description: 'OFX 1.0.2 SGML for QuickBooks' },
  { value: 'qfx', label: 'QFX', description: 'OFX 1.0.2 SGML for Quicken' },
];

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export function ExportPage() {
  const { statementId = '' } = useParams();
  const stmt = useStatement(statementId);
  const jobs = useExportJobs(statementId);
  const deleteJob = useDeleteExportJob(statementId);
  const me = useMe();
  const isAdmin = me.data?.role === 'admin';
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(['csv-qbo3', 'qbo']));
  const [previewFormat, setPreviewFormat] = useState<string>('csv-qbo3');
  // Active delete-export confirmation. null = none open. Holds the
  // job context so the dialog can show what's being deleted.
  const [pendingDelete, setPendingDelete] = useState<{ id: string; format: string } | null>(null);

  const overridden = stmt.data?.statement.reconciliationStatus === 'overridden';
  const allowOverride = overridden;
  const blocked = stmt.data?.statement.reconciliationStatus === 'discrepancy';

  const preview = useExportPreview(statementId, previewFormat, allowOverride);

  const toggle = (fmt: string): void => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(fmt)) next.delete(fmt);
      else next.add(fmt);
      return next;
    });
  };

  const onDownloadOne = async (fmt: string): Promise<void> => {
    try {
      await downloadFile(
        'POST',
        `/api/statements/${statementId}/exports/${fmt}${allowOverride ? '?override=true' : ''}`,
        `export.${fmt.startsWith('csv-') ? 'csv' : fmt}`,
      );
      toast.success(`Downloaded ${fmt}`);
      jobs.refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'export failed');
    }
  };

  const onDownloadSelected = async (): Promise<void> => {
    if (selected.size === 0) {
      toast.info('Pick at least one format.');
      return;
    }
    if (selected.size === 1) {
      await onDownloadOne([...selected][0]!);
      return;
    }
    // Multi-format: hit the bundle endpoint (renders all 7) and let the
    // user save the zip. The server includes formats they didn't ask
    // for, but it's still the most efficient path — JSZip on the client
    // for a subset would require parallel rendering.
    try {
      await downloadFile(
        'POST',
        `/api/statements/${statementId}/exports-bundle${allowOverride ? '?override=true' : ''}`,
        'exports-bundle.zip',
      );
      toast.success(`Downloaded all 7 formats as a zip`);
      jobs.refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'bundle export failed');
    }
  };

  const onDownloadJob = async (jobId: string): Promise<void> => {
    try {
      await downloadFile('GET', `/api/exports/${jobId}/file`, `export-${jobId.slice(0, 8)}`);
      toast.success('Downloaded prior export');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'download failed');
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    try {
      await deleteJob.mutateAsync(pendingDelete.id);
      toast.success(`Deleted ${pendingDelete.format} export`);
      setPendingDelete(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'delete failed');
    }
  };

  const jobsData = jobs.data;
  const groupedJobs = useMemo(() => {
    if (!jobsData) return null;
    const m = new Map<string, typeof jobsData>();
    for (const j of jobsData) {
      const list = m.get(j.format) ?? [];
      list.push(j);
      m.set(j.format, list);
    }
    return m;
  }, [jobsData]);

  if (stmt.isPending) return <p className="text-sm text-ink-muted">Loading…</p>;
  if (!stmt.data) return <p className="text-sm text-danger">Statement not found.</p>;

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <div>
        <Link to={`/statements/${statementId}`} className="text-sm text-ink-muted hover:text-ink">
          ← Review
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Export</h1>
        <p className="text-sm text-ink-subtle">
          Pick formats, preview before downloading, and re-grab any prior export.
        </p>
      </div>

      {blocked ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Reconciliation is in <strong>discrepancy</strong>. Fix the rows or override the
          reconciliation on the review page before exporting.
        </div>
      ) : null}

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Formats</h2>
          <ul className="space-y-1">
            {FORMATS.map((f) => (
              <li
                key={f.value}
                className="flex items-start gap-3 rounded-md border border-surface-muted bg-white p-3"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected.has(f.value)}
                  onChange={() => toggle(f.value)}
                />
                <div className="flex-1">
                  <button
                    type="button"
                    onClick={() => setPreviewFormat(f.value)}
                    className={`text-left font-medium ${previewFormat === f.value ? 'text-accent' : ''}`}
                  >
                    {f.label}
                  </button>
                  <p className="text-xs text-ink-muted">{f.description}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void onDownloadOne(f.value)}
                  disabled={blocked}
                  className="rounded-md border border-surface-muted px-2 py-1 text-xs disabled:opacity-50"
                >
                  Download
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => void onDownloadSelected()}
            disabled={blocked || selected.size === 0}
            className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            {selected.size <= 1
              ? 'Download selected'
              : `Download all 7 as zip (${selected.size} requested)`}
          </button>
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Preview — {previewFormat}
          </h2>
          {preview.isPending ? (
            <p className="text-xs text-ink-muted">Rendering…</p>
          ) : preview.data ? (
            <div className="rounded-md border border-surface-muted bg-white">
              <div className="border-b border-surface-muted px-3 py-2 text-xs text-ink-muted">
                {preview.data.filename} · {formatBytes(preview.data.totalBytes)} ·{' '}
                {preview.data.totalLines} lines
                {preview.data.truncated ? ' (showing first 30)' : ''}
              </div>
              <pre className="max-h-[400px] overflow-auto bg-surface-subtle p-3 font-mono text-xs">
                {preview.data.previewLines.join('\n')}
              </pre>
            </div>
          ) : (
            <p className="text-xs text-danger">
              {preview.error instanceof ApiError ? preview.error.message : 'preview failed'}
            </p>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Prior exports
        </h2>
        {jobs.isPending ? (
          <p className="text-xs text-ink-muted">Loading…</p>
        ) : !jobs.data || jobs.data.length === 0 ? (
          <p className="rounded-md border border-dashed border-surface-muted bg-surface-subtle p-4 text-xs text-ink-muted">
            No prior exports for this statement.
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-surface-muted">
            <table className="w-full text-sm">
              <thead className="bg-surface-subtle text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Format</th>
                  <th className="px-3 py-2 text-left">When</th>
                  <th className="px-3 py-2 text-right">Size</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {jobs.data.map((j) => (
                  <tr key={j.id} className="border-t border-surface-muted">
                    <td className="px-3 py-2 font-mono text-xs">{j.format}</td>
                    <td className="px-3 py-2 text-xs">
                      {new Date(j.requestedAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums">
                      {formatBytes(j.fileBytes)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => void onDownloadJob(j.id)}
                          disabled={!j.available}
                          title={
                            j.available
                              ? 'Re-download this exact file'
                              : 'Expired (>30 days) — re-export to refresh'
                          }
                          className="rounded-md border border-surface-muted px-2 py-1 text-xs disabled:opacity-50"
                        >
                          ↓ Download
                        </button>
                        {isAdmin ? (
                          <button
                            type="button"
                            onClick={() => setPendingDelete({ id: j.id, format: j.format })}
                            title="Delete this export (admin only)"
                            className="rounded-md border border-danger px-2 py-1 text-xs text-danger hover:bg-danger/10"
                          >
                            Delete
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {groupedJobs ? (
          <p className="text-xs text-ink-subtle">
            {[...groupedJobs.entries()].map(([fmt, list]) => `${fmt}: ${list.length}×`).join(' · ')}
          </p>
        ) : null}
      </section>

      {/* Audit trail — every render, re-download, override, and now
          delete is logged. Useful here for "who exported what when". */}
      <EntityAuditLog entityType="statement" entityId={statementId} title="Export audit log" />

      <DeleteConfirmDialog
        open={pendingDelete !== null}
        title={`Delete ${pendingDelete?.format ?? ''} export?`}
        description="The rendered file is removed from disk. The audit trail (record of when it was exported, by whom, and the bytes) stays — audit_log is append-only."
        busy={deleteJob.isPending}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </section>
  );
}
