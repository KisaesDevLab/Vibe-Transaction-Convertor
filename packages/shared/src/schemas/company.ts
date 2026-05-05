import { z } from 'zod';

export const CompanyCreate = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
});
export type CompanyCreate = z.infer<typeof CompanyCreate>;

export const CompanyUpdate = CompanyCreate.partial();
export type CompanyUpdate = z.infer<typeof CompanyUpdate>;

export const CompanyId = z.string().uuid();
export type CompanyId = z.infer<typeof CompanyId>;

export const CompanyListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['name', 'createdAt']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  q: z.string().trim().max(120).optional(),
});
export type CompanyListQuery = z.infer<typeof CompanyListQuery>;
