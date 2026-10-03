# ADR-027 — Single sign-on via Vibe Auth (`@kisaesdevlab/vibe-auth`)

## Status

Accepted (2026-10-02). Amends ADR-015 (cookie-session auth) and removes
"SSO / SAML / OIDC" from the v1 out-of-scope list (BuildPlan Appendix D).
SAML and third-party SSO integrations other than Vibe Auth stay out of scope.

## Context

Every Vibe product is moving to one firm-wide identity provider: **Vibe Auth**,
the appliance's authentik-backed broker. Staff sign in once and reach every
product. Without it, admins keep separate user lists in every product, and a
departing employee has to be removed by hand from each one.

The Vibe family ships a shared client package, `@kisaesdevlab/vibe-auth`, that
owns the OIDC flow. It handles the Authorization Code + PKCE flow, ID-token
validation, back-channel and RP-initiated logout, the Settings → Authentication
API, role mapping, and the break-glass CLI. A product implements only adapters
over its own users, sessions and audit log. Trial Balance, Vibe-1040,
Vibe-1099, Recap, Calculators and Sentinel already use it. The per-product plan
is `Vibe-Auth/docs/integration-plans/vibe-transaction-convertor.md`.

## Decision

Adopt `@kisaesdevlab/vibe-auth` as the only SSO mechanism. ADR-015's
server-side session remains the session of record.

- **Modes.** `VIBE_AUTH_MODE` = `local` (default) | `both` | `oidc_only`, and
  an admin can override it from Settings → Authentication. **`local` behaves
  exactly as before.** `oidc_only` refuses local password login except for the
  break-glass account, and refuses to boot without one.
- **Sessions.** An SSO sign-in inserts the same `vibetc.sessions` row and sets
  the same signed `vibetc_session` cookie as a password login. The row also
  carries `oidc_issuer`, `oidc_subject`, `oidc_sid`, and an AES-GCM-wrapped
  `oidc_id_token` (used for `id_token_hint` on logout). Back-channel logout
  deletes rows matching the `sid`, then `(issuer, subject)`, then the user.
- **Users and roles.** Users are linked by `(issuer, subject)` in
  `vibetc.auth_identities`, or by verified email. An unknown user is created
  on first sign-in only when `VIBE_OIDC_ALLOW_JIT` is on (just-in-time
  provisioning, "JIT"). JIT users have an unusable password hash, so they can
  sign in only through SSO. Role mapping: `vibe-admin`, `vibe-it` and
  `vibe-partner` → `admin`; `vibe-manager` and `vibe-staff` → `staff`.
  Role sync refuses to demote the last active admin. Per-user
  `user_feature_access` denials are never touched by SSO.
- **Disabled users.** New nullable `users.disabled_at`. A disabled user's
  sessions are ignored by `loadSession`, and password login is refused.
- **Mounting.** The package middleware handles `/auth/*` and mounts after
  `loadSession` and the global `csrf()`, so the admin settings mutations
  (`PUT /auth/settings`, `POST /auth/settings/test`) need the CSRF header
  like every other mutation. The only new CSRF exemption is
  `POST /auth/oidc/backchannel`: a server-to-server form POST from the IdP,
  authenticated by a signed logout token. (The per-product plan suggested
  mounting before `csrf()`; that would have exempted the settings API as
  well.)
- **Secrets.** The OIDC client secret stored from the settings page and the
  ID token are wrapped with the existing `SESSION_SECRET`-derived AES-256-GCM
  key-wrap (`lib/secrets.ts`, ADR-020).
- **Audit.** Every package event (`vibe.auth.*`) is written to the append-only
  `audit_log` (ADR-013) with `entity_type = 'auth'`. The audit write never
  fails a sign-in.
- **Break-glass.** A local admin account, `vibe-breakglass`, stored as
  `vibe-breakglass@vibe-tx-converter.local`, is created by
  `vibe-auth breakglass ensure`. The Appliance runs that command in the
  container through `apps/api/dist/vibeAuthAdapter.js`. The account signs in
  at `/login/local`.

## Network invariant

The "zero outbound network calls at runtime by default" invariant still holds:
in `local` mode, or when no issuer is configured, the package makes no network
calls. SSO is a second opt-in egress exception, alongside the Anthropic
provider:

- The API talks only to the configured issuer, through `VIBE_OIDC_INTERNAL_BASE`
  when set. On the Appliance, that is the on-box Vibe Auth container. The calls
  are discovery, JWKS, token and userinfo.
- No statement data, PDFs, page images or transaction content is ever sent; the
  calls carry only OAuth parameters.
- Each sign-in, logout and settings change is audit-logged.

## Consequences

- **Pro:** One identity per person across the Vibe family; offboarding is one
  click in Vibe Auth, and back-channel logout ends sessions here immediately.
- **Pro:** Local login and first-admin bootstrap are untouched in `local` mode,
  so standalone installs are unaffected.
- **Con:** A private dependency from GitHub Packages. Image builds need a
  `NODE_AUTH_TOKEN` BuildKit secret, and developers need a token in `~/.npmrc`.
- **Con:** A new public route family (`/auth/*`) and a CSRF-exempt POST
  (`/auth/oidc/backchannel`, authenticated by a signed logout token instead).

## References

- `apps/api/src/lib/vibe-auth.ts`, `apps/api/src/lib/vibe-auth-users.ts`,
  `apps/api/src/vibeAuthAdapter.ts`
- `apps/api/src/db/migrations/0018_vibe_auth.sql`
- `docs/sso.md`
- `Vibe-Auth/docs/integration-checklist.md`
