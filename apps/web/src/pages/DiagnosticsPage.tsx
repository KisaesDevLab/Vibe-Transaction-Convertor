import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { api } from '../lib/api';

interface Diagnostics {
  env: {
    nodeVersion: string;
    platform: string;
    buildSha: string;
    appliance: boolean;
    workerInline: boolean;
  };
  rss: { rssMb: number };
  services: {
    databaseUrl: 'configured' | 'unconfigured';
    redisUrl: 'configured' | 'unconfigured';
    glmOcrUrl: 'configured' | 'unconfigured';
    llmGatewayUrl: 'configured' | 'unconfigured';
    anthropicBaseUrl: string;
  };
  counts: Record<string, number>;
  uptime: { seconds: number };
}

interface ReadyCheck {
  status: 'ok' | 'degraded';
  dependencies: Record<
    string,
    { status: 'ok' | 'fail' | 'unconfigured'; latencyMs?: number; detail?: string }
  >;
}

const fmtUptime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
};

const Pill = ({
  ok,
  text,
}: {
  ok: 'ok' | 'fail' | 'unconfigured' | 'configured';
  text: string;
}) => {
  const palette =
    ok === 'ok' || ok === 'configured'
      ? 'bg-emerald-50 text-emerald-800'
      : ok === 'fail'
        ? 'bg-red-50 text-red-800'
        : 'bg-surface-muted text-ink-muted';
  return <span className={`rounded px-1.5 py-0.5 text-xs ${palette}`}>{text}</span>;
};

export function DiagnosticsPage() {
  const diag = useQuery({
    queryKey: ['admin', 'diagnostics'],
    queryFn: () => api.get<Diagnostics>('/api/admin/diagnostics'),
    refetchInterval: 5_000,
  });
  const ready = useQuery({
    queryKey: ['health', 'ready'],
    queryFn: () => api.get<ReadyCheck>('/api/health/ready'),
    refetchInterval: 5_000,
  });

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <Link to="/admin" className="text-sm text-ink-muted hover:text-ink">
        ← Admin
      </Link>
      <h1 className="text-2xl font-semibold">Diagnostics</h1>

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-base font-medium">Runtime</h2>
        {diag.data ? (
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-ink-muted">Node</dt>
              <dd className="font-mono">{diag.data.env.nodeVersion}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Platform</dt>
              <dd className="font-mono">{diag.data.env.platform}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Build SHA</dt>
              <dd className="font-mono">{diag.data.env.buildSha}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Mode</dt>
              <dd>
                {diag.data.env.appliance ? 'appliance' : 'standalone'}
                {' · '}
                worker {diag.data.env.workerInline ? 'inline' : 'separate'}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">Memory (RSS)</dt>
              <dd className="font-mono">{diag.data.rss.rssMb} MB</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Uptime</dt>
              <dd className="font-mono">{fmtUptime(diag.data.uptime.seconds)}</dd>
            </div>
          </dl>
        ) : null}
      </section>

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-base font-medium">Dependencies</h2>
        {ready.data ? (
          <ul className="mt-3 space-y-1.5 text-sm">
            {Object.entries(ready.data.dependencies).map(([name, info]) => (
              <li key={name} className="flex items-center justify-between gap-2">
                <span className="font-medium">{name}</span>
                <span className="flex items-center gap-2">
                  {info.latencyMs !== undefined ? (
                    <span className="text-xs text-ink-subtle">{info.latencyMs} ms</span>
                  ) : null}
                  {info.detail ? (
                    <span className="text-xs text-ink-subtle">{info.detail}</span>
                  ) : null}
                  <Pill ok={info.status} text={info.status} />
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-base font-medium">Counts</h2>
        {diag.data ? (
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {Object.entries(diag.data.counts).map(([k, v]) => (
              <div key={k}>
                <dt className="text-ink-muted">{k}</dt>
                <dd className="font-mono">{v.toLocaleString()}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </section>

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-base font-medium">Service URLs</h2>
        {diag.data ? (
          <ul className="mt-3 space-y-1.5 text-sm">
            <li className="flex items-center justify-between">
              <span>DATABASE_URL</span>
              <Pill ok={diag.data.services.databaseUrl} text={diag.data.services.databaseUrl} />
            </li>
            <li className="flex items-center justify-between">
              <span>REDIS_URL</span>
              <Pill ok={diag.data.services.redisUrl} text={diag.data.services.redisUrl} />
            </li>
            <li className="flex items-center justify-between">
              <span>GLM_OCR_URL</span>
              <Pill ok={diag.data.services.glmOcrUrl} text={diag.data.services.glmOcrUrl} />
            </li>
            <li className="flex items-center justify-between">
              <span>LLM_GATEWAY_URL</span>
              <Pill ok={diag.data.services.llmGatewayUrl} text={diag.data.services.llmGatewayUrl} />
            </li>
            <li className="flex items-center justify-between">
              <span>ANTHROPIC_BASE_URL</span>
              <code className="rounded bg-surface-subtle px-1.5 py-0.5 text-xs">
                {diag.data.services.anthropicBaseUrl}
              </code>
            </li>
          </ul>
        ) : null}
      </section>
    </section>
  );
}
