import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAdminUsers, useCreateStaff, useResetPassword } from '../hooks/useUsers';
import { useToast } from '../components/Toast';
import { ApiError } from '../lib/api';

const formatRelativeTime = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(ms / 86_400_000);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
};

export function UsersAdminPage() {
  const list = useAdminUsers();
  const create = useCreateStaff();
  const reset = useResetPassword();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [resetTemp, setResetTemp] = useState<{ id: string; temp: string } | null>(null);

  const onCreate = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    try {
      await create.mutateAsync({ email, password, displayName });
      toast.success('Staff user created');
      setEmail('');
      setDisplayName('');
      setPassword('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'create failed');
    }
  };

  const onReset = async (id: string): Promise<void> => {
    if (!window.confirm('Reset password? A temporary password will be shown once.')) return;
    try {
      const { temporaryPassword } = await reset.mutateAsync(id);
      setResetTemp({ id, temp: temporaryPassword });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'reset failed');
    }
  };

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <Link to="/admin" className="text-sm text-ink-muted hover:text-ink">
        ← Admin
      </Link>
      <h1 className="text-2xl font-semibold">Users</h1>

      <form
        onSubmit={onCreate}
        className="space-y-3 rounded-lg border border-surface-muted bg-white p-4"
      >
        <h2 className="text-base font-medium">Create staff user</h2>
        <p className="text-xs text-ink-muted">
          Staff users see all firm data but can't access /admin.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="dn" className="block text-sm font-medium">
              Display name
            </label>
            <input
              id="dn"
              required
              className="mt-1 w-full rounded-md border border-surface-muted px-3 py-2 text-sm"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="email" className="block text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              className="mt-1 w-full rounded-md border border-surface-muted px-3 py-2 text-sm"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        </div>
        <div>
          <label htmlFor="pw" className="block text-sm font-medium">
            Initial password
          </label>
          <input
            id="pw"
            type="password"
            required
            minLength={12}
            className="mt-1 w-full rounded-md border border-surface-muted px-3 py-2 text-sm"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-subtle">
            12 characters minimum. Hand-deliver — never email.
          </p>
        </div>
        <button
          type="submit"
          disabled={create.isPending || password.length < 12}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {create.isPending ? 'Creating…' : 'Create staff user'}
        </button>
      </form>

      <section className="overflow-hidden rounded-lg border border-surface-muted bg-white">
        <table className="w-full text-sm">
          <thead className="bg-surface-subtle text-left">
            <tr>
              <th className="px-3 py-2 font-medium">Display name</th>
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">Last login</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-muted">
            {list.data?.map((u) => (
              <tr key={u.id}>
                <td className="px-3 py-2">{u.displayName}</td>
                <td className="px-3 py-2 text-ink-muted">{u.email}</td>
                <td className="px-3 py-2">
                  <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-xs">{u.role}</span>
                </td>
                <td className="px-3 py-2 text-xs text-ink-subtle">
                  {new Date(u.createdAt).toLocaleDateString()}
                </td>
                <td className="px-3 py-2 text-xs text-ink-subtle">
                  {u.lastLoginAt ? formatRelativeTime(u.lastLoginAt) : 'never'}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => onReset(u.id)}
                    className="rounded border border-surface-muted px-2 py-1 text-xs"
                  >
                    Reset password
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {resetTemp ? (
        <div
          role="dialog"
          aria-modal
          className="fixed inset-0 z-40 grid place-items-center bg-ink/40 px-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setResetTemp(null);
          }}
        >
          <div className="w-full max-w-md space-y-3 rounded-xl bg-white p-6">
            <h2 className="text-lg font-semibold">Temporary password</h2>
            <p className="text-sm text-ink-muted">
              Hand this to the user out-of-band. It will not be shown again.
            </p>
            <pre className="rounded-md bg-surface-subtle p-3 font-mono text-sm select-all">
              {resetTemp.temp}
            </pre>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setResetTemp(null)}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg"
              >
                I copied it — close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
