# ADR-015 — Cookie-session auth, single firm per host

## Status

Accepted.

## Context

The product is internal to a single firm at a single deployment. There is
no external user base, no multi-tenant isolation requirement, and no SSO
provider integration in v1. We need just enough auth to (a) prove who
performed each action for the audit log, (b) keep the UI usable for
multiple staff in a firm, and (c) make CSRF / session-fixation attacks
impractical. Anything beyond that is yak-shaving.

## Decision

Auth uses a **server-side cookie session** with these properties:

- Sessions are persisted in the `sessions` Postgres table — server-side
  storage, not a self-contained signed cookie. The cookie carries an
  opaque session ID, signed with `SESSION_SECRET`.
- Cookie attributes: `httpOnly`, `sameSite=lax`, `secure` when HTTPS is
  detected (Caddy or reverse-proxy upstream sets `X-Forwarded-Proto`),
  `maxAge: 30d` with rolling renewal at half-life.
- Passwords hashed with `argon2id` (`memoryCost: 19456, timeCost: 2,
parallelism: 1`).
- **CSRF protection** uses the double-submit cookie pattern: every
  mutating endpoint (POST/PUT/PATCH/DELETE) requires a CSRF token
  fetched from `GET /api/auth/csrf` and submitted in a header.
- **Single firm per host** — no tenant column on tables, no per-request
  tenant resolution. If a customer needs multiple firms, they run
  multiple deployments with separate Postgres databases.
- No SSO, no SAML, no OIDC in v1. First-time setup creates an admin via
  a self-bootstrap page that's only available when zero users exist.

## Consequences

- **Pro:** Boot path is one query (look up the session row), no JWT
  validation, no key rotation choreography.
- **Pro:** Logout is `DELETE` of a row — immediate revocation, unlike
  signed JWTs.
- **Pro:** Smaller attack surface than a token-mint pipeline.
- **Con:** Each authenticated request hits the DB to look up the session
  row. We accept the cost; sessions are tiny and Postgres handles this
  trivially.
- **Con:** Sharing a session across multiple deployments is impossible
  (and out of scope).

## References

- `apps/api/src/services/auth.ts`
- `apps/api/src/middleware/auth.ts`
- `apps/api/src/middleware/csrf.ts`
- BuildPlan.md §3 ADR-015, Phase 6.
