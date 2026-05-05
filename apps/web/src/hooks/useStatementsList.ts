import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';

export interface StatementSummary {
  id: string;
  accountId: string;
  sourcePdfHash: string;
  sourcePdfPages: number;
  periodStart: string | null;
  periodEnd: string | null;
  openingBalanceCents: string | null;
  closingBalanceCents: string | null;
  status: string;
  reconciliationStatus: string;
  llmProvider: 'local' | 'anthropic' | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionRow {
  id: string;
  statementId: string;
  seqInDay: number;
  postedDate: string;
  description: string;
  amountCents: string;
  trntype: string;
  fitid: string;
  sourcePage: number;
  userEdited: boolean;
  confidence: number;
}

export const useStatementsByAccount = (accountId: string) =>
  useQuery({
    queryKey: ['statements', accountId],
    queryFn: () =>
      api.get<StatementSummary[]>('/api/statements', accountId ? { accountId } : undefined),
    enabled: accountId.length > 0,
  });

export const useStatement = (statementId: string) =>
  useQuery({
    queryKey: ['statement', statementId],
    queryFn: () =>
      api.get<{ statement: StatementSummary; transactions: TransactionRow[] }>(
        `/api/statements/${statementId}`,
      ),
    enabled: statementId.length > 0,
  });

export interface TransactionPatch {
  description?: string;
  amount_cents?: number | string;
  trntype?: string;
  posted_date?: string;
}

export const useUpdateTransaction = (statementId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: TransactionPatch }) =>
      api.patch<TransactionRow>(`/api/statements/transactions/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['statement', statementId] }),
  });
};

export const useOverrideReconciliation = (statementId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      api.post<{ ok: boolean }>(`/api/statements/${statementId}/override-reconciliation`, {
        reason,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['statement', statementId] }),
  });
};
