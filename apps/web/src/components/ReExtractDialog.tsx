// Re-extract confirm dialog. Type-confirm gate + a processing-strategy
// picker that mirrors the upload screen. Defaults to "keep current" so
// hitting Re-extract behaves exactly like the old DeleteConfirmDialog-
// based flow unless the operator explicitly changes the strategy.

import { useEffect, useRef, useState } from 'react';

import type { PdfProcessingStrategy } from '../hooks/useAccounts';
import type { ReExtractStrategy } from '../hooks/useStatementsList';

type StrategyChoice = 'keep' | 'default' | PdfProcessingStrategy;

const STRATEGY_LABELS: Record<StrategyChoice, string> = {
  keep: 'Keep current strategy',
  default: 'Use firm default',
  auto: 'Auto (text-layer if present, else OCR)',
  'force-text': 'Force text-layer extraction',
  'force-ocr': 'Force OCR',
  'auto-ocr-fallback': 'Text-layer with OCR fallback',
  'auto-text-fallback': 'OCR with text-layer fallback',
};

const CONFIRM_PHRASE = 'RE-EXTRACT';

export function ReExtractDialog({
  open,
  currentOverride,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  // Persisted per-statement override at the time the dialog opens. Used
  // only to label the "Keep current" option so the operator sees what
  // they're keeping. NULL means "currently uses firm default".
  currentOverride: PdfProcessingStrategy | null;
  busy?: boolean;
  onClose: () => void;
  // `strategy` is undefined when the operator keeps the existing
  // override (no API change), 'default' to clear it, or a concrete
  // strategy to set it.
  onConfirm: (input: { strategy?: ReExtractStrategy }) => Promise<void> | void;
}) {
  const [choice, setChoice] = useState<StrategyChoice>('keep');
  const [typed, setTyped] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setChoice('keep');
      setTyped('');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const keepLabel =
    currentOverride !== null
      ? `Keep current strategy (${STRATEGY_LABELS[currentOverride]})`
      : 'Keep current strategy (firm default)';

  const submit = (): void => {
    if (typed !== CONFIRM_PHRASE || busy) return;
    if (choice === 'keep') {
      void onConfirm({});
    } else {
      void onConfirm({ strategy: choice });
    }
  };

  return (
    <div
      role="dialog"
      aria-modal
      className="fixed inset-0 z-30 grid place-items-center bg-ink/40 px-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="w-full max-w-md space-y-3 rounded-xl bg-white p-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 className="text-lg font-semibold">Re-extract this statement?</h2>
        <p className="text-sm text-ink-muted">
          Existing transactions will be discarded and the LLM will run again from the source PDF.
          Any user edits and trntype overrides on the current rows are lost. The original PDF and
          audit trail are preserved.
        </p>

        <label className="block space-y-1">
          <span className="text-xs uppercase tracking-wide text-ink-muted">
            Processing strategy
          </span>
          <select
            value={choice}
            onChange={(e) => setChoice(e.target.value as StrategyChoice)}
            disabled={busy}
            className="w-full rounded-md border border-surface-muted bg-white px-3 py-2 text-sm"
          >
            <option value="keep">{keepLabel}</option>
            <option value="default">{STRATEGY_LABELS.default}</option>
            <option value="auto">{STRATEGY_LABELS.auto}</option>
            <option value="force-text">{STRATEGY_LABELS['force-text']}</option>
            <option value="force-ocr">{STRATEGY_LABELS['force-ocr']}</option>
            <option value="auto-ocr-fallback">{STRATEGY_LABELS['auto-ocr-fallback']}</option>
            <option value="auto-text-fallback">{STRATEGY_LABELS['auto-text-fallback']}</option>
          </select>
        </label>

        <p className="text-xs text-ink-subtle">
          Type <code className="rounded bg-surface-subtle px-1 font-mono">{CONFIRM_PHRASE}</code> to
          confirm.
        </p>
        <input
          ref={inputRef}
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={CONFIRM_PHRASE}
          className="w-full rounded-md border border-surface-muted px-3 py-2 font-mono text-sm"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-surface-muted px-3 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={typed !== CONFIRM_PHRASE || busy}
            className="rounded-md bg-danger px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Enqueueing…' : 'Re-extract'}
          </button>
        </div>
      </form>
    </div>
  );
}
