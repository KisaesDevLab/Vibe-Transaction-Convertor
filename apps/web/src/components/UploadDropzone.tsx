import { useRef, useState } from 'react';

import { useUpload, type UploadResult } from '../hooks/useAccounts';
import { cn } from '../lib/cn';

export function UploadDropzone({ accountId }: { accountId: string }) {
  const upload = useUpload(accountId);
  const [dragActive, setDragActive] = useState(false);
  const [lastResult, setLastResult] = useState<UploadResult | null>(null);
  // Filenames currently in flight (between dispatch and response).
  // Used purely to give feedback during multi-PDF uploads, since the
  // request is one POST so there's no per-file progress event yet.
  const [pendingNames, setPendingNames] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (fileList: FileList | File[] | null): Promise<void> => {
    if (!fileList) return;
    const files = Array.from(fileList);
    if (files.length === 0) return;
    setPendingNames(files.map((f) => f.name));
    try {
      const result = await upload.mutateAsync(files);
      setLastResult(result);
    } finally {
      setPendingNames([]);
    }
  };

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
        onDrop={async (e) => {
          e.preventDefault();
          setDragActive(false);
          await handleFiles(e.dataTransfer?.files ?? null);
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
            void handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={upload.isPending}
          className="mt-3 inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {upload.isPending ? (
            <>
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent-fg/40 border-t-accent-fg"
              />
              Uploading {pendingNames.length} file{pendingNames.length === 1 ? '' : 's'}…
            </>
          ) : (
            'Choose files'
          )}
        </button>
        {upload.isPending && pendingNames.length > 0 ? (
          <p className="mt-2 truncate text-xs text-ink-subtle" title={pendingNames.join(', ')}>
            {pendingNames.slice(0, 3).join(', ')}
            {pendingNames.length > 3 ? ` +${pendingNames.length - 3} more` : ''}
          </p>
        ) : null}
      </div>

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
