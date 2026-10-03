import argon2 from 'argon2';
import { and, eq, gt, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

import type { Db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import type { Session, User } from '../db/types.js';
import { AuthError, ConflictError, ForbiddenError, ValidationError } from '../lib/errors.js';
import { writeAudit } from './audit.js';

const ARGON2_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const newSessionId = (): string => randomBytes(32).toString('hex');

export const hashPassword = (password: string): Promise<string> =>
  argon2.hash(password, ARGON2_OPTS);

export const verifyPassword = (hash: string, password: string): Promise<boolean> =>
  argon2.verify(hash, password).catch(() => false);

// OIDC identity carried by sessions born from a Vibe Auth sign-in
// (ADR-027). idTokenWrapped is already AES-GCM-wrapped by the caller.
export interface SessionOidc {
  issuer: string;
  subject: string;
  sid?: string;
  idTokenWrapped?: string;
}

// Inserts a session row. Shared by password login and the Vibe Auth
// SessionAdapter so both produce the same row shape and lifetime.
export const createSession = async (
  db: Db,
  userId: string,
  oidc?: SessionOidc,
): Promise<{ sessionId: string; expiresAt: Date }> => {
  const sessionId = newSessionId();
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    expiresAt,
    oidcIssuer: oidc?.issuer ?? null,
    oidcSubject: oidc?.subject ?? null,
    oidcSid: oidc?.sid ?? null,
    oidcIdToken: oidc?.idTokenWrapped ?? null,
  });
  return { sessionId, expiresAt };
};

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
}

const validatePassword = (pw: string): void => {
  if (pw.length < 12) {
    throw new ValidationError('password must be at least 12 characters');
  }
};

export const register = async (
  db: Db,
  input: RegisterInput,
  opts: { actor?: User | null } = {},
): Promise<User> => {
  const email = normalizeEmail(input.email);
  if (!email.includes('@')) {
    throw new ValidationError('invalid email');
  }
  validatePassword(input.password);
  if (input.displayName.trim().length === 0) {
    throw new ValidationError('displayName is required');
  }

  const userCount = await db.select({ c: sql<number>`count(*)::int` }).from(users);
  const isFirstUser = (userCount[0]?.c ?? 0) === 0;

  if (!isFirstUser) {
    if (!opts.actor || opts.actor.role !== 'admin') {
      throw new ForbiddenError('Registration is closed; ask an admin to add you');
    }
  }

  const existing = await db.select().from(users).where(eq(users.email, email));
  if (existing.length > 0) {
    throw new ConflictError('email already registered');
  }

  const passwordHash = await hashPassword(input.password);

  const [created] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: input.displayName.trim(),
      role: isFirstUser ? 'admin' : 'staff',
    })
    .returning();

  if (!created) {
    throw new Error('user insert returned no row');
  }

  await writeAudit(db, {
    actorUserId: opts.actor?.id ?? created.id,
    entityType: 'user',
    entityId: created.id,
    action: 'user.register',
    payload: { email, role: created.role, firstUser: isFirstUser },
  });

  return created;
};

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  user: User;
  sessionId: string;
  expiresAt: Date;
}

export const login = async (db: Db, input: LoginInput): Promise<LoginResult> => {
  const email = normalizeEmail(input.email);
  const rows = await db.select().from(users).where(eq(users.email, email));
  const user = rows[0];
  if (!user) {
    throw new AuthError('invalid email or password');
  }
  const ok = await verifyPassword(user.passwordHash, input.password);
  // A disabled account (ADR-027) gets the same answer as a wrong password
  // so the response does not reveal which accounts exist.
  if (!ok || user.disabledAt) {
    throw new AuthError('invalid email or password');
  }
  const { sessionId, expiresAt } = await createSession(db, user.id);
  await writeAudit(db, {
    actorUserId: user.id,
    entityType: 'user',
    entityId: user.id,
    action: 'user.login',
  });
  return { user, sessionId, expiresAt };
};

export const logout = async (db: Db, sessionId: string): Promise<void> => {
  const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  const sess = rows[0];
  await db.delete(sessions).where(eq(sessions.id, sessionId));
  if (sess) {
    await writeAudit(db, {
      actorUserId: sess.userId,
      entityType: 'session',
      entityId: sess.id,
      action: 'user.logout',
    });
  }
};

export interface SessionContext {
  user: User;
  session: Session;
}

export const getSession = async (
  db: Db,
  sessionId: string | undefined,
): Promise<SessionContext | null> => {
  if (!sessionId) return null;
  const now = new Date();
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now)));
  const session = rows[0];
  if (!session) return null;
  const userRows = await db.select().from(users).where(eq(users.id, session.userId));
  const user = userRows[0];
  if (!user || user.disabledAt) return null;
  return { user, session };
};

// Rolling session: extend expiresAt when the session is past half-life.
export const maybeRollSession = async (db: Db, session: Session): Promise<Session> => {
  const lifetime = SESSION_LIFETIME_MS;
  const remaining = session.expiresAt.getTime() - Date.now();
  if (remaining > lifetime / 2) return session;
  const newExpiry = new Date(Date.now() + lifetime);
  await db.update(sessions).set({ expiresAt: newExpiry }).where(eq(sessions.id, session.id));
  return { ...session, expiresAt: newExpiry };
};

export const changePassword = async (
  db: Db,
  user: User,
  current: string,
  next: string,
): Promise<void> => {
  validatePassword(next);
  const ok = await verifyPassword(user.passwordHash, current);
  if (!ok) throw new AuthError('current password is incorrect');
  const passwordHash = await hashPassword(next);
  await db
    .update(users)
    .set({ passwordHash, updatedAt: sql`now()` })
    .where(eq(users.id, user.id));
  await writeAudit(db, {
    actorUserId: user.id,
    entityType: 'user',
    entityId: user.id,
    action: 'user.change-password',
  });
};

export const adminCreateStaff = async (
  db: Db,
  actor: User,
  input: RegisterInput,
): Promise<User> => {
  if (actor.role !== 'admin') throw new ForbiddenError();
  return register(db, input, { actor });
};

export const adminResetPassword = async (
  db: Db,
  actor: User,
  targetUserId: string,
): Promise<{ temporaryPassword: string }> => {
  if (actor.role !== 'admin') throw new ForbiddenError();
  const temp = randomBytes(12).toString('base64url');
  const passwordHash = await hashPassword(temp);
  await db
    .update(users)
    .set({ passwordHash, updatedAt: sql`now()` })
    .where(eq(users.id, targetUserId));
  await writeAudit(db, {
    actorUserId: actor.id,
    entityType: 'user',
    entityId: targetUserId,
    action: 'user.admin-reset-password',
  });
  return { temporaryPassword: temp };
};
