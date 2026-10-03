// Vibe Auth SSO (ADR-027) — the product side of the @kisaesdevlab/vibe-auth
// user contract. Shared by the API (lib/vibe-auth.ts) and the break-glass
// CLI adapter (vibeAuthAdapter.ts), so it depends on nothing but the DB.
//
// Users are keyed by email here. The package's break-glass *username*
// (`vibe-breakglass`) is stored under a dotted placeholder address that no
// mailbox backs; findByUsername maps between the two.

import { randomBytes } from 'node:crypto';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type {
  AuditEvent,
  AuditSink,
  CreateLocalUserInput,
  CreateUserInput,
  RoleVocabulary,
  UserAdapter,
  VibeUser,
} from '@kisaesdevlab/vibe-auth';

import type { Db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import type { User } from '../db/types.js';
import { writeAudit } from '../services/audit.js';
import { hashPassword, verifyPassword } from '../services/auth.js';

type Role = User['role'];
const ROLES: readonly Role[] = ['admin', 'staff'];

// Explicit map rather than the package default (which leaves a group
// unmapped when the vocabulary has no matching name — managers would be
// refused here). Partners administer the firm's tools, so they map to
// admin, as in every other two-role Vibe product.
export const VIBETC_ROLES: RoleVocabulary = {
  roles: ROLES,
  adminRole: 'admin',
  defaultRoleMap: {
    'vibe-admin': 'admin',
    'vibe-it': 'admin',
    'vibe-partner': 'admin',
    'vibe-manager': 'staff',
    'vibe-staff': 'staff',
  },
};

export const DEFAULT_BREAKGLASS_USERNAME = 'vibe-breakglass';
export const BREAKGLASS_EMAIL = 'vibe-breakglass@vibe-tx-converter.local';

export const breakglassUsername = (env: typeof process.env = process.env): string =>
  (env.VIBE_BREAKGLASS_USERNAME?.trim() || DEFAULT_BREAKGLASS_USERNAME).toLowerCase();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parseRole = (role: string): Role => {
  if ((ROLES as readonly string[]).includes(role)) return role as Role;
  throw new Error(`vibe-auth: unknown role "${role}"`);
};

const toVibeUser = (row: User): VibeUser => {
  const local = row.email === BREAKGLASS_EMAIL;
  return {
    id: row.id,
    email: row.email,
    name: row.displayName,
    role: row.role,
    active: row.disabledAt === null,
    local,
    ...(local ? { username: breakglassUsername() } : {}),
  };
};

export interface VibeUsersOptions {
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
}

export const createVibeUsers = (db: Db, opts: VibeUsersOptions = {}): UserAdapter => {
  const warn = opts.warn ?? (() => undefined);

  const byId = async (id: string): Promise<User | null> => {
    // The package passes ids it read back from auth_identities (TEXT), so
    // guard the uuid cast instead of letting Postgres throw.
    if (!UUID_RE.test(id)) return null;
    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ?? null;
  };

  const byEmail = async (email: string): Promise<User | null> => {
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(1);
    return row ?? null;
  };

  const countOtherActiveAdmins = async (excludeUserId: string): Promise<number> => {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(
        and(
          eq(users.role, 'admin'),
          isNull(users.disabledAt),
          ne(users.id, excludeUserId),
          ne(users.email, BREAKGLASS_EMAIL),
        ),
      );
    return r?.n ?? 0;
  };

  const endSessions = async (userId: string): Promise<void> => {
    await db.delete(sessions).where(eq(sessions.userId, userId));
  };

  return {
    async findById(id) {
      const row = await byId(id);
      return row ? toVibeUser(row) : null;
    },

    // Only the engine's SSO email-linking calls this. The break-glass row is
    // local-only: an IdP identity asserting its placeholder address must
    // never link to it (break-glass tooling reaches it via findByUsername).
    async findByEmail(email) {
      if (email.trim().toLowerCase() === BREAKGLASS_EMAIL) return null;
      const row = await byEmail(email);
      return row ? toVibeUser(row) : null;
    },

    async findByUsername(username) {
      const u = username.trim().toLowerCase();
      const row = await byEmail(u === breakglassUsername() ? BREAKGLASS_EMAIL : u);
      return row ? toVibeUser(row) : null;
    },

    // JIT provisioning. password_hash is NOT NULL, so the row gets the hash
    // of a random secret nobody holds: the user can only sign in via SSO
    // until an admin issues a reset.
    async create(input: CreateUserInput) {
      const email = input.email.trim().toLowerCase();
      if (email === BREAKGLASS_EMAIL) {
        throw new Error('vibe-auth: the break-glass address cannot be provisioned via SSO');
      }
      const [row] = await db
        .insert(users)
        .values({
          email,
          displayName: input.name?.trim() || email.split('@')[0] || email,
          role: parseRole(input.role),
          passwordHash: await hashPassword(randomBytes(32).toString('base64url')),
        })
        .returning();
      if (!row) throw new Error('users insert returned no row');
      return toVibeUser(row);
    },

    countOtherActiveAdmins,

    // The engine already refuses a demotion when countOtherActiveAdmins is
    // 0; this re-check covers the CLI path and races between two logins.
    async setRole(userId, role) {
      const next = parseRole(role);
      const current = await byId(userId);
      if (!current || current.role === next) return;
      if (current.role === 'admin' && (await countOtherActiveAdmins(userId)) === 0) {
        warn('vibe-auth: role sync refused; would demote the last active admin', {
          userId,
          wanted: next,
        });
        return false;
      }
      await db
        .update(users)
        .set({ role: next, updatedAt: sql`now()` })
        .where(eq(users.id, userId));
    },

    async verifyLocalPassword(userId, password) {
      const row = await byId(userId);
      return row ? verifyPassword(row.passwordHash, password) : false;
    },

    // Break-glass provisioning: an active local admin with an argon2id hash.
    async createLocalUser(input: CreateLocalUserInput) {
      const [row] = await db
        .insert(users)
        .values({
          email: input.email.trim().toLowerCase(),
          displayName: input.name,
          role: parseRole(input.role),
          passwordHash: await hashPassword(input.password),
        })
        .returning();
      if (!row) throw new Error('users insert returned no row');
      return toVibeUser(row);
    },

    async setLocalPassword(userId, password) {
      await db
        .update(users)
        .set({ passwordHash: await hashPassword(password), updatedAt: sql`now()` })
        .where(eq(users.id, userId));
      await endSessions(userId);
    },

    async setActive(userId, active) {
      await db
        .update(users)
        .set({ disabledAt: active ? null : sql`now()`, updatedAt: sql`now()` })
        .where(eq(users.id, userId));
      if (!active) await endSessions(userId);
    },
  };
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

// Package audit events → the append-only audit_log (ADR-013). Never
// throws: a failed audit write must not fail the sign-in it describes.
// actor_user_id is a uuid column, so non-user actors ("cli", "idp") stay
// in the payload only.
export const createVibeAuditSink = (db: Db, opts: VibeUsersOptions = {}): AuditSink => {
  const warn = opts.warn ?? (() => undefined);
  return {
    async emit(event: AuditEvent) {
      const { type, at: _at, ...payload } = event;
      const userId = str(payload.user_id);
      const actor = str(payload.actor);
      const actorUserId = [actor, userId].find((v) => v && UUID_RE.test(v)) ?? null;
      try {
        await writeAudit(db, {
          actorUserId,
          entityType: 'auth',
          entityId: userId ?? 'vibe-auth',
          action: type,
          payload,
        });
      } catch (err) {
        warn('vibe-auth: audit write failed', {
          type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
};
