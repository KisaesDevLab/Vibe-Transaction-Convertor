import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../lib/api';
import type { PdfProcessingStrategy } from './useAccounts';

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
  // Vibe Shield vision path: per-page document type (bank_statement |
  // credit_card | check | deposit | transmittal | unknown | unclassified)
  // in page order. NULL for the text/markdown path or pre-v1.13.0 gateways.
  pageClassifications: string[] | null;
  // Set when a page classified 'unknown' (maximal redaction — data may have
  // been clipped). Export is blocked until reviewHoldAcknowledged is true.
  reviewHoldReason: string | null;
  reviewHoldAcknowledged: boolean;
  // Per-statement override of the firm-wide PDF processing strategy.
  // NULL means "use the firm default" at extraction time. Surfaced so
  // the Re-extract dialog can pre-fill the strategy picker.
  processingStrategyOverride: PdfProcessingStrategy | null;
  // true when the source PDF has been removed from disk (admin Delete-
  // PDF on a statement sharing the same stored file, or the retention
  // sweep). The row and its transactions remain; the viewer and
  // re-extract are blocked until the same PDF is re-uploaded.
  sourcePdfDeleted: boolean;
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
  // Check payee ("Pay to the order of"), read off the cancelled-check image
  // on the local vision model. Drives the OFX <NAME> for check rows; editable
  // in the review grid. Null for non-check rows or when not yet resolved.
  payee: string | null;
  trntype: string;
  fitid: string;
  sourcePage: number;
  sourceBboxJson: [number, number, number, number] | null;
  userEdited: boolean;
  confidence: number;
  // Phase 33 — LLM enrichment fields. Null until the operator clicks
  // "Cleanse descriptions" / "Assign categories" on the review page.
  // enrichmentUserEdited flips true when the user overrides either
  // field manually so a later batch enrich() skips the row.
  cleansedDescription: string | null;
  businessCategoryId: string | null;
  // Server resolves the FK to the category name in one batched fetch
  // so the grid can render the cell without a second round-trip per
  // row. Null when the row has no category assigned, or when the
  // assigned category was hard-deleted (very rare — soft-archive is
  // the default).
  businessCategoryName: string | null;
  enrichmentUserEdited: boolean;
  enrichmentRunAt: string | null;
  // Structured cleanse outputs (Phase 33 follow-up). Null until cleansed.
  enrichmentMerchantName: string | null;
  enrichmentProcessor: string | null;
  enrichmentTransactionType: string | null;
  enrichmentIsOpaque: boolean | null;
  enrichmentConfidence: string | null;
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

export interface StatementDetail {
  statement: StatementSummary;
  transactions: TransactionRow[];
  // Admin-tunable review.confidence_threshold (0–1; 0 disables the hold). The
  // review grid flags rows below it as "suspect" so its count matches the
  // server's review hold. Optional for back-compat with older API responses.
  reviewConfidenceThreshold?: number;
}

export const useStatement = (statementId: string) =>
  useQuery({
    queryKey: ['statement', statementId],
    queryFn: () => api.get<StatementDetail>(`/api/statements/${statementId}`),
    enabled: statementId.length > 0,
    // Poll while the extraction pipeline is running so the operator sees
    // status transitions (uploaded → preprocessing → ocr → extracting →
    // reconciling → review) without manual refresh.
    refetchInterval: (q) => {
      const data = q.state.data as StatementDetail | undefined;
      if (!data) return 2_000; // initial load — try again soon
      return TERMINAL_STATUSES.has(data.statement.status) ? false : 3_000;
    },
  });

// Client mirror of the server's export gate (services/exports.ts: Golden Rule +
// review hold, plus the review/exported status gate). Returns why export is
// blocked, or null when the statement can be exported. Status comes first: a
// stale 'verified' reconciliation on a statement that is re-extracting, failed,
// or awaiting the date-format confirmation must not enable the export buttons.
export const exportBlockReason = (
  s: Pick<
    StatementSummary,
    'status' | 'reconciliationStatus' | 'reviewHoldReason' | 'reviewHoldAcknowledged'
  >,
): string | null => {
  if (s.status !== 'review' && s.status !== 'exported') {
    if (s.status === 'awaiting-locale-confirmation') {
      return 'Confirm the source date format before exporting.';
    }
    if (s.status === 'failed') {
      return 'Extraction failed — re-extract the statement before exporting.';
    }
    return `Statement is still processing (${s.status}) — export unlocks once it reaches review.`;
  }
  if (s.reconciliationStatus === 'discrepancy') {
    return 'Reconciliation is in discrepancy — fix the rows or override the reconciliation before exporting.';
  }
  if (s.reconciliationStatus !== 'verified' && s.reconciliationStatus !== 'overridden') {
    return 'Reconciliation is not verified — fix discrepancies or override before export.';
  }
  if (s.reviewHoldReason && !s.reviewHoldAcknowledged) {
    return 'Review hold — acknowledge the flagged page(s) before exporting.';
  }
  return null;
};

export interface TransactionPatch {
  description?: string;
  amount_cents?: number | string;
  trntype?: string;
  posted_date?: string;
  // Phase 33 — operator overrides for LLM enrichment fields. Either
  // field set to a non-null value flips enrichment_user_edited so the
  // row is skipped on a subsequent batch enrichment click.
  cleansed_description?: string | null;
  business_category_id?: string | null;
  // Check payee correction. Empty string / null clears it.
  payee?: string | null;
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

// Phase 33 — operator-triggered LLM enrichment. The button on the review
// page calls this with `{cleanse: true}` or `{categorize: true}` (or both).
// Server skips rows where enrichmentUserEdited is true and reports back
// counts so the UI can toast "12 enriched, 3 manual edits skipped, 8 from
// cache".
export interface EnrichStatementResult {
  txCount: number;
  enrichedCount: number;
  skippedUserEditedCount: number;
  cacheHits: number;
  llmCalls: number;
  costMicros: string;
  model: string | null;
  provider: 'local' | 'anthropic' | null;
}

export const useEnrichStatement = (statementId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts: { cleanse: boolean; categorize: boolean }) =>
      api.post<EnrichStatementResult>(`/api/statements/${statementId}/enrich`, opts),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['statement', statementId] }),
  });
};

// Vision pass that reads cancelled-check images out of the source PDF
// and writes "Check #N → PAYEE" back into cleansedDescription. Only
// works when the Anthropic provider is configured — the local Qwen
// has no vision input. Result counts let the UI toast something like
// "8 of 12 checks matched, 4 unmatched check numbers".
export interface CheckResolveResult {
  txCount: number;
  candidateCount: number;
  llmExtractedCount: number;
  matchedCount: number;
  unmatchedCheckNumbers: string[];
  pageCount: number;
  costMicros: string;
  model: string | null;
}

export const useResolveCheckPayees = (statementId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<CheckResolveResult>(`/api/statements/${statementId}/resolve-check-payees`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['statement', statementId] }),
  });
};

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

// Re-extract accepts an optional strategy override. 'default' means
// "fall back to the firm-wide default" (clears the per-statement
// override); a concrete strategy updates the override before the worker
// picks it up. Omitting the argument keeps whatever override the
// statement already had.
export type ReExtractStrategy = PdfProcessingStrategy | 'default';

export interface ExtractedText {
  text: string | null;
  source: string | null;
  method: 'text' | 'ocr' | 'hybrid' | null;
  chars: number;
  updatedAt: string;
}

// Lazily fetch the stored extracted text (OCR/text-layer markdown that fed
// extraction). Disabled until `enabled` flips true (the operator opens the
// viewer) so the potentially-large payload isn't fetched on every page load.
export const useExtractedText = (statementId: string, enabled: boolean) =>
  useQuery({
    queryKey: ['statement', statementId, 'extracted-text'],
    queryFn: () => api.get<ExtractedText>(`/api/statements/${statementId}/extracted-text`),
    enabled,
    staleTime: 60_000,
  });

export const useReExtract = (statementId: string) => {
  const qc = useQueryClient();
  return useMutation({
    // `provider: 'anthropic'` forces this run through Anthropic (the deliberate,
    // audit-logged egress carve-out) regardless of the routing policy — used by
    // the "Process via Anthropic" action on a failed statement.
    mutationFn: (input?: { strategy?: ReExtractStrategy; provider?: 'local' | 'anthropic' }) =>
      api.post<{ ok: boolean }>(`/api/statements/${statementId}/re-extract`, {
        ...(input?.strategy ? { strategy: input.strategy } : {}),
        ...(input?.provider ? { provider: input.provider } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['statement', statementId] }),
  });
};

export interface DeleteStatementResult {
  ok: boolean;
  txCount: number;
  exportFilesRemoved: number;
  sourcePdfRemoved: boolean;
}

// Admin-only delete of just the source PDF, leaving the statement row
// and transactions intact. Flags sourcePdfDeleted on every statement
// that points at the same stored file (split children / same-month
// re-uploads share it) so their UI stops promising a viewable PDF.
// Idempotent — calling it twice returns { fileRemoved: false,
// alreadyDeleted: true } the second time.
export interface DeletePdfResult {
  ok: boolean;
  fileRemoved: boolean;
  cascadedSiblings: number;
  alreadyDeleted: boolean;
}

export const useDeleteStatementPdf = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.post<DeletePdfResult>(`/api/statements/${id}/delete-pdf`),
    onSuccess: (_data, { id }) => {
      // Invalidate this statement (so sourcePdfDeleted flips in the
      // detail view) plus the list (so any other row that just got
      // cascaded shows up as deleted).
      qc.invalidateQueries({ queryKey: ['statement', id] });
      qc.invalidateQueries({ queryKey: ['statements'] });
    },
  });
};

// Admin-only hard delete of a statement. Cascades transactions +
// export_jobs at the DB level. The source PDF is unlinked only when no
// other statement still uses the same stored file (split children and
// same-month re-uploads share one); sibling rows are left untouched.
//
// Takes the id at mutation time so the same hook instance can be shared
// across a list view (one hook, N rows). Both the review page and the
// statements list call it as `deleteStmt.mutateAsync({ id })`.
export const useDeleteStatement = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.delete<DeleteStatementResult>(`/api/statements/${id}`),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['statement', id] });
      qc.invalidateQueries({ queryKey: ['statements'] });
    },
  });
};

export interface RecomputeReconciliationResult {
  status: string;
  deltaCents: string;
  // false when the server left the verdict alone — a sticky operator override,
  // or no balances extracted yet — and `status` is the unchanged one. Absent
  // when the reconciliation was recomputed.
  recomputed?: boolean;
}

// The toast for a recompute. A not-recomputed answer must not read as a fresh
// verdict (e.g. 'pending (Δ 0¢)' looking balanced), so it gets an info toast
// saying why nothing ran.
export const recomputeToast = (
  r: RecomputeReconciliationResult,
): { kind: 'success' | 'info'; message: string } => {
  if (r.recomputed === false) {
    return {
      kind: 'info',
      message:
        r.status === 'overridden'
          ? 'Override is sticky — not recomputed'
          : 'No balances extracted yet — nothing to recompute',
    };
  }
  return { kind: 'success', message: `Reconciliation: ${r.status} (Δ ${r.deltaCents}¢)` };
};

export const useRecomputeReconciliation = (statementId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<RecomputeReconciliationResult>(
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

export const useAcknowledgeReviewHold = (statementId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean }>(`/api/statements/${statementId}/acknowledge-review-hold`),
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
