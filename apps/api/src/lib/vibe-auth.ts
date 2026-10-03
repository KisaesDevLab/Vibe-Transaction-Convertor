// Vibe Auth single sign-on (ADR-027). @kisaesdevlab/vibe-auth owns the
// OIDC flow (Authorization Code + PKCE), the Settings → Authentication API
// and the break-glass rules; this module is the product side:
//
//   - SessionAdapter: an SSO sign-in creates the same `sessions` row and
//     signed `vibetc_session` cookie a password login does, plus the OIDC
//     identity (issuer/subject/sid, wrapped ID token) on the row.
//   - Identity / settings / revocation stores on the vibetc.auth_* tables.
//   - Client secret and ID token wrapped with the SESSION_SECRET-derived
//     AES-GCM key (lib/secrets.ts, ADR-020); audit into audit_log.
//
// Paths: the engine runs with basePath = the SPA prefix ('' standalone,
// e.g. '/vibe-tx-converter' on the Appliance), so every path it hands the
// browser (login page, return-to, start / test URLs) and the redirect URIs
// it derives from the request when VIBE_OIDC_PUBLIC_URL is unset all carry
// the prefix. stripBasePath() has already removed the prefix from req.url
// (whether or not the proxy kept it), so the middleware re-adds it before
// handing the request to the engine.
//
// With VIBE_AUTH_MODE=local (the default) and no issuer configured the
// engine makes no network calls; `/auth/status` reports oidc disabled.

import express, { type Request, type RequestHandler, type Response } from 'express';
import { and, eq, or, type SQL } from 'drizzle-orm';
import {
  createPgStores,
  createVibeAuth,
  sendHttpResponse,
  toHttpRequest,
  type HttpRequest,
  type HttpResponse,
  type Logger,
  type SessionAdapter,
  type VibeAuth,
} from '@kisaesdevlab/vibe-auth';

import { db as defaultDb, pool as defaultPool, type Db } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { clearSessionCookie, readSessionCookie, setSessionCookie } from '../middleware/auth.js';
import { createSession, logout } from '../services/auth.js';
import { logger as appLogger } from './logger.js';
import { unwrapSecret, wrapSecret } from './secrets.js';
import {
  BREAKGLASS_EMAIL,
  VIBETC_ROLES,
  createVibeAuditSink,
  createVibeUsers,
} from './vibe-auth-users.js';

const AUTH_PREFIX = '/auth';
const AUTH_SETTINGS_FEATURE = 'admin.authentication';

const TABLES = {
  identities: 'vibetc.auth_identities',
  settings: 'vibetc.auth_settings',
  revocations: 'vibetc.auth_revocations',
};

interface QueryablePool {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface TxVibeAuthOptions {
  db?: Db;
  pool?: QueryablePool;
  env?: typeof process.env;
  fetch?: typeof fetch;
  logger?: Logger;
}

export interface TxVibeAuth {
  auth: VibeAuth;
  // Mount at app level after loadSession and csrf().
  middleware: RequestHandler;
  // Browser-facing SPA prefix ('' or e.g. '/vibe-tx-converter').
  spaPrefix: string;
}

const trimSlash = (p: string): string => p.replace(/\/+$/, '');

// The SPA is built under VITE_BASE_PATH (scripts/web-base-path.sh); fall
// back to the path of VIBE_OIDC_PUBLIC_URL, which the Appliance writes with
// the prefix included.
export const spaPrefixFrom = (env: typeof process.env): string => {
  const base = env.VITE_BASE_PATH?.trim();
  if (base && base !== '/') return trimSlash(base.startsWith('/') ? base : `/${base}`);
  const pub = env.VIBE_OIDC_PUBLIC_URL?.trim();
  if (!pub) return '';
  try {
    return trimSlash(new URL(pub).pathname);
  } catch {
    return '';
  }
};

const pinoLogger = (): Logger => ({
  info: (msg, meta) => appLogger.info(meta ?? {}, msg),
  warn: (msg, meta) => appLogger.warn(meta ?? {}, msg),
  error: (msg, meta) => appLogger.error(meta ?? {}, msg),
});

const wrap = (plaintext: string): string => wrapSecret(plaintext).toString('base64');
const unwrap = (wrapped: string): string => unwrapSecret(Buffer.from(wrapped, 'base64'));

export const createTxVibeAuth = (opts: TxVibeAuthOptions = {}): TxVibeAuth => {
  const db = opts.db ?? defaultDb;
  const pool = opts.pool ?? defaultPool;
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? pinoLogger();
  const spaPrefix = spaPrefixFrom(env);
  const warn = (msg: string, meta?: Record<string, unknown>) => logger.warn(msg, meta);

  const stores = createPgStores({
    query: async (text, params = []) =>
      (await pool.query(text, params as unknown[])).rows as Array<Record<string, unknown>>,
    tables: TABLES,
  });

  const session: SessionAdapter<Request, Response> = {
    // Same row + cookie as POST /api/auth/login, plus the identity.
    async create(_req, res, user, identity) {
      const { sessionId, expiresAt } = await createSession(db, user.id, {
        issuer: identity.issuer,
        subject: identity.subject,
        ...(identity.sid ? { sid: identity.sid } : {}),
        ...(identity.idToken ? { idTokenWrapped: wrap(identity.idToken) } : {}),
      });
      setSessionCookie(res, sessionId, expiresAt);
    },

    async destroy(req, res) {
      const sid = readSessionCookie(req);
      if (sid) await logout(db, sid);
      clearSessionCookie(res);
    },

    // loadSession already ran (and refused expired / disabled sessions).
    async currentUserId(req) {
      return req.user?.id ?? null;
    },

    async currentIdentity(req) {
      const s = req.session;
      if (!s?.oidcIssuer || !s.oidcSubject) return null;
      let idToken: string | undefined;
      if (s.oidcIdToken) {
        try {
          idToken = unwrap(s.oidcIdToken);
        } catch {
          // SESSION_SECRET rotated: logout still works, just without the hint.
        }
      }
      return {
        issuer: s.oidcIssuer,
        subject: s.oidcSubject,
        ...(s.oidcSid ? { sid: s.oidcSid } : {}),
        ...(idToken ? { idToken } : {}),
      };
    },

    // Back-channel logout. With a resolved user every session of theirs
    // ends (the IdP said this person is signed out); a sid-only token ends
    // just the sessions born from that IdP session.
    async destroyByIdentity(i) {
      const conds: SQL[] = [];
      if (i.sid) conds.push(eq(sessions.oidcSid, i.sid));
      if (i.subject) {
        const c = and(eq(sessions.oidcIssuer, i.issuer), eq(sessions.oidcSubject, i.subject));
        if (c) conds.push(c);
      }
      if (i.userId) conds.push(eq(sessions.userId, i.userId));
      if (conds.length === 0) return 0;
      const ended = await db
        .delete(sessions)
        .where(conds.length === 1 ? conds[0] : or(...conds))
        .returning({ id: sessions.id });
      return ended.length;
    },
  };

  // Settings → Authentication follows the same gates as every other admin
  // page: admin role (requireAdmin) plus the per-user feature
  // (requireFeature). loadSession already resolved user + feature map.
  const authorizeAdmin = async (req: HttpRequest): Promise<{ userId: string } | null> => {
    const r = req.raw.req as Request;
    if (!r.user || r.user.role !== VIBETC_ROLES.adminRole) return null;
    if (r.featureAccess?.[AUTH_SETTINGS_FEATURE] === false) return null;
    return { userId: r.user.id };
  };

  const auth = createVibeAuth({
    product: { slug: 'vibe-tx-converter', name: 'Transaction Converter', roles: VIBETC_ROLES },
    users: createVibeUsers(db, { warn }),
    session,
    identities: stores.identities,
    settings: stores.settings,
    revocations: stores.revocations,
    secretWrap: {
      wrap: async (plaintext) => wrap(plaintext),
      unwrap: async (wrapped) => unwrap(wrapped),
    },
    audit: createVibeAuditSink(db, { warn }),
    env,
    basePath: spaPrefix,
    loginPath: '/login',
    breakglassLoginPath: '/login/local',
    breakglassEmail: BREAKGLASS_EMAIL,
    trustProxy: true,
    syncRoles: true,
    authorizeAdmin,
    logger,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  const urlencoded = express.urlencoded({ extended: false });

  const middleware: RequestHandler = (req, res, next) => {
    if (req.path !== AUTH_PREFIX && !req.path.startsWith(`${AUTH_PREFIX}/`)) return next();
    // The back-channel logout posts a form; scoped here so no other route
    // starts accepting urlencoded bodies.
    urlencoded(req, res, (err?: unknown) => {
      if (err) return next(err);
      // toHttpRequest reads originalUrl, which carries the prefix only when
      // the proxy kept it; rebuild from the always-stripped req.url instead.
      const httpReq = { ...toHttpRequest(req, res), url: spaPrefix + req.url };
      auth
        .handle(httpReq)
        .then((r) => {
          if (!r) return next();
          sendHttpResponse(res, withPageCsp(r, res));
        })
        .catch(next);
    });
  };

  return { auth, middleware, spaPrefix };
};

const withPageCsp = (r: HttpResponse, res: Response): HttpResponse => {
  // The engine's own pages (logged out, sign-in error, test-connection
  // result) carry inline style and, for the popup, an inline postMessage
  // script. helmet's CSP blocks both, so these pages — and only these —
  // get a CSP that permits exactly that, and the popup keeps window.opener.
  const type = String(r.headers['content-type'] ?? '');
  if (type.includes('text/html')) {
    r.headers['content-security-policy'] =
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
    res.removeHeader('Cross-Origin-Opener-Policy');
  }
  return r;
};
