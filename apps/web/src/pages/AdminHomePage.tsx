import { type FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { UpdateAvailableBanner } from '../components/UpdateAvailableBanner';
import { api, ApiError } from '../lib/api';

interface ProviderStatus {
  provider: 'local' | 'anthropic';
  anthropicModel: string | null;
  anthropicKeyConfigured: boolean;
}

interface FidirStatus {
  entriesCount: number;
  lastRefreshedAt: string | null;
}

interface FailedStatement {
  id: string;
  accountId: string;
  status: string;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RecentActivityRow {
  id: string;
  at: string;
  actorEmail: string | null;
  actorDisplayName: string | null;
  entityType: string;
  action: string;
}

interface RecentActivityResp {
  rows: RecentActivityRow[];
  total: number;
}

export function AdminHomePage() {
  const qc = useQueryClient();
  const provider = useQuery({
    queryKey: ['admin', 'llm-provider'],
    queryFn: () => api.get<ProviderStatus>('/api/admin/llm-provider'),
  });
  const fidir = useQuery({
    queryKey: ['admin', 'fidir', 'status'],
    queryFn: () => api.get<FidirStatus>('/api/admin/fidir/status'),
  });
  // Last 10 audit events. The audit endpoint is admin-only and the
  // AdminHomePage is mounted behind <AdminGate/>, so we don't gate
  // again. Stale-while-revalidate keeps the list current without
  // hammering the API on tab switches.
  const activity = useQuery({
    queryKey: ['admin', 'recent-activity'],
    queryFn: () => api.get<RecentActivityResp>('/api/audit', { limit: '10', mutationsOnly: '1' }),
    staleTime: 15_000,
  });
  // Fetch all statements and filter client-side. With <5k statements
  // this is fast; if the firm grows past that we can add a status
  // filter to GET /api/statements. Polled because failed jobs come
  // from the worker, not user interaction.
  const allStmts = useQuery({
    queryKey: ['statements', 'all-for-failed-widget'],
    queryFn: () => api.get<FailedStatement[]>('/api/statements'),
    refetchInterval: 30_000,
  });
  const reExtract = useMutation({
    mutationFn: (statementId: string) =>
      api.post<{ ok: boolean }>(`/api/statements/${statementId}/re-extract`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['statements', 'all-for-failed-widget'] }),
  });
  const failedRows = (allStmts.data ?? [])
    .filter((s) => s.status === 'failed')
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 5);
  const switchProvider = useMutation({
    mutationFn: (p: 'local' | 'anthropic') => api.post('/api/admin/llm-provider', { provider: p }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'llm-provider'] }),
  });
  const setKey = useMutation({
    mutationFn: (apiKey: string) => api.post('/api/admin/llm-provider/anthropic-key', { apiKey }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'llm-provider'] }),
  });
  const refreshFidir = useMutation({
    mutationFn: () => api.post('/api/admin/fidir/refresh'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'fidir', 'status'] }),
  });

  const [keyInput, setKeyInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warningTyped, setWarningTyped] = useState('');

  const onSetKey = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (warningTyped !== 'I UNDERSTAND OCR TEXT EGRESSES') {
      setError('Type the warning phrase exactly to confirm.');
      return;
    }
    try {
      await setKey.mutateAsync(keyInput);
      setKeyInput('');
      setWarningTyped('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed');
    }
  };

  return (
    <section className="mx-auto max-w-3xl space-y-8">
      <UpdateAvailableBanner />
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <nav className="flex flex-wrap gap-3 text-sm">
          <Link to="/admin/users" className="text-accent hover:underline">
            Users →
          </Link>
          <Link to="/admin/audit" className="text-accent hover:underline">
            Audit log →
          </Link>
          <Link to="/admin/diagnostics" className="text-accent hover:underline">
            Diagnostics →
          </Link>
          <Link to="/admin/llm-provider" className="text-accent hover:underline">
            LLM provider →
          </Link>
          <Link to="/admin/maintenance" className="text-accent hover:underline">
            Maintenance →
          </Link>
          <Link to="/admin/engines" className="text-accent hover:underline">
            Engines →
          </Link>
          <Link to="/admin/backup" className="text-accent hover:underline">
            Backup →
          </Link>
          <Link to="/admin/categories" className="text-accent hover:underline">
            Categories →
          </Link>
        </nav>
      </header>

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-lg font-medium">LLM provider</h2>
        {provider.data ? (
          <>
            <p className="mt-1 text-sm">
              Current: <strong>{provider.data.provider}</strong>
              {provider.data.provider === 'anthropic'
                ? ` · model ${provider.data.anthropicModel ?? 'claude-sonnet-4-6'}`
                : ' · Qwen3-8B via Vibe LLM Gateway'}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={provider.data.provider === 'local'}
                onClick={() => switchProvider.mutate('local')}
                className="rounded-md border border-surface-muted px-3 py-1.5 text-sm disabled:opacity-50"
              >
                Use local
              </button>
              <button
                type="button"
                disabled={
                  provider.data.provider === 'anthropic' || !provider.data.anthropicKeyConfigured
                }
                onClick={() => switchProvider.mutate('anthropic')}
                className="rounded-md border border-surface-muted px-3 py-1.5 text-sm disabled:opacity-50"
              >
                Use Anthropic
              </button>
            </div>

            <form onSubmit={onSetKey} className="mt-4 border-t border-surface-muted pt-4">
              <p className="text-sm">
                {provider.data.anthropicKeyConfigured
                  ? 'Replace Anthropic API key'
                  : 'Set Anthropic API key'}
              </p>
              <p className="mt-1 text-xs text-ink-subtle">
                Stored AES-256-GCM-encrypted at rest. Only OCR-extracted markdown egresses; raw PDFs
                and page images NEVER leave this server.
              </p>
              <input
                type="password"
                placeholder="sk-ant-…"
                className="mt-2 w-full rounded-md border border-surface-muted px-3 py-2"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
              />
              <input
                type="text"
                aria-describedby="warning-phrase-hint"
                placeholder="Type the phrase below exactly"
                className="mt-2 w-full rounded-md border border-surface-muted px-3 py-2"
                value={warningTyped}
                onChange={(e) => setWarningTyped(e.target.value)}
              />
              <p id="warning-phrase-hint" className="mt-1 text-xs text-ink-subtle">
                Required phrase:{' '}
                <code className="rounded bg-surface-subtle px-1 font-mono">
                  I UNDERSTAND OCR TEXT EGRESSES
                </code>
              </p>
              {error ? (
                <p role="alert" className="mt-2 text-sm text-danger">
                  {error}
                </p>
              ) : null}
              <button
                type="submit"
                disabled={setKey.isPending || keyInput.length < 20}
                className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
              >
                {setKey.isPending ? 'Saving…' : 'Save key'}
              </button>
            </form>
          </>
        ) : null}
      </section>

      {failedRows.length > 0 ? (
        <section className="rounded-lg border border-red-300 bg-red-50/40 p-4">
          <h2 className="text-lg font-medium text-red-900">
            Failed extractions ({failedRows.length})
          </h2>
          <ul className="mt-2 divide-y divide-red-200 text-sm">
            {failedRows.map((s) => (
              <li key={s.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <Link to={`/statements/${s.id}`} className="font-mono text-xs hover:underline">
                    {s.id.slice(0, 8)}
                  </Link>
                  <p className="text-xs text-red-900/80">
                    {s.errorMessage ?? 'No error message recorded.'}
                  </p>
                  <p className="text-[11px] text-ink-subtle">
                    {new Date(s.updatedAt).toLocaleString()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => reExtract.mutate(s.id)}
                  disabled={reExtract.isPending}
                  className="rounded-md border border-red-300 bg-white px-2 py-1 text-xs text-red-900 hover:bg-red-100 disabled:opacity-50"
                >
                  {reExtract.isPending && reExtract.variables === s.id ? '…' : 'Re-extract'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Recent activity</h2>
          <Link to="/admin/audit" className="text-xs text-accent hover:underline">
            Full audit log →
          </Link>
        </div>
        {activity.isPending ? (
          <p className="mt-2 text-sm text-ink-muted">Loading…</p>
        ) : !activity.data || activity.data.rows.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">No mutations recorded yet.</p>
        ) : (
          <ol className="mt-3 divide-y divide-surface-muted text-xs">
            {activity.data.rows.map((r) => (
              <li key={r.id} className="flex items-baseline gap-2 py-1.5">
                <span className="font-mono tabular-nums text-ink-muted">
                  {new Date(r.at).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span className="font-mono">{r.action}</span>
                <span className="text-ink-subtle">on {r.entityType}</span>
                <span className="ml-auto text-ink-subtle">
                  {r.actorDisplayName ?? r.actorEmail ?? 'system'}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-lg font-medium">FIDIR</h2>
        {fidir.data ? (
          <>
            <p className="mt-1 text-sm">
              {fidir.data.entriesCount} entries · last refreshed{' '}
              {fidir.data.lastRefreshedAt
                ? new Date(fidir.data.lastRefreshedAt).toLocaleString()
                : 'never'}
            </p>
            <button
              type="button"
              onClick={() => refreshFidir.mutate()}
              disabled={refreshFidir.isPending}
              className="mt-3 rounded-md border border-surface-muted px-3 py-1.5 text-sm"
            >
              {refreshFidir.isPending ? 'Refreshing…' : 'Refresh from vendored file'}
            </button>
          </>
        ) : null}
      </section>
    </section>
  );
}
