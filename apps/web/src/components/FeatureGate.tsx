import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { hasFeature, useMe } from '../hooks/useAuth';

// Route-level guard: renders children only when the current user has the
// named feature enabled. Mirrors AdminGate; compose the two for admin
// pages that are also feature-gated. Access is default-on, so this only
// blocks once an admin has disabled the feature for the user.
export function FeatureGate({ feature, children }: { feature: string; children: ReactNode }) {
  const me = useMe();
  if (me.isPending) return <p className="text-sm text-ink-muted">Loading…</p>;
  if (!hasFeature(me.data?.features, feature)) {
    return (
      <section className="mx-auto max-w-md rounded-lg border border-surface-muted bg-white p-6 text-sm">
        <h1 className="text-lg font-semibold">No access</h1>
        <p className="mt-2 text-ink-muted">
          Your access to this feature is turned off. Ask your firm's admin to enable it.
        </p>
        <Link to="/" className="mt-4 inline-block text-accent hover:underline">
          Back to companies →
        </Link>
      </section>
    );
  }
  return <>{children}</>;
}
