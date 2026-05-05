import { type FormEvent, useState } from 'react';

import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, isValidAbaRouting } from '@vibe-tx-converter/shared';

import {
  useCreateAccount,
  type AccountType,
  type CreateAccountInput,
  type CsvTemplate,
} from '../hooks/useAccounts';
import { ApiError } from '../lib/api';
import { BankPickerCombobox, type BankSelection } from './BankPickerCombobox';

const CSV_TEMPLATES: Array<{ value: CsvTemplate; label: string }> = [
  { value: 'qbo3', label: 'QuickBooks 3-column' },
  { value: 'qbo4', label: 'QuickBooks 4-column' },
  { value: 'xero', label: 'Xero' },
  { value: 'generic', label: 'Generic' },
];

export function AccountFormDialog({
  companyId,
  onClose,
}: {
  companyId: string;
  onClose: () => void;
}) {
  const [bank, setBank] = useState<BankSelection | null>(null);
  const [nickname, setNickname] = useState('');
  const [accountType, setAccountType] = useState<AccountType>('CHECKING');
  const [accountNumber, setAccountNumber] = useState('');
  const [routingNumber, setRoutingNumber] = useState('');
  const [csvTemplate, setCsvTemplate] = useState<CsvTemplate>('qbo3');
  const [error, setError] = useState<string | null>(null);

  const create = useCreateAccount(companyId);
  const isCreditCard = accountType === 'CREDITCARD';
  const routingTrim = routingNumber.trim();
  const routingValid = routingTrim.length === 0 ? null : isValidAbaRouting(routingTrim);

  const valid =
    bank !== null &&
    nickname.trim().length > 0 &&
    accountNumber.trim().length >= 4 &&
    /^[\d-]+$/.test(accountNumber.trim()) &&
    (!isCreditCard || routingTrim.length === 0);

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (!bank) return;
    const payload: CreateAccountInput = {
      nickname: nickname.trim(),
      financialInstitution: bank.bankName,
      intuBid: bank.intuBid,
      intuOrg: bank.intuOrg,
      accountType,
      accountNumber: accountNumber.trim(),
      defaultCsvTemplate: csvTemplate,
    };
    if (!isCreditCard && routingTrim.length > 0) payload.routingNumber = routingTrim;
    try {
      await create.mutateAsync(payload);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'create failed');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal
      className="fixed inset-0 z-20 grid place-items-center bg-ink/40 px-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-lg space-y-4 rounded-xl bg-white p-6 shadow-xl"
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">Add account</h2>
            <p className="text-sm text-ink-muted">
              The Bank Picker stamps INTU.BID + INTU.ORG on every export.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-surface-muted px-2 py-1 text-sm"
          >
            Close
          </button>
        </div>

        <div>
          <label htmlFor="nickname" className="block text-sm font-medium">
            Nickname
          </label>
          <input
            id="nickname"
            required
            className="mt-1 w-full rounded-md border border-surface-muted px-3 py-2"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
          />
        </div>

        <div>
          <label htmlFor="bank" className="block text-sm font-medium">
            Bank
          </label>
          <BankPickerCombobox id="bank" value={bank} onChange={setBank} />
        </div>

        <fieldset>
          <legend className="text-sm font-medium">Account type</legend>
          <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {ACCOUNT_TYPES.map((t) => (
              <label
                key={t}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-surface-muted px-3 py-2 text-sm hover:bg-surface-subtle"
              >
                <input
                  type="radio"
                  name="accountType"
                  value={t}
                  checked={accountType === t}
                  onChange={() => setAccountType(t)}
                />
                <span>{ACCOUNT_TYPE_LABELS[t]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor="acct" className="block text-sm font-medium">
            Account number
          </label>
          <input
            id="acct"
            required
            inputMode="numeric"
            placeholder="digits, dashes allowed"
            className="mt-1 w-full rounded-md border border-surface-muted px-3 py-2"
            value={accountNumber}
            onChange={(e) => setAccountNumber(e.target.value)}
          />
        </div>

        {!isCreditCard ? (
          <div>
            <label htmlFor="routing" className="block text-sm font-medium">
              Routing number (optional)
            </label>
            <input
              id="routing"
              inputMode="numeric"
              placeholder="ABA / routing — optional"
              className="mt-1 w-full rounded-md border border-surface-muted px-3 py-2"
              value={routingNumber}
              onChange={(e) => setRoutingNumber(e.target.value)}
            />
            {routingValid === false ? (
              <p className="mt-1 text-xs text-amber-700">
                Doesn't pass ABA checksum — you can save anyway. QuickBooks does not validate the
                BANKID field.
              </p>
            ) : null}
          </div>
        ) : null}

        <div>
          <label htmlFor="csv" className="block text-sm font-medium">
            Default CSV template
          </label>
          <select
            id="csv"
            className="mt-1 w-full rounded-md border border-surface-muted bg-white px-3 py-2"
            value={csvTemplate}
            onChange={(e) => setCsvTemplate(e.target.value as CsvTemplate)}
          >
            {CSV_TEMPLATES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-surface-muted px-3 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid || create.isPending}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create account'}
          </button>
        </div>
      </form>
    </div>
  );
}
