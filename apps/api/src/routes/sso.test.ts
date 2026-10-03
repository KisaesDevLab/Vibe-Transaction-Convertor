// Vibe Auth single sign-on (ADR-027) — end to end against the in-process
// fake IdP and a real Postgres: the real engine, the real adapters, the
// real Express app built by createApp().
//
// Covers the integration plan's exit gate: local mode unchanged; `both`
// JIT-provisions with the mapped role and an ordinary cookie session;
// back-channel logout is accepted without a CSRF token and ends the
// session; oidc_only refuses local login and registration except for
// break-glass; the Appliance path prefix is handled.

import { breakglassEnsure, makeAudit, type VibeAuth } from '@kisaesdevlab/vibe-auth';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Express } from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, getPool } from '../db/client.js';
import { auditLog, sessions, userFeatureAccess, users } from '../db/schema.js';
import { createTxVibeAuth } from '../lib/vibe-auth.js';
import {
  BREAKGLASS_EMAIL,
  VIBETC_ROLES,
  createVibeAuditSink,
  createVibeUsers,
} from '../lib/vibe-auth-users.js';
import { SESSION_COOKIE } from '../middleware/auth.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../server.js';
import { FakeIdp, type FakeIdpUser } from '../test/fake-idp.js';

const databaseUrl = process.env.DATABASE_URL;
const live = describe.skipIf(!databaseUrl);

const __filename = fileURLToPath(import.meta.url);
const migrationsFolder = join(dirname(__filename), '..', 'db', 'migrations');

const CLIENT_ID = 'vibe-tx-converter';
const CLIENT_SECRET = 's3cret';
const PUBLIC_URL = 'http://tx.test';

const ALICE: FakeIdpUser = {
  sub: 'sub-alice',
  email: 'alice@firm.test',
  email_verified: true,
  name: 'Alice Manager',
  groups: ['vibe-manager'],
};

type Mode = 'local' | 'both' | 'oidc_only';

live('Vibe Auth SSO (live Postgres, fake IdP)', () => {
  let idp: FakeIdp;
  const started: VibeAuth[] = [];

  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = 'test-secret-must-be-at-least-32-bytes-long-XXXX';
  }

  const buildApp = async (
    mode: Mode,
    // publicUrl: null leaves VIBE_OIDC_PUBLIC_URL unset (URIs from the request).
    opts: { publicUrl?: string | null; basePath?: string } = {},
  ): Promise<{ app: Express; auth: VibeAuth }> => {
    const sso = createTxVibeAuth({
      logger: { info() {}, warn() {}, error() {} },
      env: {
        VIBE_AUTH_MODE: mode,
        VIBE_OIDC_ISSUER: idp.issuer,
        VIBE_OIDC_CLIENT_ID: CLIENT_ID,
        VIBE_OIDC_CLIENT_SECRET: CLIENT_SECRET,
        ...(opts.publicUrl === null ? {} : { VIBE_OIDC_PUBLIC_URL: opts.publicUrl ?? PUBLIC_URL }),
        ...(opts.basePath ? { VITE_BASE_PATH: opts.basePath } : {}),
      },
    });
    await sso.auth.start();
    await sso.auth.ready();
    started.push(sso.auth);
    // stripBasePath reads VITE_BASE_PATH from the process env at build time.
    const prevBase = process.env.VITE_BASE_PATH;
    if (opts.basePath) process.env.VITE_BASE_PATH = opts.basePath;
    else delete process.env.VITE_BASE_PATH;
    const app = createApp({ vibeAuth: sso });
    if (prevBase === undefined) delete process.env.VITE_BASE_PATH;
    else process.env.VITE_BASE_PATH = prevBase;
    return { app, auth: sso.auth };
  };

  // Browser walk: start → IdP authorize → callback. `prefix` is the
  // Appliance path the browser sees; the app strips it itself.
  // A fixed Host: each request(app) listens on a fresh port, and without
  // VIBE_OIDC_PUBLIC_URL the engine derives redirect URIs from the request
  // origin, which must match between start and callback (as in a browser).
  const ssoSignIn = async (app: Express, prefix = '') => {
    const start = await request(app).get(`${prefix}/auth/oidc/start`).set('Host', 'tx.test');
    expect(start.status).toBe(302);
    const authorize = await fetch(start.headers.location as string, { redirect: 'manual' });
    expect(authorize.status).toBe(302);
    const back = new URL(authorize.headers.get('location') as string);
    expect(back.pathname).toBe(`${prefix}/auth/oidc/callback`);
    return request(app)
      .get(back.pathname + back.search)
      .set('Host', 'tx.test');
  };

  const sessionCookie = (res: request.Response): string => {
    const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const hit = raw.map((c) => c.split(';')[0] ?? '').find((c) => c.startsWith(SESSION_COOKIE));
    if (!hit) throw new Error('no session cookie set');
    return hit;
  };

  const seedUser = async (email: string, role: 'admin' | 'staff', password: string) => {
    const [row] = await getDb()
      .insert(users)
      .values({ email, displayName: email, role, passwordHash: await hashPassword(password) })
      .returning();
    return row!;
  };

  const ensureBreakglass = async (): Promise<string> => {
    const result = await breakglassEnsure({
      users: createVibeUsers(getDb()),
      audit: makeAudit(createVibeAuditSink(getDb())),
      username: 'vibe-breakglass',
      adminRole: VIBETC_ROLES.adminRole,
      email: BREAKGLASS_EMAIL,
    });
    return result.password as string;
  };

  const csrfAgent = async (app: Express) => {
    const agent = request.agent(app);
    const res = await agent.get('/api/auth/csrf').expect(200);
    return { agent, token: res.body.token as string };
  };

  beforeAll(async () => {
    const pool = getPool();
    await pool.query('DROP SCHEMA IF EXISTS vibetc CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrate(getDb(), { migrationsFolder });
    idp = await new FakeIdp({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      user: ALICE,
    }).start();
  }, 60_000);

  afterAll(async () => {
    for (const a of started) a.stop();
    await idp.stop();
    await closeDb();
  });

  beforeEach(async () => {
    await getPool().query(
      'TRUNCATE vibetc.users, vibetc.auth_identities, vibetc.auth_settings, vibetc.auth_revocations CASCADE',
    );
    idp.user = { ...ALICE };
  });

  it('local mode: SSO is off and password login is unchanged', async () => {
    const { app } = await buildApp('local');
    await seedUser('pat@firm.test', 'staff', 'correcthorsebatterystaple');

    const status = await request(app).get('/auth/status');
    expect(status.status).toBe(200);
    expect(status.body.mode).toBe('local');
    expect(status.body.oidc.enabled).toBe(false);
    expect((await request(app).get('/auth/oidc/start')).status).toBe(409);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'pat@firm.test', password: 'correcthorsebatterystaple' });
    expect(login.status).toBe(200);
    const me = await request(app).get('/api/auth/me').set('Cookie', sessionCookie(login));
    expect(me.status).toBe(200);
    expect(me.body.sso).toBe(false);
  });

  it('both: sign-in JIT-provisions with the mapped role and an ordinary cookie session', async () => {
    const { app } = await buildApp('both');

    const status = await request(app).get('/auth/status');
    expect(status.body.oidc.enabled).toBe(true);
    expect(status.body.oidc.reachable).toBe(true);

    const cb = await ssoSignIn(app);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/');

    const me = await request(app).get('/api/auth/me').set('Cookie', sessionCookie(cb));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('alice@firm.test');
    expect(me.body.user.role).toBe('staff'); // vibe-manager → staff
    expect(me.body.sso).toBe(true);

    const db = getDb();
    const [alice] = await db.select().from(users).where(eq(users.email, 'alice@firm.test'));
    // Per-user feature denials are never written by SSO (default-on access).
    const grants = await db
      .select()
      .from(userFeatureAccess)
      .where(eq(userFeatureAccess.userId, alice!.id));
    expect(grants).toHaveLength(0);

    const [sess] = await db.select().from(sessions).where(eq(sessions.userId, alice!.id));
    expect(sess!.oidcSubject).toBe('sub-alice');
    expect(sess!.oidcSid).toBe('sid-sub-alice');
    // The ID token is stored wrapped, never as a bare JWT.
    expect(sess!.oidcIdToken).toBeTruthy();
    expect(sess!.oidcIdToken!.startsWith('eyJ')).toBe(false);

    const events = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'auth'), eq(auditLog.entityId, alice!.id)));
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['vibe.auth.user.provisioned', 'vibe.auth.login.success']),
    );
  });

  it('both: vibe-partner maps to admin and may read the auth settings; staff may not', async () => {
    const { app } = await buildApp('both');

    const staffCb = await ssoSignIn(app);
    const staffSettings = await request(app)
      .get('/auth/settings')
      .set('Cookie', sessionCookie(staffCb));
    expect(staffSettings.status).toBe(403);

    idp.user = {
      sub: 'sub-pam',
      email: 'pam@firm.test',
      email_verified: true,
      name: 'Pam Partner',
      groups: ['vibe-partner'],
    };
    const adminCb = await ssoSignIn(app);
    const me = await request(app).get('/api/auth/me').set('Cookie', sessionCookie(adminCb));
    expect(me.body.user.role).toBe('admin');
    const settings = await request(app).get('/auth/settings').set('Cookie', sessionCookie(adminCb));
    expect(settings.status).toBe(200);

    // Settings mutations keep CSRF protection; only the back-channel is exempt.
    const noCsrf = await request(app)
      .put('/auth/settings')
      .set('Cookie', sessionCookie(adminCb))
      .send({ idpName: 'Firm SSO' });
    expect(noCsrf.status).toBe(403);
  });

  it('back-channel logout needs no CSRF token and ends the SSO session', async () => {
    const { app } = await buildApp('both');
    const cb = await ssoSignIn(app);
    const cookie = sessionCookie(cb);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);

    const token = await idp.logoutToken({ sub: 'sub-alice', sid: 'sid-sub-alice' });
    const bc = await request(app)
      .post('/auth/oidc/backchannel')
      .type('form')
      .send({ logout_token: token });
    expect(bc.status).toBe(200);

    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('RP-initiated logout ends the session and sends id_token_hint to the IdP', async () => {
    const { app } = await buildApp('both');
    const cb = await ssoSignIn(app);
    const cookie = sessionCookie(cb);

    const out = await request(app).get('/auth/oidc/logout').set('Cookie', cookie);
    expect(out.status).toBe(302);
    const target = new URL(out.headers.location as string);
    expect(target.pathname).toMatch(/end-session\/$/);
    expect(target.searchParams.get('id_token_hint')).toMatch(/^eyJ/);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('oidc_only refuses to start without a break-glass account', async () => {
    const sso = createTxVibeAuth({
      logger: { info() {}, warn() {}, error() {} },
      env: {
        VIBE_AUTH_MODE: 'oidc_only',
        VIBE_OIDC_ISSUER: idp.issuer,
        VIBE_OIDC_CLIENT_ID: CLIENT_ID,
        VIBE_OIDC_CLIENT_SECRET: CLIENT_SECRET,
        VIBE_OIDC_PUBLIC_URL: PUBLIC_URL,
      },
    });
    await expect(sso.auth.start()).rejects.toThrow();
    sso.auth.stop();
  });

  it('oidc_only: only break-glass signs in locally; registration is closed', async () => {
    const password = await ensureBreakglass();
    await seedUser('pat@firm.test', 'staff', 'correcthorsebatterystaple');
    const { app } = await buildApp('oidc_only');

    const refused = await request(app)
      .post('/api/auth/login')
      .send({ email: 'pat@firm.test', password: 'correcthorsebatterystaple' });
    expect(refused.status).toBe(403);

    const { agent, token } = await csrfAgent(app);
    const register = await agent
      .post('/api/auth/register')
      .set('x-csrf-token', token)
      .send({ email: 'new@firm.test', password: 'correcthorsebatterystaple', displayName: 'N' });
    expect(register.status).toBe(403);

    const bg = await request(app)
      .post('/api/auth/login')
      .send({ email: BREAKGLASS_EMAIL, password });
    expect(bg.status).toBe(200);
    expect(bg.body.user.role).toBe('admin');

    const [row] = await getDb().select().from(users).where(eq(users.email, BREAKGLASS_EMAIL));
    const used = await getDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'vibe.auth.breakglass.used'), eq(auditLog.entityId, row!.id)));
    expect(used.length).toBeGreaterThan(0);
  });

  it('an IdP identity claiming the break-glass address is never linked to it', async () => {
    await ensureBreakglass();
    const { app } = await buildApp('both');
    idp.user = {
      sub: 'sub-mallory',
      email: BREAKGLASS_EMAIL,
      email_verified: true,
      name: 'Mallory',
      groups: ['vibe-staff'],
    };

    const cb = await ssoSignIn(app);
    const setCookies = ([] as string[]).concat(cb.headers['set-cookie'] ?? []);
    expect(setCookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);

    const [bg] = await getDb().select().from(users).where(eq(users.email, BREAKGLASS_EMAIL));
    const linked = await getPool().query(
      'SELECT 1 FROM vibetc.auth_identities WHERE user_id = $1',
      [bg!.id],
    );
    expect(linked.rowCount).toBe(0);
    const bgSessions = await getDb().select().from(sessions).where(eq(sessions.userId, bg!.id));
    expect(bgSessions).toHaveLength(0);
  });

  it('a disabled account can neither keep its session nor sign in with a password', async () => {
    const { app } = await buildApp('both');
    const pat = await seedUser('pat@firm.test', 'staff', 'correcthorsebatterystaple');
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'pat@firm.test', password: 'correcthorsebatterystaple' });
    const cookie = sessionCookie(login);

    await createVibeUsers(getDb()).setActive!(pat.id, false);

    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
    const again = await request(app)
      .post('/api/auth/login')
      .send({ email: 'pat@firm.test', password: 'correcthorsebatterystaple' });
    expect(again.status).toBe(401);
  });

  it('serves /auth/* under the Appliance path prefix and redirects back into it', async () => {
    const prefix = '/vibe-tx-converter';
    const { app } = await buildApp('both', {
      publicUrl: `${PUBLIC_URL}${prefix}`,
      basePath: `${prefix}/`,
    });

    const status = await request(app).get(`${prefix}/auth/status`);
    expect(status.status).toBe(200);
    expect(status.body.oidc.startPath).toBe(`${prefix}/auth/oidc/start`);

    const cb = await ssoSignIn(app, prefix);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe(`${prefix}/`);
    const me = await request(app).get(`${prefix}/api/auth/me`).set('Cookie', sessionCookie(cb));
    expect(me.status).toBe(200);
    expect(me.body.sso).toBe(true);
  });

  it('keeps the path prefix in redirect URIs when VIBE_OIDC_PUBLIC_URL is unset', async () => {
    // e.g. issuer + client configured from Admin → Authentication only.
    const prefix = '/vibe-tx-converter';
    const { app } = await buildApp('both', { publicUrl: null, basePath: `${prefix}/` });

    // ssoSignIn asserts the IdP sends the browser back to <prefix>/auth/oidc/callback.
    const cb = await ssoSignIn(app, prefix);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe(`${prefix}/`);
  });
});
