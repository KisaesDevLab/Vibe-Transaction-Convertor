// Phase 26 admin page for the LLM provider — local Vibe Gateway vs.
// Anthropic API. The home /admin page also renders an inline summary;
// this page is the deep-config surface (model picker, monthly cap,
// test-connection, cost dashboard, key rotation).

import { type FormEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { useToast } from '../components/Toast';
import { api, ApiError } from '../lib/api';

type LlmProviderPolicy = 'local-only' | 'anthropic-only' | 'local-first' | 'anthropic-first';

type PdfProcessingStrategy =
  | 'auto'
  | 'force-text'
  | 'force-ocr'
  | 'auto-ocr-fallback'
  | 'auto-text-fallback';

const PDF_STRATEGY_LABELS: Record<PdfProcessingStrategy, { title: string; description: string }> = {
  auto: {
    title: 'Auto',
    description:
      'Text-layer when the PDF has one; local OCR (Ollama Qwen-VL vision) when it doesn’t. No retry. Current default.',
  },
  'force-text': {
    title: 'Force text-layer',
    description:
      'Always read the embedded text layer. Upload fails if the PDF has none (scanned-only banks).',
  },
  'force-ocr': {
    title: 'Force OCR',
    description:
      'Always run local OCR (Ollama Qwen-VL vision), even when a text layer is present. Useful when the embedded text is scrambled or hidden.',
  },
  'auto-ocr-fallback': {
    title: 'Text-layer with OCR fallback',
    description:
      'Try the text layer first; if the LLM rejects the result (HTTP error, malformed response, empty transactions, or reconciliation discrepancy), retry with local OCR. Up to twice the LLM cost when triggered.',
  },
  'auto-text-fallback': {
    title: 'OCR with text-layer fallback',
    description:
      'Run local OCR first; if the LLM rejects the result, retry with the embedded text layer (when present). Mirror of the OCR-fallback path — useful when the text layer is unreliable (scrambled / hidden text). Up to twice the LLM cost when triggered.',
  },
};

interface ProviderStatus {
  // `provider` is the currently-active primary, derived from the
  // policy. `policy` is what's actually persisted; older API clients
  // pre-policy still read `provider` only.
  provider: 'local' | 'anthropic';
  policy: LlmProviderPolicy;
  anthropicModel: string | null;
  anthropicKeyConfigured: boolean;
  anthropicKeyLastFour: string | null;
  allowedModels: string[];
  // Effective Anthropic base URL + whether extraction is proxied through an
  // operator-configured Messages-API proxy rather than hitting Anthropic
  // directly (ANTHROPIC_BASE_URL).
  anthropicBaseUrl: string;
  anthropicViaProxy: boolean;
  // Local Ollama config (default provider). Resolved DB → env → default.
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaVisionModel: string;
  // Suggested vision/OCR tags for the picker (MiniCPM-V 4.5 first).
  curatedVisionModels: string[];
  // Per-call extraction/enrichment timeout (ms). DB-backed; falls back to
  // LLM_TIMEOUT_MS env, then 60000.
  llmTimeoutMs: number;
  // Per-call output-token ceiling. DB-backed; falls back to
  // LLM_MAX_COMPLETION_TOKENS env, then 32000.
  llmMaxTokens: number;
  // Resolved on-the-wire request shape — what the provider will actually
  // send. effectiveModel applies the DB → env → default fallback.
  effectiveModel: string;
  effectiveMaxTokens: number;
  monthlyCapUsd: number | null;
  // Operator-tunable AI knobs (check-payee vision / GLM-OCR / text extraction /
  // review safety net), rendered generically by `kind` and grouped.
  aiSettings: AiSetting[];
  // GLM-OCR stage-1 engine (ADR-025): resolved config + live health probe.
  glmOcr: {
    url: string | null;
    model: string;
    health: { ok: boolean; status?: number; detail?: string };
  };
  // VibeOCR (ADR-026): PDF-native OCR engine + which engine is selected.
  vibeOcr: {
    url: string | null;
    engine: 'vibe' | 'glm';
    health: { ok: boolean; status?: number; detail?: string };
  };
}

interface AiSetting {
  id: string;
  group:
    | 'vision'
    | 'ocr'
    | 'extraction'
    | 'safety'
    | 'proc-extraction'
    | 'proc-cleanse'
    | 'proc-category'
    | 'proc-check';
  kind: 'int' | 'float' | 'string' | 'bool' | 'enum';
  label: string;
  help: string;
  value: string;
  source: 'db' | 'env' | 'default';
  default: string;
  min?: number;
  max?: number;
  enumValues?: string[];
  unit?: string;
}

const POLICY_LABELS: Record<LlmProviderPolicy, { title: string; description: string }> = {
  'local-only': {
    title: 'Local only',
    description:
      'Always use the local Vibe Gateway (Qwen). No outbound API call. Statement fails if the local extraction fails.',
  },
  'anthropic-only': {
    title: 'Anthropic only',
    description:
      'Always send OCR-extracted markdown to Anthropic. Statement fails if Anthropic fails.',
  },
  'local-first': {
    title: 'Local first, fall back to Anthropic',
    description:
      'Try the local gateway; if extraction fails (HTTP error, malformed response, empty transactions, or reconciliation discrepancy), retry once on Anthropic.',
  },
  'anthropic-first': {
    title: 'Anthropic first, fall back to local',
    description:
      'Try Anthropic; if extraction fails any of the four triggers, retry once on the local gateway.',
  },
};

interface TestResult {
  provider: 'local' | 'anthropic';
  ok: boolean;
  detail: string | null;
}

interface CostSummary {
  days7: { totalUsd: number; statements: number };
  days30: { totalUsd: number; statements: number; avgUsdPerStatement: number };
  days90: { totalUsd: number; statements: number };
}

const fmtUsd = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// Phase 26 #29: typed-confirmation phrase. Filed verbatim in the audit
// log when an operator enables the Anthropic provider.
const CONFIRM_PHRASE = 'I AUTHORIZE OCR EGRESS';

// Mirrors the server default (resolveLlmTimeoutMs / DEFAULT_LLM_TIMEOUT_MS).
const DEFAULT_TIMEOUT_MS = 60000;
// Mirrors the server default (resolveLlmMaxTokens / DEFAULT_LLM_MAX_TOKENS).
const DEFAULT_MAX_TOKENS = 32000;

export function LlmProviderAdminPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const provider = useQuery({
    queryKey: ['admin', 'llm-provider'],
    queryFn: () => api.get<ProviderStatus>('/api/admin/llm-provider'),
  });
  const cost = useQuery({
    queryKey: ['admin', 'llm-cost'],
    queryFn: () => api.get<CostSummary>('/api/admin/llm-provider/cost-summary'),
  });
  // Live catalog of models installed on the Ollama host — drives the model
  // dropdowns. {ok:false} (empty list) when Ollama is unreachable; the fields
  // stay free-text either way.
  const localModels = useQuery({
    queryKey: ['admin', 'local-models'],
    queryFn: () =>
      api.get<{ models: string[]; ok: boolean }>('/api/admin/llm-provider/local-models'),
    staleTime: 60_000,
  });

  const switchPolicy = useMutation({
    mutationFn: (p: LlmProviderPolicy) => api.post('/api/admin/llm-provider', { policy: p }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'llm-provider'] }),
  });
  const pdfStrategy = useQuery({
    queryKey: ['admin', 'pdf-strategy'],
    queryFn: () => api.get<{ strategy: PdfProcessingStrategy }>('/api/admin/pdf-strategy'),
  });
  const switchPdfStrategy = useMutation({
    mutationFn: (s: PdfProcessingStrategy) =>
      api.post<{ strategy: PdfProcessingStrategy }>('/api/admin/pdf-strategy', { strategy: s }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'pdf-strategy'] }),
  });
  // PDF retention: days = null/0 → disabled, positive int → auto-purge
  // PDFs older than N days. The daily cron honors this; the "Run now"
  // button below triggers the same sweep on demand.
  const pdfRetention = useQuery({
    queryKey: ['admin', 'pdf-retention'],
    queryFn: () =>
      api.get<{ days: number | null; lastSweepAt: string | null }>('/api/admin/pdf-retention'),
  });
  const setRetention = useMutation({
    mutationFn: (days: number | null) =>
      api.post<{ days: number | null }>('/api/admin/pdf-retention', { days }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'pdf-retention'] }),
  });
  const runRetentionNow = useMutation({
    mutationFn: () =>
      api.post<{
        ranAt: string;
        retentionDays: number | null;
        candidates: number;
        filesRemoved: number;
        rowsFlipped: number;
        skipped: 'disabled' | null;
      }>('/api/admin/pdf-retention/sweep'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'pdf-retention'] }),
  });
  const setKey = useMutation({
    mutationFn: (apiKey: string) => api.post('/api/admin/llm-provider/anthropic-key', { apiKey }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'llm-provider'] }),
  });
  const clearKey = useMutation({
    mutationFn: () => api.delete('/api/admin/llm-provider/anthropic-key'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'llm-provider'] }),
  });
  const setModel = useMutation({
    mutationFn: (model: string) => api.post('/api/admin/llm-provider/anthropic-model', { model }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'llm-provider'] }),
  });
  const setBaseUrl = useMutation({
    mutationFn: (baseUrl: string) =>
      api.post('/api/admin/llm-provider/anthropic-base-url', { baseUrl }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'llm-provider'] }),
  });
  const setCap = useMutation({
    mutationFn: (usd: number | null) => api.post('/api/admin/llm-provider/monthly-cap', { usd }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'llm-provider'] }),
  });
  const setLlmTimeout = useMutation({
    mutationFn: (timeoutMs: number | '') =>
      api.post('/api/admin/llm-provider/timeout', { timeoutMs }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'llm-provider'] }),
  });
  const setLlmMaxTokens = useMutation({
    mutationFn: (maxTokens: number | '') =>
      api.post('/api/admin/llm-provider/max-tokens', { maxTokens }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'llm-provider'] }),
  });
  const setOllamaBaseUrl = useMutation({
    mutationFn: (baseUrl: string) =>
      api.post('/api/admin/llm-provider/ollama-base-url', { baseUrl }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'llm-provider'] }),
  });
  const setOllamaModel = useMutation({
    mutationFn: (model: string) => api.post('/api/admin/llm-provider/ollama-model', { model }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'llm-provider'] }),
  });
  const setOllamaVisionModel = useMutation({
    mutationFn: (visionModel: string) =>
      api.post('/api/admin/llm-provider/ollama-vision-model', { visionModel }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'llm-provider'] }),
  });
  const setAiSettingMut = useMutation({
    mutationFn: (input: { id: string; value: string }) =>
      api.post('/api/admin/llm-provider/ai-setting', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'llm-provider'] }),
  });
  const test = useMutation({
    mutationFn: () => api.post<TestResult>('/api/admin/llm-provider/test'),
  });

  const [keyInput, setKeyInput] = useState('');
  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onSetKey = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (confirmPhrase !== CONFIRM_PHRASE) {
      setError(`Type the phrase exactly to confirm: ${CONFIRM_PHRASE}`);
      return;
    }
    if (keyInput.length < 20) {
      setError('Anthropic keys are longer than 20 characters.');
      return;
    }
    try {
      await setKey.mutateAsync(keyInput);
      setKeyInput('');
      setConfirmPhrase('');
      toast.success('Anthropic key stored AES-256-GCM-encrypted at rest.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed');
    }
  };

  const onClearKey = async (): Promise<void> => {
    if (!window.confirm('Clear the stored Anthropic API key? Provider will fall back to local.'))
      return;
    try {
      await clearKey.mutateAsync();
      toast.success('Anthropic key cleared.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'clear failed');
    }
  };

  const onTest = async (): Promise<void> => {
    try {
      const result = await test.mutateAsync();
      if (result.ok) toast.success(`Provider "${result.provider}" reachable.`);
      else toast.error(`Provider "${result.provider}" not reachable: ${result.detail ?? '?'}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'test failed');
    }
  };

  const onSetCap = async (raw: string): Promise<void> => {
    const value = raw.trim();
    if (value === '') {
      await setCap.mutateAsync(null);
      toast.success('Monthly cap cleared (no limit).');
      return;
    }
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast.error('Cap must be a non-negative dollar amount.');
      return;
    }
    await setCap.mutateAsync(parsed);
    toast.success(`Monthly cap set to ${fmtUsd(parsed)}.`);
  };

  const onSaveTimeout = async (raw: string): Promise<void> => {
    const v = raw.trim();
    try {
      await setLlmTimeout.mutateAsync(v === '' ? '' : Number.parseInt(v, 10));
      toast.success(
        v === '' ? 'LLM timeout reset to default (60s).' : `LLM timeout set to ${v} ms.`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'failed');
    }
  };

  const onSaveMaxTokens = async (raw: string): Promise<void> => {
    const v = raw.trim();
    try {
      await setLlmMaxTokens.mutateAsync(v === '' ? '' : Number.parseInt(v, 10));
      toast.success(
        v === ''
          ? `Max output tokens reset to default (${DEFAULT_MAX_TOKENS}).`
          : `Max output tokens set to ${v}.`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'failed');
    }
  };

  const onSaveBaseUrl = async (baseUrl: string): Promise<void> => {
    try {
      await setBaseUrl.mutateAsync(baseUrl);
      toast.success(
        baseUrl.length > 0
          ? `Anthropic endpoint set to ${baseUrl}`
          : 'Anthropic endpoint reset to direct (api.anthropic.com).',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'failed');
    }
  };

  const onSaveOllama =
    (kind: 'baseUrl' | 'model' | 'visionModel') =>
    async (value: string): Promise<void> => {
      try {
        if (kind === 'baseUrl') await setOllamaBaseUrl.mutateAsync(value);
        else if (kind === 'model') await setOllamaModel.mutateAsync(value);
        else await setOllamaVisionModel.mutateAsync(value);
        toast.success(value.length > 0 ? 'Saved.' : 'Reset to default.');
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'failed');
      }
    };

  const onSaveAiSetting = async (id: string, value: string): Promise<void> => {
    try {
      await setAiSettingMut.mutateAsync({ id, value });
      toast.success(value.length > 0 ? 'Saved.' : 'Reset to default.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'failed');
    }
  };

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <Link to="/admin" className="text-sm text-ink-muted hover:text-ink">
        ← Admin
      </Link>
      <header>
        <h1 className="text-2xl font-semibold">LLM provider</h1>
        <p className="mt-1 rounded-md bg-surface-subtle px-3 py-2 text-xs text-ink-muted">
          <strong>Extraction provider.</strong> Text-layer PDFs are turned into structured rows
          (dates, amounts, descriptions, balances) here. Scanned PDFs are OCR’d <em>and</em>{' '}
          extracted in one local call by the Qwen-VL vision model (set the model tags below; the
          Ollama URL is on{' '}
          <Link to="/admin/engines" className="text-accent hover:underline">
            Engines
          </Link>
          ). Page images never egress. Extraction defaults to <strong>local Ollama (Qwen)</strong> —
          Anthropic is only used (text-only) if you switch the provider below.
        </p>
        <p className="mt-2 text-sm text-ink-subtle">
          Anthropic is opt-in and <strong>text-only</strong>: switching to it sends OCR-extracted /
          text-layer markdown outbound (never raw PDFs or page images). Scanned PDFs always OCR
          locally first.
        </p>
      </header>

      {provider.data ? (
        <section className="rounded-lg border border-surface-muted bg-white p-4">
          <h2 className="text-base font-medium">Effective request</h2>
          <p className="mt-1 text-xs text-ink-subtle">
            Exactly what an Anthropic extraction call will send right now — resolved from the
            settings below (no need to trigger a failure to find out).
          </p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-muted">Model</dt>
            <dd className="font-mono">{provider.data.effectiveModel}</dd>
            <dt className="text-ink-muted">Endpoint</dt>
            <dd className="font-mono">
              {provider.data.anthropicBaseUrl}{' '}
              <span className="text-xs text-ink-subtle">
                ({provider.data.anthropicViaProxy ? 'via proxy' : 'direct'})
              </span>
            </dd>
            <dt className="text-ink-muted">max_tokens</dt>
            <dd className="font-mono">{provider.data.effectiveMaxTokens.toLocaleString()}</dd>
            <dt className="text-ink-muted">Timeout</dt>
            <dd className="font-mono">{(provider.data.llmTimeoutMs / 1000).toFixed(0)}s</dd>
            <dt className="text-ink-muted">Auth</dt>
            <dd className="font-mono">
              {provider.data.anthropicViaProxy ? 'Bearer (gateway key)' : 'x-api-key'}
            </dd>
          </dl>
          {!provider.data.anthropicKeyConfigured ? (
            <p className="mt-2 text-xs text-amber-700">
              No API key stored yet — set one below for these to take effect.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-base font-medium">Routing policy</h2>
        {provider.data ? (
          <>
            <p className="mt-2 text-sm">
              Current policy: <strong className="font-mono">{provider.data.policy}</strong>. Primary
              provider: <strong className="font-mono">{provider.data.provider}</strong>
              {provider.data.provider === 'anthropic' && provider.data.anthropicModel
                ? ` (${provider.data.anthropicModel})`
                : ''}
              .
            </p>
            <fieldset className="mt-3 space-y-2 text-sm">
              {(Object.keys(POLICY_LABELS) as LlmProviderPolicy[]).map((p) => {
                const usesAnthropic = p !== 'local-only';
                const disabled =
                  switchPolicy.isPending ||
                  (usesAnthropic && !provider.data!.anthropicKeyConfigured);
                return (
                  <label key={p} className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="policy"
                      checked={provider.data!.policy === p}
                      disabled={disabled}
                      onChange={() => switchPolicy.mutate(p)}
                      className="mt-1"
                    />
                    <div className="flex flex-col">
                      <span className="font-medium">{POLICY_LABELS[p].title}</span>
                      <span className="text-xs text-ink-muted">{POLICY_LABELS[p].description}</span>
                      {disabled && usesAnthropic && !provider.data!.anthropicKeyConfigured ? (
                        <span className="mt-0.5 text-xs text-amber-700">
                          Set an Anthropic API key below to enable this policy.
                        </span>
                      ) : null}
                    </div>
                  </label>
                );
              })}
            </fieldset>
            <div className="mt-3">
              <button
                type="button"
                onClick={() => void onTest()}
                disabled={test.isPending}
                className="rounded-md border border-accent px-3 py-1.5 text-sm text-accent hover:bg-accent/5"
              >
                {test.isPending ? 'Testing…' : 'Test primary connection'}
              </button>
            </div>
          </>
        ) : (
          <p className="mt-2 text-sm text-ink-muted">Loading…</p>
        )}
      </section>

      {provider.data ? (
        <OllamaSection
          baseUrl={provider.data.ollamaBaseUrl}
          model={provider.data.ollamaModel}
          visionModel={provider.data.ollamaVisionModel}
          visionModels={provider.data.curatedVisionModels}
          localModels={localModels.data?.models ?? []}
          disabled={
            setOllamaBaseUrl.isPending || setOllamaModel.isPending || setOllamaVisionModel.isPending
          }
          onSaveBaseUrl={onSaveOllama('baseUrl')}
          onSaveModel={onSaveOllama('model')}
          onSaveVisionModel={onSaveOllama('visionModel')}
        />
      ) : null}

      {provider.data ? <VibeOcrSection vibeOcr={provider.data.vibeOcr} /> : null}
      {provider.data ? <GlmOcrSection glmOcr={provider.data.glmOcr} /> : null}

      {provider.data ? (
        <AiTuningSection
          settings={provider.data.aiSettings}
          disabled={setAiSettingMut.isPending}
          onSave={onSaveAiSetting}
        />
      ) : null}

      {provider.data ? (
        <BaseUrlSection
          baseUrl={provider.data.anthropicBaseUrl}
          viaProxy={provider.data.anthropicViaProxy}
          disabled={setBaseUrl.isPending}
          onSave={onSaveBaseUrl}
        />
      ) : null}

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-base font-medium">PDF processing strategy (firm default)</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Controls how each PDF is turned into markdown before the LLM sees it. Operators can
          override per upload from the upload picker.
        </p>
        {pdfStrategy.data ? (
          <fieldset className="mt-3 space-y-2 text-sm">
            {(Object.keys(PDF_STRATEGY_LABELS) as PdfProcessingStrategy[]).map((s) => (
              <label key={s} className="flex items-start gap-2">
                <input
                  type="radio"
                  name="pdf-strategy"
                  checked={pdfStrategy.data!.strategy === s}
                  disabled={switchPdfStrategy.isPending}
                  onChange={() => switchPdfStrategy.mutate(s)}
                  className="mt-1"
                />
                <div className="flex flex-col">
                  <span className="font-medium">{PDF_STRATEGY_LABELS[s].title}</span>
                  <span className="text-xs text-ink-muted">
                    {PDF_STRATEGY_LABELS[s].description}
                  </span>
                </div>
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="mt-2 text-sm text-ink-muted">Loading…</p>
        )}
      </section>

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-base font-medium">PDF retention</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Auto-purge source PDFs older than N days. Statements and transactions are kept; only the
          file on disk is removed. Leave the field blank (or zero) to disable. The sweep also runs
          daily at 04:00 UTC.
        </p>
        {pdfRetention.data !== undefined ? (
          <RetentionEditor
            days={pdfRetention.data.days}
            lastSweepAt={pdfRetention.data.lastSweepAt}
            saving={setRetention.isPending}
            sweeping={runRetentionNow.isPending}
            sweepResult={runRetentionNow.data}
            onSave={(d) => setRetention.mutate(d)}
            onSweep={() => runRetentionNow.mutate()}
          />
        ) : (
          <p className="mt-2 text-sm text-ink-muted">Loading…</p>
        )}
      </section>

      {provider.data ? (
        <section className="rounded-lg border border-surface-muted bg-white p-4">
          <h2 className="text-base font-medium">Anthropic key</h2>
          {provider.data.anthropicKeyConfigured ? (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
              <span className="font-mono text-ink-muted">
                {provider.data.anthropicViaProxy ? 'key' : 'sk-ant-'}…
                {provider.data.anthropicKeyLastFour}
              </span>
              <button
                type="button"
                onClick={() => void onClearKey()}
                disabled={clearKey.isPending}
                className="rounded-md border border-danger px-3 py-1 text-xs text-danger hover:bg-danger/5"
              >
                Clear key
              </button>
            </div>
          ) : (
            <p className="mt-2 text-sm text-ink-muted">No key on file.</p>
          )}

          <form onSubmit={onSetKey} className="mt-4 border-t border-surface-muted pt-4">
            <p className="text-sm">
              {provider.data.anthropicKeyConfigured ? 'Replace key' : 'Set key'}
            </p>
            <p className="mt-1 text-xs text-ink-subtle">
              Stored AES-256-GCM-encrypted at rest. Anthropic is text-only — only OCR-extracted /
              text-layer markdown egresses; raw PDFs and page images NEVER leave this server.
              {provider.data.anthropicViaProxy
                ? ' Routing via a proxy — paste that proxy’s bearer key here (not a raw sk-ant key).'
                : ''}
            </p>
            <input
              type="password"
              autoComplete="off"
              placeholder={provider.data.anthropicViaProxy ? 'proxy key…' : 'sk-ant-…'}
              className="mt-2 w-full rounded-md border border-surface-muted px-3 py-2 text-sm font-mono"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <input
              type="text"
              placeholder={`Type: ${CONFIRM_PHRASE}`}
              className="mt-2 w-full rounded-md border border-surface-muted px-3 py-2 text-sm"
              value={confirmPhrase}
              onChange={(e) => setConfirmPhrase(e.target.value)}
            />
            {error ? (
              <p role="alert" className="mt-2 text-sm text-danger">
                {error}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={
                setKey.isPending || keyInput.length < 20 || confirmPhrase !== CONFIRM_PHRASE
              }
              className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              {setKey.isPending ? 'Saving…' : 'Save key'}
            </button>
          </form>
        </section>
      ) : null}

      {provider.data ? (
        <ModelSection
          currentModel={provider.data.anthropicModel}
          curated={provider.data.allowedModels}
          onChange={(m) => setModel.mutate(m)}
        />
      ) : null}

      {provider.data ? <PricingSection currentModel={provider.data.anthropicModel} /> : null}

      {provider.data ? (
        <section className="rounded-lg border border-surface-muted bg-white p-4">
          <h2 className="text-base font-medium">Monthly spend cap</h2>
          <p className="mt-1 text-xs text-ink-subtle">
            Worker refuses to call Anthropic when current calendar-month spend would exceed this.
            Empty = no cap. Local provider is free and isn&apos;t affected.
          </p>
          <CapForm
            current={provider.data.monthlyCapUsd}
            disabled={setCap.isPending}
            onSubmit={onSetCap}
          />
        </section>
      ) : null}

      {provider.data ? (
        <section className="rounded-lg border border-surface-muted bg-white p-4">
          <h2 className="text-base font-medium">LLM call timeout</h2>
          <p className="mt-1 text-xs text-ink-subtle">
            Per-call timeout for extraction + enrichment (both the local Ollama provider and
            Anthropic). Local vision/OCR has its own longer budget (OLLAMA_VISION_TIMEOUT_MS,
            default 120s). A slow statement may take up to ~2× this (one reminder retry). Range
            1000–600000 ms. Blank = default ({DEFAULT_TIMEOUT_MS} ms).
          </p>
          <TimeoutForm
            current={provider.data.llmTimeoutMs}
            disabled={setLlmTimeout.isPending}
            onSubmit={onSaveTimeout}
          />
        </section>
      ) : null}

      {provider.data ? (
        <section className="rounded-lg border border-surface-muted bg-white p-4">
          <h2 className="text-base font-medium">Max output tokens</h2>
          <p className="mt-1 text-xs text-ink-subtle">
            Output-token ceiling per extraction call. A multi-page statement&apos;s transaction list
            will not fit in a small cap — if it&apos;s too low, the model is cut off mid-array and
            the extraction fails with a truncation error. Raising this also needs a larger timeout
            (more tokens take longer to generate) and costs more per statement. Range 1000–64000.
            Blank = default ({DEFAULT_MAX_TOKENS}).
          </p>
          <MaxTokensForm
            current={provider.data.llmMaxTokens}
            disabled={setLlmMaxTokens.isPending}
            onSubmit={onSaveMaxTokens}
          />
        </section>
      ) : null}

      <section className="rounded-lg border border-surface-muted bg-white p-4">
        <h2 className="text-base font-medium">Cost dashboard</h2>
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
          <p className="mt-2 text-sm text-ink-muted">Loading…</p>
        )}
      </section>
    </section>
  );
}

// Phase 26 #29 — model picker that tracks Anthropic's live catalog when
// a key is configured. Operators can pick from the curated list (with
// known pricing in our table) or type any `claude-*` id directly to use
// a model not yet curated. The /v1/models endpoint is hit on demand via
// useQuery; cost calculation falls back to "0 micros" for unpriced
// models, so usage is still tracked but USD totals will under-report
// until we update the price table.
function ModelSection({
  currentModel,
  curated,
  onChange,
}: {
  currentModel: string | null;
  curated: readonly string[];
  onChange: (model: string) => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [customId, setCustomId] = useState('');

  const live = useQuery({
    queryKey: ['admin', 'anthropic-models'],
    queryFn: () =>
      api.get<{ models: string[]; curated: string[]; liveCount: number; hasLiveCatalog: boolean }>(
        '/api/admin/llm-provider/anthropic-models',
      ),
    staleTime: 5 * 60_000, // /v1/models is stable for minutes; 5min cache is fine
  });

  const allModels = live.data?.models ?? curated;
  const inCatalog = currentModel ? allModels.includes(currentModel) : false;

  const onSelect = (m: string): void => {
    onChange(m);
    setCustomId('');
  };

  const onSaveCustom = (): void => {
    const trimmed = customId.trim();
    if (trimmed.length > 0) onChange(trimmed);
  };

  return (
    <section className="rounded-lg border border-surface-muted bg-white p-4">
      <header className="flex items-baseline justify-between">
        <h2 className="text-base font-medium">Model</h2>
        {live.data ? (
          <span className="text-xs text-ink-subtle">
            {live.data.hasLiveCatalog
              ? `live catalog · ${live.data.liveCount} models from Anthropic`
              : 'showing curated list (set a key to sync live catalog)'}
          </span>
        ) : null}
      </header>
      <p className="mt-1 text-xs text-ink-subtle">
        Pricing per ADR-020. Models in the curated list have known per-token costs; operator-typed
        models still work but cost rollups read $0 until the price table gets updated.
      </p>

      <select
        className="mt-2 w-full rounded-md border border-surface-muted bg-white px-3 py-2 text-sm"
        value={inCatalog ? (currentModel ?? '') : ''}
        onChange={(e) => onSelect(e.target.value)}
      >
        <option value="" disabled>
          — pick a model —
        </option>
        {allModels.map((m) => (
          <option key={m} value={m}>
            {m}
            {curated.includes(m) ? ' · curated' : ''}
          </option>
        ))}
        {currentModel && !inCatalog ? (
          <option value={currentModel}>{currentModel} · custom (current)</option>
        ) : null}
      </select>
      {currentModel && !inCatalog ? (
        <p className="mt-1 text-xs text-amber-700">
          Current model <code className="rounded bg-surface-subtle px-1">{currentModel}</code>{' '}
          isn&apos;t in the live catalog or curated list. Worker will still call it; cost rollups
          will under-report until pricing lands.
        </p>
      ) : null}

      <div className="mt-3 border-t border-surface-muted pt-3">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={advanced}
            onChange={(e) => setAdvanced(e.target.checked)}
          />
          Advanced: type a custom model id (for newer models not yet in our table)
        </label>
        {advanced ? (
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              placeholder="claude-opus-5-0"
              value={customId}
              onChange={(e) => setCustomId(e.target.value)}
              className="flex-1 rounded-md border border-surface-muted px-3 py-1.5 text-sm font-mono"
            />
            <button
              type="button"
              onClick={onSaveCustom}
              disabled={!customId.trim().match(/^claude-/i)}
              className="rounded-md border border-surface-muted px-3 py-1.5 text-xs disabled:opacity-50"
            >
              Use
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// Anthropic pricing editor. Lets operators add or override per-model
// per-million-token USD prices so the cost rollup tracks reality even
// for models that aren't yet in the curated default table. Curated
// rows show the default; an operator-set override-row replaces the
// default for that model. Pure-operator rows (no default) get a Delete.
interface PricingApiRow {
  model: string;
  source: 'default' | 'operator' | 'operator-override';
  inputPerMTokenMicros: string;
  outputPerMTokenMicros: string;
  inputPerMTokenUsd: number;
  outputPerMTokenUsd: number;
}

function PricingSection({ currentModel }: { currentModel: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({
    queryKey: ['admin', 'llm-pricing'],
    queryFn: () => api.get<{ rows: PricingApiRow[] }>('/api/admin/llm-provider/pricing'),
  });

  const save = useMutation({
    mutationFn: (input: { model: string; inputPerMTokenUsd: number; outputPerMTokenUsd: number }) =>
      api.post('/api/admin/llm-provider/pricing', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'llm-pricing'] });
      qc.invalidateQueries({ queryKey: ['admin', 'llm-cost'] });
    },
  });
  const remove = useMutation({
    mutationFn: (model: string) =>
      api.delete(`/api/admin/llm-provider/pricing/${encodeURIComponent(model)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'llm-pricing'] });
      qc.invalidateQueries({ queryKey: ['admin', 'llm-cost'] });
    },
  });

  const [adding, setAdding] = useState(false);
  const [newModel, setNewModel] = useState('');
  const [newInput, setNewInput] = useState('');
  const [newOutput, setNewOutput] = useState('');

  const onAdd = async (): Promise<void> => {
    const model = newModel.trim();
    const inputUsd = Number.parseFloat(newInput);
    const outputUsd = Number.parseFloat(newOutput);
    if (!model.match(/^claude-/i)) {
      toast.error('Model id must start with claude-');
      return;
    }
    if (
      !Number.isFinite(inputUsd) ||
      !Number.isFinite(outputUsd) ||
      inputUsd < 0 ||
      outputUsd < 0
    ) {
      toast.error('Prices must be non-negative numbers');
      return;
    }
    try {
      await save.mutateAsync({
        model,
        inputPerMTokenUsd: inputUsd,
        outputPerMTokenUsd: outputUsd,
      });
      toast.success(`Pricing saved for ${model}`);
      setNewModel('');
      setNewInput('');
      setNewOutput('');
      setAdding(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'save failed');
    }
  };

  const onClear = async (model: string): Promise<void> => {
    if (
      !window.confirm(
        `Clear operator pricing for ${model}? Curated default will resume if one exists.`,
      )
    )
      return;
    try {
      await remove.mutateAsync(model);
      toast.success(`Pricing cleared for ${model}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'clear failed');
    }
  };

  return (
    <section className="rounded-lg border border-surface-muted bg-white p-4">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-medium">Pricing</h2>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="text-xs text-accent hover:underline"
        >
          {adding ? 'Cancel' : '+ Add / override'}
        </button>
      </header>
      <p className="mt-1 text-xs text-ink-subtle">
        Per-million-token USD prices. Operator-set values override the curated defaults. Models not
        in this table accumulate token counts but don&apos;t contribute to cost rollups (treated as
        $0).
      </p>

      {adding ? (
        <div className="mt-3 grid gap-2 rounded-md border border-surface-muted bg-surface-subtle p-3 sm:grid-cols-[2fr_1fr_1fr_auto]">
          <input
            type="text"
            placeholder="claude-opus-5-0"
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            className="rounded-md border border-surface-muted px-2 py-1.5 text-sm font-mono"
          />
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="Input $/M"
            value={newInput}
            onChange={(e) => setNewInput(e.target.value)}
            className="rounded-md border border-surface-muted px-2 py-1.5 text-sm tabular-nums"
          />
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="Output $/M"
            value={newOutput}
            onChange={(e) => setNewOutput(e.target.value)}
            className="rounded-md border border-surface-muted px-2 py-1.5 text-sm tabular-nums"
          />
          <button
            type="button"
            onClick={() => void onAdd()}
            disabled={save.isPending || !newModel.trim() || !newInput.trim() || !newOutput.trim()}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      ) : null}

      {list.isPending ? (
        <p className="mt-2 text-sm text-ink-muted">Loading…</p>
      ) : (
        <div className="mt-3 overflow-hidden rounded-md border border-surface-muted">
          <table className="w-full text-sm">
            <thead className="bg-surface-subtle text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-3 py-2 text-left">Model</th>
                <th className="px-3 py-2 text-right">Input $/M</th>
                <th className="px-3 py-2 text-right">Output $/M</th>
                <th className="px-3 py-2 text-left">Source</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {list.data?.rows.map((r) => (
                <tr
                  key={r.model}
                  className={`border-t border-surface-muted ${
                    r.model === currentModel ? 'bg-accent/5' : ''
                  }`}
                >
                  <td className="px-3 py-2 font-mono text-xs">
                    {r.model}
                    {r.model === currentModel ? (
                      <span className="ml-2 rounded bg-accent/20 px-1 py-0.5 text-[10px] font-medium text-accent">
                        active
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    ${r.inputPerMTokenUsd.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    ${r.outputPerMTokenUsd.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-muted">
                    {r.source === 'default'
                      ? 'curated'
                      : r.source === 'operator-override'
                        ? 'override (curated exists)'
                        : 'operator-set'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.source !== 'default' ? (
                      <button
                        type="button"
                        onClick={() => void onClear(r.model)}
                        disabled={remove.isPending}
                        className="rounded-md border border-danger px-2 py-1 text-xs text-danger hover:bg-danger/5 disabled:opacity-50"
                      >
                        Clear
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {list.data?.rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-xs text-ink-muted">
                    No pricing rows. Add one above.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Anthropic endpoint editor. Points the extraction LLM at the Vibe Shield
// gateway (so PII is redacted before reaching Claude) instead of calling
// api.anthropic.com directly — the routing that used to be env-only.
// One labelled text input + Save/Reset for a single Ollama setting. Blank
// input clears the DB override (back to env / default).
function OllamaField({
  label,
  value,
  placeholder,
  disabled,
  onSave,
  suggestions,
  options,
}: {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  onSave: (value: string) => Promise<void>;
  // Optional autocomplete list (e.g. curated vision models). Stays free-text.
  suggestions?: readonly string[];
  // Live catalog of installed models (from Ollama /api/tags). When present,
  // renders a dropdown of what's actually pulled; the text input remains for a
  // custom tag.
  options?: readonly string[];
}) {
  const [val, setVal] = useState(value);
  useEffect(() => setVal(value), [value]);
  const listId = suggestions
    ? `ollama-field-${label.replace(/\W+/g, '-').toLowerCase()}`
    : undefined;
  const hasOptions = options && options.length > 0;
  return (
    <label className="block text-xs text-ink-muted">
      {label}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {hasOptions ? (
          <select
            value={options.includes(val) ? val : ''}
            disabled={disabled}
            onChange={(e) => {
              if (e.target.value) setVal(e.target.value);
            }}
            title="Installed models (Ollama /api/tags)"
            className="rounded-md border border-surface-muted px-2 py-1.5 text-sm"
          >
            <option value="">
              {val && !options.includes(val) ? `custom: ${val}` : 'Installed…'}
            </option>
            {options.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : null}
        <input
          type="text"
          placeholder={placeholder}
          value={val}
          {...(listId ? { list: listId } : {})}
          onChange={(e) => setVal(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-surface-muted px-3 py-1.5 text-sm font-mono"
        />
        {suggestions ? (
          <datalist id={listId}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        ) : null}
        <button
          type="button"
          onClick={() => void onSave(val.trim())}
          disabled={disabled}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </label>
  );
}

// Operator-tunable AI knobs, rendered generically by `kind` and grouped. Each
// setting falls back to its env var / default; blanking a field clears the
// override. int/float/string commit on blur+Enter; bool/enum commit on change.
const AI_GROUP_LABELS: Record<AiSetting['group'], string> = {
  vision: 'Ollama runtime — statement model + check-payee vision',
  ocr: 'Scanned-statement OCR (GLM-OCR)',
  extraction: 'Text extraction (Ollama)',
  safety: 'Review safety net',
  'proc-extraction': 'Process · Statement extraction',
  'proc-cleanse': 'Process · Cleanse description',
  'proc-category': 'Process · Assign category',
  'proc-check': 'Process · Resolve check payees',
};

function AiTuningSection({
  settings,
  disabled,
  onSave,
}: {
  settings: AiSetting[];
  disabled: boolean;
  onSave: (id: string, value: string) => Promise<void>;
}) {
  const groups: AiSetting['group'][] = [
    'proc-extraction',
    'proc-cleanse',
    'proc-category',
    'proc-check',
    'vision',
    'ocr',
    'extraction',
    'safety',
  ];
  return (
    <section className="rounded-lg border border-surface-muted bg-white p-4">
      <h2 className="text-base font-medium">Local model tuning</h2>
      <p className="mt-1 text-xs text-ink-subtle">
        Per-process provider/model/token routing (top), plus vision/OCR performance and safety
        knobs. For each process, provider <code>default</code> follows the routing policy above;
        blank a model/token field to use the provider default. Check images are always OCR&apos;d
        locally — Anthropic only sees transcribed text. Each falls back to its env var / default.
        Changes apply on the next extraction. The <code>[db/env/default]</code> tag shows where the
        current value comes from.
      </p>
      {groups.map((g) => {
        const items = settings.filter((s) => s.group === g);
        if (items.length === 0) return null;
        return (
          <div key={g} className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              {AI_GROUP_LABELS[g]}
            </h3>
            <div className="mt-2 space-y-3">
              {items.map((s) => (
                <AiSettingRow key={s.id} setting={s} disabled={disabled} onSave={onSave} />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function AiSettingRow({
  setting,
  disabled,
  onSave,
}: {
  setting: AiSetting;
  disabled: boolean;
  onSave: (id: string, value: string) => Promise<void>;
}) {
  const [val, setVal] = useState(setting.value);
  useEffect(() => setVal(setting.value), [setting.value]);
  const commit = (v: string): void => {
    if (v !== setting.value) void onSave(setting.id, v);
  };
  const cls = 'rounded-md border border-surface-muted px-2 py-1 text-sm';
  return (
    <label className="block">
      <span className="text-xs text-ink-muted">
        {setting.label}
        {setting.unit ? ` (${setting.unit})` : ''}
        <span className="ml-1 text-[10px] text-ink-subtle">[{setting.source}]</span>
      </span>
      <div className="mt-1">
        {setting.kind === 'bool' ? (
          <select
            disabled={disabled}
            value={val}
            onChange={(e) => {
              setVal(e.target.value);
              commit(e.target.value);
            }}
            className={cls}
          >
            <option value="true">On</option>
            <option value="false">Off</option>
          </select>
        ) : setting.kind === 'enum' ? (
          <select
            disabled={disabled}
            value={val}
            onChange={(e) => {
              setVal(e.target.value);
              commit(e.target.value);
            }}
            className={cls}
          >
            {(setting.enumValues ?? []).map((ev) => (
              <option key={ev} value={ev}>
                {ev === '' ? '(model default)' : ev}
              </option>
            ))}
          </select>
        ) : (
          <input
            type={setting.kind === 'int' || setting.kind === 'float' ? 'number' : 'text'}
            value={val}
            disabled={disabled}
            placeholder={setting.default.length > 0 ? setting.default : 'default'}
            {...(setting.min != null ? { min: setting.min } : {})}
            {...(setting.max != null ? { max: setting.max } : {})}
            {...(setting.kind === 'float' ? { step: '0.05' } : {})}
            onChange={(e) => setVal(e.target.value)}
            onBlur={() => commit(val.trim())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit(val.trim());
              }
            }}
            className={`w-40 font-mono tabular-nums ${cls}`}
          />
        )}
      </div>
      <p className="mt-0.5 text-[11px] text-ink-subtle">{setting.help}</p>
    </label>
  );
}

// Local Ollama (default provider): base URL + text/vision model tags. OCR
// (scanned pages) and text extraction both run here; page images never egress.
function VibeOcrSection({
  vibeOcr,
}: {
  vibeOcr: {
    url: string | null;
    engine: 'vibe' | 'glm';
    health: { ok: boolean; status?: number; detail?: string };
  };
}) {
  const { url, engine, health } = vibeOcr;
  const selected = engine === 'vibe';
  return (
    <section className="rounded-lg border border-surface-muted bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium">VibeOCR (scanned-statement OCR)</h2>
        <span
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${
            !selected
              ? 'bg-surface-muted text-ink-muted'
              : !url
                ? 'bg-surface-muted text-ink-muted'
                : health.ok
                  ? 'bg-emerald-50 text-emerald-800'
                  : 'bg-amber-50 text-amber-800'
          }`}
        >
          {!selected
            ? 'not selected (engine: GLM-OCR)'
            : !url
              ? 'not configured'
              : health.ok
                ? 'healthy'
                : 'unreachable → GLM-OCR fallback'}
        </span>
      </div>
      <p className="mt-1 text-xs text-ink-subtle">
        VibeOCR is the PDF-native OCR service — the whole PDF is uploaded once and OCR&apos;d
        server-side on the appliance (page images never egress). Select it with the{' '}
        <strong>OCR engine</strong> setting below; configure the URL/key via{' '}
        <code className="rounded bg-surface-subtle px-1">VIBE_OCR_URL</code> or the OCR settings.
        When VibeOCR is unset or unreachable it falls back to GLM-OCR automatically.
      </p>
      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-ink-muted">Engine</dt>
        <dd className="font-mono">{engine}</dd>
        <dt className="text-ink-muted">URL</dt>
        <dd className="font-mono">{url ?? <span className="text-ink-subtle">unset</span>}</dd>
        {!health.ok && health.detail ? (
          <>
            <dt className="text-ink-muted">Detail</dt>
            <dd className="text-amber-700">{health.detail}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

function GlmOcrSection({
  glmOcr,
}: {
  glmOcr: {
    url: string | null;
    model: string;
    health: { ok: boolean; status?: number; detail?: string };
  };
}) {
  const { url, model, health } = glmOcr;
  return (
    <section className="rounded-lg border border-surface-muted bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium">GLM-OCR (scanned-page OCR)</h2>
        <span
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${
            !url
              ? 'bg-surface-muted text-ink-muted'
              : health.ok
                ? 'bg-emerald-50 text-emerald-800'
                : 'bg-red-50 text-red-800'
          }`}
        >
          {!url ? 'not configured' : health.ok ? 'healthy' : 'unreachable'}
        </span>
      </div>
      <p className="mt-1 text-xs text-ink-subtle">
        Local GLM-OCR llama-server transcribes scanned statement pages (and cancelled checks) on the
        appliance — page images never egress. Configure the URL via the{' '}
        <code className="rounded bg-surface-subtle px-1">GLM_OCR_URL</code> env or the “Text
        extraction / OCR” settings below. GLM-OCR is the <strong>fallback</strong> when VibeOCR is
        the engine; if it is the selected engine and down, scanned extraction fails fast.
      </p>
      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-ink-muted">URL</dt>
        <dd className="font-mono">{url ?? <span className="text-ink-subtle">unset</span>}</dd>
        <dt className="text-ink-muted">Model</dt>
        <dd className="font-mono">{model}</dd>
        {!health.ok && health.detail ? (
          <>
            <dt className="text-ink-muted">Detail</dt>
            <dd className="text-danger">{health.detail}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

function OllamaSection({
  baseUrl,
  model,
  visionModel,
  disabled,
  visionModels,
  localModels,
  onSaveBaseUrl,
  onSaveModel,
  onSaveVisionModel,
}: {
  baseUrl: string;
  model: string;
  visionModel: string;
  disabled: boolean;
  visionModels: string[];
  // Live list of models installed on the Ollama host (empty when unreachable).
  localModels: string[];
  onSaveBaseUrl: (value: string) => Promise<void>;
  onSaveModel: (value: string) => Promise<void>;
  onSaveVisionModel: (value: string) => Promise<void>;
}) {
  return (
    <section className="rounded-lg border border-surface-muted bg-white p-4">
      <h2 className="text-base font-medium">Local Ollama (default provider)</h2>
      <p className="mt-1 text-xs text-ink-subtle">
        The text model extracts transactions from statement markdown (text-layer pages, or the
        GLM-OCR transcription of scanned pages). The vision model is the{' '}
        <strong>check-payee fallback</strong> only — scanned-page OCR runs on GLM-OCR (below). Page
        images are processed locally and never egress. Pull the tags on the Ollama host first (e.g.{' '}
        <code className="rounded bg-surface-subtle px-1">
          ollama pull {visionModels[0] ?? 'qwen3-vl:30b'}
        </code>
        ). Blank = use the env / default.
      </p>
      <div className="mt-3 space-y-2">
        <OllamaField
          label="Base URL"
          value={baseUrl}
          placeholder="http://localhost:11434"
          disabled={disabled}
          onSave={onSaveBaseUrl}
        />
        <OllamaField
          label="Text model"
          value={model}
          placeholder="qwen2.5:32b-instruct"
          disabled={disabled}
          onSave={onSaveModel}
          options={localModels}
        />
        <OllamaField
          label="Check-payee fallback vision model"
          value={visionModel}
          placeholder={visionModels[0] ?? 'qwen3-vl:30b'}
          disabled={disabled}
          onSave={onSaveVisionModel}
          suggestions={visionModels}
          options={localModels}
        />
      </div>
    </section>
  );
}

function BaseUrlSection({
  baseUrl,
  viaProxy,
  disabled,
  onSave,
}: {
  baseUrl: string;
  viaProxy: boolean;
  disabled: boolean;
  onSave: (baseUrl: string) => Promise<void>;
}) {
  // Empty input == "direct api.anthropic.com". Pre-fill only when a
  // proxy override is active so clearing is obvious.
  const [val, setVal] = useState(viaProxy ? baseUrl : '');
  useEffect(() => {
    setVal(viaProxy ? baseUrl : '');
  }, [baseUrl, viaProxy]);

  return (
    <section className="rounded-lg border border-surface-muted bg-white p-4">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-medium">Anthropic endpoint</h2>
        {viaProxy ? (
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800">
            via proxy
          </span>
        ) : (
          <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-xs text-ink-muted">
            direct
          </span>
        )}
      </header>
      <p className="mt-1 text-xs text-ink-subtle">
        Optional. Point this at an operator-run Messages-API proxy to route the (text-only)
        extraction LLM through it; the “Anthropic API key” below then holds that proxy’s bearer key.
        Leave blank to call{' '}
        <code className="rounded bg-surface-subtle px-1">api.anthropic.com</code> directly. Page
        images are OCR’d locally on Ollama and never reach Anthropic.
      </p>
      <p className="mt-2 text-sm">
        Current: <code className="rounded bg-surface-subtle px-1 font-mono">{baseUrl}</code>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="url"
          placeholder="https://your-proxy.example  (blank = direct)"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-surface-muted px-3 py-1.5 text-sm font-mono"
        />
        <button
          type="button"
          onClick={() => void onSave(val.trim())}
          disabled={disabled}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {disabled ? 'Saving…' : 'Save'}
        </button>
        {viaProxy ? (
          <button
            type="button"
            onClick={() => void onSave('')}
            disabled={disabled}
            className="rounded-md border border-surface-muted px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Reset to direct
          </button>
        ) : null}
      </div>
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

function CapForm({
  current,
  disabled,
  onSubmit,
}: {
  current: number | null;
  disabled: boolean;
  onSubmit: (raw: string) => Promise<void>;
}) {
  const [val, setVal] = useState<string>(current === null ? '' : current.toFixed(2));
  return (
    <form
      className="mt-2 flex flex-wrap gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(val);
      }}
    >
      <span className="grid place-items-center text-sm text-ink-muted">$</span>
      <input
        type="number"
        min="0"
        step="0.01"
        placeholder="No cap"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        className="w-32 rounded-md border border-surface-muted px-3 py-1.5 text-sm tabular-nums"
      />
      <button
        type="submit"
        disabled={disabled}
        className="rounded-md border border-surface-muted px-3 py-1.5 text-sm"
      >
        {disabled ? 'Saving…' : 'Save cap'}
      </button>
    </form>
  );
}

function TimeoutForm({
  current,
  disabled,
  onSubmit,
}: {
  current: number;
  disabled: boolean;
  onSubmit: (raw: string) => Promise<void>;
}) {
  const [val, setVal] = useState<string>(String(current));
  useEffect(() => {
    setVal(String(current));
  }, [current]);
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(val);
      }}
    >
      <input
        type="number"
        min="1000"
        max="600000"
        step="1000"
        placeholder={String(DEFAULT_TIMEOUT_MS)}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        className="w-32 rounded-md border border-surface-muted px-3 py-1.5 text-sm tabular-nums"
      />
      <span className="text-sm text-ink-muted">ms</span>
      <button
        type="submit"
        disabled={disabled}
        className="rounded-md border border-surface-muted px-3 py-1.5 text-sm"
      >
        {disabled ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}

function MaxTokensForm({
  current,
  disabled,
  onSubmit,
}: {
  current: number;
  disabled: boolean;
  onSubmit: (raw: string) => Promise<void>;
}) {
  const [val, setVal] = useState<string>(String(current));
  useEffect(() => {
    setVal(String(current));
  }, [current]);
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(val);
      }}
    >
      <input
        type="number"
        min="1000"
        max="64000"
        step="1000"
        placeholder={String(DEFAULT_MAX_TOKENS)}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        className="w-32 rounded-md border border-surface-muted px-3 py-1.5 text-sm tabular-nums"
      />
      <span className="text-sm text-ink-muted">tokens</span>
      <button
        type="submit"
        disabled={disabled}
        className="rounded-md border border-surface-muted px-3 py-1.5 text-sm"
      >
        {disabled ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}

function RetentionEditor({
  days,
  lastSweepAt,
  saving,
  sweeping,
  sweepResult,
  onSave,
  onSweep,
}: {
  days: number | null;
  lastSweepAt: string | null;
  saving: boolean;
  sweeping: boolean;
  sweepResult:
    | {
        ranAt: string;
        retentionDays: number | null;
        candidates: number;
        filesRemoved: number;
        rowsFlipped: number;
        skipped: 'disabled' | null;
      }
    | undefined;
  onSave: (days: number | null) => void;
  onSweep: () => void;
}) {
  // Local input state lets the admin edit freely; server only sees the
  // final value when "Save" lands. Empty string == null (disabled).
  const [input, setInput] = useState(days === null ? '' : String(days));
  useEffect(() => {
    setInput(days === null ? '' : String(days));
  }, [days]);
  const parsed = input.trim() === '' ? null : Number.parseInt(input.trim(), 10);
  const invalid = parsed !== null && (!Number.isFinite(parsed) || parsed < 1);
  return (
    <div className="mt-3 space-y-3 text-sm">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-muted">Days to retain</span>
          <input
            type="number"
            min={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={saving}
            placeholder="disabled"
            className="w-28 rounded-md border border-surface-muted px-2 py-1"
          />
        </label>
        <button
          type="button"
          onClick={() => !invalid && onSave(parsed)}
          disabled={saving || invalid}
          className="rounded-md border border-surface-muted px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onSweep}
          disabled={sweeping || days === null}
          title={
            days === null ? 'Set a retention period first' : 'Run the retention sweep immediately'
          }
          className="rounded-md border border-accent px-3 py-1.5 text-sm text-accent hover:bg-accent/5 disabled:opacity-50"
        >
          {sweeping ? 'Sweeping…' : 'Run sweep now'}
        </button>
      </div>
      {invalid ? (
        <p className="text-xs text-danger">days must be a positive integer (or empty to disable)</p>
      ) : null}
      <p className="text-xs text-ink-muted">
        Current: {days === null ? <em>disabled</em> : `purge PDFs older than ${days} day(s)`}
        {lastSweepAt ? ` · last sweep ${new Date(lastSweepAt).toLocaleString()}` : ' · never run'}
      </p>
      {sweepResult ? (
        <p className="text-xs text-ink-muted">
          Last run:{' '}
          {sweepResult.skipped === 'disabled'
            ? 'skipped (disabled)'
            : `${sweepResult.candidates} candidate(s), ${sweepResult.filesRemoved} file(s) unlinked, ${sweepResult.rowsFlipped} row(s) flagged.`}
        </p>
      ) : null}
    </div>
  );
}
