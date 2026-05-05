import { asc, desc, eq, ilike, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { accounts, companies } from '../db/schema.js';
import type { Company, User } from '../db/types.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { writeAudit } from './audit.js';

export interface ListCompaniesParams {
  limit?: number | undefined;
  offset?: number | undefined;
  sort?: 'name' | 'createdAt' | undefined;
  order?: 'asc' | 'desc' | undefined;
  q?: string | undefined;
}

export interface CompanyWithCounts extends Company {
  accountCount: number;
}

export const listCompanies = async (
  db: Db,
  params: ListCompaniesParams = {},
): Promise<{ rows: CompanyWithCounts[]; total: number }> => {
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  const sortCol = params.sort === 'createdAt' ? companies.createdAt : companies.name;
  const orderFn = params.order === 'desc' ? desc : asc;
  const where = params.q ? ilike(companies.name, `%${params.q}%`) : undefined;

  const totalRows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(companies)
    .where(where);

  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      createdAt: companies.createdAt,
      updatedAt: companies.updatedAt,
      accountCount: sql<number>`(select count(*)::int from ${accounts} where ${accounts.companyId} = ${companies.id})`,
    })
    .from(companies)
    .where(where)
    .orderBy(orderFn(sortCol))
    .limit(limit)
    .offset(offset);

  return { rows, total: Number(totalRows[0]?.c ?? 0) };
};

export const getCompany = async (db: Db, id: string): Promise<CompanyWithCounts> => {
  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      createdAt: companies.createdAt,
      updatedAt: companies.updatedAt,
      accountCount: sql<number>`(select count(*)::int from ${accounts} where ${accounts.companyId} = ${companies.id})`,
    })
    .from(companies)
    .where(eq(companies.id, id));
  const row = rows[0];
  if (!row) throw new NotFoundError(`company ${id} not found`);
  return row;
};

export const createCompany = async (
  db: Db,
  actor: User,
  input: { name: string },
): Promise<Company> => {
  const [created] = await db.insert(companies).values({ name: input.name.trim() }).returning();
  if (!created) throw new Error('company insert returned no row');
  await writeAudit(db, {
    actorUserId: actor.id,
    entityType: 'company',
    entityId: created.id,
    action: 'company.create',
    payload: { name: created.name },
  });
  return created;
};

export const updateCompany = async (
  db: Db,
  actor: User,
  id: string,
  input: { name?: string | undefined },
): Promise<Company> => {
  const patch: Record<string, unknown> = { updatedAt: sql`now()` };
  if (input.name !== undefined) patch.name = input.name.trim();
  const [updated] = await db.update(companies).set(patch).where(eq(companies.id, id)).returning();
  if (!updated) throw new NotFoundError(`company ${id} not found`);
  await writeAudit(db, {
    actorUserId: actor.id,
    entityType: 'company',
    entityId: id,
    action: 'company.update',
    payload: input,
  });
  return updated;
};

export const deleteCompany = async (
  db: Db,
  actor: User,
  id: string,
  opts: { force?: boolean } = {},
): Promise<void> => {
  const accountRows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(accounts)
    .where(eq(accounts.companyId, id));
  const accountCount = Number(accountRows[0]?.c ?? 0);

  if (accountCount > 0 && !opts.force) {
    throw new ConflictError(`company has ${accountCount} account(s); use ?force=true to cascade`, {
      accountCount,
    });
  }

  const [deleted] = await db.delete(companies).where(eq(companies.id, id)).returning();
  if (!deleted) throw new NotFoundError(`company ${id} not found`);

  await writeAudit(db, {
    actorUserId: actor.id,
    entityType: 'company',
    entityId: id,
    action: 'company.delete',
    payload: { force: opts.force ?? false, cascadedAccounts: accountCount },
  });
};
