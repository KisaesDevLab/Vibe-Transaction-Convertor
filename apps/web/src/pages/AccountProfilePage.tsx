// /account — the signed-in user's profile + change-password form.
// Currently the only meaningful action is rotating their password;
// the page also surfaces basic identity info so it doubles as a
// "who am I, when did I sign in" reference.

import { type FormEvent, useState } from 'react';

import { useToast } from '../components/Toast';
import { useChangePassword, useMe } from '../hooks/useAuth';
import { ApiError } from '../lib/api';

export function AccountProfilePage() {
  const me = useMe();
  const change = useChangePassword();
  const toast = useToast();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (next.length < 12) {
      setError('New password must be at least 12 characters.');
      return;
    }
    if (next !== confirm) {
      setError('New password and confirmation must match.');
      return;
    }
    if (current === next) {
      setError('New password must differ from the current one.');
      return;
    }
    try {
      await change.mutateAsync({ currentPassword: current, newPassword: next });
      toast.success('Password changed.');
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'change failed');
    }
  };

  if (!me.data) return <p className="text-sm text-ink-muted">Loading…</p>;
  const u = me.data;

  return (
    <section className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Account</h1>
        <p className="text-sm text-ink-muted">Your profile and password.</p>
      </header>

      <section className="rounded-lg border border-surface-muted bg-white p-4 text-sm">
        <dl className="grid gap-2 sm:grid-cols-2">
          <div>
            <dt className="text-ink-muted">Display name</dt>
            <dd>{u.displayName}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Email</dt>
            <dd className="font-mono">{u.email}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Role</dt>
            <dd>
              <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-xs">{u.role}</span>
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">Created</dt>
            <dd>{new Date(u.createdAt).toLocaleDateString()}</dd>
          </div>
        </dl>
      </section>

      <form
        onSubmit={onSubmit}
        className="space-y-3 rounded-lg border border-surface-muted bg-white p-4"
      >
        <h2 className="text-base font-medium">Change password</h2>
        <p className="text-xs text-ink-muted">
          12 characters minimum. After saving, your other sessions stay valid until they expire.
        </p>
        <div>
          <label htmlFor="current" className="block text-sm font-medium">
            Current password
          </label>
          <input
            id="current"
            type="password"
            required
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="mt-1 w-full rounded-md border border-surface-muted px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="next" className="block text-sm font-medium">
            New password
          </label>
          <input
            id="next"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className="mt-1 w-full rounded-md border border-surface-muted px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="confirm" className="block text-sm font-medium">
            Confirm new password
          </label>
          <input
            id="confirm"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="mt-1 w-full rounded-md border border-surface-muted px-3 py-2 text-sm"
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={change.isPending || current.length === 0 || next.length < 12}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {change.isPending ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </section>
  );
}
