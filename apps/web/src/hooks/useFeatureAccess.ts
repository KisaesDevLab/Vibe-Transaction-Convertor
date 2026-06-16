import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';
import { meKey } from './useAuth';

export interface FeatureDef {
  key: string;
  label: string;
  area: 'core' | 'admin';
  description: string;
}

export interface FeatureAccessUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'staff';
  features: Record<string, boolean>;
}

const matrixKey = ['admin', 'feature-access'] as const;
const registryKey = ['admin', 'feature-access', 'registry'] as const;

// Static catalog of gateable features. Rarely changes, so cache hard.
export const useFeatureRegistry = () =>
  useQuery({
    queryKey: registryKey,
    queryFn: () => api.get<FeatureDef[]>('/api/admin/feature-access/registry'),
    staleTime: 60 * 60 * 1000,
  });

// All users with their effective per-feature map.
export const useFeatureAccessMatrix = () =>
  useQuery({
    queryKey: matrixKey,
    queryFn: () => api.get<FeatureAccessUser[]>('/api/admin/feature-access'),
    staleTime: 30 * 1000,
  });

export const useSetFeatureAccess = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; featureKey: string; enabled: boolean }) =>
      api.patch<{ ok: true }>(`/api/admin/feature-access/${input.userId}/${input.featureKey}`, {
        enabled: input.enabled,
      }),
    // Patch the single changed cell into the cached matrix instead of
    // refetching the whole users × features grid on every toggle — bulk
    // edits would otherwise fan out into many GETs and trip the rate
    // limiter.
    onSuccess: (_data, vars) => {
      qc.setQueryData<FeatureAccessUser[]>(matrixKey, (prev) =>
        prev?.map((u) =>
          u.id === vars.userId
            ? { ...u, features: { ...u.features, [vars.featureKey]: vars.enabled } }
            : u,
        ),
      );
      // The acting admin may have changed their own access — refresh /me
      // so nav/route gates update without a reload.
      void qc.invalidateQueries({ queryKey: meKey });
    },
  });
};
