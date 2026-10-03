import { AuthSettingsPage } from '@kisaesdevlab/vibe-auth/react';
import { Link } from 'react-router-dom';

import { APP_BASE, csrfFetch } from '../lib/api';

// Settings → Authentication (ADR-027). The form itself ships with
// @kisaesdevlab/vibe-auth: sign-in mode with its guards, identity-provider
// fields, role map, "Test connection", MFA enforcement and break-glass
// status. It talks to /auth/settings, which needs the admin role, the
// admin.authentication feature and (for writes) the CSRF header.
export function AuthenticationAdminPage() {
  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <Link to="/admin" className="text-sm text-ink-muted hover:text-ink">
        ← Admin
      </Link>
      <header>
        <h1 className="text-2xl font-semibold">Authentication</h1>
        <p className="text-sm text-ink-muted">
          Single sign-on through Vibe Auth. In <strong>local</strong> mode (the default) only
          password sign-in is offered; <strong>both</strong> adds a single sign-on button;{' '}
          <strong>single sign-on only</strong> turns password sign-in off except for the break-glass
          account at <code className="rounded bg-surface-subtle px-1">/login/local</code>.
        </p>
      </header>
      <div className="rounded-lg border border-surface-muted bg-white p-4 text-sm">
        <AuthSettingsPage
          basePath={APP_BASE}
          productName="Transaction Converter"
          fetch={csrfFetch}
        />
      </div>
    </section>
  );
}
