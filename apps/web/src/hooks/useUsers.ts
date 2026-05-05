import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'staff';
  createdAt: string;
}

const usersKey = ['admin', 'users'] as const;

export const useAdminUsers = () =>
  useQuery({
    queryKey: usersKey,
    queryFn: () => api.get<AdminUser[]>('/api/users'),
  });

export const useCreateStaff = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string; displayName: string }) =>
      api.post<AdminUser>('/api/users', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: usersKey }),
  });
};

export const useResetPassword = () =>
  useMutation({
    mutationFn: (id: string) =>
      api.post<{ temporaryPassword: string }>(`/api/users/${id}/reset-password`),
  });
