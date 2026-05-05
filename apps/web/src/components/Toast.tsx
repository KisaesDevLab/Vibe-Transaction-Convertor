import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { cn } from '../lib/cn';

type ToastKind = 'success' | 'error' | 'info';
interface ToastEntry {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  push: (kind: ToastKind, message: string) => void;
  success: (m: string) => void;
  error: (m: string) => void;
  info: (m: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export const useToast = (): ToastApi => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastEntry[]>([]);
  const idRef = useRef(0);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = ++idRef.current;
    setItems((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 5_000);
  }, []);

  const api: ToastApi = {
    push,
    success: (m) => push('success', m),
    error: (m) => push('error', m),
    info: (m) => push('info', m),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {items.map((t) => (
          <ToastBubble
            key={t.id}
            entry={t}
            onClose={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastBubble({ entry, onClose }: { entry: ToastEntry; onClose: () => void }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);
  const palette =
    entry.kind === 'success'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
      : entry.kind === 'error'
        ? 'border-red-200 bg-red-50 text-red-900'
        : 'border-surface-muted bg-white text-ink';
  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-md transition-all duration-200',
        palette,
        visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p>{entry.message}</p>
        <button
          type="button"
          aria-label="Dismiss"
          className="-mr-1 -mt-1 rounded p-1 text-current/60 hover:text-current"
          onClick={onClose}
        >
          ×
        </button>
      </div>
    </div>
  );
}
