// Phase 29 #10 — surfacing for "an updated image of vibe-tx-converter
// has been published". Polls /api/admin/appliance/status (admin-only)
// every minute and renders an amber banner across the AdminGate-
// guarded section when an update is available.
//
// We deliberately *don't* try to apply the update from the app — the
// appliance orchestrator owns that. The banner just tells the
// operator to run `vibe upgrade vibe-tx-converter` on the host.

import { useQuery } from '@tanstack/react-query';

import { useMe } from '../hooks/useAuth';
import { api } from '../lib/api';

interface ApplianceStatus {
  appliance: boolean;
  applianceVersion: string | null;
  runningVersion: string;
  availableVersion: string | null;
  buildSha: string;
  updateAvailable: boolean;
}

export function UpdateAvailableBanner() {
  const me = useMe();
  const isAdmin = me.data?.role === 'admin';
  const q = useQuery({
    queryKey: ['admin', 'appliance', 'status'],
    queryFn: () => api.get<ApplianceStatus>('/api/admin/appliance/status'),
    enabled: isAdmin,
    // Once a minute is plenty — operators don't need real-time.
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (!isAdmin) return null;
  if (!q.data?.updateAvailable) return null;

  return (
    <div
      role="status"
      className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      <strong>Update available:</strong>{' '}
      <code className="rounded bg-amber-100 px-1 font-mono">{q.data.availableVersion}</code>{' '}
      (running <code className="rounded bg-amber-100 px-1 font-mono">{q.data.runningVersion}</code>
      ). Run{' '}
      <code className="rounded bg-amber-100 px-1 font-mono">vibe upgrade vibe-tx-converter</code> on
      the appliance host to apply it.
    </div>
  );
}
