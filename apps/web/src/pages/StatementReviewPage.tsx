import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { LocaleConfirmBanner } from '../components/LocaleConfirmBanner';
import { ReconciliationBadge, StatusBadge } from '../components/StatusBadge';
import { ReconciliationWidget } from '../components/ReconciliationWidget';
import { TransactionGrid } from '../components/TransactionGrid';
import { PdfViewer } from '../components/PdfViewer';
import { useToast } from '../components/Toast';
import {
  useAcknowledgeMultiAccount,
  useAddTransaction,
  useConfirmDateFormat,
  useDeleteTransaction,
  useReExtract,
  useSplitStatement,
  useStatement,
  useUpdateTransaction,
  type TransactionRow,
} from '../hooks/useStatementsList';
import { useAccount } from '../hooks/useStatements';
import { useAccounts } from '../hooks/useAccounts';
import { useMe } from '../hooks/useAuth';
import { ApiError } from '../lib/api';
import { SplitStatementModal } from '../components/SplitStatementModal';

const FORMATS: Array<{ value: string; label: string }> = [
  { value: 'csv-qbo3', label: 'CSV (QBO 3-col)' },
  { value: 'csv-qbo4', label: 'CSV (QBO 4-col)' },
  { value: 'csv-xero', label: 'CSV (Xero)' },
  { value: 'csv-generic', label: 'CSV (Generic)' },
  { value: 'ofx', label: 'OFX 2.x' },
  { value: 'qbo', label: 'QBO Web Connect' },
  { value: 'qfx', label: 'QFX' },
];

const csrfHeader = (): Record<string, string> => ({
  'x-csrf-token':
    document.cookie
      .split('; ')
      .find((c) => c.startsWith('vibetc_csrf='))
      ?.split('=')[1] ?? '',
});

const downloadFromUrl = async (url: string, fallbackName: string): Promise<void> => {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: csrfHeader(),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ message: `HTTP ${res.status}` }))) as {
      message?: string;
      code?: string;
      details?: unknown;
    };
    throw new ApiError(res.status, body);
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
};

const downloadExport = (statementId: string, format: string, override: boolean): Promise<void> =>
  downloadFromUrl(
    `/api/statements/${statementId}/exports/${format}${override ? '?override=true' : ''}`,
    'export',
  );

const downloadBundle = (statementId: string, override: boolean): Promise<void> =>
  downloadFromUrl(
    `/api/statements/${statementId}/exports-bundle${override ? '?override=true' : ''}`,
    'export-bundle.zip',
  );

export function StatementReviewPage() {
  const { statementId = '' } = useParams();
  const stmt = useStatement(statementId);
  const update = useUpdateTransaction(statementId);
  const addTx = useAddTransaction(statementId);
  const deleteTx = useDeleteTransaction(statementId);
  const reExtract = useReExtract(statementId);
  const confirmFormat = useConfirmDateFormat(statementId);
  const ackMultiAccount = useAcknowledgeMultiAccount(statementId);
  const splitStmt = useSplitStatement(statementId);
  const me = useMe();
  const isAdmin = me.data?.role === 'admin';
  const toast = useToast();
  const [selectedTx, setSelectedTx] = useState<TransactionRow | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  // Pull the parent account → company so the split modal can show only
  // accounts under the same company in the per-segment dropdowns.
  const parentAccount = useAccount(stmt.data?.statement.accountId ?? '');
  const accountsInCompany = useAccounts(parentAccount.data?.companyId ?? '');

  const txSumCents = useMemo<bigint>(() => {
    if (!stmt.data) return 0n;
    return stmt.data.transactions.reduce<bigint>((acc, t) => acc + BigInt(t.amountCents), 0n);
  }, [stmt.data]);

  if (stmt.isPending) {
    return (
      <div className="space-y-3">
        <div className="h-8 w-1/3 animate-pulse rounded bg-surface-muted" />
        <div className="h-32 animate-pulse rounded bg-surface-muted" />
      </div>
    );
  }
  if (!stmt.data) return <p>Statement not found</p>;

  const s = stmt.data.statement;
  const txs = stmt.data.transactions;
  const exportable =
    s.reconciliationStatus === 'verified' || s.reconciliationStatus === 'overridden';
  const exportBlocked = !exportable || s.status === 'awaiting-locale-confirmation';

  const onExport = async (format: string): Promise<void> => {
    try {
      await downloadExport(statementId, format, s.reconciliationStatus === 'overridden');
      toast.success(`Downloaded ${format}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'export failed');
    }
  };

  return (
    <section className="mx-auto max-w-7xl space-y-4">
      <div className="flex items-center justify-between gap-3 text-sm">
        <Link to={`/accounts/${s.accountId}/statements`} className="text-ink-muted hover:text-ink">
          ← Statements
        </Link>
        {isAdmin ? (
          <Link
            to={`/admin/audit?entityType=statement&entityId=${s.id}`}
            className="text-ink-muted hover:text-ink"
          >
            View audit history →
          </Link>
        ) : null}
      </div>

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">
            {s.periodStart && s.periodEnd
              ? `${s.periodStart} → ${s.periodEnd}`
              : `Statement ${s.id.slice(0, 8)}`}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-subtle">
            <StatusBadge status={s.status} />
            <ReconciliationBadge
              status={s.reconciliationStatus}
              periodBoundsViolations={s.periodBoundsViolations}
            />
            {s.sourceDateFormat ? (
              <span className="rounded bg-surface-subtle px-1.5 py-0.5">
                Dates: {s.sourceDateFormat}
                {s.sourceDateFormatConfidence !== null
                  ? ` · conf ${(s.sourceDateFormatConfidence * 100).toFixed(0)}%`
                  : ''}
                {s.sourceDateFormatUserConfirmed ? ' ✓' : ''}
              </span>
            ) : null}
            {s.llmProvider ? (
              <span className="rounded bg-surface-subtle px-1.5 py-0.5">
                LLM: {s.llmProvider} {s.llmModelVersion ?? ''}
              </span>
            ) : null}
            {s.extractionMethod ? (
              <span className="rounded bg-surface-subtle px-1.5 py-0.5">
                Method: {s.extractionMethod}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin ? (
            <button
              type="button"
              onClick={async () => {
                if (
                  !window.confirm(
                    'Re-extract this statement? Existing transactions will be discarded and the LLM will run again.',
                  )
                )
                  return;
                try {
                  await reExtract.mutateAsync();
                  toast.success('Re-extraction enqueued');
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.message : 're-extract failed');
                }
              }}
              disabled={reExtract.isPending}
              className="rounded-md border border-surface-muted px-3 py-1.5 text-sm hover:bg-surface-subtle disabled:opacity-50"
            >
              {reExtract.isPending ? 'Enqueueing…' : 'Re-extract'}
            </button>
          ) : null}
          <Link
            to={`/statements/${statementId}/export`}
            className="rounded-md border border-surface-muted px-3 py-1.5 text-sm hover:bg-surface-subtle"
          >
            Export…
          </Link>
          <button
            type="button"
            disabled={exportBlocked}
            title={
              exportBlocked
                ? 'Reconciliation is not verified — fix discrepancies or override before export'
                : 'Download all 7 formats as a single zip'
            }
            onClick={async () => {
              try {
                await downloadBundle(statementId, s.reconciliationStatus === 'overridden');
                toast.success('Downloaded all formats');
              } catch (err) {
                toast.error(err instanceof ApiError ? err.message : 'export failed');
              }
            }}
            className="rounded-md border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Download all (.zip)
          </button>
          {FORMATS.map((f) => (
            <button
              key={f.value}
              type="button"
              disabled={exportBlocked}
              title={
                exportBlocked
                  ? 'Reconciliation is not verified — fix discrepancies or override before export'
                  : ''
              }
              onClick={() => void onExport(f.value)}
              className="rounded-md border border-surface-muted px-3 py-1.5 text-sm hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-50"
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>

      {s.errorMessage ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <strong>Extraction failed.</strong> {s.errorMessage}
        </div>
      ) : null}

      {s.detectedSplits?.multiAccount && !s.multiAccountAcknowledged ? (
        <div className="rounded-md border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
          <h2 className="text-base font-semibold">Multiple accounts detected in this PDF</h2>
          <p className="mt-1">
            We saw {s.detectedSplits.uniqueLast4.length} different account numbers across the pages
            of this PDF (ending in {s.detectedSplits.uniqueLast4.join(', ')}). The extraction
            proceeded as one statement; this often produces unbalanced results. Consider
            re-uploading each account separately.
          </p>
          <ul className="mt-2 list-disc pl-5 text-xs text-blue-800">
            {s.detectedSplits.splits.map((sp, i) => (
              <li key={i}>
                <code className="rounded bg-white px-1">••••{sp.last4}</code> — pages{' '}
                {sp.pageStart + 1} to {sp.pageEnd + 1}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={async () => {
                try {
                  await ackMultiAccount.mutateAsync();
                  toast.success('Multi-account warning dismissed');
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.message : 'failed');
                }
              }}
              disabled={ackMultiAccount.isPending}
              className="rounded-md border border-blue-700 px-3 py-1.5 text-xs font-medium text-blue-900 disabled:opacity-50"
            >
              Acknowledge — proceed as single statement
            </button>
            <button
              type="button"
              onClick={() => setSplitOpen(true)}
              className="rounded-md bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-800"
            >
              Split into per-account statements
            </button>
          </div>
        </div>
      ) : null}

      {splitOpen && stmt.data && s.detectedSplits ? (
        <SplitStatementModal
          detectedSplits={s.detectedSplits}
          accounts={accountsInCompany.data ?? []}
          parentAccountId={s.accountId}
          isPending={splitStmt.isPending}
          onClose={() => setSplitOpen(false)}
          onSubmit={async (input) => {
            try {
              const result = await splitStmt.mutateAsync(input);
              toast.success(
                `Split into ${result.children.length} statement${result.children.length === 1 ? '' : 's'} — re-extraction enqueued.`,
              );
              setSplitOpen(false);
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'split failed');
            }
          }}
        />
      ) : null}

      {s.status === 'awaiting-locale-confirmation' ? (
        <LocaleConfirmBanner
          onConfirm={async (fmt) => {
            try {
              await confirmFormat.mutateAsync(fmt);
              toast.success(`Re-extracting with ${fmt}`);
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'failed');
            }
          }}
          isPending={confirmFormat.isPending}
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-4">
          <TransactionGrid
            txs={txs}
            periodStart={s.periodStart}
            periodEnd={s.periodEnd}
            selectedId={selectedTx?.id ?? null}
            isAdmin={isAdmin}
            onSelect={(t) => setSelectedTx(t)}
            onSave={async (id, patch) => {
              try {
                await update.mutateAsync({ id, patch });
                toast.success('Transaction updated');
              } catch (err) {
                toast.error(err instanceof ApiError ? err.message : 'update failed');
                throw err;
              }
            }}
            onAdd={
              isAdmin
                ? async (input) => {
                    try {
                      await addTx.mutateAsync(input);
                      toast.success('Transaction added');
                    } catch (err) {
                      toast.error(err instanceof ApiError ? err.message : 'add failed');
                      throw err;
                    }
                  }
                : undefined
            }
            onDelete={
              isAdmin
                ? async (id) => {
                    try {
                      await deleteTx.mutateAsync(id);
                      toast.success('Transaction deleted');
                    } catch (err) {
                      toast.error(err instanceof ApiError ? err.message : 'delete failed');
                      throw err;
                    }
                  }
                : undefined
            }
          />

          {/* Hide PDF viewer below 1024px — the side-by-side review layout
              isn't usable on small screens, and rendering pdf.js there is
              expensive for no benefit. Phase 19 item 14. */}
          <div className="hidden lg:block">
            <PdfViewer
              pdfHash={s.sourcePdfHash}
              highlight={
                selectedTx?.sourceBboxJson
                  ? {
                      page: selectedTx.sourcePage,
                      bbox: selectedTx.sourceBboxJson,
                    }
                  : null
              }
              onPdfClick={(loc) => {
                // Phase 19 #7: PDF→txn click selection. Find the row whose
                // source_page matches and whose bbox contains the click;
                // when no exact hit, fall back to the closest center on
                // the same page (Euclidean distance in PDF user-space).
                const onPage = txs.filter((t) => t.sourcePage === loc.page);
                if (onPage.length === 0) return;
                const inBbox = onPage.find(
                  (t) =>
                    t.sourceBboxJson &&
                    loc.x >= t.sourceBboxJson[0] &&
                    loc.x <= t.sourceBboxJson[2] &&
                    loc.y >= t.sourceBboxJson[1] &&
                    loc.y <= t.sourceBboxJson[3],
                );
                if (inBbox) {
                  setSelectedTx(inBbox);
                  return;
                }
                let best: TransactionRow | null = null;
                let bestDist = Infinity;
                for (const t of onPage) {
                  if (!t.sourceBboxJson) continue;
                  const cx = (t.sourceBboxJson[0] + t.sourceBboxJson[2]) / 2;
                  const cy = (t.sourceBboxJson[1] + t.sourceBboxJson[3]) / 2;
                  const dx = cx - loc.x;
                  const dy = cy - loc.y;
                  const d = dx * dx + dy * dy;
                  if (d < bestDist) {
                    bestDist = d;
                    best = t;
                  }
                }
                if (best) setSelectedTx(best);
              }}
            />
          </div>
        </div>
        <ReconciliationWidget stmt={s} txCount={txs.length} txSumCents={txSumCents} />
      </div>
    </section>
  );
}
