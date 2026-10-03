import { type FormEvent, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { LoginPanel, type AuthStatusDto } from '@kisaesdevlab/vibe-auth/react';

import { useLogin, useMe, useUsersExist } from '../hooks/useAuth';
import { APP_BASE, ApiError } from '../lib/api';

// Parse the trailing "retry in Ns" hint from RateLimitError.
// Returns 0 when no number is found, signalling "unknown duration".
const parseRetryAfterSeconds = (msg: string): number => {
  const m = /retry in (\d+)s/i.exec(msg);
  return m ? Number.parseInt(m[1]!, 10) : 0;
};

// Vibe Auth SSO (ADR-027): LoginPanel reads GET /auth/status and adds a
// "Sign in with <IdP>" button in `both` mode, hides the password form in
// `oidc_only`, and renders the form alone in `local` (the default).
// `breakglass` is the hidden /login/local route that keeps the password
// form visible in oidc_only for the break-glass account.
export function LoginPage({ breakglass = false }: { breakglass?: boolean }) {
  const me = useMe();
  const usersExist = useUsersExist();
  const navigate = useNavigate();
  const login = useLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lockoutSec, setLockoutSec] = useState(0);
  const [authMode, setAuthMode] = useState<AuthStatusDto['mode'] | null>(null);

  // Countdown ticks once per second until 0. We only keep the
  // interval alive while there's time left, so a stuck timer can't
  // outlive the lockout.
  useEffect(() => {
    if (lockoutSec <= 0) return;
    const id = setInterval(() => setLockoutSec((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [lockoutSec]);

  if (me.data) return <Navigate to="/" replace />;
  // First-admin bootstrap is a local account, which oidc_only forbids.
  if (usersExist.data && !usersExist.data.exists && authMode !== 'oidc_only') {
    return <Navigate to="/register" replace />;
  }

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    try {
      await login.mutateAsync({ email, password });
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const sec = parseRetryAfterSeconds(err.message) || 60;
        setLockoutSec(sec);
        setError(err.message);
      } else {
        setError(err instanceof ApiError ? err.message : 'login failed');
      }
    }
  };

  const locked = lockoutSec > 0;

  return (
    <main className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-surface-muted bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold mb-1">
          {breakglass ? 'Break-glass sign-in' : 'Sign in'}
        </h1>
        <p className="text-sm text-ink-muted mb-6">Vibe Transactions Converter</p>
        <LoginPanel
          basePath={APP_BASE}
          returnTo={`${APP_BASE}/`}
          breakglass={breakglass}
          onStatus={(s) => setAuthMode(s.mode)}
          classNames={{
            button:
              'block w-full rounded-md bg-accent text-accent-fg text-center font-medium py-2 aria-disabled:opacity-60',
            divider: 'my-4 text-center text-xs uppercase tracking-wide text-ink-subtle',
            note: 'mt-3 text-sm text-ink-muted',
          }}
        >
          <form onSubmit={onSubmit}>
            <label className="block text-sm font-medium" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              className="mt-1 w-full rounded-md border border-surface-muted px-3 py-2"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            <label className="mt-4 block text-sm font-medium" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              className="mt-1 w-full rounded-md border border-surface-muted px-3 py-2"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            {error ? (
              <p role="alert" className="mt-3 text-sm text-danger">
                {locked ? `Too many attempts — try again in ${lockoutSec}s.` : error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={login.isPending || locked}
              className="mt-6 w-full rounded-md bg-accent text-accent-fg font-medium py-2 disabled:opacity-50"
            >
              {login.isPending ? 'Signing in…' : locked ? `Wait ${lockoutSec}s` : 'Sign in'}
            </button>
          </form>
        </LoginPanel>
      </div>
    </main>
  );
}
