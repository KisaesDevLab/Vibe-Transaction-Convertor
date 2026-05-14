import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, withBase } from '../lib/api';
import { companiesKey } from './useCompanies';

export type AccountType = 'CHECKING' | 'SAVINGS' | 'MONEYMRKT' | 'CREDITLINE' | 'CREDITCARD';
export type CsvTemplate = 'qbo3' | 'qbo4' | 'xero' | 'generic';

export interface Account {
  id: string;
  companyId: string;
  nickname: string;
  financialInstitution: string;
  intuBid: string;
  intuOrg: string;
  accountType: AccountType;
  accountNumber: string;
  accountNumberMasked: string;
  routingNumber: string | null;
  routingNumberAbaValid: boolean | null;
  defaultCsvTemplate: CsvTemplate;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAccountInput {
  nickname: string;
  financialInstitution: string;
  intuBid: string;
  intuOrg: string;
  accountType: AccountType;
  accountNumber: string;
  routingNumber?: string;
  defaultCsvTemplate: CsvTemplate;
}

export const accountsKey = (companyId: string) => ['accounts', companyId] as const;

export const useAccounts = (companyId: string) =>
  useQuery({
    queryKey: accountsKey(companyId),
    queryFn: () => api.get<Account[]>(`/api/companies/${companyId}/accounts`),
    enabled: companyId.length > 0,
  });

// Admin-only: fetch the unmasked account number. Each call audit-logs
// the reveal action via the API.
export const fetchRevealedAccount = (id: string): Promise<Account> =>
  api.get<Account>(`/api/accounts/${id}`, { reveal: 'true' });

export const useCreateAccount = (companyId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAccountInput) =>
      api.post<Account>(`/api/companies/${companyId}/accounts`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountsKey(companyId) });
      // Companies list shows `accountCount` per row; without this the
      // count stays stale until a hard refresh.
      qc.invalidateQueries({ queryKey: companiesKey });
    },
  });
};

export const useDeleteAccount = (companyId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      api.delete<void>(`/api/accounts/${id}${force ? '?force=true' : ''}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountsKey(companyId) });
      qc.invalidateQueries({ queryKey: companiesKey });
    },
  });
};

export interface UpdateAccountInput {
  nickname?: string;
  defaultCsvTemplate?: CsvTemplate;
  routingNumber?: string | null;
  intuUseridOverride?: string | null;
}

export const useUpdateAccount = (companyId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateAccountInput }) =>
      api.patch<Account>(`/api/accounts/${id}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountsKey(companyId) });
      qc.invalidateQueries({ queryKey: ['account'] });
    },
  });
};

export interface UploadResult {
  statements: Array<{
    filename: string;
    hash: string;
    pages: number;
    bytes: number;
    statementId: string;
    deduplicated: boolean;
    status: string;
  }>;
  errors: Array<{ filename: string; error: string }>;
}

const readCsrfFromCookie = (): string =>
  document.cookie
    .split('; ')
    .find((c) => c.startsWith('vibetc_csrf='))
    ?.split('=')[1] ?? '';

export type PdfProcessingStrategy =
  | 'auto'
  | 'force-text'
  | 'force-ocr'
  | 'auto-ocr-fallback'
  | 'auto-text-fallback';

export interface UploadInput {
  files: File[];
  // Per-file strategy override, aligned with `files` by index. null
  // entries fall through to the firm default at extraction time.
  strategies?: Array<PdfProcessingStrategy | null>;
}

export const useUpload = (accountId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UploadInput): Promise<UploadResult> => {
      const { files, strategies } = input;
      const form = new FormData();
      for (const f of files) form.append('files', f);
      if (strategies && strategies.some((s) => s !== null)) {
        // Pad / truncate to match files length so the server's index
        // alignment stays unambiguous.
        const aligned = files.map((_, i) => strategies[i] ?? null);
        form.append('processingStrategies', JSON.stringify(aligned));
      }
      const res = await fetch(withBase(`/api/accounts/${accountId}/uploads`), {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-csrf-token': readCsrfFromCookie() },
        body: form,
      });
      const body = (await res.json().catch(() => ({}))) as UploadResult & { message?: string };
      if (!res.ok) throw new Error(body.message ?? `upload failed (${res.status})`);
      return body;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['statements', accountId] }),
  });
};
