import { z } from 'zod';

import { ACCOUNT_TYPES } from '../account-types.js';

export const AccountId = z.string().uuid();
export type AccountId = z.infer<typeof AccountId>;

export const CsvTemplate = z.enum(['qbo3', 'qbo4', 'xero', 'generic']);
export type CsvTemplate = z.infer<typeof CsvTemplate>;

export const AccountCreate = z
  .object({
    companyId: z.string().uuid(),
    nickname: z.string().trim().min(1).max(120),
    financialInstitution: z.string().trim().min(1).max(200),
    intuBid: z.string().trim().min(1).max(20),
    intuOrg: z.string().trim().min(1).max(120),
    accountType: z.enum(ACCOUNT_TYPES),
    accountNumber: z
      .string()
      .trim()
      .min(4, 'account_number must be at least 4 digits')
      .max(40)
      .regex(/^[\d-]+$/, 'account_number must be digits (dashes allowed)'),
    routingNumber: z.string().trim().min(1).max(20).optional(),
    defaultCsvTemplate: CsvTemplate.default('qbo3'),
  })
  .superRefine((val, ctx) => {
    if (val.accountType === 'CREDITCARD' && val.routingNumber !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routingNumber'],
        message: 'credit-card accounts must not carry a routing number',
      });
    }
    // Reject dashes-only account numbers — the regex above tolerates
    // both digits and dashes for grouping but at least 4 digits must
    // be present.
    const digitCount = val.accountNumber.replace(/\D/g, '').length;
    if (digitCount < 4) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accountNumber'],
        message: 'account_number must contain at least 4 digits',
      });
    }
  });
export type AccountCreate = z.infer<typeof AccountCreate>;

export const AccountUpdate = z
  .object({
    nickname: z.string().trim().min(1).max(120),
    financialInstitution: z.string().trim().min(1).max(200),
    intuBid: z.string().trim().min(1).max(20),
    intuOrg: z.string().trim().min(1).max(120),
    accountType: z.enum(ACCOUNT_TYPES),
    accountNumber: z
      .string()
      .trim()
      .min(4, 'account_number must be at least 4 digits')
      .max(40)
      .regex(/^[\d-]+$/, 'account_number must be digits (dashes allowed)'),
    // null clears the routing number (the account edit form sends null for
    // an emptied field, and for every credit card); a blank string means
    // the same.
    routingNumber: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
      z.string().trim().min(1).max(20).nullable(),
    ),
    defaultCsvTemplate: CsvTemplate,
  })
  .partial()
  .superRefine((val, ctx) => {
    // The patch alone; the service re-checks against the stored account
    // type / routing number, since either may come from the existing row.
    if (val.accountType === 'CREDITCARD' && typeof val.routingNumber === 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routingNumber'],
        message: 'credit-card accounts must not carry a routing number',
      });
    }
    if (val.accountNumber !== undefined && val.accountNumber.replace(/\D/g, '').length < 4) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accountNumber'],
        message: 'account_number must contain at least 4 digits',
      });
    }
  });
export type AccountUpdate = z.infer<typeof AccountUpdate>;
