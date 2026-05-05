import { type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

import { useMe, useUsersExist } from '../hooks/useAuth';

export function AuthGate({ children }: { children: ReactNode }) {
  const me = useMe();
  const usersExist = useUsersExist();
  if (me.isPending || usersExist.isPending) {
    return <div className="grid min-h-screen place-items-center text-ink-muted">Loading…</div>;
  }
  if (!me.data) {
    if (usersExist.data && !usersExist.data.exists) return <Navigate to="/register" replace />;
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
