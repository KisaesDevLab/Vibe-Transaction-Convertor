import { eq, sql } from 'drizzle-orm';

import { isValidAbaRouting, maskAccountNumber } from '@vibe-tx-converter/shared';

import type { Db } from '../db/client.js';
import { accounts, statements } from '../db/schema.js';
import type { Account, User } from '../db/types.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { writeAudit } from './audit.js';

export type SafeAccount = Omit<Account, 'accountNumber'> & {
  accountNumber: string;
  accountNumberMasked: string;
};

const toSafe = (a: Account, opts: { reveal?: boolean } = {}): SafeAccount => ({
  ...a,
  accountNumber: opts.reveal ? a.accountNumber : maskAccountNumber(a.accountNumber),
  accountNumberMasked: maskAccountNumber(a.accountNumber),
});

export const listAccountsByCompany = async (db: Db, companyId: string): Promise<SafeAccount[]> => {
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, companyId));
  return rows.map((r) => toSafe(r));
};

export const getAccount = async (
  db: Db,
  id: string,
  opts: { reveal?: boolean; actor?: User } = {},
): Promise<SafeAccount> => {
  const rows = await db.select().from(accounts).where(eq(accounts.id, id));
  const row = rows[0];
  if (!row) throw new NotFoundError(`account ${id} not found`);
  if (opts.reveal && opts.actor && opts.actor.role === 'admin') {
    await writeAudit(db, {
      actorUserId: opts.actor.id,
      entityType: 'account',
      entityId: id,
      action: 'account.reveal-number',
    });
    return toSafe(row, { reveal: true });
  }
  return toSafe(row);
};

export interface CreateAccountInput {
  companyId: string;
  nickname: string;
  financialInstitution: string;
  intuBid: string;
  intuOrg: string;
  accountType: Account['accountType'];
  accountNumber: string;
  routingNumber?: string | undefined;
  defaultCsvTemplate?: Account['defaultCsvTemplate'];
}

export const createAccount = async (
  db: Db,
  actor: User,
  input: CreateAccountInput,
): Promise<SafeAccount> => {
  const routingValid = input.routingNumber ? isValidAbaRouting(input.routingNumber) : null;
  const insertValues = {
    companyId: input.companyId,
    nickname: input.nickname.trim(),
    financialInstitution: input.financialInstitution.trim(),
    intuBid: input.intuBid.trim(),
    intuOrg: input.intuOrg.trim(),
    accountType: input.accountType,
    accountNumber: input.accountNumber.trim(),
    ...(input.routingNumber ? { routingNumber: input.routingNumber.trim() } : {}),
    ...(routingValid !== null ? { routingNumberAbaValid: routingValid } : {}),
    defaultCsvTemplate: input.defaultCsvTemplate ?? 'qbo3',
  };
  const [created] = await db.insert(accounts).values(insertValues).returning();
  if (!created) throw new Error('account insert returned no row');
  await writeAudit(db, {
    actorUserId: actor.id,
    entityType: 'account',
    entityId: created.id,
    action: 'account.create',
    payload: {
      nickname: created.nickname,
      intuBid: created.intuBid,
      accountType: created.accountType,
      routingNumberAbaValid: routingValid,
    },
  });
  return toSafe(created);
};

export interface UpdateAccountInput {
  nickname?: string | undefined;
  financialInstitution?: string | undefined;
  intuBid?: string | undefined;
  intuOrg?: string | undefined;
  accountType?: Account['accountType'] | undefined;
  accountNumber?: string | undefined;
  // null (or blank) clears the routing number.
  routingNumber?: string | null | undefined;
  defaultCsvTemplate?: Account['defaultCsvTemplate'] | undefined;
}

export const updateAccount = async (
  db: Db,
  actor: User,
  id: string,
  input: UpdateAccountInput,
): Promise<SafeAccount> => {
  const [current] = await db.select().from(accounts).where(eq(accounts.id, id));
  if (!current) throw new NotFoundError(`account ${id} not found`);

  const patch: Record<string, unknown> = { updatedAt: sql`now()` };
  if (input.nickname !== undefined) patch.nickname = input.nickname.trim();
  if (input.financialInstitution !== undefined)
    patch.financialInstitution = input.financialInstitution.trim();
  if (input.intuBid !== undefined) patch.intuBid = input.intuBid.trim();
  if (input.intuOrg !== undefined) patch.intuOrg = input.intuOrg.trim();
  if (input.accountType !== undefined) patch.accountType = input.accountType;
  if (input.accountNumber !== undefined) patch.accountNumber = input.accountNumber.trim();

  let nextRouting = current.routingNumber;
  let routingValid: boolean | null = null;
  if (input.routingNumber !== undefined) {
    nextRouting = input.routingNumber?.trim() || null;
    routingValid = nextRouting === null ? null : isValidAbaRouting(nextRouting);
    patch.routingNumber = nextRouting;
    patch.routingNumberAbaValid = routingValid;
  }
  const routingChanged = nextRouting !== current.routingNumber;
  if (input.defaultCsvTemplate !== undefined) patch.defaultCsvTemplate = input.defaultCsvTemplate;

  // Either half may come from the stored row; refuse the combination as the
  // validation error it is rather than letting the DB CHECK
  // accounts_credit_card_no_routing turn it into a 500.
  const nextType = input.accountType ?? current.accountType;
  if (nextType === 'CREDITCARD' && nextRouting !== null) {
    throw new ValidationError('credit-card accounts must not carry a routing number');
  }

  const [updated] = await db.update(accounts).set(patch).where(eq(accounts.id, id)).returning();
  if (!updated) throw new NotFoundError(`account ${id} not found`);

  // audit_log is append-only: never write a full account or routing number
  // into it (createAccount leaves both out too).
  const { accountNumber, routingNumber: _routingNumber, ...rest } = input;
  await writeAudit(db, {
    actorUserId: actor.id,
    entityType: 'account',
    entityId: id,
    action: 'account.update',
    payload: {
      ...rest,
      ...(accountNumber === undefined
        ? {}
        : { accountNumberMasked: maskAccountNumber(accountNumber) }),
      ...(routingChanged
        ? { routingNumberChanged: true, routingNumberAbaValid: routingValid }
        : {}),
    },
  });
  return toSafe(updated);
};

export const deleteAccount = async (
  db: Db,
  actor: User,
  id: string,
  opts: { force?: boolean } = {},
): Promise<void> => {
  const stmtRows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(statements)
    .where(eq(statements.accountId, id));
  const stmtCount = Number(stmtRows[0]?.c ?? 0);
  if (stmtCount > 0 && !opts.force) {
    throw new ConflictError(`account has ${stmtCount} statement(s); use ?force=true to cascade`, {
      statementCount: stmtCount,
    });
  }

  const [deleted] = await db.delete(accounts).where(eq(accounts.id, id)).returning();
  if (!deleted) throw new NotFoundError(`account ${id} not found`);

  await writeAudit(db, {
    actorUserId: actor.id,
    entityType: 'account',
    entityId: id,
    action: 'account.delete',
    payload: { force: opts.force ?? false, cascadedStatements: stmtCount },
  });
};
