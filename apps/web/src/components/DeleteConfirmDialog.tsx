// Reusable typed-confirm dialog. Replaces window.confirm() for
// destructive actions where we want a forensic-grade audit trail and a
// less-startling UX than the native browser confirm.

import { useEffect, useRef, useState } from 'react';

export function DeleteConfirmDialog({
  open,
  title,
  description,
  preview,
  confirmText,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  preview?: React.ReactNode;
  // Operator must type this string verbatim before the confirm button
  // unlocks. Default 'DELETE' — use a more specific phrase for higher
  // stakes (e.g. the row count for bulk delete).
  confirmText?: string;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
}) {
  const phrase = confirmText ?? 'DELETE';
  const [typed, setTyped] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTyped('');
      // Defer focus until after the dialog mounts.
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
          if (typed === phrase && !busy) void onConfirm();
        }}
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        {typeof description === 'string' ? (
          <p className="text-sm text-ink-muted">{description}</p>
        ) : (
          description
        )}
        {preview ? (
          <div className="rounded-md border border-surface-muted bg-surface-subtle p-3 text-xs">
            {preview}
          </div>
        ) : null}
        <p className="text-xs text-ink-subtle">
          Type <code className="rounded bg-surface-subtle px-1 font-mono">{phrase}</code> to
          confirm.
        </p>
        <input
          ref={inputRef}
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={phrase}
          className="w-full rounded-md border border-surface-muted px-3 py-2 text-sm font-mono"
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
            disabled={typed !== phrase || busy}
            className="rounded-md bg-danger px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </form>
    </div>
  );
}
