import { useQuery } from '@tanstack/react-query';

import { api } from '../lib/api';

export interface Account {
  id: string;
  companyId: string;
  nickname: string;
  financialInstitution: string;
  intuBid: string;
  intuOrg?: string | null;
  accountType: string;
  accountNumberMasked: string;
  routingNumber: string | null;
  routingNumberAbaValid: boolean | null;
  defaultCsvTemplate: 'qbo3' | 'qbo4' | 'xero' | 'generic';
  intuUseridOverride?: string | null;
}

export const useAccount = (id: string) =>
  useQuery({
    queryKey: ['account', id],
    queryFn: () => api.get<Account>(`/api/accounts/${id}`),
    enabled: id.length > 0,
  });
