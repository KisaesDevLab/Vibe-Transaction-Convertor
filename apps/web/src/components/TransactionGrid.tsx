import { useEffect, useMemo, useRef, useState } from 'react';

import { decimalString, formatUsd, parseDecimalToCents } from '@vibe-tx-converter/shared';

import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { type TransactionPatch, type TransactionRow } from '../hooks/useStatementsList';
import { type BusinessCategory } from '../hooks/useCategories';
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
  // Phase 18 #17 — suspect-only toggle. Mirrors the suspect badge in
  // the row (confidence < 0.7).
  suspectOnly: boolean;
  // Inclusive amount-range filter expressed in dollars (decimal string
  // is what the user types). Empty string = unbounded on that side.
  // Sign matters: -50 to 0 returns only debits between $0 and $50.
  amountMin: string;
  amountMax: string;
}

export interface AddTxInput {
  posted_date: string;
  description: string;
  amount_cents: string;
  trntype?: string;
}

export function TransactionGrid({
  txs,
  periodStart,
  periodEnd,
  onSave,
  onBulkSave,
  onDelete,
  onAdd,
  onRecompute,
  isAdmin,
  onSelect,
  selectedId,
  categories,
}: {
  txs: TransactionRow[];
  periodStart: string | null;
  periodEnd: string | null;
  onSave: (id: string, patch: TransactionPatch) => Promise<unknown>;
  // Optional bulk-save path. When provided, the grid issues a single
  // PATCH for all selected rows. Falls back to per-row onSave loop
  // when omitted.
  onBulkSave?:
    | ((edits: Array<{ id: string; patch: TransactionPatch }>) => Promise<unknown>)
    | undefined;
  onDelete?: ((id: string) => Promise<unknown>) | undefined;
  onAdd?: ((input: AddTxInput) => Promise<unknown>) | undefined;
  // Hot-key `r` triggers this when set; renders a Recompute toolbar
  // button when provided.
  onRecompute?: (() => Promise<unknown>) | undefined;
  isAdmin?: boolean | undefined;
  onSelect?: ((tx: TransactionRow) => void) | undefined;
  selectedId?: string | null | undefined;
  // Phase 33 — non-archived business categories for the row dropdown.
  // Empty / undefined hides the column; the parent fetches via
  // useCategories() and passes through.
  categories?: BusinessCategory[] | undefined;
}) {
  const [filters, setFilters] = useState<GridFilters>({
    search: '',
    trntype: null,
    editedOnly: false,
    suspectOnly: false,
    amountMin: '',
    amountMax: '',
  });
  const [sortField, setSortField] = useState<SortField>('postedDate');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeRow, setActiveRow] = useState<number>(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTrntype, setBulkTrntype] = useState<string>('');
  const [pendingDelete, setPendingDelete] = useState<
    { kind: 'one'; tx: TransactionRow } | { kind: 'bulk'; ids: string[] } | null
  >(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // Phase 18 #16: when on, the row's edit fields commit on blur instead
  // of needing the explicit Save button. Persisted in localStorage so
  // the operator's preference survives reloads.
  const [autoSave, setAutoSave] = useState<boolean>(() => {
    return localStorage.getItem('vibetc:txgrid:autosave') === '1';
  });
  useEffect(() => {
    localStorage.setItem('vibetc:txgrid:autosave', autoSave ? '1' : '0');
  }, [autoSave]);
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
    if (filters.suspectOnly) {
      filtered = filtered.filter((t) => (t.confidence ?? 1) < 0.7);
    }
    // Amount-range filter. We parse the decimal-cent strings only when
    // the operator has typed something — empty input is unbounded on
    // that side. Bad input falls through silently rather than wiping
    // results out from under the user.
    const minCents = (() => {
      if (filters.amountMin.trim().length === 0) return null;
      try {
        return parseDecimalToCents(filters.amountMin);
      } catch {
        return null;
      }
    })();
    const maxCents = (() => {
      if (filters.amountMax.trim().length === 0) return null;
      try {
        return parseDecimalToCents(filters.amountMax);
      } catch {
        return null;
      }
    })();
    if (minCents !== null) {
      filtered = filtered.filter((t) => BigInt(t.amountCents) >= minCents);
    }
    if (maxCents !== null) {
      filtered = filtered.filter((t) => BigInt(t.amountCents) <= maxCents);
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

  // Hot-keys (Phase 18 item 23): j/k move row, e edit, Esc cancel,
  // x toggle row select, s submits the editing row's form, r runs
  // recompute-reconciliation against the live transactions.
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
      } else if (e.key === 'x' && rows[activeRow]) {
        toggleSelectOne(rows[activeRow]!.id);
      } else if (e.key === 's' && editingId) {
        // Click the editing row's Save button via DOM. Each row carries
        // a data-tx-save-button="<id>" attribute when in edit mode.
        const btn = document.querySelector<HTMLButtonElement>(
          `[data-tx-save-button="${editingId}"]`,
        );
        btn?.click();
      } else if (e.key === 'r' && onRecompute) {
        e.preventDefault();
        void onRecompute();
      } else if (e.key === 'Escape') {
        setEditingId(null);
        setSelectedIds(new Set());
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rows, activeRow, editingId, onRecompute]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const allFilteredSelected = rows.length > 0 && rows.every((r) => selectedIds.has(r.id));
  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(rows.map((r) => r.id)));
    }
  };
  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      {isAdmin && selectedIds.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-sm">
          <span className="font-medium">{selectedIds.size} selected</span>
          <select
            value={bulkTrntype}
            onChange={(e) => setBulkTrntype(e.target.value)}
            className="rounded-md border border-surface-muted bg-white px-2 py-1 text-xs"
          >
            <option value="">Set TRNTYPE…</option>
            {TRNTYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!bulkTrntype}
            onClick={async () => {
              const ids = Array.from(selectedIds);
              if (onBulkSave) {
                await onBulkSave(ids.map((id) => ({ id, patch: { trntype: bulkTrntype } })));
              } else {
                // Fallback for callers that haven't wired onBulkSave yet —
                // loop through per-row PATCHes.
                for (const id of ids) {
                  await onSave(id, { trntype: bulkTrntype });
                }
              }
              setBulkTrntype('');
              setSelectedIds(new Set());
            }}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-accent-fg disabled:opacity-50"
          >
            Apply
          </button>
          {onDelete ? (
            <button
              type="button"
              onClick={() => {
                const ids = Array.from(selectedIds);
                if (ids.length === 0) return;
                setPendingDelete({ kind: 'bulk', ids });
              }}
              className="rounded-md border border-danger px-3 py-1 text-xs font-medium text-danger"
            >
              Delete selected
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto rounded-md border border-surface-muted px-3 py-1 text-xs"
          >
            Clear
          </button>
        </div>
      ) : null}

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
        <label
          className="flex items-center gap-1.5 text-sm"
          title="Show only rows the LLM marked low-confidence (< 0.7)"
        >
          <input
            type="checkbox"
            checked={filters.suspectOnly}
            onChange={(e) => setFilters({ ...filters, suspectOnly: e.target.checked })}
          />
          Suspect only
        </label>
        <div className="flex items-center gap-1 text-xs text-ink-muted">
          <span>Amount</span>
          <input
            inputMode="decimal"
            placeholder="min"
            aria-label="Minimum amount in dollars"
            value={filters.amountMin}
            onChange={(e) => setFilters({ ...filters, amountMin: e.target.value })}
            className="w-20 rounded-md border border-surface-muted px-2 py-1 text-right"
          />
          <span>–</span>
          <input
            inputMode="decimal"
            placeholder="max"
            aria-label="Maximum amount in dollars"
            value={filters.amountMax}
            onChange={(e) => setFilters({ ...filters, amountMax: e.target.value })}
            className="w-20 rounded-md border border-surface-muted px-2 py-1 text-right"
          />
        </div>
        {onRecompute ? (
          <button
            type="button"
            onClick={() => void onRecompute()}
            title="Recompute reconciliation against the current transaction list (hot-key: r)"
            className="rounded-md border border-surface-muted px-3 py-1.5 text-xs hover:bg-surface-subtle"
          >
            Recompute
          </button>
        ) : null}
        <label
          className="flex items-center gap-1.5 text-xs text-ink-muted"
          title="When on, edits commit on field blur instead of needing the Save button"
        >
          <input
            type="checkbox"
            checked={autoSave}
            onChange={(e) => setAutoSave(e.target.checked)}
          />
          Auto-save
        </label>
      </div>

      <p className="text-xs text-ink-subtle">
        {txs.length} transaction{txs.length === 1 ? '' : 's'}
        {editedCount > 0 ? ` · ${editedCount} edited` : ''}
        {suspectCount > 0 ? ` · ${suspectCount} suspect` : ''}
        {' · '}
        absolute total {formatUsd(totalAbs)}
        <span className="ml-2 text-ink-subtle">
          (j/k row · e edit · x select · s save · r recompute · Esc cancel)
        </span>
      </p>

      <div className="overflow-hidden rounded-lg border border-surface-muted bg-white">
        <table ref={tableRef} className="w-full text-sm">
          <thead className="bg-surface-subtle text-left">
            <tr>
              {isAdmin ? (
                <th className="w-8 px-2 py-2">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleSelectAll}
                    aria-label="Select all visible rows"
                  />
                </th>
              ) : null}
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
              {categories ? (
                <>
                  <th className="px-3 py-2 font-medium">Cleansed</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                </>
              ) : null}
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
              {isAdmin ? <th className="px-3 py-2 w-8"></th> : null}
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
                checked={selectedIds.has(tx.id)}
                onToggleCheck={() => toggleSelectOne(tx.id)}
                isAdmin={isAdmin}
                autoSave={autoSave}
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
                onDelete={onDelete ? () => setPendingDelete({ kind: 'one', tx }) : undefined}
                categories={categories}
              />
            ))}
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={(isAdmin ? 10 : 8) + (categories ? 2 : 0)}
                  className="px-3 py-8 text-center text-sm text-ink-muted"
                >
                  No matching transactions.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {isAdmin && onAdd ? <AddRowForm onAdd={onAdd} defaultDate={periodStart ?? ''} /> : null}

      <DeleteConfirmDialog
        open={pendingDelete !== null}
        title={
          pendingDelete?.kind === 'bulk'
            ? `Delete ${pendingDelete.ids.length} transaction${pendingDelete.ids.length === 1 ? '' : 's'}?`
            : 'Delete transaction?'
        }
        description={
          pendingDelete?.kind === 'bulk'
            ? 'These rows will be removed from the statement. Reconciliation status will be recomputed automatically; if the delete makes the totals balance, the statement flips back to verified.'
            : 'This row will be removed from the statement. Reconciliation status is recomputed automatically.'
        }
        preview={
          pendingDelete?.kind === 'one' ? (
            <div className="space-y-1 font-mono">
              <div>{pendingDelete.tx.postedDate}</div>
              <div className="truncate">{pendingDelete.tx.description}</div>
              <div className="tabular-nums">{formatUsd(BigInt(pendingDelete.tx.amountCents))}</div>
            </div>
          ) : pendingDelete?.kind === 'bulk' ? (
            <div className="text-xs text-ink-muted">{pendingDelete.ids.length} rows selected</div>
          ) : null
        }
        confirmText={
          pendingDelete?.kind === 'bulk' ? `DELETE ${pendingDelete.ids.length}` : 'DELETE'
        }
        busy={deleteBusy}
        onClose={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete || !onDelete) return;
          setDeleteBusy(true);
          try {
            if (pendingDelete.kind === 'one') {
              await onDelete(pendingDelete.tx.id);
            } else {
              for (const id of pendingDelete.ids) await onDelete(id);
              setSelectedIds(new Set());
            }
            setPendingDelete(null);
          } finally {
            setDeleteBusy(false);
          }
        }}
      />
    </div>
  );
}

function AddRowForm({
  onAdd,
  defaultDate,
}: {
  onAdd: (input: AddTxInput) => Promise<unknown>;
  defaultDate: string;
}) {
  const [open, setOpen] = useState(false);
  const [postedDate, setPostedDate] = useState(defaultDate);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [trntype, setTrntype] = useState('OTHER');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-dashed border-surface-muted px-3 py-2 text-sm text-ink-muted hover:bg-surface-subtle"
      >
        + Add transaction (admin)
      </button>
    );
  }

  const submit = async (): Promise<void> => {
    setError(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(postedDate)) {
      setError('Date must be YYYY-MM-DD');
      return;
    }
    if (description.trim().length === 0) {
      setError('Description is required');
      return;
    }
    let cents: bigint;
    try {
      cents = parseDecimalToCents(amount);
    } catch {
      setError('Amount must be like -4.50 or 12.34');
      return;
    }
    if (cents === 0n) {
      setError('Amount must be non-zero');
      return;
    }
    setSaving(true);
    try {
      await onAdd({
        posted_date: postedDate,
        description: description.trim(),
        amount_cents: cents.toString(),
        trntype,
      });
      setDescription('');
      setAmount('');
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-surface-muted bg-white p-3 text-sm">
      <p className="font-medium">Add transaction</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[10rem_1fr_8rem_8rem]">
        <input
          type="date"
          value={postedDate}
          onChange={(e) => setPostedDate(e.target.value)}
          className="rounded-md border border-surface-muted px-2 py-1.5"
        />
        <input
          placeholder="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="rounded-md border border-surface-muted px-2 py-1.5"
        />
        <input
          inputMode="decimal"
          placeholder="-4.50"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="rounded-md border border-surface-muted px-2 py-1.5 text-right tabular-nums"
        />
        <select
          value={trntype}
          onChange={(e) => setTrntype(e.target.value)}
          className="rounded-md border border-surface-muted bg-white px-2 py-1.5"
        >
          {TRNTYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="rounded-md border border-surface-muted px-3 py-1.5 text-xs"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={saving}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-50"
        >
          {saving ? 'Adding…' : 'Add row'}
        </button>
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
  checked,
  isAdmin,
  autoSave,
  onActivate,
  onToggleCheck,
  onStartEdit,
  onCancelEdit,
  onSave,
  onDelete,
  categories,
}: {
  tx: TransactionRow;
  periodStart: string | null;
  periodEnd: string | null;
  editing: boolean;
  active: boolean;
  selected: boolean;
  checked: boolean;
  isAdmin?: boolean | undefined;
  autoSave?: boolean | undefined;
  onActivate: () => void;
  onToggleCheck: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (patch: TransactionPatch) => Promise<unknown>;
  onDelete?: (() => void) | undefined;
  categories?: BusinessCategory[] | undefined;
}) {
  const [desc, setDesc] = useState(tx.description);
  const [amount, setAmount] = useState(decimalString(BigInt(tx.amountCents)));
  const [trntype, setTrntype] = useState(tx.trntype);
  const [postedDate, setPostedDate] = useState(tx.postedDate);
  const [error, setError] = useState<string | null>(null);

  const outsidePeriod =
    periodStart && periodEnd && (tx.postedDate < periodStart || tx.postedDate > periodEnd);
  const suspect = (tx.confidence ?? 1) < 0.7;

  // Single source of truth for the row's commit logic. Both the Save
  // button onClick and (when autoSave is on) the per-input onBlur fire
  // through here. Returns a boolean for downstream chaining if needed.
  const commitEdit = async (): Promise<boolean> => {
    let cents: bigint;
    try {
      cents = parseDecimalToCents(amount);
    } catch {
      setError('decimal like -4.50');
      return false;
    }
    if (cents === 0n) {
      setError('non-zero');
      return false;
    }
    try {
      await onSave({
        description: desc,
        amount_cents: cents.toString(),
        trntype,
        posted_date: postedDate,
      });
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
      return false;
    }
  };

  // Auto-save fires on blur when (a) the toggle is on, (b) we're in
  // edit mode, and (c) focus is moving outside the row entirely
  // (relatedTarget not contained). This avoids spamming PATCHes when
  // tabbing between fields within the row.
  const onFieldBlur = (e: React.FocusEvent<HTMLElement>): void => {
    if (!autoSave || !editing) return;
    const next = e.relatedTarget as HTMLElement | null;
    const row = e.currentTarget.closest('tr');
    if (next && row && row.contains(next)) return;
    void commitEdit();
  };

  return (
    <tr
      onClick={onActivate}
      className={cn(
        'cursor-pointer align-top transition-colors',
        checked ? 'bg-accent/10' : selected ? 'bg-amber-50' : active ? 'bg-surface-subtle/50' : '',
      )}
    >
      {isAdmin ? (
        <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggleCheck}
            aria-label={`Select transaction ${tx.description}`}
          />
        </td>
      ) : null}
      <td className="px-3 py-2 whitespace-nowrap">
        {editing ? (
          <input
            type="date"
            value={postedDate}
            onChange={(e) => setPostedDate(e.target.value)}
            onBlur={onFieldBlur}
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
            onBlur={onFieldBlur}
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
            onBlur={onFieldBlur}
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
      {categories ? (
        <>
          {/* Phase 33 — cleansed description. Editable inline; saving
              flips enrichment_user_edited so a later batch enrich
              skips the row. Truncated display when not editing. */}
          <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
            <CleansedCell
              tx={tx}
              onSaveCleansed={async (val) => {
                await onSave({ cleansed_description: val });
              }}
            />
          </td>
          {/* Phase 33 — category dropdown. Empty option clears the
              field; non-empty maps name back to id via lookup. */}
          <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
            <CategoryCell
              tx={tx}
              categories={categories}
              onSaveCategory={async (id) => {
                await onSave({ business_category_id: id });
              }}
            />
          </td>
        </>
      ) : null}
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
            onBlur={onFieldBlur}
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
              onClick={() => void commitEdit()}
              data-tx-save-button={tx.id}
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
        {tx.runningBalanceDeltaCents && tx.runningBalanceDeltaCents !== '0' ? (
          <span
            title={`Printed running balance is off by ${formatUsd(BigInt(tx.runningBalanceDeltaCents))} vs prior_running + this row's amount.`}
            className="ml-1 inline-block rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-900"
          >
            off by {formatUsd(BigInt(tx.runningBalanceDeltaCents))}
          </span>
        ) : null}
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
      {isAdmin ? (
        <td className="px-2 py-2 text-right">
          {onDelete ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              title="Admin: delete transaction"
              className="rounded text-xs text-ink-subtle hover:text-danger"
            >
              ✕
            </button>
          ) : null}
        </td>
      ) : null}
    </tr>
  );
}

// Phase 33 — cleansed-description cell. Click to edit; commits on
// blur if the value actually changed (so simply opening the input
// doesn't write a userEdited row). Truncates display to keep rows
// from ballooning vertically — full text is in the input on edit and
// in the title attribute as a tooltip.
function CleansedCell({
  tx,
  onSaveCleansed,
}: {
  tx: TransactionRow;
  onSaveCleansed: (val: string | null) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(tx.cleansedDescription ?? '');
  const [saving, setSaving] = useState(false);

  // Re-sync local state when the row's underlying value changes (e.g.
  // after a batch "Cleanse descriptions" run completes).
  useEffect(() => {
    if (!editing) setValue(tx.cleansedDescription ?? '');
  }, [tx.cleansedDescription, editing]);

  const commit = async (): Promise<void> => {
    const trimmed = value.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    if (next === (tx.cleansedDescription ?? null)) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSaveCleansed(next);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void commit();
          }
          if (e.key === 'Escape') {
            setValue(tx.cleansedDescription ?? '');
            setEditing(false);
          }
        }}
        disabled={saving}
        maxLength={80}
        className="w-full rounded-md border border-surface-muted px-2 py-1 text-xs"
        placeholder="Cleansed name…"
      />
    );
  }

  const display = tx.cleansedDescription ?? '';
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="text-left text-xs hover:underline"
      title={display || 'Click to add a cleansed description'}
    >
      {display.length > 32 ? `${display.slice(0, 32)}…` : display || '—'}
      {tx.enrichmentUserEdited ? (
        <span className="ml-1 text-[10px] text-ink-subtle">(edited)</span>
      ) : null}
    </button>
  );
}

// Phase 33 — category dropdown. Empty option clears the assignment;
// non-empty maps the displayed name back to the category id. Archived
// categories aren't in `categories` so the user can't pick them, but
// existing assignments to a now-archived category still display via
// `tx.businessCategoryName` (resolved server-side regardless of
// archive state).
function CategoryCell({
  tx,
  categories,
  onSaveCategory,
}: {
  tx: TransactionRow;
  categories: BusinessCategory[];
  onSaveCategory: (id: string | null) => Promise<unknown>;
}) {
  const [saving, setSaving] = useState(false);
  const value = tx.businessCategoryId ?? '';
  const archivedAssignedName =
    !categories.some((c) => c.id === tx.businessCategoryId) && tx.businessCategoryName
      ? tx.businessCategoryName
      : null;

  const onChange = async (e: React.ChangeEvent<HTMLSelectElement>): Promise<void> => {
    const next = e.target.value === '' ? null : e.target.value;
    if (next === (tx.businessCategoryId ?? null)) return;
    setSaving(true);
    try {
      await onSaveCategory(next);
    } finally {
      setSaving(false);
    }
  };

  return (
    <select
      value={value}
      onChange={onChange}
      disabled={saving}
      className="rounded-md border border-surface-muted bg-white px-1.5 py-1 text-xs"
    >
      <option value="">—</option>
      {archivedAssignedName ? (
        <option value={tx.businessCategoryId!} disabled>
          {archivedAssignedName} (archived)
        </option>
      ) : null}
      {categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
