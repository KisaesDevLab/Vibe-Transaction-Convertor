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

export const useCompanies = (
  params: { q?: string | undefined; limit?: number | undefined; offset?: number | undefined } = {},
) =>
  useQuery({
    queryKey: [...companiesKey, params.q ?? '', params.limit ?? 50, params.offset ?? 0],
    queryFn: () => {
      const query: Record<string, string | number> = {
        limit: params.limit ?? 50,
        offset: params.offset ?? 0,
      };
      if (params.q && params.q.length > 0) query.q = params.q;
      return api.get<{ rows: Company[]; total: number }>('/api/companies', query);
    },
  });

// Single-company fetch — the list endpoint is paginated, so a deep link
// to /companies/:id can't rely on the list cache when the company isn't
// on the first page.
export const useCompany = (id: string) =>
  useQuery({
    queryKey: [...companiesKey, 'one', id],
    queryFn: () => api.get<Company>(`/api/companies/${id}`),
    enabled: id.length > 0,
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
