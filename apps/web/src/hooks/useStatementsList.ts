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
    // Poll the list while any statement is mid-pipeline so newly uploaded
    // PDFs appear and progress through statuses without a manual refresh.
    refetchInterval: (q) => {
      const data = q.state.data as StatementSummary[] | undefined;
      if (!data || data.length === 0) return false;
      const anyInFlight = data.some(
        (s) =>
          s.status !== 'review' &&
          s.status !== 'exported' &&
          s.status !== 'failed' &&
          s.status !== 'awaiting-locale-confirmation',
      );
      return anyInFlight ? 3_000 : false;
    },
  });

const TERMINAL_STATUSES = new Set(['review', 'exported', 'failed', 'awaiting-locale-confirmation']);

export const useStatement = (statementId: string) =>
  useQuery({
    queryKey: ['statement', statementId],
    queryFn: () =>
      api.get<{ statement: StatementSummary; transactions: TransactionRow[] }>(
        `/api/statements/${statementId}`,
      ),
    enabled: statementId.length > 0,
    // Poll while the extraction pipeline is running so the operator sees
    // status transitions (uploaded → preprocessing → ocr → extracting →
    // reconciling → review) without manual refresh.
    refetchInterval: (q) => {
      const data = q.state.data as
        | { statement: StatementSummary; transactions: TransactionRow[] }
        | undefined;
      if (!data) return 2_000; // initial load — try again soon
      return TERMINAL_STATUSES.has(data.statement.status) ? false : 3_000;
    },
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
