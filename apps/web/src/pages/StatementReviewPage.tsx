import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { formatUsd } from '@vibe-tx-converter/shared';

import {
  useOverrideReconciliation,
  useStatement,
  useUpdateTransaction,
  type TransactionPatch,
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
    const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
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
  const override = useOverrideReconciliation(statementId);
  const [error, setError] = useState<string | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  if (stmt.isPending) return <p className="text-sm text-ink-muted">Loading…</p>;
  if (!stmt.data) return <p>Statement not found</p>;

  const s = stmt.data.statement;
  const txs = stmt.data.transactions;
  const isDiscrepancy = s.reconciliationStatus === 'discrepancy';

  const onExport = async (format: string): Promise<void> => {
    setError(null);
    try {
      await downloadExport(statementId, format, isDiscrepancy);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'export failed');
    }
  };

  return (
    <section className="mx-auto max-w-6xl">
      <Link
        to={`/accounts/${s.accountId}/statements`}
        className="text-sm text-ink-muted hover:text-ink"
      >
        ← Statements
      </Link>
      <header className="mt-2 mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            {s.periodStart && s.periodEnd
              ? `${s.periodStart} → ${s.periodEnd}`
              : `Statement ${s.id.slice(0, 8)}`}
          </h1>
          <p className="text-sm text-ink-muted">
            {txs.length} transactions · status {s.status} ·{' '}
            <ReconBadge status={s.reconciliationStatus} />
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {FORMATS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => void onExport(f.value)}
              className="rounded-md border border-surface-muted px-3 py-1.5 text-sm hover:bg-surface-subtle"
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>

      {isDiscrepancy ? (
        <div className="mb-4 flex items-center justify-between rounded-md border border-danger/40 bg-danger/5 p-3 text-sm">
          <span>
            Golden Rule discrepancy — exports are blocked unless you click through an override.
          </span>
          <button
            type="button"
            onClick={() => setOverrideOpen(true)}
            className="rounded-md border border-danger px-3 py-1 text-danger"
          >
            Override
          </button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-surface-muted bg-white">
        <table className="w-full text-sm">
          <thead className="bg-surface-subtle text-left">
            <tr>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-muted">
            {txs.map((t) => (
              <Row key={t.id} tx={t} onSave={(patch) => update.mutateAsync({ id: t.id, patch })} />
            ))}
          </tbody>
        </table>
      </div>

      {overrideOpen ? (
        <div
          role="dialog"
          aria-modal
          className="fixed inset-0 z-20 grid place-items-center bg-ink/40 px-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOverrideOpen(false);
          }}
        >
          <form
            className="w-full max-w-md space-y-3 rounded-xl bg-white p-6"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await override.mutateAsync(overrideReason);
                setOverrideOpen(false);
                setOverrideReason('');
              } catch (err) {
                setError(err instanceof ApiError ? err.message : 'override failed');
              }
            }}
          >
            <h2 className="text-lg font-semibold">Override reconciliation</h2>
            <p className="text-sm text-ink-muted">
              The audit log captures this override with your name, the timestamp, and your reason.
              Type at least 5 characters of justification.
            </p>
            <textarea
              rows={3}
              required
              minLength={5}
              className="w-full rounded-md border border-surface-muted px-3 py-2"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="e.g. PDF skipped a mid-period adjustment that's documented in our records"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOverrideOpen(false)}
                className="rounded-md border border-surface-muted px-3 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={overrideReason.trim().length < 5 || override.isPending}
                className="rounded-md bg-danger px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Override
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}

function ReconBadge({ status }: { status: string }) {
  const color =
    status === 'verified'
      ? 'text-emerald-700 bg-emerald-50'
      : status === 'overridden'
        ? 'text-amber-700 bg-amber-50'
        : status === 'discrepancy'
          ? 'text-danger bg-danger/5'
          : 'text-ink-muted bg-surface-subtle';
  return <span className={`rounded px-1.5 py-0.5 ${color}`}>{status}</span>;
}

function Row({
  tx,
  onSave,
}: {
  tx: TransactionRow;
  onSave: (patch: TransactionPatch) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [desc, setDesc] = useState(tx.description);
  const [amount, setAmount] = useState(tx.amountCents);
  return (
    <tr>
      <td className="px-3 py-2 align-top">{tx.postedDate}</td>
      <td className="px-3 py-2 align-top">
        {editing ? (
          <input
            className="w-full rounded-md border border-surface-muted px-2 py-1"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-left hover:underline"
          >
            {tx.description}
            {tx.userEdited ? <span className="ml-1 text-xs text-ink-subtle">(edited)</span> : null}
          </button>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-xs">{tx.trntype}</span>
      </td>
      <td className="px-3 py-2 text-right align-top tabular-nums">
        {editing ? (
          <input
            className="w-28 rounded-md border border-surface-muted px-2 py-1 text-right"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        ) : (
          formatUsd(BigInt(tx.amountCents))
        )}
        {editing ? (
          <span className="ml-2 inline-flex gap-1">
            <button
              type="button"
              onClick={async () => {
                await onSave({ description: desc, amount_cents: amount });
                setEditing(false);
              }}
              className="rounded-md bg-accent px-2 py-1 text-xs text-accent-fg"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setDesc(tx.description);
                setAmount(tx.amountCents);
                setEditing(false);
              }}
              className="rounded-md border border-surface-muted px-2 py-1 text-xs"
            >
              Cancel
            </button>
          </span>
        ) : null}
      </td>
    </tr>
  );
}
