import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useMe } from '../hooks/useAuth';

export function AdminGate({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isPending) return <p className="text-sm text-ink-muted">Loading…</p>;
  if (me.data?.role !== 'admin') {
    return (
      <section className="mx-auto max-w-md rounded-lg border border-surface-muted bg-white p-6 text-sm">
        <h1 className="text-lg font-semibold">Admin only</h1>
        <p className="mt-2 text-ink-muted">
          This page is restricted to administrators. Ask your firm's admin if you need access.
        </p>
        <Link to="/" className="mt-4 inline-block text-accent hover:underline">
          Back to companies →
        </Link>
      </section>
    );
  }
  return <>{children}</>;
}
