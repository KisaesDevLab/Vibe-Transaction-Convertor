import { useRef, useState } from 'react';

import { useUpload, type UploadResult } from '../hooks/useAccounts';
import { cn } from '../lib/cn';

export function UploadDropzone({ accountId }: { accountId: string }) {
  const upload = useUpload(accountId);
  const [dragActive, setDragActive] = useState(false);
  const [lastResult, setLastResult] = useState<UploadResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (fileList: FileList | File[] | null): Promise<void> => {
    if (!fileList) return;
    const files = Array.from(fileList);
    if (files.length === 0) return;
    const result = await upload.mutateAsync(files);
    setLastResult(result);
  };

  return (
    <div>
      <div
        className={cn(
          'rounded-lg border-2 border-dashed p-8 text-center transition-colors',
          dragActive ? 'border-accent bg-accent/5' : 'border-surface-muted bg-white',
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
          className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {upload.isPending ? 'Uploading…' : 'Choose files'}
        </button>
      </div>

      {lastResult ? (
        <div className="mt-3 space-y-2 text-sm">
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
