import { type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

import { useLogout, useMe } from '../hooks/useAuth';
import { cn } from '../lib/cn';

const NAV: Array<{ to: string; label: string }> = [
  { to: '/companies', label: 'Companies' },
  { to: '/statements', label: 'Statements' },
  { to: '/admin', label: 'Admin' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const logout = useLogout();

  return (
    <div className="grid min-h-screen grid-cols-[16rem_1fr] bg-surface text-ink">
      <aside className="border-r border-surface-muted bg-surface-subtle p-4">
        <div className="mb-6 px-2">
          <p className="text-sm font-semibold tracking-wide">Vibe Tx</p>
          <p className="text-xs text-ink-subtle">Transactions Converter</p>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-white text-ink shadow-sm'
                    : 'text-ink-muted hover:bg-white hover:text-ink',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex flex-col">
        <header className="flex items-center justify-between border-b border-surface-muted bg-white px-6 py-3">
          <div className="text-sm text-ink-muted">
            {me.data ? `${me.data.displayName} · ${me.data.role}` : null}
          </div>
          <button
            type="button"
            className="rounded-md border border-surface-muted px-3 py-1 text-sm hover:bg-surface-subtle"
            onClick={() =>
              logout.mutate(undefined, { onSuccess: () => window.location.assign('/login') })
            }
          >
            Sign out
          </button>
        </header>
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
