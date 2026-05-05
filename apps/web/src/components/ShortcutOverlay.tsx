// Global "?" keyboard-shortcut overlay. Mounted from AppShell so it's
// available on every authenticated page. Listens for shift+/ ("?") at
// the document level when focus is not in an editable element. Esc
// closes it. Phase 18 #20.

import { useEffect, useState } from 'react';

interface Group {
  title: string;
  rows: Array<{ keys: string[]; description: string }>;
}

const GROUPS: Group[] = [
  {
    title: 'Transaction grid',
    rows: [
      { keys: ['j'], description: 'Next row' },
      { keys: ['k'], description: 'Previous row' },
      { keys: ['e'], description: 'Edit selected row' },
      { keys: ['x'], description: 'Toggle row selection (for bulk ops)' },
      { keys: ['s'], description: 'Save the row currently being edited' },
      { keys: ['r'], description: 'Recompute reconciliation' },
      { keys: ['Esc'], description: 'Cancel edit / clear selection' },
    ],
  },
  {
    title: 'Anywhere',
    rows: [
      { keys: ['?'], description: 'Show this overlay' },
      { keys: ['/'], description: 'Focus the search field on the current page' },
      { keys: ['Esc'], description: 'Close overlay or cancel current edit' },
    ],
  },
];

const isEditableTarget = (t: unknown): boolean => {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
};

export function ShortcutOverlay() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Ignore when the user is typing in a field. "?" is shift+/ on
      // US layouts, so checking e.key === '?' is the canonical form
      // and survives layout differences better than testing the
      // physical key code.
      if (e.key === '?' && !isEditableTarget(e.target)) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      // "/" jumps focus to the page's search field. Pages opt in by
      // marking their input with [data-focus="search"] or by using
      // a native <input type="search">. We swallow the keystroke so
      // the "/" doesn't end up in the input itself.
      if (e.key === '/' && !isEditableTarget(e.target)) {
        const el =
          document.querySelector<HTMLInputElement>('[data-focus="search"]') ??
          document.querySelector<HTMLInputElement>('input[type="search"]');
        if (el) {
          e.preventDefault();
          el.focus();
          el.select();
        }
        return;
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-surface-muted bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-xs text-ink-muted hover:text-ink"
          >
            Esc to close
          </button>
        </div>
        <div className="space-y-4">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                {g.title}
              </h3>
              <dl className="mt-2 space-y-1.5 text-sm">
                {g.rows.map((row) => (
                  <div key={row.description} className="flex items-baseline justify-between gap-3">
                    <dt className="flex flex-wrap gap-1">
                      {row.keys.map((k) => (
                        <kbd
                          key={k}
                          className="rounded border border-surface-muted bg-surface-subtle px-1.5 py-0.5 font-mono text-xs"
                        >
                          {k}
                        </kbd>
                      ))}
                    </dt>
                    <dd className="text-ink-muted">{row.description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
