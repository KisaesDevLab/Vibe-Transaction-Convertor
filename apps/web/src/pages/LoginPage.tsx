import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { useLogin, useMe, useUsersExist } from '../hooks/useAuth';
import { ApiError } from '../lib/api';

export function LoginPage() {
  const me = useMe();
  const usersExist = useUsersExist();
  const navigate = useNavigate();
  const login = useLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (me.data) return <Navigate to="/" replace />;
  if (usersExist.data && !usersExist.data.exists) return <Navigate to="/register" replace />;

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    try {
      await login.mutateAsync({ email, password });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'login failed');
    }
  };

  return (
    <main className="min-h-screen grid place-items-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-xl border border-surface-muted bg-white p-6 shadow-sm"
      >
        <h1 className="text-xl font-semibold mb-1">Sign in</h1>
        <p className="text-sm text-ink-muted mb-6">Vibe Transactions Converter</p>

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
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={login.isPending}
          className="mt-6 w-full rounded-md bg-accent text-accent-fg font-medium py-2 disabled:opacity-50"
        >
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
