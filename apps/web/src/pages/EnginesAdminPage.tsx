import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { api } from '../lib/api';

interface ReadyCheck {
  status: 'ok' | 'degraded';
  dependencies: Record<
    string,
    { status: 'ok' | 'fail' | 'unconfigured'; latencyMs?: number; detail?: string }
  >;
}

interface ProviderStatus {
  provider: 'local' | 'anthropic';
  anthropicModel: string | null;
  anthropicKeyConfigured: boolean;
}

const palette = (s: 'ok' | 'fail' | 'unconfigured'): string =>
  s === 'ok'
    ? 'bg-emerald-50 text-emerald-800'
    : s === 'fail'
      ? 'bg-red-50 text-red-800'
      : 'bg-surface-muted text-ink-muted';

export function EnginesAdminPage() {
  const ready = useQuery({
    queryKey: ['health', 'ready'],
    queryFn: () => api.get<ReadyCheck>('/api/health/ready'),
    refetchInterval: 5_000,
  });
  const provider = useQuery({
    queryKey: ['admin', 'llm-provider'],
    queryFn: () => api.get<ProviderStatus>('/api/admin/llm-provider'),
  });

  const deps = ready.data?.dependencies ?? {};
  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <Link to="/admin" className="text-sm text-ink-muted hover:text-ink">
        ← Admin
      </Link>
      <h1 className="text-2xl font-semibold">Engines</h1>
      <p className="text-sm text-ink-muted">
        External services the extractor and uploader depend on. Ready-probe runs every 5 seconds.
      </p>

      <Engine
        name="PostgreSQL 16"
        envVar="DATABASE_URL"
        info={deps.postgres}
        notes="Persistence layer. Schema 'vibetc'; audit_log is append-only."
      />
      <Engine
        name="Redis 7"
        envVar="REDIS_URL"
        info={deps.redis}
        notes="BullMQ queue + login rate-limit cache. Optional in dev; required in production."
      />
      <Engine
        name="GLM-OCR"
        envVar="GLM_OCR_URL"
        info={deps.glmOcr}
        notes="Zhipu GLM-OCR over HTTP. Used only when the PDF lacks a text layer."
      />
      <Engine
        name="LLM Gateway (Vibe)"
        envVar="LLM_GATEWAY_URL"
        info={deps.llmGateway}
        notes={
          provider.data?.provider === 'anthropic'
            ? 'Local provider available but currently routed to Anthropic — Vibe Gateway sits idle.'
            : 'Default extraction provider — Qwen3-8B via Vibe LLM Gateway.'
        }
      />

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-base font-medium">LLM provider routing</h2>
        {provider.data ? (
          <p className="mt-2 text-sm">
            Currently routing extractions to{' '}
            <strong className="font-mono">{provider.data.provider}</strong>
            {provider.data.provider === 'anthropic' && provider.data.anthropicModel
              ? ` · model ${provider.data.anthropicModel}`
              : ''}
            .{' '}
            {provider.data.anthropicKeyConfigured
              ? 'Anthropic API key is configured.'
              : 'Anthropic API key not configured.'}{' '}
            <Link to="/admin" className="text-accent hover:underline">
              Change in /admin →
            </Link>
          </p>
        ) : null}
      </section>
    </section>
  );
}

function Engine({
  name,
  envVar,
  info,
  notes,
}: {
  name: string;
  envVar: string;
  info?:
    | { status: 'ok' | 'fail' | 'unconfigured'; latencyMs?: number; detail?: string }
    | undefined;
  notes?: string | undefined;
}) {
  const status = info?.status ?? 'unconfigured';
  return (
    <section className="rounded-lg border border-surface-muted bg-white p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-base font-medium">{name}</h2>
        <span className={`rounded px-1.5 py-0.5 text-xs ${palette(status)}`}>{status}</span>
      </header>
      <p className="mt-1 text-xs text-ink-subtle">
        env <code className="rounded bg-surface-subtle px-1">{envVar}</code>
        {info?.latencyMs !== undefined ? ` · ${info.latencyMs} ms` : ''}
        {info?.detail ? ` · ${info.detail}` : ''}
      </p>
      {notes ? <p className="mt-2 text-sm text-ink-muted">{notes}</p> : null}
    </section>
  );
}
