import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { ForbiddenError } from '../lib/errors.js';

const COOKIE = 'vibetc_csrf';
const HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const issueToken = (): string => randomBytes(24).toString('hex');

const setCookie = (res: Response, token: string): void => {
  res.cookie(COOKIE, token, {
    httpOnly: false, // double-submit pattern: client JS must read this
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000,
  });
};

const exemptPaths = new Set<string>([
  '/api/auth/login', // login uses rate limiting, not CSRF (Phase 6)
]);

export const csrf = (): RequestHandler => (req: Request, res: Response, next: NextFunction) => {
  const existing = req.cookies?.[COOKIE] as string | undefined;
  if (!existing) {
    setCookie(res, issueToken());
  }

  if (SAFE_METHODS.has(req.method) || exemptPaths.has(req.path)) {
    return next();
  }

  const headerValue = req.header(HEADER);
  const cookieValue = req.cookies?.[COOKIE] as string | undefined;
  if (!headerValue || !cookieValue) {
    return next(new ForbiddenError('Missing CSRF token'));
  }
  const a = Buffer.from(headerValue);
  const b = Buffer.from(cookieValue);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return next(new ForbiddenError('Invalid CSRF token'));
  }
  next();
};

export const csrfTokenHandler: RequestHandler = (req, res) => {
  let token = req.cookies?.[COOKIE] as string | undefined;
  if (!token) {
    token = issueToken();
    setCookie(res, token);
  }
  res.json({ token });
};
