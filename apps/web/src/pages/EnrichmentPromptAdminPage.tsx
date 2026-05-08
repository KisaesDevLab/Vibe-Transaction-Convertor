// Operator-tunable enrichment system prompt. Two modes:
//   - rules:  edit the cleanse / categorize rule blocks; persona +
//             JSON-output framing + "Available categories:" listing
//             stay locked so prompts always remain valid for the
//             schema-constrained LLM call.
//   - full:   replace the whole system prompt verbatim; {{categories}}
//             is substituted with the live business_categories list
//             at runtime. Account-context is auto-appended in both
//             modes.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { useToast } from '../components/Toast';
import { api, ApiError } from '../lib/api';

type PromptMode = 'rules' | 'full';

interface PromptField {
  current: string;
  isOverride: boolean;
  defaultValue: string;
}

interface PromptStatus {
  mode: PromptMode;
  cleanseRules: PromptField;
  categorizeRules: PromptField;
  fullSystemPrompt: PromptField;
  promptVersion: string;
}

interface PromptUpdate {
  mode?: PromptMode;
  cleanseRules?: string | null;
  categorizeRules?: string | null;
  fullSystemPrompt?: string | null;
}

export function EnrichmentPromptAdminPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const status = useQuery({
    queryKey: ['admin', 'enrichment-prompt'],
    queryFn: () => api.get<PromptStatus>('/api/admin/enrichment-prompt'),
  });
  const save = useMutation({
    mutationFn: (update: PromptUpdate) =>
      api.put<PromptStatus>('/api/admin/enrichment-prompt', update),
    onSuccess: (data) => qc.setQueryData(['admin', 'enrichment-prompt'], data),
  });

  // Local edits are kept separate from the server state so the textareas
  // don't snap back to "current" on every keystroke + refetch. We seed
  // from the query's first success, then track dirtiness against the
  // authoritative `current` value.
  const [mode, setMode] = useState<PromptMode>('rules');
  const [cleanse, setCleanse] = useState<string>('');
  const [categorize, setCategorize] = useState<string>('');
  const [full, setFull] = useState<string>('');
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (status.data && !seeded) {
      setMode(status.data.mode);
      setCleanse(status.data.cleanseRules.current);
      setCategorize(status.data.categorizeRules.current);
      setFull(status.data.fullSystemPrompt.current);
      setSeeded(true);
    }
  }, [status.data, seeded]);

  if (status.isPending) {
    return (
      <section className="mx-auto max-w-4xl space-y-3">
        <div className="h-8 w-1/3 animate-pulse rounded bg-surface-muted" />
        <div className="h-32 animate-pulse rounded bg-surface-muted" />
      </section>
    );
  }
  if (!status.data) {
    return <p className="text-danger">Failed to load enrichment prompt.</p>;
  }

  const s = status.data;
  const dirty =
    mode !== s.mode ||
    cleanse !== s.cleanseRules.current ||
    categorize !== s.categorizeRules.current ||
    full !== s.fullSystemPrompt.current;

  const onSave = async (): Promise<void> => {
    try {
      // Only send fields whose value differs from the server's current.
      // Empty-string maps to "clear the override" on the backend.
      const update: PromptUpdate = {};
      if (mode !== s.mode) update.mode = mode;
      if (cleanse !== s.cleanseRules.current) update.cleanseRules = cleanse;
      if (categorize !== s.categorizeRules.current) update.categorizeRules = categorize;
      if (full !== s.fullSystemPrompt.current) update.fullSystemPrompt = full;
      await save.mutateAsync(update);
      toast.success('Enrichment prompt saved.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'save failed');
    }
  };

  const onResetCleanse = (): void => setCleanse(s.cleanseRules.defaultValue);
  const onResetCategorize = (): void => setCategorize(s.categorizeRules.defaultValue);
  const onResetFull = (): void => setFull(s.fullSystemPrompt.defaultValue);

  const onDiscard = (): void => {
    setMode(s.mode);
    setCleanse(s.cleanseRules.current);
    setCategorize(s.categorizeRules.current);
    setFull(s.fullSystemPrompt.current);
  };

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <header className="space-y-1">
        <Link to="/admin" className="text-xs text-ink-muted hover:text-ink">
          ← Admin
        </Link>
        <h1 className="text-2xl font-semibold">Enrichment prompt</h1>
        <p className="text-sm text-ink-muted">
          Tune what the LLM sees when it runs the cleanse + categorize pass on a statement&apos;s
          transactions. Saved overrides apply to the next enrichment run; the cache invalidates
          automatically so cached merchants re-run under the new rules.
        </p>
        <p className="text-xs text-ink-subtle">
          Active prompt version:{' '}
          <code className="rounded bg-surface-subtle px-1 font-mono">{s.promptVersion}</code>
        </p>
      </header>

      <fieldset className="rounded-lg border border-surface-muted bg-white p-4">
        <legend className="px-1 text-sm font-medium">Mode</legend>
        <div className="space-y-2 text-sm">
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="mode"
              checked={mode === 'rules'}
              onChange={() => setMode('rules')}
              className="mt-1"
            />
            <span>
              <span className="font-medium">Edit rule blocks</span>
              <br />
              <span className="text-xs text-ink-muted">
                Replace just the cleansing and categorization rule sections. Persona, JSON-output
                framing, and the auto-generated &quot;Available categories:&quot; list stay intact.
                Safest option.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="mode"
              checked={mode === 'full'}
              onChange={() => setMode('full')}
              className="mt-1"
            />
            <span>
              <span className="font-medium">Full system prompt (advanced)</span>
              <br />
              <span className="text-xs text-ink-muted">
                Take over the entire system prompt verbatim. Use{' '}
                <code className="rounded bg-surface-subtle px-1 font-mono">{'{{categories}}'}</code>{' '}
                anywhere you want the live category list interpolated. Removing it means the LLM
                can&apos;t pick a valid category and the schema-constrained response will fail.
              </span>
            </span>
          </label>
        </div>
      </fieldset>

      {mode === 'rules' ? (
        <>
          <PromptBlock
            title="Cleanse rules"
            description="Sent only when the operator triggers a cleanse. The LLM sees these verbatim under the JSON-output framing."
            value={cleanse}
            onChange={setCleanse}
            isOverride={s.cleanseRules.isOverride}
            defaultValue={s.cleanseRules.defaultValue}
            onReset={onResetCleanse}
          />
          <PromptBlock
            title="Categorize rules"
            description={
              <>
                Sent only when the operator triggers categorization. The live category list from{' '}
                <Link to="/admin/categories" className="text-accent hover:underline">
                  /admin/categories
                </Link>{' '}
                is appended automatically below this block — no need to list categories here.
              </>
            }
            value={categorize}
            onChange={setCategorize}
            isOverride={s.categorizeRules.isOverride}
            defaultValue={s.categorizeRules.defaultValue}
            onReset={onResetCategorize}
          />
        </>
      ) : (
        <PromptBlock
          title="Full system prompt"
          description={
            <>
              Replaces the entire system prompt. Include{' '}
              <code className="rounded bg-surface-subtle px-1 font-mono">{'{{categories}}'}</code>{' '}
              wherever the live category list should appear. Per-statement account-context is
              appended automatically.
            </>
          }
          value={full}
          onChange={setFull}
          isOverride={s.fullSystemPrompt.isOverride}
          defaultValue={s.fullSystemPrompt.defaultValue}
          onReset={onResetFull}
          rows={20}
        />
      )}

      <div className="flex items-center justify-end gap-2 border-t border-surface-muted pt-4">
        <button
          type="button"
          onClick={onDiscard}
          disabled={!dirty || save.isPending}
          className="rounded-md border border-surface-muted px-3 py-2 text-sm hover:bg-surface-subtle disabled:opacity-50"
        >
          Discard changes
        </button>
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={!dirty || save.isPending}
          className="rounded-md border border-accent bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:bg-accent/90 disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}

function PromptBlock({
  title,
  description,
  value,
  onChange,
  isOverride,
  defaultValue,
  onReset,
  rows = 14,
}: {
  title: string;
  description: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  isOverride: boolean;
  defaultValue: string;
  onReset: () => void;
  rows?: number;
}) {
  const isDefault = value === defaultValue;
  return (
    <fieldset className="rounded-lg border border-surface-muted bg-white p-4">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      <p className="mb-2 text-xs text-ink-muted">{description}</p>
      <div className="mb-2 flex items-center justify-between text-xs">
        <span
          className={
            isOverride
              ? 'rounded-full bg-amber-100 px-2 py-0.5 text-amber-900'
              : 'rounded-full bg-surface-subtle px-2 py-0.5 text-ink-muted'
          }
        >
          {isOverride ? 'Saved override active' : 'Using built-in default'}
        </span>
        <button
          type="button"
          onClick={onReset}
          disabled={isDefault}
          className="rounded-md border border-surface-muted px-2 py-1 text-xs hover:bg-surface-subtle disabled:opacity-50"
        >
          Reset to default
        </button>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        className="w-full rounded-md border border-surface-muted px-3 py-2 font-mono text-xs leading-relaxed"
      />
    </fieldset>
  );
}
