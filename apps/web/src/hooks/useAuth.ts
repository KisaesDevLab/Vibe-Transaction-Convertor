import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { api, ApiError } from '../lib/api';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'staff';
  createdAt: string;
}

// The me-query flattens { user, features } into the user object with a
// `features` map attached, so existing `me.data?.role` call sites keep
// working while gating code reads `me.data?.features`.
export interface AuthMe extends AuthUser {
  features: Record<string, boolean>;
}

export const meKey = ['auth', 'me'] as const;

export const useMe = () =>
  useQuery({
    queryKey: meKey,
    queryFn: async (): Promise<AuthMe | null> => {
      try {
        const res = await api.get<{ user: AuthUser; features: Record<string, boolean> }>(
          '/api/auth/me',
        );
        return { ...res.user, features: res.features ?? {} };
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
  });

// Access is default-on: a feature counts as enabled unless the map
// explicitly says false. Treats loading/missing maps as enabled so the
// UI never flashes "no access" before /me resolves.
export const hasFeature = (features: Record<string, boolean> | undefined, key: string): boolean =>
  features?.[key] !== false;

// Convenience hook for a single feature check in a component.
export const useFeature = (key: string): boolean => {
  const me = useMe();
  return hasFeature(me.data?.features, key);
};

export const useLogin = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api.post<{ user: AuthUser }>('/api/auth/login', input),
    // Set the meQuery cache synchronously from the login response — this
    // closes the brief flash where AuthGate sees stale `null` and bounces
    // the just-authenticated user back to /login while the meQuery
    // refetches. The login response has no feature map (default-on until
    // /me resolves), so seed an empty map and invalidate to fetch it.
    onSuccess: (data) => {
      qc.setQueryData(meKey, { ...data.user, features: {} });
      void qc.invalidateQueries({ queryKey: meKey });
    },
  });
};

export const useLogout = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/api/auth/logout'),
    onSuccess: () => qc.setQueryData(meKey, null),
  });
};

export const useRegisterFirstAdmin = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string; displayName: string }) =>
      api.post<AuthUser>('/api/auth/register', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: meKey }),
  });
};

export const useUsersExist = () =>
  useQuery({
    queryKey: ['auth', 'users-exist'],
    queryFn: () => api.get<{ exists: boolean }>('/api/auth/users-exist'),
  });

export const useChangePassword = () =>
  useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      api.post<{ ok: boolean }>('/api/auth/change-password', input),
  });
