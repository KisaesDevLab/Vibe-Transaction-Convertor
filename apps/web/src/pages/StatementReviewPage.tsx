import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ReconciliationBadge, StatusBadge } from '../components/StatusBadge';
import { ReconciliationWidget } from '../components/ReconciliationWidget';
import { TransactionGrid } from '../components/TransactionGrid';
import { PdfViewer } from '../components/PdfViewer';
import { useToast } from '../components/Toast';
import {
  useStatement,
  useUpdateTransaction,
  type TransactionRow,
} from '../hooks/useStatementsList';
import { ApiError } from '../lib/api';

const FORMATS: Array<{ value: string; label: string }> = [
  { value: 'csv-qbo3', label: 'CSV (QBO 3-col)' },
  { value: 'csv-qbo4', label: 'CSV (QBO 4-col)' },
  { value: 'csv-xero', label: 'CSV (Xero)' },
  { value: 'csv-generic', label: 'CSV (Generic)' },
  { value: 'ofx', label: 'OFX 2.x' },
  { value: 'qbo', label: 'QBO Web Connect' },
  { value: 'qfx', label: 'QFX' },
];

const downloadExport = async (
  statementId: string,
  format: string,
  override: boolean,
): Promise<void> => {
  const url = `/api/statements/${statementId}/exports/${format}${override ? '?override=true' : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'x-csrf-token':
        document.cookie
          .split('; ')
          .find((c) => c.startsWith('vibetc_csrf='))
          ?.split('=')[1] ?? '',
    },
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
  const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'export';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
};

export function StatementReviewPage() {
  const { statementId = '' } = useParams();
  const stmt = useStatement(statementId);
  const update = useUpdateTransaction(statementId);
  const toast = useToast();
  const [selectedTx, setSelectedTx] = useState<TransactionRow | null>(null);

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
      <Link
        to={`/accounts/${s.accountId}/statements`}
        className="text-sm text-ink-muted hover:text-ink"
      >
        ← Statements
      </Link>

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
        <div className="flex flex-wrap gap-2">
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

      {s.status === 'awaiting-locale-confirmation' ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <h2 className="text-base font-semibold">Date format ambiguous</h2>
          <p className="mt-1">
            We extracted dates from this PDF but couldn't tell whether the day or the month comes
            first. Pick the right one before exports unblock.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="rounded-md bg-amber-700 px-3 py-1.5 text-sm font-medium text-white"
            >
              Use MDY (US — month/day/year)
            </button>
            <button
              type="button"
              className="rounded-md border border-amber-700 px-3 py-1.5 text-sm font-medium text-amber-900"
            >
              Use DMY (European — day/month/year)
            </button>
          </div>
          <p className="mt-2 text-xs italic">
            Confirmation endpoint lands when the LLM extractor reports an ambiguous source.
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-4">
          <TransactionGrid
            txs={txs}
            periodStart={s.periodStart}
            periodEnd={s.periodEnd}
            selectedId={selectedTx?.id ?? null}
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
          />

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
          />
        </div>
        <ReconciliationWidget stmt={s} txCount={txs.length} txSumCents={txSumCents} />
      </div>
    </section>
  );
}
