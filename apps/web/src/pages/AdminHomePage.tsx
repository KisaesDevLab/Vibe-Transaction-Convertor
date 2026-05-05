import { type FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

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
                placeholder="Type: I UNDERSTAND OCR TEXT EGRESSES"
                className="mt-2 w-full rounded-md border border-surface-muted px-3 py-2"
                value={warningTyped}
                onChange={(e) => setWarningTyped(e.target.value)}
              />
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
