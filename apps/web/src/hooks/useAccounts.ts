import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';

export type AccountType = 'CHECKING' | 'SAVINGS' | 'MONEYMRKT' | 'CREDITLINE' | 'CREDITCARD';
export type CsvTemplate = 'qbo3' | 'qbo4' | 'xero' | 'generic';

export interface Account {
  id: string;
  companyId: string;
  nickname: string;
  financialInstitution: string;
  intuBid: string;
  intuOrg: string;
  accountType: AccountType;
  accountNumber: string;
  accountNumberMasked: string;
  routingNumber: string | null;
  routingNumberAbaValid: boolean | null;
  defaultCsvTemplate: CsvTemplate;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAccountInput {
  nickname: string;
  financialInstitution: string;
  intuBid: string;
  intuOrg: string;
  accountType: AccountType;
  accountNumber: string;
  routingNumber?: string;
  defaultCsvTemplate: CsvTemplate;
}

export const accountsKey = (companyId: string) => ['accounts', companyId] as const;

export const useAccounts = (companyId: string) =>
  useQuery({
    queryKey: accountsKey(companyId),
    queryFn: () => api.get<Account[]>(`/api/companies/${companyId}/accounts`),
    enabled: companyId.length > 0,
  });

// Admin-only: fetch the unmasked account number. Each call audit-logs
// the reveal action via the API.
export const fetchRevealedAccount = (id: string): Promise<Account> =>
  api.get<Account>(`/api/accounts/${id}`, { reveal: 'true' });

export const useCreateAccount = (companyId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAccountInput) =>
      api.post<Account>(`/api/companies/${companyId}/accounts`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: accountsKey(companyId) }),
  });
};

export const useDeleteAccount = (companyId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      api.delete<void>(`/api/accounts/${id}${force ? '?force=true' : ''}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: accountsKey(companyId) }),
  });
};

export interface UploadResult {
  statements: Array<{
    filename: string;
    hash: string;
    pages: number;
    bytes: number;
    statementId: string;
    deduplicated: boolean;
    status: string;
  }>;
  errors: Array<{ filename: string; error: string }>;
}

const readCsrfFromCookie = (): string =>
  document.cookie
    .split('; ')
    .find((c) => c.startsWith('vibetc_csrf='))
    ?.split('=')[1] ?? '';

export const useUpload = (accountId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (files: File[]): Promise<UploadResult> => {
      const form = new FormData();
      for (const f of files) form.append('files', f);
      const res = await fetch(`/api/accounts/${accountId}/uploads`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-csrf-token': readCsrfFromCookie() },
        body: form,
      });
      const body = (await res.json().catch(() => ({}))) as UploadResult & { message?: string };
      if (!res.ok) throw new Error(body.message ?? `upload failed (${res.status})`);
      return body;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['statements', accountId] }),
  });
};
