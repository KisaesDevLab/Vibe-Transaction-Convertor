import { useQuery } from '@tanstack/react-query';

import { api } from '../lib/api';

export interface Account {
  id: string;
  companyId: string;
  nickname: string;
  financialInstitution: string;
  intuBid: string;
  accountType: string;
  accountNumberMasked: string;
}

export const useAccount = (id: string) =>
  useQuery({
    queryKey: ['account', id],
    queryFn: () => api.get<Account>(`/api/accounts/${id}`),
    enabled: id.length > 0,
  });
