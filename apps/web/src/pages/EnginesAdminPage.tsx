// /admin/engines — DB-backed engine configuration with a live readiness
// probe. Operators can edit Vibe Shield (OCR) and LLM-Gateway URLs (plus per-engine
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
  source: 'db' | 'env' | 'default' | 'unset';
  timeoutMs?: number;
  concurrency?: number;
  // Optional overrides (Vibe Shield only). null / undefined means "use
  // the client default" — the edit form treats both as "unset".
  healthPath?: string | null;
  model?: string | null;
  prompt?: string | null;
  // The plaintext apiKey is never returned over the wire — the API
  // strips it via maskEngineConfig. We only see the two derived
  // fields and the input field is write-only.
  hasApiKey?: boolean;
  apiKeyLastFour?: string | null;
}

type EngineKey = 'vibe-shield' | 'llm-gateway';

interface EnginesResponse {
  configs: Record<EngineKey, EngineConfig>;
}

interface TestResult {
  ok: boolean;
  source: EngineConfig['source'];
  detail: string | null;
  latencyMs?: number;
}

interface CostSummary {
  days7: { totalUsd: number; statements: number };
  days30: { totalUsd: number; statements: number; avgUsdPerStatement: number };
  days90: { totalUsd: number; statements: number };
}

const fmtUsd = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const palette = (s: 'ok' | 'fail' | 'unconfigured'): string =>
  s === 'ok'
    ? 'bg-emerald-50 text-emerald-800'
    : s === 'fail'
      ? 'bg-red-50 text-red-800'
      : 'bg-surface-muted text-ink-muted';

const sourceLabel = (s: EngineConfig['source']): string =>
  s === 'db'
    ? 'operator-set'
    : s === 'env'
      ? 'from environment'
      : s === 'default'
        ? 'appliance default'
        : 'unset';

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
  const cost = useQuery({
    queryKey: ['admin', 'llm-cost'],
    queryFn: () => api.get<CostSummary>('/api/admin/llm-provider/cost-summary'),
    // Cost numbers move slowly; refresh every minute is plenty.
    refetchInterval: 60_000,
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
        engine="vibe-shield"
        name="Vibe Shield — OCR (vision)"
        envVar="VIBE_SHIELD_URL"
        status={deps.vibeShield}
        config={cfgs?.['vibe-shield'] ?? null}
        showAdvanced
        showShieldFields
        showApiKey
        notes="Stage 1 of 2 — OCR. Scanned page images are read by Claude VISION, turning the scan into markdown text. (Stage 2 — turning that text into structured rows — is the separate LLM provider on /admin/llm-provider, which defaults to the local gateway.) DEFAULT: route through the Vibe Shield gateway (it masks PII first) — URL defaults to http://vibe-shield-gateway:8080 (leave blank to use it) and the key is your Shield tenant key (vs_live_…, appId='converter'); requires Vibe Shield ≥ v1.12 with ZDR. Run `pnpm shield:smoke` to verify. DIRECT MODE: set the URL to https://api.anthropic.com and the key to a real sk-ant key to bypass Shield — ⚠️ this egresses UNREDACTED page images to Anthropic (no PII masking) and needs outbound internet."
      />

      <EditableEngine
        engine="llm-gateway"
        name="LLM Gateway (Vibe)"
        envVar="LLM_GATEWAY_URL"
        status={deps.llmGateway}
        config={cfgs?.['llm-gateway'] ?? null}
        notes="Default extraction provider — Qwen3-8B via Vibe LLM Gateway. Switching to Anthropic happens on /admin/llm-provider; this URL is only used when provider=local."
      />

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <header className="flex items-baseline justify-between">
          <h2 className="text-base font-medium">LLM cost rollup</h2>
          <Link to="/admin/llm-provider" className="text-xs text-accent hover:underline">
            Manage provider →
          </Link>
        </header>
        <p className="mt-1 text-xs text-ink-muted">
          Rolls up{' '}
          <code className="rounded bg-surface-subtle px-1">statements.llm_cost_micros</code> per
          window. Local provider is free, so these only move when routing to Anthropic.
        </p>
        {cost.data ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <CostCard
              label="7d"
              usd={cost.data.days7.totalUsd}
              statements={cost.data.days7.statements}
            />
            <CostCard
              label="30d"
              usd={cost.data.days30.totalUsd}
              statements={cost.data.days30.statements}
              extra={`avg ${fmtUsd(cost.data.days30.avgUsdPerStatement)}/stmt`}
            />
            <CostCard
              label="90d"
              usd={cost.data.days90.totalUsd}
              statements={cost.data.days90.statements}
            />
          </div>
        ) : (
          <p className="mt-2 text-xs text-ink-muted">Loading…</p>
        )}
      </section>
    </section>
  );
}

function CostCard({
  label,
  usd,
  statements,
  extra,
}: {
  label: string;
  usd: number;
  statements: number;
  extra?: string;
}) {
  return (
    <div className="rounded-md border border-surface-muted bg-surface-subtle p-3">
      <p className="text-xs uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="mt-1 font-mono text-lg tabular-nums">{fmtUsd(usd)}</p>
      <p className="text-xs text-ink-subtle">{statements} statements</p>
      {extra ? <p className="mt-1 text-xs text-ink-subtle">{extra}</p> : null}
    </div>
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
  showShieldFields = false,
  showApiKey = false,
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
  // Exposes the health-path + Claude model + OCR-prompt inputs (Vibe
  // Shield only).
  showShieldFields?: boolean | undefined;
  // Exposes the bearer-token field. Write-only — the plaintext key
  // never round-trips back from the server (see maskEngineConfig).
  showApiKey?: boolean | undefined;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [timeoutMs, setTimeoutMs] = useState('');
  const [concurrency, setConcurrency] = useState('');
  const [healthPath, setHealthPath] = useState('');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [apiKey, setApiKey] = useState('');

  // Hydrate inputs whenever the loaded config changes (after a save the
  // server returns the new value, which may differ from what was typed
  // — e.g., a trailing slash trimmed).
  useEffect(() => {
    if (!config) return;
    setUrl(config.source === 'db' ? (config.url ?? '') : '');
    setTimeoutMs(config.timeoutMs ? String(config.timeoutMs) : '');
    setConcurrency(config.concurrency ? String(config.concurrency) : '');
    setHealthPath(config.healthPath ?? '');
    setModel(config.model ?? '');
    setPrompt(config.prompt ?? '');
    // apiKey is write-only — the API doesn't echo it back, only
    // `hasApiKey` + last-4. Reset the input on re-hydration so a
    // typed-but-unsaved value doesn't survive a refresh.
    setApiKey('');
  }, [config]);

  const save = useMutation({
    mutationFn: (input: {
      url?: string | null;
      timeoutMs?: number | null;
      concurrency?: number | null;
      healthPath?: string | null;
      model?: string | null;
      prompt?: string | null;
      apiKey?: string | null;
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
    const input: {
      url?: string | null;
      timeoutMs?: number | null;
      concurrency?: number | null;
      healthPath?: string | null;
      model?: string | null;
      prompt?: string | null;
      apiKey?: string | null;
    } = {};
    const trimmed = url.trim();
    if (trimmed.length === 0) input.url = null;
    else input.url = trimmed;
    if (showAdvanced) {
      const t = timeoutMs.trim();
      input.timeoutMs = t.length === 0 ? null : Number.parseInt(t, 10);
      const c = concurrency.trim();
      input.concurrency = c.length === 0 ? null : Number.parseInt(c, 10);
    }
    if (showShieldFields) {
      const norm = (s: string): string | null => (s.trim().length === 0 ? null : s.trim());
      input.healthPath = norm(healthPath);
      input.model = norm(model);
      input.prompt = prompt.trim().length === 0 ? null : prompt;
    }
    if (showApiKey) {
      // Only send the apiKey field when the operator actually typed
      // something. Empty input means "don't touch the stored value" —
      // otherwise loading the page and clicking Save would clear it.
      // Clearing is done via the dedicated button below.
      if (apiKey.trim().length > 0) input.apiKey = apiKey.trim();
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
        {showShieldFields ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-xs text-ink-muted">
                Health path
                <input
                  type="text"
                  placeholder="/health"
                  value={healthPath}
                  onChange={(e) => setHealthPath(e.target.value)}
                  className="mt-1 w-full rounded-md border border-surface-muted px-3 py-1.5 text-sm font-mono"
                />
              </label>
              <label className="block text-xs text-ink-muted">
                Claude model
                <input
                  type="text"
                  placeholder="claude-sonnet-4-6"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="mt-1 w-full rounded-md border border-surface-muted px-3 py-1.5 text-sm font-mono"
                />
              </label>
            </div>
            <label className="block text-xs text-ink-muted">
              OCR prompt (per page)
              <textarea
                rows={3}
                placeholder="Transcribe this statement page to Markdown…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="mt-1 w-full rounded-md border border-surface-muted px-3 py-1.5 text-sm"
              />
            </label>
          </>
        ) : null}
        {showApiKey ? (
          <label className="block text-xs text-ink-muted">
            API key (sent as Authorization: Bearer)
            <div className="mt-1 flex items-center gap-2">
              <input
                type="password"
                autoComplete="off"
                placeholder={
                  config?.hasApiKey
                    ? `••••••••${config.apiKeyLastFour ?? ''} — leave blank to keep, or type to replace`
                    : 'No key configured'
                }
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="flex-1 rounded-md border border-surface-muted px-3 py-1.5 text-sm font-mono"
              />
              {config?.hasApiKey ? (
                <button
                  type="button"
                  onClick={async () => {
                    if (!window.confirm(`Clear ${name} API key?`)) return;
                    try {
                      await save.mutateAsync({ apiKey: null });
                      toast.success(`${name} API key cleared`);
                    } catch (err) {
                      toast.error(err instanceof ApiError ? err.message : 'clear failed');
                    }
                  }}
                  disabled={save.isPending}
                  className="rounded-md border border-danger px-3 py-1 text-xs text-danger hover:bg-danger/5 disabled:opacity-50"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </label>
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
