import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';

export interface Company {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  accountCount: number;
}

export const companiesKey = ['companies'] as const;

export const useCompanies = (q?: string) =>
  useQuery({
    queryKey: [...companiesKey, q ?? ''],
    queryFn: () =>
      api.get<{ rows: Company[]; total: number }>('/api/companies', q ? { q } : undefined),
  });

export const useCreateCompany = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string }) => api.post<Company>('/api/companies', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: companiesKey }),
  });
};

export const useUpdateCompany = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.patch<Company>(`/api/companies/${id}`, { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: companiesKey }),
  });
};

export const useDeleteCompany = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      api.delete<void>(`/api/companies/${id}${force ? '?force=true' : ''}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: companiesKey }),
  });
};
