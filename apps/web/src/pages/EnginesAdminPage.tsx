// /admin/engines — DB-backed engine configuration with a live readiness
// probe. Operators can edit GLM-OCR and LLM-Gateway URLs (plus per-engine
// timeoutMs / concurrency where applicable) without a restart; values
// land in `system_settings`, falling back to the env vars when unset.
//
// Postgres + Redis stay read-only — they're set via the boot env and
// changing them at runtime would require reconnecting half the app.

import { type FormEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { useToast } from '../components/Toast';
import { ApiError, api } from '../lib/api';

interface ReadyCheck {
  status: 'ok' | 'degraded';
  dependencies: Record<
    string,
    { status: 'ok' | 'fail' | 'unconfigured'; latencyMs?: number; detail?: string }
  >;
}

interface EngineConfig {
  url: string | null;
  source: 'db' | 'env' | 'unset';
  timeoutMs?: number;
  concurrency?: number;
}

type EngineKey = 'glm-ocr' | 'llm-gateway';

interface EnginesResponse {
  configs: Record<EngineKey, EngineConfig>;
}

interface TestResult {
  ok: boolean;
  source: EngineConfig['source'];
  detail: string | null;
  latencyMs?: number;
}

const palette = (s: 'ok' | 'fail' | 'unconfigured'): string =>
  s === 'ok'
    ? 'bg-emerald-50 text-emerald-800'
    : s === 'fail'
      ? 'bg-red-50 text-red-800'
      : 'bg-surface-muted text-ink-muted';

const sourceLabel = (s: EngineConfig['source']): string =>
  s === 'db' ? 'operator-set' : s === 'env' ? 'from environment' : 'unset';

export function EnginesAdminPage() {
  const ready = useQuery({
    queryKey: ['health', 'ready'],
    queryFn: () => api.get<ReadyCheck>('/api/health/ready'),
    refetchInterval: 5_000,
  });
  const engines = useQuery({
    queryKey: ['admin', 'engines'],
    queryFn: () => api.get<EnginesResponse>('/api/admin/engines'),
  });

  const deps = ready.data?.dependencies ?? {};
  const cfgs = engines.data?.configs;

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <Link to="/admin" className="text-sm text-ink-muted hover:text-ink">
        ← Admin
      </Link>
      <header>
        <h1 className="text-2xl font-semibold">Engines</h1>
        <p className="text-sm text-ink-muted">
          External services the extractor and uploader depend on. Edits land in
          <code className="mx-1 rounded bg-surface-subtle px-1">system_settings</code>
          and take effect on the next call (no restart). Ready-probe runs every 5 seconds.
        </p>
      </header>

      <ReadOnlyEngine
        name="PostgreSQL 16"
        envVar="DATABASE_URL"
        status={deps.postgres}
        notes="Persistence layer. Schema 'vibetc'; audit_log is append-only. Set via boot env only — runtime changes would require reconnecting BullMQ + Drizzle pools."
      />
      <ReadOnlyEngine
        name="Redis 7"
        envVar="REDIS_URL"
        status={deps.redis}
        notes="BullMQ queue + login rate-limit + OCR cache. Set via boot env only."
      />

      <EditableEngine
        engine="glm-ocr"
        name="GLM-OCR"
        envVar="GLM_OCR_URL"
        status={deps.glmOcr}
        config={cfgs?.['glm-ocr'] ?? null}
        showAdvanced
        notes="Zhipu GLM-OCR over HTTP. Used only when the PDF lacks a text layer. Standalone: typically http://glm-ocr:8080 (compose) or http://localhost:8080 (host). Appliance: shared service URL."
      />

      <EditableEngine
        engine="llm-gateway"
        name="LLM Gateway (Vibe)"
        envVar="LLM_GATEWAY_URL"
        status={deps.llmGateway}
        config={cfgs?.['llm-gateway'] ?? null}
        notes="Default extraction provider — Qwen3-8B via Vibe LLM Gateway. Switching to Anthropic happens on /admin/llm-provider; this URL is only used when provider=local."
      />
    </section>
  );
}

function StatusPill({
  status,
}: {
  status?:
    | { status: 'ok' | 'fail' | 'unconfigured'; latencyMs?: number; detail?: string }
    | undefined;
}) {
  const s = status?.status ?? 'unconfigured';
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs ${palette(s)}`}>
      {s}
      {status?.latencyMs !== undefined ? ` · ${status.latencyMs} ms` : ''}
    </span>
  );
}

function ReadOnlyEngine({
  name,
  envVar,
  status,
  notes,
}: {
  name: string;
  envVar: string;
  status?:
    | { status: 'ok' | 'fail' | 'unconfigured'; latencyMs?: number; detail?: string }
    | undefined;
  notes?: string | undefined;
}) {
  return (
    <section className="rounded-lg border border-surface-muted bg-white p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-base font-medium">{name}</h2>
        <StatusPill status={status} />
      </header>
      <p className="mt-1 text-xs text-ink-subtle">
        env <code className="rounded bg-surface-subtle px-1">{envVar}</code>
        {status?.detail ? ` · ${status.detail}` : ''}
      </p>
      {notes ? <p className="mt-2 text-sm text-ink-muted">{notes}</p> : null}
    </section>
  );
}

function EditableEngine({
  engine,
  name,
  envVar,
  status,
  config,
  notes,
  showAdvanced = false,
}: {
  engine: EngineKey;
  name: string;
  envVar: string;
  status?:
    | { status: 'ok' | 'fail' | 'unconfigured'; latencyMs?: number; detail?: string }
    | undefined;
  config: EngineConfig | null;
  notes?: string | undefined;
  showAdvanced?: boolean | undefined;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [timeoutMs, setTimeoutMs] = useState('');
  const [concurrency, setConcurrency] = useState('');

  // Hydrate inputs whenever the loaded config changes (after a save the
  // server returns the new value, which may differ from what was typed
  // — e.g., a trailing slash trimmed).
  useEffect(() => {
    if (!config) return;
    setUrl(config.source === 'db' ? (config.url ?? '') : '');
    setTimeoutMs(config.timeoutMs ? String(config.timeoutMs) : '');
    setConcurrency(config.concurrency ? String(config.concurrency) : '');
  }, [config]);

  const save = useMutation({
    mutationFn: (input: {
      url?: string | null;
      timeoutMs?: number | null;
      concurrency?: number | null;
    }) => api.post<EngineConfig>(`/api/admin/engines/${engine}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'engines'] });
      qc.invalidateQueries({ queryKey: ['health', 'ready'] });
    },
  });
  const reset = useMutation({
    mutationFn: () => api.delete<EngineConfig>(`/api/admin/engines/${engine}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'engines'] });
      qc.invalidateQueries({ queryKey: ['health', 'ready'] });
    },
  });
  const test = useMutation({
    mutationFn: () => api.post<TestResult>(`/api/admin/engines/${engine}/test`),
  });

  const onSave = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const input: { url?: string | null; timeoutMs?: number | null; concurrency?: number | null } =
      {};
    const trimmed = url.trim();
    if (trimmed.length === 0) input.url = null;
    else input.url = trimmed;
    if (showAdvanced) {
      const t = timeoutMs.trim();
      input.timeoutMs = t.length === 0 ? null : Number.parseInt(t, 10);
      const c = concurrency.trim();
      input.concurrency = c.length === 0 ? null : Number.parseInt(c, 10);
    }
    try {
      await save.mutateAsync(input);
      toast.success(`${name} configuration saved`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'save failed');
    }
  };

  const onReset = async (): Promise<void> => {
    if (
      !window.confirm(`Reset ${name} to environment defaults? Operator overrides will be cleared.`)
    )
      return;
    try {
      await reset.mutateAsync();
      toast.success(`${name} reset to environment`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'reset failed');
    }
  };

  const onTest = async (): Promise<void> => {
    try {
      const result = await test.mutateAsync();
      if (result.ok) {
        toast.success(
          `${name} reachable${result.latencyMs !== undefined ? ` (${result.latencyMs} ms)` : ''}`,
        );
      } else {
        toast.error(`${name} not reachable: ${result.detail ?? 'unknown error'}`);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'test failed');
    }
  };

  return (
    <section className="rounded-lg border border-surface-muted bg-white p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-base font-medium">{name}</h2>
        <StatusPill status={status} />
      </header>
      <p className="mt-1 text-xs text-ink-subtle">
        env <code className="rounded bg-surface-subtle px-1">{envVar}</code>
        {config ? ` · ${sourceLabel(config.source)}` : ''}
        {config?.url ? (
          <>
            {' · '}
            <code className="rounded bg-surface-subtle px-1">{config.url}</code>
          </>
        ) : null}
        {status?.detail ? ` · ${status.detail}` : ''}
      </p>
      {notes ? <p className="mt-2 text-sm text-ink-muted">{notes}</p> : null}

      <form onSubmit={onSave} className="mt-3 space-y-2">
        <label className="block text-xs text-ink-muted">
          URL
          <input
            type="url"
            placeholder={`Leave blank to use ${envVar}`}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="mt-1 w-full rounded-md border border-surface-muted px-3 py-1.5 text-sm font-mono"
          />
        </label>
        {showAdvanced ? (
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-ink-muted">
              Timeout (ms)
              <input
                type="number"
                min="500"
                step="500"
                placeholder="60000"
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(e.target.value)}
                className="mt-1 w-full rounded-md border border-surface-muted px-3 py-1.5 text-sm tabular-nums"
              />
            </label>
            <label className="block text-xs text-ink-muted">
              Concurrency
              <input
                type="number"
                min="1"
                max="16"
                placeholder="2"
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
                className="mt-1 w-full rounded-md border border-surface-muted px-3 py-1.5 text-sm tabular-nums"
              />
            </label>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={save.isPending}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => void onTest()}
            disabled={test.isPending}
            className="rounded-md border border-accent px-3 py-1.5 text-sm text-accent hover:bg-accent/5 disabled:opacity-50"
          >
            {test.isPending ? 'Testing…' : 'Test connection'}
          </button>
          {config?.source === 'db' ? (
            <button
              type="button"
              onClick={() => void onReset()}
              disabled={reset.isPending}
              className="rounded-md border border-danger px-3 py-1.5 text-sm text-danger hover:bg-danger/5 disabled:opacity-50"
            >
              Reset to env
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
