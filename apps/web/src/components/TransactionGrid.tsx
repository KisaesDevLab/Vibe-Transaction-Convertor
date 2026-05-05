import { useEffect, useMemo, useRef, useState } from 'react';

import { decimalString, formatUsd, parseDecimalToCents } from '@vibe-tx-converter/shared';

import { type TransactionPatch, type TransactionRow } from '../hooks/useStatementsList';
import { cn } from '../lib/cn';

const TRNTYPE_OPTIONS: string[] = [
  'CREDIT',
  'DEBIT',
  'INT',
  'DIV',
  'FEE',
  'SRVCHG',
  'DEP',
  'ATM',
  'POS',
  'XFER',
  'CHECK',
  'PAYMENT',
  'CASH',
  'DIRECTDEP',
  'DIRECTDEBIT',
  'REPEATPMT',
  'HOLD',
  'OTHER',
];

export type SortField = 'postedDate' | 'amountCents' | 'description' | 'trntype';
export type SortOrder = 'asc' | 'desc';

export interface GridFilters {
  search: string;
  trntype: string | null;
  editedOnly: boolean;
}

export function TransactionGrid({
  txs,
  periodStart,
  periodEnd,
  onSave,
  onSelect,
  selectedId,
}: {
  txs: TransactionRow[];
  periodStart: string | null;
  periodEnd: string | null;
  onSave: (id: string, patch: TransactionPatch) => Promise<unknown>;
  onSelect?: (tx: TransactionRow) => void;
  selectedId?: string | null;
}) {
  const [filters, setFilters] = useState<GridFilters>({
    search: '',
    trntype: null,
    editedOnly: false,
  });
  const [sortField, setSortField] = useState<SortField>('postedDate');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeRow, setActiveRow] = useState<number>(0);
  const tableRef = useRef<HTMLTableElement>(null);

  const rows = useMemo(() => {
    let filtered = txs;
    if (filters.search.trim().length > 0) {
      const q = filters.search.trim().toLowerCase();
      filtered = filtered.filter((t) => t.description.toLowerCase().includes(q));
    }
    if (filters.trntype) {
      filtered = filtered.filter((t) => t.trntype === filters.trntype);
    }
    if (filters.editedOnly) {
      filtered = filtered.filter((t) => t.userEdited);
    }
    const dir = sortOrder === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'postedDate') cmp = a.postedDate.localeCompare(b.postedDate);
      else if (sortField === 'amountCents') {
        const av = BigInt(a.amountCents);
        const bv = BigInt(b.amountCents);
        cmp = av < bv ? -1 : av > bv ? 1 : 0;
      } else if (sortField === 'description') cmp = a.description.localeCompare(b.description);
      else if (sortField === 'trntype') cmp = a.trntype.localeCompare(b.trntype);
      if (cmp === 0) cmp = a.seqInDay - b.seqInDay;
      return cmp * dir;
    });
  }, [txs, filters, sortField, sortOrder]);

  const editedCount = txs.filter((t) => t.userEdited).length;
  const suspectCount = txs.filter((t) => (t.confidence ?? 1) < 0.7).length;
  const totalAbs = txs.reduce<bigint>(
    (acc, t) => acc + (BigInt(t.amountCents) < 0n ? -BigInt(t.amountCents) : BigInt(t.amountCents)),
    0n,
  );

  // Hot-keys: j/k to move, e to edit, Esc to cancel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'j') {
        setActiveRow((i) => Math.min(i + 1, rows.length - 1));
      } else if (e.key === 'k') {
        setActiveRow((i) => Math.max(i - 1, 0));
      } else if (e.key === 'e' && rows[activeRow]) {
        setEditingId(rows[activeRow]!.id);
      } else if (e.key === 'Escape') {
        setEditingId(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rows, activeRow]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          placeholder="Filter by description…"
          className="flex-1 min-w-[12rem] rounded-md border border-surface-muted px-3 py-1.5 text-sm"
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
        />
        <select
          className="rounded-md border border-surface-muted bg-white px-2 py-1.5 text-sm"
          value={filters.trntype ?? ''}
          onChange={(e) =>
            setFilters({ ...filters, trntype: e.target.value === '' ? null : e.target.value })
          }
        >
          <option value="">All types</option>
          {TRNTYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={filters.editedOnly}
            onChange={(e) => setFilters({ ...filters, editedOnly: e.target.checked })}
          />
          Edited only
        </label>
      </div>

      <p className="text-xs text-ink-subtle">
        {txs.length} transaction{txs.length === 1 ? '' : 's'}
        {editedCount > 0 ? ` · ${editedCount} edited` : ''}
        {suspectCount > 0 ? ` · ${suspectCount} suspect` : ''}
        {' · '}
        absolute total {formatUsd(totalAbs)}
        <span className="ml-2 text-ink-subtle">(j/k navigate · e edit · Esc cancel)</span>
      </p>

      <div className="overflow-hidden rounded-lg border border-surface-muted bg-white">
        <table ref={tableRef} className="w-full text-sm">
          <thead className="bg-surface-subtle text-left">
            <tr>
              <SortHeader
                label="Date"
                active={sortField === 'postedDate'}
                order={sortOrder}
                onClick={() => toggleSort('postedDate')}
              />
              <SortHeader
                label="Description"
                active={sortField === 'description'}
                order={sortOrder}
                onClick={() => toggleSort('description')}
              />
              <SortHeader
                label="Type"
                active={sortField === 'trntype'}
                order={sortOrder}
                onClick={() => toggleSort('trntype')}
              />
              <th className="px-3 py-2 font-medium">Check #</th>
              <SortHeader
                label="Amount"
                active={sortField === 'amountCents'}
                order={sortOrder}
                onClick={() => toggleSort('amountCents')}
                align="right"
              />
              <th className="px-3 py-2 text-right font-medium">Running</th>
              <th className="px-3 py-2 text-right font-medium">Pg</th>
              <th className="px-3 py-2 text-right font-medium">Conf</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-muted">
            {rows.map((tx, i) => (
              <Row
                key={tx.id}
                tx={tx}
                periodStart={periodStart}
                periodEnd={periodEnd}
                editing={editingId === tx.id}
                active={i === activeRow}
                selected={selectedId === tx.id}
                onActivate={() => {
                  setActiveRow(i);
                  onSelect?.(tx);
                }}
                onStartEdit={() => setEditingId(tx.id)}
                onCancelEdit={() => setEditingId(null)}
                onSave={async (patch) => {
                  await onSave(tx.id, patch);
                  setEditingId(null);
                }}
              />
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-sm text-ink-muted">
                  No matching transactions.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SortHeader({
  label,
  active,
  order,
  onClick,
  align,
}: {
  label: string;
  active: boolean;
  order: SortOrder;
  onClick: () => void;
  align?: 'right';
}) {
  return (
    <th className={cn('px-3 py-2 font-medium', align === 'right' ? 'text-right' : 'text-left')}>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1 hover:text-ink"
      >
        {label}
        <span className="text-[10px] text-ink-subtle">
          {active ? (order === 'asc' ? '▲' : '▼') : ''}
        </span>
      </button>
    </th>
  );
}

function Row({
  tx,
  periodStart,
  periodEnd,
  editing,
  active,
  selected,
  onActivate,
  onStartEdit,
  onCancelEdit,
  onSave,
}: {
  tx: TransactionRow;
  periodStart: string | null;
  periodEnd: string | null;
  editing: boolean;
  active: boolean;
  selected: boolean;
  onActivate: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (patch: TransactionPatch) => Promise<unknown>;
}) {
  const [desc, setDesc] = useState(tx.description);
  const [amount, setAmount] = useState(decimalString(BigInt(tx.amountCents)));
  const [trntype, setTrntype] = useState(tx.trntype);
  const [postedDate, setPostedDate] = useState(tx.postedDate);
  const [error, setError] = useState<string | null>(null);

  const outsidePeriod =
    periodStart && periodEnd && (tx.postedDate < periodStart || tx.postedDate > periodEnd);
  const suspect = (tx.confidence ?? 1) < 0.7;

  return (
    <tr
      onClick={onActivate}
      className={cn(
        'cursor-pointer align-top transition-colors',
        selected ? 'bg-amber-50' : active ? 'bg-surface-subtle/50' : '',
      )}
    >
      <td className="px-3 py-2 whitespace-nowrap">
        {editing ? (
          <input
            type="date"
            value={postedDate}
            onChange={(e) => setPostedDate(e.target.value)}
            className="rounded-md border border-surface-muted px-2 py-1"
          />
        ) : (
          <span className={outsidePeriod ? 'text-amber-700' : ''}>{tx.postedDate}</span>
        )}
      </td>
      <td className="px-3 py-2">
        {editing ? (
          <input
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            className="w-full rounded-md border border-surface-muted px-2 py-1"
          />
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onStartEdit();
            }}
            className="text-left hover:underline"
          >
            {tx.description}
            {tx.userEdited ? <span className="ml-1 text-xs text-ink-subtle">(edited)</span> : null}
          </button>
        )}
      </td>
      <td className="px-3 py-2">
        {editing ? (
          <select
            value={trntype}
            onChange={(e) => setTrntype(e.target.value)}
            className="rounded-md border border-surface-muted bg-white px-2 py-1 text-xs"
          >
            {TRNTYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        ) : (
          <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-xs">{tx.trntype}</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-ink-subtle">{tx.checkNumber ?? ''}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {editing ? (
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setError(null);
            }}
            className="w-28 rounded-md border border-surface-muted px-2 py-1 text-right"
          />
        ) : (
          <span className={BigInt(tx.amountCents) < 0n ? 'text-red-700' : 'text-emerald-700'}>
            {formatUsd(BigInt(tx.amountCents))}
          </span>
        )}
        {editing ? (
          <div className="mt-1 flex items-center justify-end gap-1">
            {error ? <span className="text-xs text-danger">{error}</span> : null}
            <button
              type="button"
              onClick={async () => {
                let cents: bigint;
                try {
                  cents = parseDecimalToCents(amount);
                } catch {
                  setError('decimal like -4.50');
                  return;
                }
                if (cents === 0n) {
                  setError('non-zero');
                  return;
                }
                try {
                  await onSave({
                    description: desc,
                    amount_cents: cents.toString(),
                    trntype,
                    posted_date: postedDate,
                  });
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'failed');
                }
              }}
              className="rounded-md bg-accent px-2 py-1 text-xs text-accent-fg"
            >
              Save
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setDesc(tx.description);
                setAmount(decimalString(BigInt(tx.amountCents)));
                setTrntype(tx.trntype);
                setPostedDate(tx.postedDate);
                setError(null);
                onCancelEdit();
              }}
              className="rounded-md border border-surface-muted px-2 py-1 text-xs"
            >
              Cancel
            </button>
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2 text-right text-xs tabular-nums text-ink-subtle">
        {tx.runningBalanceCents ? formatUsd(BigInt(tx.runningBalanceCents)) : ''}
      </td>
      <td className="px-3 py-2 text-right text-xs text-ink-subtle">{tx.sourcePage}</td>
      <td className="px-3 py-2 text-right">
        <span
          aria-label={`Confidence ${(tx.confidence * 100).toFixed(0)}%`}
          title={`Confidence ${(tx.confidence * 100).toFixed(0)}%`}
          className={cn(
            'inline-block h-2 w-2 rounded-full',
            suspect
              ? 'bg-amber-400'
              : (tx.confidence ?? 1) < 0.95
                ? 'bg-amber-200'
                : 'bg-emerald-400',
          )}
        />
      </td>
    </tr>
  );
}
