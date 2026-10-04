import { Router, type RequestHandler } from 'express';
import { eq, sql } from 'drizzle-orm';
import type { VibeAuth } from '@kisaesdevlab/vibe-auth';

import { db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { AuthError, ForbiddenError, ValidationError } from '../lib/errors.js';
import { defaultFeatureAccess } from '../lib/feature-registry.js';
import { csrfTokenHandler } from '../middleware/csrf.js';
import { loginRateLimit } from '../middleware/login-rate-limit.js';
import {
  clearSessionCookie,
  readSessionCookie,
  requireAdmin,
  requireAuth,
  setSessionCookie,
} from '../middleware/auth.js';
import {
  adminCreateStaff,
  adminResetPassword,
  changePassword,
  login,
  logout,
  register,
} from '../services/auth.js';

const safeUser = (u: {
  id: string;
  email: string;
  displayName: string;
  role: string;
  createdAt: Date;
}) => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  role: u.role,
  createdAt: u.createdAt,
});

// Vibe Auth (ADR-027): in oidc_only mode password login is refused for
// everyone but the break-glass account. Same error shape as every other
// 403 so the SPA shows the message as-is.
const localLoginGuard =
  (vibeAuth: VibeAuth | undefined): RequestHandler =>
  (req, _res, next) => {
    if (!vibeAuth) return next();
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    const verdict = vibeAuth.localLoginAllowed(email);
    if (verdict.allowed) return next();
    next(new ForbiddenError('Local sign-in is disabled; use single sign-on.'));
  };

export const authRouter = (vibeAuth?: VibeAuth): Router => {
  const router = Router();

  router.get('/csrf', csrfTokenHandler);

  router.get('/users-exist', async (_req, res, next) => {
    try {
      const rows = await db.select({ c: sql<number>`count(*)::int` }).from(users);
      res.json({ exists: (rows[0]?.c ?? 0) > 0 });
    } catch (err) {
      next(err);
    }
  });

  router.post('/register', async (req, res, next) => {
    try {
      // First-admin bootstrap creates a local password account, which
      // oidc_only exists to forbid. Admins provision via the IdP instead.
      if (vibeAuth?.mode === 'oidc_only') {
        throw new ForbiddenError('Registration is disabled; sign in with single sign-on.');
      }
      const { email, password, displayName } = req.body ?? {};
      if (
        typeof email !== 'string' ||
        typeof password !== 'string' ||
        typeof displayName !== 'string'
      ) {
        throw new ValidationError('email, password, displayName are required');
      }
      // First-admin bootstrap only. Admins add users through POST
      // /api/users, which carries the admin.users feature gate this public
      // route does not.
      const created = await register(db, { email, password, displayName }, { actor: null });
      res.status(201).json(safeUser(created));
    } catch (err) {
      next(err);
    }
  });

  router.post('/login', loginRateLimit, localLoginGuard(vibeAuth), async (req, res, next) => {
    try {
      const { email, password } = req.body ?? {};
      if (typeof email !== 'string' || typeof password !== 'string') {
        throw new ValidationError('email and password are required');
      }
      const result = await login(db, { email, password });
      setSessionCookie(res, result.sessionId, result.expiresAt);
      // Audits break-glass use (vibe.auth.breakglass.used); no-op otherwise.
      await vibeAuth?.afterLocalLogin({
        userId: result.user.id,
        email,
        ...(req.ip ? { ip: req.ip } : {}),
      });
      res.json({ user: safeUser(result.user) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      const sid = readSessionCookie(req);
      if (sid) {
        await logout(db, sid);
      }
      clearSessionCookie(res);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', (req, res, next) => {
    try {
      if (!req.user) throw new AuthError();
      // featureAccess is set by loadSession; fall back to fully-enabled
      // so the SPA never hides everything if it's somehow absent.
      res.json({
        user: safeUser(req.user),
        features: req.featureAccess ?? defaultFeatureAccess(),
        // SSO-born sessions sign out through /auth/oidc/logout so the IdP
        // session ends too (RP-initiated logout).
        sso: Boolean(req.session?.oidcSubject),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/change-password', requireAuth, async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body ?? {};
      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
        throw new ValidationError('currentPassword and newPassword are required');
      }
      // Ends the user's other sessions; this one stays signed in.
      await changePassword(db, req.user!, currentPassword, newPassword, req.session?.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

export const usersRouter = (): Router => {
  const router = Router();

  router.use(requireAdmin);

  router.get('/', async (_req, res, next) => {
    try {
      // Phase 26 #5: surface last-login per user. Each session row's
      // createdAt is "this user authenticated at this moment"; the
      // newest one is "last login" (or null when the user has never
      // logged in / sessions were pruned).
      const rows = await db
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          role: users.role,
          createdAt: users.createdAt,
          lastLoginAt: sql<Date | null>`max(${sessions.createdAt})`,
        })
        .from(users)
        .leftJoin(sessions, eq(sessions.userId, users.id))
        .groupBy(users.id);
      res.json(
        rows.map((u) => ({
          ...safeUser(u),
          lastLoginAt: u.lastLoginAt,
        })),
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const { email, password, displayName } = req.body ?? {};
      if (
        typeof email !== 'string' ||
        typeof password !== 'string' ||
        typeof displayName !== 'string'
      ) {
        throw new ValidationError('email, password, displayName are required');
      }
      const created = await adminCreateStaff(db, req.user!, { email, password, displayName });
      res.status(201).json(safeUser(created));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/reset-password', async (req, res, next) => {
    try {
      const id = String(req.params.id ?? '');
      const result = await adminResetPassword(db, req.user!, id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
};
