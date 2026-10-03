import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { db } from '../db/client.js';
import type { Session, User } from '../db/types.js';
import { cookieDomain, cookiePath, cookieSecure } from '../lib/cookie-flags.js';
import { AuthError, ForbiddenError } from '../lib/errors.js';
import { getSession, maybeRollSession } from '../services/auth.js';
import { loadFeatureAccess } from '../services/feature-access.js';

declare global {
  namespace Express {
    interface Request {
      user?: User;
      session?: Session;
      // Effective per-feature access for req.user, default-on with the
      // user's explicit denials applied. Set by loadSession; read by
      // requireFeature (middleware/feature-access.ts).
      featureAccess?: Record<string, boolean>;
    }
  }
}

export const SESSION_COOKIE = 'vibetc_session';

// One definition of the session cookie for password login, SSO sign-in
// (lib/vibe-auth.ts) and the rolling re-issue below. clearCookie must echo
// the same domain/path used at set-time, or the browser keeps the original
// cookie around (cookies are identified by the (name, domain, path) triple).
export const setSessionCookie = (res: Response, sessionId: string, expiresAt: Date): void => {
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(),
    signed: true,
    expires: expiresAt,
    domain: cookieDomain(),
    path: cookiePath(),
  });
};

export const clearSessionCookie = (res: Response): void => {
  res.clearCookie(SESSION_COOKIE, { domain: cookieDomain(), path: cookiePath() });
};

export const readSessionCookie = (req: Request): string | undefined => {
  const signed = req.signedCookies?.[SESSION_COOKIE];
  if (typeof signed === 'string' && signed.length > 0) return signed;
  return undefined;
};

export const loadSession: RequestHandler = async (req, res, next) => {
  try {
    const sid = readSessionCookie(req);
    if (!sid) return next();
    const ctx = await getSession(db, sid);
    if (!ctx) return next();
    const before = ctx.session.expiresAt.getTime();
    const session = await maybeRollSession(db, ctx.session);
    // If the rolling helper extended the expiry, re-issue the cookie so
    // the browser tracks the new expiration. Without this, the DB row
    // keeps rolling but the browser drops the cookie at the original
    // deadline.
    if (session.expiresAt.getTime() !== before) {
      setSessionCookie(res, sid, session.expiresAt);
    }
    req.user = ctx.user;
    req.session = session;
    req.featureAccess = await loadFeatureAccess(db, ctx.user.id);
    next();
  } catch (err) {
    next(err);
  }
};

export const requireAuth = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.user) return next(new AuthError());
  next();
};

export const requireAdmin = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.user) return next(new AuthError());
  if (req.user.role !== 'admin') return next(new ForbiddenError('admin required'));
  next();
};
