export const ACCOUNT_TYPES = [
  'CHECKING',
  'SAVINGS',
  'MONEYMRKT',
  'CREDITLINE',
  'CREDITCARD',
] as const;

export type AccountTypeCode = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_TYPE_LABELS: Record<AccountTypeCode, string> = {
  CHECKING: 'Checking',
  SAVINGS: 'Savings',
  MONEYMRKT: 'Money Market',
  CREDITLINE: 'Line of Credit',
  CREDITCARD: 'Credit Card',
};

export const isCreditCard = (t: AccountTypeCode): boolean => t === 'CREDITCARD';
export const isBankAccount = (t: AccountTypeCode): boolean =>
  t === 'CHECKING' || t === 'SAVINGS' || t === 'MONEYMRKT' || t === 'CREDITLINE';
