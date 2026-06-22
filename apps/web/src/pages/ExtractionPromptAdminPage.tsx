// Operator-tunable transaction-EXTRACTION system prompt. Two modes:
//   - rules: keep the built-in default prompt (all schema-contract rules:
//            integer cents, signs, required fields, reconciliation) and APPEND
//            an optional "additional instructions" block. Safest.
//   - full:  replace the entire system prompt verbatim (advanced — you own
//            correctness, including the integer-cents / required-field rules).
// Applies to both text-layer and scanned (OCR'd) statements; takes effect on
// the next extraction.

import { useState } from 'react';
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
  extraInstructions: PromptField;
  fullSystemPrompt: PromptField;
  effectivePreview: string;
}

interface PromptUpdate {
  mode?: PromptMode;
  extraInstructions?: string | null;
  fullSystemPrompt?: string | null;
}

export function ExtractionPromptAdminPage() {
  const status = useQuery({
    queryKey: ['admin', 'extraction-prompt'],
    queryFn: () => api.get<PromptStatus>('/api/admin/extraction-prompt'),
  });

  if (status.isPending) {
    return (
      <section className="mx-auto max-w-4xl space-y-3">
        <div className="h-8 w-1/3 animate-pulse rounded bg-surface-muted" />
        <div className="h-32 animate-pulse rounded bg-surface-muted" />
      </section>
    );
  }
  if (!status.data) {
    return <p className="text-danger">Failed to load extraction prompt.</p>;
  }
  return <Editor initial={status.data} />;
}

function Editor({ initial }: { initial: PromptStatus }) {
  const qc = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: (update: PromptUpdate) =>
      api.put<PromptStatus>('/api/admin/extraction-prompt', update),
    onSuccess: (data) => qc.setQueryData(['admin', 'extraction-prompt'], data),
  });

  const [mode, setMode] = useState<PromptMode>(initial.mode);
  const [extra, setExtra] = useState<string>(initial.extraInstructions.current);
  const [full, setFull] = useState<string>(initial.fullSystemPrompt.current);

  const dirty =
    mode !== initial.mode ||
    extra !== initial.extraInstructions.current ||
    full !== initial.fullSystemPrompt.current;

  const onSave = async (): Promise<void> => {
    try {
      const update: PromptUpdate = {};
      if (mode !== initial.mode) update.mode = mode;
      if (extra !== initial.extraInstructions.current) update.extraInstructions = extra;
      if (full !== initial.fullSystemPrompt.current) update.fullSystemPrompt = full;
      await save.mutateAsync(update);
      toast.success('Extraction prompt saved.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'save failed');
    }
  };

  const onDiscard = (): void => {
    setMode(initial.mode);
    setExtra(initial.extraInstructions.current);
    setFull(initial.fullSystemPrompt.current);
  };

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <header className="space-y-1">
        <Link to="/admin" className="text-xs text-ink-muted hover:text-ink">
          ← Admin
        </Link>
        <h1 className="text-2xl font-semibold">Extraction prompt</h1>
        <p className="text-sm text-ink-muted">
          Tune what the LLM sees when it extracts transactions from a statement (text-layer and
          OCR&apos;d scans both use this prompt). Saved overrides apply to the next extraction.
        </p>
      </header>

      <fieldset className="rounded-lg border border-surface-muted bg-white p-4">
        <legend className="px-1 text-sm font-medium">Mode</legend>
        <div className="space-y-2 text-sm">
          <ModeOption
            checked={mode === 'rules'}
            onSelect={() => setMode('rules')}
            title="Default + additional instructions"
            description={
              <>
                Keep the built-in extraction rules (integer cents, debit/credit signs, required
                fields, reconciliation) and append your own guidance — e.g. quirks of a specific
                bank&apos;s layout. Safest option.
              </>
            }
          />
          <ModeOption
            checked={mode === 'full'}
            onSelect={() => setMode('full')}
            title="Full system prompt (advanced)"
            description={
              <>
                Replace the entire system prompt verbatim. You become responsible for the
                schema-contract rules — especially &quot;amount_cents is an integer number of
                cents&quot; and the required <code>period</code>/<code>balances</code>/
                <code>transactions</code> fields. A blank field reverts to the built-in default.
              </>
            }
          />
        </div>
      </fieldset>

      {mode === 'rules' ? (
        <PromptBlock
          title="Additional instructions"
          description="Appended to the built-in prompt under an 'ADDITIONAL OPERATOR INSTRUCTIONS' header. Leave blank to use the default prompt unchanged."
          value={extra}
          onChange={setExtra}
          isOverride={initial.extraInstructions.isOverride}
          defaultValue={initial.extraInstructions.defaultValue}
          placeholder="e.g. This bank prints the running balance in the rightmost column; treat amounts in parentheses as debits."
        />
      ) : (
        <PromptBlock
          title="Full system prompt"
          description="Replaces the entire system prompt. Must keep the integer-cents rule and the required top-level fields, or extraction will fail / reconcile wrong."
          value={full}
          onChange={setFull}
          isOverride={initial.fullSystemPrompt.isOverride}
          defaultValue={initial.fullSystemPrompt.defaultValue}
          rows={24}
        />
      )}

      <details className="rounded-lg border border-surface-muted bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Effective prompt preview (what the model receives now)
        </summary>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-surface-subtle p-3 font-mono text-xs leading-relaxed">
          {initial.effectivePreview}
        </pre>
      </details>

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

function ModeOption({
  checked,
  onSelect,
  title,
  description,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  description: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-2">
      <input type="radio" name="mode" checked={checked} onChange={onSelect} className="mt-1" />
      <div className="flex flex-col">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-ink-muted">{description}</span>
      </div>
    </label>
  );
}

function PromptBlock({
  title,
  description,
  value,
  onChange,
  isOverride,
  defaultValue,
  rows = 14,
  placeholder,
}: {
  title: string;
  description: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  isOverride: boolean;
  defaultValue: string;
  rows?: number;
  placeholder?: string;
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
          onClick={() => onChange(defaultValue)}
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
        {...(placeholder ? { placeholder } : {})}
        className="w-full rounded-md border border-surface-muted px-3 py-2 font-mono text-xs leading-relaxed"
      />
    </fieldset>
  );
}
