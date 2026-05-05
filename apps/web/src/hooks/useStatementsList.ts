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
  llmModelVersion: string | null;
  ocrEngineVersion: string | null;
  extractionMethod: 'text' | 'ocr' | 'hybrid' | null;
  sourceDateFormat: string | null;
  sourceDateFormatConfidence: number | null;
  sourceDateFormatUserConfirmed: boolean | null;
  periodBoundsViolations: number;
  detectedSplits: {
    multiAccount: boolean;
    uniqueLast4: string[];
    splits: Array<{ last4: string; pageStart: number; pageEnd: number }>;
  } | null;
  multiAccountAcknowledged: boolean;
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
  normalizedDescription: string;
  amountCents: string;
  runningBalanceCents: string | null;
  checkNumber: string | null;
  trntype: string;
  fitid: string;
  sourcePage: number;
  sourceBboxJson: [number, number, number, number] | null;
  userEdited: boolean;
  confidence: number;
  // Server-computed: cents the printed running_balance is off vs.
  // (prior_running + this row's amount). Null when the row reconciles
  // cleanly or no running balance was extracted. Phase 18 #25.
  runningBalanceDeltaCents?: string | null;
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

export interface BulkEdit {
  id: string;
  patch: TransactionPatch;
}

export interface BulkEditResult {
  results: Array<{ id: string; status: 'updated' | 'noop' | 'not-found' }>;
}

// Phase 18 #15: bulk PATCH. Sends every edit in a single round trip and
// recomputes reconciliation once. The server short-circuits no-ops, so
// shipping every visible row through it is fine.
export const useBulkUpdateTransactions = (statementId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (edits: BulkEdit[]) =>
      api.patch<BulkEditResult>(`/api/statements/${statementId}/transactions`, { edits }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['statement', statementId] }),
  });
};

export interface AddTransactionInput {
  posted_date: string;
  description: string;
  amount_cents: string | number;
  trntype?: string;
  check_number?: string;
  source_page?: number;
}

export const useAddTransaction = (statementId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AddTransactionInput) =>
      api.post<TransactionRow>(`/api/statements/${statementId}/transactions`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['statement', statementId] }),
  });
};

export const useDeleteTransaction = (statementId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (txId: string) => api.delete<void>(`/api/statements/transactions/${txId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['statement', statementId] }),
  });
};

export const useReExtract = (statementId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>(`/api/statements/${statementId}/re-extract`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['statement', statementId] }),
  });
};

export const useRecomputeReconciliation = (statementId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ status: string; deltaCents: string }>(
        `/api/statements/${statementId}/recompute-reconciliation`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['statement', statementId] }),
  });
};

export const useAcknowledgeMultiAccount = (statementId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean }>(`/api/statements/${statementId}/acknowledge-multi-account`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['statement', statementId] }),
  });
};

export interface SplitInput {
  splits: Array<{ accountId: string; pageStart: number; pageEnd: number }>;
}

export interface SplitResult {
  ok: boolean;
  children: Array<{ id: string; accountId: string; pageRange: string }>;
}

export interface ExportJobSummary {
  id: string;
  format: string;
  requestedAt: string;
  requestedBy: string;
  fileBytes: number;
  intuBidUsed: string | null;
  available: boolean;
}

export const useExportJobs = (statementId: string) =>
  useQuery({
    queryKey: ['exports', statementId],
    queryFn: () => api.get<ExportJobSummary[]>(`/api/statements/${statementId}/exports`),
    enabled: statementId.length > 0,
  });

// Phase 18 #18 — admin-only export deletion. Removes the rendered file
// from disk and the export_jobs row. Re-uploading or re-exporting
// repopulates it; audit trail is preserved.
export const useDeleteExportJob = (statementId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.delete<{ ok: boolean }>(`/api/exports/${jobId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exports', statementId] }),
  });
};

export interface ExportPreview {
  format: string;
  filename: string;
  contentType: string;
  totalLines: number;
  totalBytes: number;
  previewLines: string[];
  truncated: boolean;
}

export const useExportPreview = (statementId: string, format: string, allowOverride: boolean) =>
  useQuery({
    queryKey: ['export-preview', statementId, format, allowOverride],
    queryFn: () =>
      api.get<ExportPreview>(
        `/api/statements/${statementId}/exports/${format}/preview`,
        allowOverride ? { override: 'true' } : undefined,
      ),
    enabled: statementId.length > 0 && format.length > 0,
    // Preview is purely a function of the persisted statement — cache
    // a few minutes so flipping format toggles is snappy.
    staleTime: 60_000,
  });

export const useSplitStatement = (statementId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SplitInput) =>
      api.post<SplitResult>(`/api/statements/${statementId}/split`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['statement', statementId] });
      qc.invalidateQueries({ queryKey: ['statements'] });
    },
  });
};

export const useConfirmDateFormat = (statementId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (format: 'MDY' | 'DMY' | 'YMD') =>
      api.post<{ ok: boolean; format: string }>(
        `/api/statements/${statementId}/confirm-date-format`,
        { format },
      ),
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
