import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';

import { db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { cookieDomain, cookiePath, cookieSecure } from '../lib/cookie-flags.js';
import { AuthError, ValidationError } from '../lib/errors.js';
import { defaultFeatureAccess } from '../lib/feature-registry.js';
import { csrfTokenHandler } from '../middleware/csrf.js';
import { loginRateLimit } from '../middleware/login-rate-limit.js';
import { SESSION_COOKIE, requireAdmin, requireAuth } from '../middleware/auth.js';
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

export const authRouter = (): Router => {
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
      const { email, password, displayName } = req.body ?? {};
      if (
        typeof email !== 'string' ||
        typeof password !== 'string' ||
        typeof displayName !== 'string'
      ) {
        throw new ValidationError('email, password, displayName are required');
      }
      const created = await register(
        db,
        { email, password, displayName },
        { actor: req.user ?? null },
      );
      res.status(201).json(safeUser(created));
    } catch (err) {
      next(err);
    }
  });

  router.post('/login', loginRateLimit, async (req, res, next) => {
    try {
      const { email, password } = req.body ?? {};
      if (typeof email !== 'string' || typeof password !== 'string') {
        throw new ValidationError('email and password are required');
      }
      const result = await login(db, { email, password });
      res.cookie(SESSION_COOKIE, result.sessionId, {
        httpOnly: true,
        sameSite: 'lax',
        secure: cookieSecure(),
        signed: true,
        expires: result.expiresAt,
        domain: cookieDomain(),
        path: cookiePath(),
      });
      res.json({ user: safeUser(result.user) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      const sid = req.signedCookies?.[SESSION_COOKIE] as string | undefined;
      if (sid) {
        await logout(db, sid);
      }
      // clearCookie must echo the same domain/path used at set-time, or
      // the browser keeps the original cookie around (cookies are
      // identified by the (name, domain, path) triple).
      res.clearCookie(SESSION_COOKIE, { domain: cookieDomain(), path: cookiePath() });
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
      res.json({ user: safeUser(req.user), features: req.featureAccess ?? defaultFeatureAccess() });
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
      await changePassword(db, req.user!, currentPassword, newPassword);
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
