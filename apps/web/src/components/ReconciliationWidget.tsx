import { useState } from 'react';

import { formatUsd } from '@vibe-tx-converter/shared';

import { useOverrideReconciliation, type StatementSummary } from '../hooks/useStatementsList';
import { useToast } from './Toast';
import { ApiError } from '../lib/api';

const toCents = (s: string | null): bigint => (s ? BigInt(s) : 0n);

export function ReconciliationWidget({
  stmt,
  txCount,
  txSumCents,
  canOverride = true,
}: {
  stmt: StatementSummary;
  txCount: number;
  txSumCents: bigint;
  // Per-user 'overrideVariance' right. When false, the Override control is
  // hidden (the server also enforces it via requireFeature).
  canOverride?: boolean;
}) {
  const opening = toCents(stmt.openingBalanceCents);
  const closing = toCents(stmt.closingBalanceCents);
  const expected = opening + txSumCents;
  const delta = closing - expected;
  const inFlight = ['preprocessing', 'ocr', 'extracting', 'reconciling'].includes(stmt.status);

  const override = useOverrideReconciliation(stmt.id);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');

  return (
    <aside className="sticky top-4 rounded-lg border border-surface-muted bg-white p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
        Reconciliation
      </h2>
      <dl className="mt-3 space-y-1 text-sm tabular-nums">
        <Row label="Opening" value={formatUsd(opening)} />
        <Row label={`Sum of ${txCount} txns`} value={formatUsd(txSumCents)} />
        <div className="my-1 h-px bg-surface-muted" />
        <Row label="Expected closing" value={formatUsd(expected)} />
        <Row label="Actual closing" value={formatUsd(closing)} />
        <Row label="Delta" value={formatUsd(delta)} highlight={delta === 0n ? 'good' : 'bad'} />
      </dl>

      {stmt.periodBoundsViolations && stmt.periodBoundsViolations > 0 ? (
        <p className="mt-3 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
          {stmt.periodBoundsViolations} transaction
          {stmt.periodBoundsViolations === 1 ? '' : 's'} fall outside the period range.
        </p>
      ) : null}

      <p className="mt-3 text-xs">
        Status:{' '}
        <strong className="font-medium">
          {inFlight ? 'computing…' : stmt.reconciliationStatus}
        </strong>
      </p>

      {stmt.reconciliationStatus === 'discrepancy' && canOverride ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 w-full rounded-md border border-danger px-3 py-1.5 text-sm text-danger hover:bg-danger/5"
        >
          Override
        </button>
      ) : null}

      {open ? (
        <div
          role="dialog"
          aria-modal
          className="fixed inset-0 z-30 grid place-items-center bg-ink/40 px-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <form
            className="w-full max-w-md space-y-3 rounded-xl bg-white p-6"
            onSubmit={async (e) => {
              e.preventDefault();
              if (confirm !== 'EXPORT ANYWAY') {
                toast.error('Type EXPORT ANYWAY exactly to confirm.');
                return;
              }
              try {
                await override.mutateAsync(reason);
                toast.success('Reconciliation overridden.');
                setOpen(false);
                setReason('');
                setConfirm('');
              } catch (err) {
                toast.error(err instanceof ApiError ? err.message : 'override failed');
              }
            }}
          >
            <h2 className="text-lg font-semibold">Override reconciliation</h2>
            <p className="text-sm text-ink-muted">
              The audit log captures this override with your name, the timestamp, and your reason.
              Type <code className="rounded bg-surface-subtle px-1">EXPORT ANYWAY</code> into the
              second field to confirm.
            </p>
            <textarea
              rows={3}
              required
              minLength={30}
              className="w-full rounded-md border border-surface-muted px-3 py-2 text-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (≥ 30 characters): describe what you reconciled and why — e.g. 'PDF skipped a mid-period adjustment for the wire from CompanyX, documented in 2026-04 internal memo.'"
            />
            <p className="text-xs text-ink-subtle">{reason.trim().length} / 30 characters</p>
            <input
              type="text"
              required
              className="w-full rounded-md border border-surface-muted px-3 py-2 text-sm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Type EXPORT ANYWAY"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md border border-surface-muted px-3 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  reason.trim().length < 30 || confirm !== 'EXPORT ANYWAY' || override.isPending
                }
                className="rounded-md bg-danger px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Override
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </aside>
  );
}

function Row({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: 'good' | 'bad';
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd
        className={
          highlight === 'good'
            ? 'font-semibold text-emerald-700'
            : highlight === 'bad'
              ? 'font-semibold text-danger'
              : 'font-medium'
        }
      >
        {value}
      </dd>
    </div>
  );
}
