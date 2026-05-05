import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { useLogin, useRegisterFirstAdmin, useUsersExist } from '../hooks/useAuth';
import { ApiError } from '../lib/api';

export function RegisterFirstAdminPage() {
  const usersExist = useUsersExist();
  const register = useRegisterFirstAdmin();
  const login = useLogin();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (usersExist.data?.exists) return <Navigate to="/login" replace />;

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    try {
      await register.mutateAsync({ email, password, displayName });
      await login.mutateAsync({ email, password });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'registration failed');
    }
  };

  return (
    <main className="min-h-screen grid place-items-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md rounded-xl border border-surface-muted bg-white p-6 shadow-sm"
      >
        <h1 className="text-xl font-semibold">Welcome</h1>
        <p className="mt-1 text-sm text-ink-muted">
          No users yet — create the first admin to start.
        </p>

        <label className="mt-6 block text-sm font-medium" htmlFor="dn">
          Display name
        </label>
        <input
          id="dn"
          required
          className="mt-1 w-full rounded-md border border-surface-muted px-3 py-2"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />

        <label className="mt-4 block text-sm font-medium" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
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
          minLength={12}
          className="mt-1 w-full rounded-md border border-surface-muted px-3 py-2"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="mt-1 text-xs text-ink-subtle">12 characters minimum.</p>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={register.isPending || login.isPending}
          className="mt-6 w-full rounded-md bg-accent text-accent-fg font-medium py-2 disabled:opacity-50"
        >
          {register.isPending || login.isPending ? 'Creating…' : 'Create admin'}
        </button>
      </form>
    </main>
  );
}
