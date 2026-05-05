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
