import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';

export interface BusinessCategory {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

// Active (non-archived) categories sorted by sort_order then name.
// The transaction-grid Category dropdown reads this list; the admin
// Category page reads with `includeArchived=true` so retired entries
// stay visible for un-archive.
export const useCategories = (opts: { includeArchived?: boolean } = {}) =>
  useQuery({
    queryKey: ['categories', { includeArchived: opts.includeArchived === true }],
    queryFn: () =>
      api.get<BusinessCategory[]>(
        '/api/admin/categories',
        opts.includeArchived ? { includeArchived: 'true' } : undefined,
      ),
    staleTime: 5 * 60 * 1000,
  });

export interface CreateCategoryInput {
  name: string;
  description?: string | null;
  sort_order?: number;
}

export const useCreateCategory = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCategoryInput) =>
      api.post<BusinessCategory>('/api/admin/categories', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories'] }),
  });
};

export interface UpdateCategoryInput {
  name?: string;
  description?: string | null;
  sort_order?: number;
  archived?: boolean;
}

export const useUpdateCategory = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateCategoryInput }) =>
      api.patch<BusinessCategory>(`/api/admin/categories/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories'] }),
  });
};

export const useArchiveCategory = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/admin/categories/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories'] }),
  });
};

// Toggle status for the two enrichment features. Drives whether the
// "Cleanse descriptions" and "Assign categories" buttons appear on the
// review page.
export interface EnrichmentTogglesStatus {
  cleanseEnabled: boolean;
  categoryEnabled: boolean;
  // The provider + model enrichment will run on (default provider). Optional
  // for back-compat with older API responses.
  provider?: 'local' | 'anthropic';
  model?: string;
}

export const useEnrichmentToggles = () =>
  useQuery({
    queryKey: ['admin', 'enrichment'],
    queryFn: () => api.get<EnrichmentTogglesStatus>('/api/admin/enrichment'),
    staleTime: 30 * 1000,
  });

export const useSetEnrichmentToggle = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { which: 'cleanse' | 'category'; enabled: boolean }) =>
      api.post<EnrichmentTogglesStatus>('/api/admin/enrichment', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'enrichment'] }),
  });
};
