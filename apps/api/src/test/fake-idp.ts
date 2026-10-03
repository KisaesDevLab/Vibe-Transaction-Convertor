// In-process fake OpenID Provider for the Vibe Auth SSO tests (ADR-027).
//
// A port of Vibe-Auth/packages/client/test/fake-idp.ts (via Vibe-Calculators).
// The published @kisaesdevlab/vibe-auth ships only dist/ and sql/, so the fake
// provider has to live here; keep the behaviour identical to the upstream file
// when re-syncing. It implements discovery, JWKS, authorization (auto-consents
// the configured user), token (PKCE S256 + client_secret_basic), userinfo,
// end-session, and can mint back-channel logout tokens. Listens on 127.0.0.1,
// which the no-egress allowlist permits.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';

export interface FakeIdpUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  groups?: string[];
  roles?: string[];
  amr?: string[];
}

export interface FakeIdpOptions {
  clientId: string;
  clientSecret?: string;
  user: FakeIdpUser;
}

interface PendingCode {
  redirectUri: string;
  nonce: string;
  codeChallenge: string | undefined;
}

export class FakeIdp {
  private server: Server | null = null;
  private port = 0;
  private priv: KeyLike | null = null;
  private pub: KeyLike | null = null;
  private readonly kid = 'test-key';
  private codes = new Map<string, PendingCode>();
  private accessTokens = new Map<string, string>();
  user: FakeIdpUser;

  constructor(private readonly opts: FakeIdpOptions) {
    this.user = opts.user;
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  get issuer(): string {
    return `${this.base}/application/o/test/`;
  }

  async start(): Promise<this> {
    const kp = await generateKeyPair('RS256');
    this.priv = kp.privateKey;
    this.pub = kp.publicKey;
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    // Keep-alive sockets from discovery/JWKS fetches would hold close() open.
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }

  private async signIdToken(o: { nonce: string; accessToken: string }): Promise<string> {
    const u = this.user;
    const claims: Record<string, unknown> = {
      email: u.email,
      email_verified: u.email_verified,
      name: u.name,
      groups: u.groups,
      roles: u.roles,
      amr: u.amr ?? ['pwd'],
      sid: `sid-${u.sub}`,
      ...(o.nonce ? { nonce: o.nonce } : {}),
      at_hash: atHash(o.accessToken),
    };
    for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: this.kid })
      .setIssuer(this.issuer)
      .setSubject(u.sub)
      .setAudience(this.opts.clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(this.priv as KeyLike);
  }

  /** A back-channel logout token for `sub` and/or the IdP session `sid`. */
  async logoutToken(o: { sub?: string; sid?: string }): Promise<string> {
    const j = new SignJWT({
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      ...(o.sid ? { sid: o.sid } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: this.kid })
      .setIssuer(this.issuer)
      .setAudience(this.opts.clientId)
      .setIssuedAt()
      .setJti(randomUUID());
    if (o.sub) j.setSubject(o.sub);
    return j.sign(this.priv as KeyLike);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.base);
    const path = url.pathname;
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (path.endsWith('/.well-known/openid-configuration')) {
      const iss = this.issuer;
      return send(200, {
        issuer: iss,
        authorization_endpoint: `${iss}authorize/`,
        token_endpoint: `${iss}token/`,
        userinfo_endpoint: `${iss}userinfo/`,
        jwks_uri: `${iss}jwks/`,
        end_session_endpoint: `${iss}end-session/`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['RS256'],
        backchannel_logout_supported: true,
        backchannel_logout_session_supported: true,
      });
    }
    if (path.endsWith('/jwks/')) {
      const jwk = await exportJWK(this.pub as KeyLike);
      return send(200, { keys: [{ ...jwk, kid: this.kid, use: 'sig', alg: 'RS256' }] });
    }
    if (path.endsWith('/authorize/')) {
      const q = url.searchParams;
      const redirectUri = q.get('redirect_uri') ?? '';
      const state = q.get('state') ?? '';
      if (q.get('client_id') !== this.opts.clientId) {
        return send(400, { error: 'unauthorized_client' });
      }
      if (q.get('code_challenge_method') !== 'S256') {
        return send(400, { error: 'invalid_request', error_description: 'PKCE S256 required' });
      }
      const code = randomUUID();
      this.codes.set(code, {
        redirectUri,
        nonce: q.get('nonce') ?? '',
        codeChallenge: q.get('code_challenge') ?? undefined,
      });
      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      target.searchParams.set('state', state);
      res.writeHead(302, { location: target.toString() });
      return void res.end();
    }
    if (path.endsWith('/token/') && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      if (this.opts.clientSecret) {
        const expected =
          'Basic ' +
          Buffer.from(
            `${encodeURIComponent(this.opts.clientId)}:${encodeURIComponent(this.opts.clientSecret)}`,
          ).toString('base64');
        if (req.headers.authorization !== expected) return send(401, { error: 'invalid_client' });
      }
      const code = form.get('code') ?? '';
      const pc = this.codes.get(code);
      this.codes.delete(code);
      if (!pc) return send(400, { error: 'invalid_grant' });
      if (pc.redirectUri !== form.get('redirect_uri')) {
        return send(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      }
      if (pc.codeChallenge) {
        const verifier = form.get('code_verifier') ?? '';
        if (b64url(createHash('sha256').update(verifier).digest()) !== pc.codeChallenge) {
          return send(400, { error: 'invalid_grant', error_description: 'pkce' });
        }
      }
      const accessToken = `at-${randomUUID()}`;
      this.accessTokens.set(accessToken, this.user.sub);
      const idToken = await this.signIdToken({ nonce: pc.nonce, accessToken });
      return send(200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken,
        scope: 'openid profile email',
      });
    }
    if (path.endsWith('/userinfo/')) {
      const t = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!this.accessTokens.has(t)) return send(401, { error: 'invalid_token' });
      const u = this.user;
      return send(200, {
        sub: u.sub,
        email: u.email,
        email_verified: u.email_verified,
        name: u.name,
        groups: u.groups,
        roles: u.roles,
      });
    }
    if (path.endsWith('/end-session/')) {
      res.writeHead(302, { location: url.searchParams.get('post_logout_redirect_uri') ?? '/' });
      return void res.end();
    }
    send(404, { error: 'not_found', path });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d));
  });
}

function b64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function atHash(accessToken: string): string {
  const h = createHash('sha256').update(accessToken).digest();
  return b64url(h.subarray(0, 16));
}
