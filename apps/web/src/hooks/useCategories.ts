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

// Non-archived categories for the review grid's Category dropdown, from the
// read-only review-meta endpoint any reviewer with the 'statements' feature
// can call (the /api/admin/categories list above 403s for staff, which hid
// the Category/Cleansed columns). Keyed under ['categories'] so the admin
// mutations' prefix invalidation refreshes it too. CategoryAdminPage keeps
// useCategories().
export const useReviewCategories = () =>
  useQuery({
    queryKey: ['categories', 'review'],
    queryFn: () => api.get<BusinessCategory[]>('/api/review-meta/categories'),
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
export interface EnrichmentProcessLabel {
  provider: 'local' | 'anthropic';
  model: string;
}

export interface EnrichmentTogglesStatus {
  cleanseEnabled: boolean;
  categoryEnabled: boolean;
  // Per-process provider + model (the matrix) for each pass. Optional for
  // back-compat with older API responses.
  cleanse?: EnrichmentProcessLabel;
  category?: EnrichmentProcessLabel;
}

export const useEnrichmentToggles = () =>
  useQuery({
    queryKey: ['admin', 'enrichment'],
    queryFn: () => api.get<EnrichmentTogglesStatus>('/api/admin/enrichment'),
    staleTime: 30 * 1000,
  });

// Same toggle status for the review page, read from the review-meta endpoint
// so staff (who can run POST /api/statements/:id/enrich) see the enrichment
// toolbar. Keyed under ['admin', 'enrichment'] so useSetEnrichmentToggle's
// prefix invalidation refreshes it.
export const useReviewEnrichmentToggles = () =>
  useQuery({
    queryKey: ['admin', 'enrichment', 'review'],
    queryFn: () => api.get<EnrichmentTogglesStatus>('/api/review-meta/enrichment'),
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
