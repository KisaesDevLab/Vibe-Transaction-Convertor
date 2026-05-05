// Display helpers shared between API responses and UI.

export const maskAccountNumber = (raw: string): string => {
  const digits = raw.replace(/\D/g, '');
  if (digits.length <= 4) return digits;
  return `••••${digits.slice(-4)}`;
};

export interface AccountDisplayInput {
  nickname: string;
  financialInstitution: string;
  accountNumberLast4?: string | null;
  accountNumber?: string;
}

export const formatAccountDisplay = (a: AccountDisplayInput): string => {
  const last4 =
    a.accountNumberLast4 ?? (a.accountNumber ? a.accountNumber.replace(/\D/g, '').slice(-4) : '');
  return last4
    ? `${a.financialInstitution} — ${a.nickname} ••••${last4}`
    : `${a.financialInstitution} — ${a.nickname}`;
};
