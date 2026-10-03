# Single sign-on (Vibe Auth)

Transaction Converter can sign staff in through **Vibe Auth**, the Vibe
Appliance's firm-wide identity provider (OIDC). It is **off by default**: a
fresh install behaves exactly as before, with email + password sign-in and
the first-admin `/register` page. Design record: [ADR-027](adrs/ADR-027-vibe-auth-sso.md).

## Sign-in modes

| Mode        | Password sign-in                  | SSO button | Notes                                                   |
| ----------- | --------------------------------- | ---------- | ------------------------------------------------------- |
| `local`     | yes                               | no         | Default. No network calls to any identity provider.     |
| `both`      | yes                               | yes        | Use this while staff move over.                         |
| `oidc_only` | break-glass only (`/login/local`) | yes        | Refuses to start without an active break-glass account. |

The mode comes from `VIBE_AUTH_MODE`. An admin can override it, and the
identity-provider fields, at **Admin → Authentication**. That page refuses to
switch to `oidc_only` until a test sign-in has succeeded and the break-glass
account exists.

## On the Vibe Appliance

1. Enable **Vibe Auth** in the console.
2. Register this app: Identity panel, or `sudo vibe identity register vibe-tx-converter`.
   This writes the `VIBE_OIDC_*` settings, restarts the app, and creates the
   break-glass account. Its password is printed once to `CREDENTIALS.txt`.
3. In the Identity panel set the mode to `both`, sign in with Vibe Auth to
   check it, then move to `oidc_only` if the firm wants SSO-only access.

The break-glass account signs in at `<app URL>/login/local` with the email
`vibe-breakglass@vibe-tx-converter.local` and the stored password. Use it only
when Vibe Auth is down. Every use is written to the audit log
(`vibe.auth.breakglass.used`).

## Who gets in, and with which role

- A person is matched by their Vibe Auth identity. On the first sign-in, a
  verified email that matches an existing user links the two accounts.
- Unknown people are created on first sign-in (`VIBE_OIDC_ALLOW_JIT=true`,
  the default). They can sign in only through SSO; they have no usable
  password.
- Roles come from Vibe Auth groups on every sign-in:

  | Vibe Auth group                         | Role here |
  | --------------------------------------- | --------- |
  | `vibe-admin`, `vibe-it`, `vibe-partner` | admin     |
  | `vibe-manager`, `vibe-staff`            | staff     |

  Override with `VIBE_OIDC_ROLE_MAP` (JSON) or on the Authentication page. A
  person whose groups map to nothing is refused, unless `VIBE_OIDC_DEFAULT_ROLE`
  is set. Role sync never demotes the last remaining admin.

- Per-user feature access (Admin → Access) is managed here as before; SSO
  never changes it.

## Signing out

Signing out of an SSO session also ends the Vibe Auth session (RP-initiated
logout). When Vibe Auth ends someone's session (they sign out of another Vibe
app, or an admin removes their access), it sends a back-channel logout and
their SSO sessions here end immediately.

## Standalone installs

Set `VIBE_OIDC_ISSUER`, `VIBE_OIDC_CLIENT_ID`, `VIBE_OIDC_CLIENT_SECRET` and
`VIBE_OIDC_PUBLIC_URL` to point at a Vibe Auth broker. Register these URIs with
the client:

- redirect: `<public URL>/auth/oidc/callback`
- back-channel logout: `<public URL>/auth/oidc/backchannel`
- post-logout: `<public URL>/auth/oidc/logged-out`

See `.env.example` for the full list.

## Network and security notes

- In `local` mode, or with no issuer configured, the app makes **no** outbound
  calls.
- With SSO on, the API calls only the configured issuer (discovery, keys,
  token, userinfo). On the Appliance that is the on-box Vibe Auth container.
  No statement data, PDFs or images are ever sent.
- The OIDC client secret saved on the Authentication page, and the ID token
  kept for sign-out, are encrypted at rest with the `SESSION_SECRET`-derived
  AES-256-GCM key.
- `/auth/*` routes sit behind the same CSRF guard as `/api/*`. The one
  exception is `POST /auth/oidc/backchannel`, which is authenticated by the
  identity provider's signed logout token.
- The app's own CSP is unchanged: the browser is redirected to the identity
  provider and never fetches from it. The few HTML pages the engine serves
  itself ("signed out", sign-in error, test-connection popup) carry their own
  narrow CSP.

## Developers

- The package `@kisaesdevlab/vibe-auth` comes from GitHub Packages. Put a
  token with `read:packages` in `~/.npmrc`:
  `//npm.pkg.github.com/:_authToken=<token>`. Docker builds need it as a
  BuildKit secret: `NODE_AUTH_TOKEN=<token> docker compose build`, or
  `docker build --secret id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN .`.
- Code: `apps/api/src/lib/vibe-auth.ts` (engine + session adapter),
  `apps/api/src/lib/vibe-auth-users.ts` (user adapter, audit sink),
  `apps/api/src/vibeAuthAdapter.ts` (break-glass CLI), migration
  `0018_vibe_auth.sql`.
- Tests: `apps/api/src/routes/sso.test.ts` runs the full flow against an
  in-process fake identity provider (needs `DATABASE_URL`).
- Break-glass CLI in dev: `cd apps/api && pnpm build && pnpm exec vibe-auth breakglass status --json`.
