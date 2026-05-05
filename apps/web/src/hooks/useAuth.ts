import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { api, ApiError } from '../lib/api';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'staff';
  createdAt: string;
}

export const meKey = ['auth', 'me'] as const;

export const useMe = () =>
  useQuery({
    queryKey: meKey,
    queryFn: async (): Promise<AuthUser | null> => {
      try {
        const res = await api.get<{ user: AuthUser }>('/api/auth/me');
        return res.user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
  });

export const useLogin = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api.post<{ user: AuthUser }>('/api/auth/login', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: meKey }),
  });
};

export const useLogout = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/api/auth/logout'),
    onSuccess: () => qc.invalidateQueries({ queryKey: meKey }),
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
