import argon2 from 'argon2';
import { and, eq, gt, ne, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

import type { Db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import type { Session, User } from '../db/types.js';
import { BREAKGLASS_EMAIL } from '../lib/breakglass.js';
import {
  AuthError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../lib/errors.js';
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

const countUsers = async (db: Db): Promise<number> => {
  const rows = await db.select({ c: sql<number>`count(*)::int` }).from(users);
  return rows[0]?.c ?? 0;
};

const registrationClosed = (): ForbiddenError =>
  new ForbiddenError('Registration is closed; ask an admin to add you');

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
  const actorIsAdmin = opts.actor?.role === 'admin';

  // Cheap early refusal, so a closed registration never costs an argon2
  // hash. The decision that counts is re-made under the lock below.
  if (!actorIsAdmin && (await countUsers(db)) > 0) throw registrationClosed();

  const passwordHash = await hashPassword(input.password);

  // First-admin bootstrap: without the lock, two registrations racing on an
  // empty database would both count zero users and both become admin.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('vibetc.users.register'))`);
    const isFirstUser = (await countUsers(tx)) === 0;
    if (!isFirstUser && !actorIsAdmin) throw registrationClosed();

    const existing = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing.length > 0) {
      throw new ConflictError('email already registered');
    }

    const [created] = await tx
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

    await writeAudit(tx, {
      actorUserId: opts.actor?.id ?? created.id,
      entityType: 'user',
      entityId: created.id,
      action: 'user.register',
      payload: { email, role: created.role, firstUser: isFirstUser },
    });

    return created;
  });
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

// Hash of a random secret nobody holds. An unknown email is verified
// against it, so it costs the same argon2 time as a known one and the
// response time does not reveal which accounts exist.
let dummyHash: Promise<string> | undefined;
const getDummyHash = (): Promise<string> => {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url')).catch((err: unknown) => {
    dummyHash = undefined; // never cache a failure
    throw err;
  });
  return dummyHash;
};

export const login = async (db: Db, input: LoginInput): Promise<LoginResult> => {
  const email = normalizeEmail(input.email);
  const rows = await db.select().from(users).where(eq(users.email, email));
  const user = rows[0];
  if (!user) {
    await verifyPassword(await getDummyHash(), input.password);
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

// currentSessionId: the session making the change, which stays signed in.
// Every other session of the user ends — a stolen 30-day rolling cookie
// must not outlive the password it was issued under.
export const changePassword = async (
  db: Db,
  user: User,
  current: string,
  next: string,
  currentSessionId?: string,
): Promise<void> => {
  validatePassword(next);
  const ok = await verifyPassword(user.passwordHash, current);
  if (!ok) throw new AuthError('current password is incorrect');
  const passwordHash = await hashPassword(next);
  await db
    .update(users)
    .set({ passwordHash, updatedAt: sql`now()` })
    .where(eq(users.id, user.id));
  await db
    .delete(sessions)
    .where(
      currentSessionId
        ? and(eq(sessions.userId, user.id), ne(sessions.id, currentSessionId))
        : eq(sessions.userId, user.id),
    );
  await writeAudit(db, {
    actorUserId: user.id,
    entityType: 'user',
    entityId: user.id,
    action: 'user.change-password',
    payload: { otherSessionsRevoked: true },
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const adminResetPassword = async (
  db: Db,
  actor: User,
  targetUserId: string,
): Promise<{ temporaryPassword: string }> => {
  if (actor.role !== 'admin') throw new ForbiddenError();
  // Checked first: a non-uuid id would reach Postgres as an invalid uuid.
  const [target] = UUID_RE.test(targetUserId)
    ? await db.select().from(users).where(eq(users.id, targetUserId)).limit(1)
    : [];
  if (!target) throw new NotFoundError('user not found');
  // The break-glass password lives with the Appliance. Minting one here
  // would hand an admin a local credential that bypasses the IdP (even in
  // oidc_only) and silently invalidate the stored one.
  if (target.email === BREAKGLASS_EMAIL) {
    throw new ForbiddenError(
      'The break-glass account is managed with the vibe-auth breakglass CLI',
    );
  }
  const temp = randomBytes(12).toString('base64url');
  const passwordHash = await hashPassword(temp);
  await db
    .update(users)
    .set({ passwordHash, updatedAt: sql`now()` })
    .where(eq(users.id, target.id));
  // A reset ends every session the user had (a stolen 30-day rolling
  // cookie must not survive it).
  await db.delete(sessions).where(eq(sessions.userId, target.id));
  await writeAudit(db, {
    actorUserId: actor.id,
    entityType: 'user',
    entityId: target.id,
    action: 'user.admin-reset-password',
    payload: { sessionsRevoked: true },
  });
  return { temporaryPassword: temp };
};
