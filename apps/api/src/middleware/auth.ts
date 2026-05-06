import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { db } from '../db/client.js';
import type { Session, User } from '../db/types.js';
import { cookieSecure } from '../lib/cookie-flags.js';
import { AuthError, ForbiddenError } from '../lib/errors.js';
import { getSession, maybeRollSession } from '../services/auth.js';

declare global {
  namespace Express {
    interface Request {
      user?: User;
      session?: Session;
    }
  }
}

export const SESSION_COOKIE = 'vibetc_session';

const readSessionId = (req: Request): string | undefined => {
  const signed = req.signedCookies?.[SESSION_COOKIE];
  if (typeof signed === 'string' && signed.length > 0) return signed;
  return undefined;
};

export const loadSession: RequestHandler = async (req, res, next) => {
  try {
    const sid = readSessionId(req);
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
      res.cookie(SESSION_COOKIE, sid, {
        httpOnly: true,
        sameSite: 'lax',
        secure: cookieSecure(),
        signed: true,
        expires: session.expiresAt,
      });
    }
    req.user = ctx.user;
    req.session = session;
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
