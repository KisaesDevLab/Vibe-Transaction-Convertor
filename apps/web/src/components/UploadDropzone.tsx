import { useEffect, useRef, useState } from 'react';

import { useUpload, type PdfProcessingStrategy, type UploadResult } from '../hooks/useAccounts';
import { cn } from '../lib/cn';

type StrategyChoice = PdfProcessingStrategy | 'default';

const STRATEGY_LABELS: Record<StrategyChoice, string> = {
  default: 'Use firm default',
  auto: 'Auto (text-layer if present, else OCR)',
  'force-text': 'Force text-layer extraction',
  'force-ocr': 'Force GLM-OCR',
  'auto-ocr-fallback': 'Text-layer with OCR fallback',
};

interface StagedFile {
  file: File;
  strategy: StrategyChoice;
}

export function UploadDropzone({ accountId }: { accountId: string }) {
  const upload = useUpload(accountId);
  const [dragActive, setDragActive] = useState(false);
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [lastResult, setLastResult] = useState<UploadResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const stageFiles = (fileList: FileList | File[] | null): void => {
    if (!fileList) return;
    const next = Array.from(fileList).map((file) => ({ file, strategy: 'default' as const }));
    if (next.length === 0) return;
    setStaged((prev) => [...prev, ...next]);
  };

  const removeStaged = (idx: number): void => {
    setStaged((prev) => prev.filter((_, i) => i !== idx));
  };

  const setStagedStrategy = (idx: number, choice: StrategyChoice): void => {
    setStaged((prev) => prev.map((s, i) => (i === idx ? { ...s, strategy: choice } : s)));
  };

  const submit = async (): Promise<void> => {
    if (staged.length === 0) return;
    const files = staged.map((s) => s.file);
    const strategies = staged.map((s) => (s.strategy === 'default' ? null : s.strategy));
    try {
      const result = await upload.mutateAsync({ files, strategies });
      setLastResult(result);
      setStaged([]);
    } catch {
      // useMutation surfaces upload.error; staged files survive so the
      // operator can re-submit without re-picking strategies.
    }
  };

  // Clear lingering staged files when the account changes — the picker
  // is per-account.
  useEffect(() => {
    setStaged([]);
  }, [accountId]);

  return (
    <div>
      <div
        className={cn(
          'rounded-lg border-2 border-dashed p-8 text-center transition-colors',
          dragActive ? 'border-accent bg-accent/5' : 'border-surface-muted bg-white',
          upload.isPending ? 'opacity-90' : '',
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          stageFiles(e.dataTransfer?.files ?? null);
        }}
      >
        <p className="text-sm text-ink-muted">
          Drop PDF statements here, or click to choose files.
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="application/pdf,.pdf"
          className="sr-only"
          onChange={(e) => {
            stageFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={upload.isPending}
          className="mt-3 inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          Choose files
        </button>
      </div>

      {staged.length > 0 ? (
        <div className="mt-3 space-y-2 rounded-md border border-surface-muted bg-white p-3">
          <p className="text-xs uppercase tracking-wide text-ink-muted">
            {staged.length} file{staged.length === 1 ? '' : 's'} ready to upload
          </p>
          <ul className="space-y-2">
            {staged.map((s, idx) => (
              <li
                key={`${s.file.name}-${idx}`}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={s.file.name}>
                  {s.file.name}
                </span>
                <span className="text-xs text-ink-subtle">
                  {(s.file.size / 1024).toFixed(0)} KB
                </span>
                <label className="text-xs">
                  <span className="sr-only">Processing strategy for {s.file.name}</span>
                  <select
                    value={s.strategy}
                    onChange={(e) => setStagedStrategy(idx, e.target.value as StrategyChoice)}
                    disabled={upload.isPending}
                    className="rounded-md border border-surface-muted bg-white px-2 py-1 text-xs"
                  >
                    {(Object.keys(STRATEGY_LABELS) as StrategyChoice[]).map((k) => (
                      <option key={k} value={k}>
                        {STRATEGY_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => removeStaged(idx)}
                  disabled={upload.isPending}
                  className="rounded-md border border-surface-muted px-2 py-1 text-xs text-ink-muted hover:bg-surface-subtle disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setStaged([])}
              disabled={upload.isPending}
              className="rounded-md border border-surface-muted px-3 py-1.5 text-sm hover:bg-surface-subtle disabled:opacity-50"
            >
              Clear list
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={upload.isPending}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              {upload.isPending ? (
                <>
                  <span
                    aria-hidden="true"
                    className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent-fg/40 border-t-accent-fg"
                  />
                  Uploading {staged.length}…
                </>
              ) : (
                `Upload ${staged.length} file${staged.length === 1 ? '' : 's'}`
              )}
            </button>
          </div>
        </div>
      ) : null}

      {lastResult ? (
        <div className="mt-3 space-y-2 rounded-md border border-surface-muted bg-white p-3 text-sm">
          <div className="flex items-center justify-between">
            <p className="text-xs uppercase tracking-wide text-ink-muted">
              Last upload — {lastResult.statements.length} accepted, {lastResult.errors.length}{' '}
              rejected
            </p>
            <button
              type="button"
              onClick={() => setLastResult(null)}
              className="text-xs text-ink-muted hover:text-ink hover:underline"
            >
              Clear
            </button>
          </div>
          {lastResult.statements.map((s) => (
            <p key={s.statementId}>
              ✓ {s.filename} ({s.pages} pages){' '}
              {s.deduplicated ? <span className="text-ink-subtle">— already uploaded</span> : null}
            </p>
          ))}
          {lastResult.errors.map((e, i) => (
            <p key={`${e.filename}-${i}`} className="text-danger">
              ✗ {e.filename} — {e.error}
            </p>
          ))}
        </div>
      ) : null}

      {upload.error ? (
        <p className="mt-2 text-sm text-danger" role="alert">
          {(upload.error as Error).message}
        </p>
      ) : null}
    </div>
  );
}
