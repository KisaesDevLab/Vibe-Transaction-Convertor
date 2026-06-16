# Security

This document is for the firm's IT operator and any reviewer doing a
SOC 2, vendor-risk, or due-diligence pass. It covers how the application
authenticates, what egresses, what is encrypted at rest, and what is
explicitly out of scope.

## Threat model and scope

`vibe-tx-converter` is licensed under PolyForm Internal Use 1.0.0. It is
**not intended for public deployment**. The threat model assumes:

- A single firm runs the application on hardware they control.
- Operators are the firm's IT staff. End users are the firm's
  bookkeepers and accountants.
- The application is reachable only on the firm's internal network or
  VPN — not exposed directly to the public internet.
- The Vibe Appliance overlay runs the same app behind the appliance's
  reverse proxy, so the same trust boundary applies.

Multi-tenant deployment is **out of scope for v1**: one firm per host,
no tenant id on any DB row. Public REST API for external callers is out
of scope. SSO, SAML, OIDC are out of scope.

## Authentication

- Cookie-session (ADR-015). Sessions are server-side, stored in the
  `vibetc.sessions` Postgres table. Cookies are signed (HMAC) and the
  session record is opaque.
- Cookies are `HttpOnly`, `Secure` (when behind HTTPS), `SameSite=Lax`,
  scoped to the configured host.
- Passwords are hashed with **argon2id** at registration and on
  password change. There is no password-reset email flow in v1; admins
  reset staff passwords and are returned a one-time temporary password
  to deliver out of band.
- Session lifetime is 30 days; logout deletes the session row.
- The first `POST /api/auth/register` is allowed without auth (the
  bootstrap admin); after that, registration requires admin auth.

## CSRF

Every mutating endpoint (`POST`, `PATCH`, `DELETE`) requires a CSRF
token from `GET /api/auth/csrf`. The web client uses a double-submit
pattern: the token is read from a cookie and echoed in the
`X-CSRF-Token` header. The server compares both.

## Account-number masking

Account numbers are stored in full but rendered masked
(`••••1234`). The reveal flow is:

- `GET /api/accounts/:id?reveal=true` is admin-only.
- The full number is shown for **30 seconds** in the UI, then re-masked.
- Every reveal is audit-logged with the actor and the account.

## Audit log (append-only, enforced at the DB level)

ADR-013. The `vibetc.audit_log` table is granted `INSERT, SELECT` to
the application role; `UPDATE` and `DELETE` are revoked. There is no
code path in the application that mutates or removes audit rows.
Retention is configurable via `AUDIT_RETENTION_DAYS`; unset (default)
keeps everything.

Every state-changing API call writes an audit entry with the actor,
entity type/id, action, and a redacted JSON delta. PII is never written
at info-level structured-log fields; sensitive deltas are redacted
before persistence.

## Encryption at rest

- **Anthropic API key** (when the optional Tier 2 provider is enabled)
  is wrapped with **AES-256-GCM**. The key-encryption key is derived
  from `SESSION_SECRET` via **HKDF-SHA256** with a domain-separating
  `info` string (ADR-020). The wrapped value lives in
  `vibetc.system_settings.value_encrypted`. Rotating
  `SESSION_SECRET` invalidates every wrapped secret and every active
  session — this is intentional.
- **Source PDFs** are content-addressed by SHA-256 under
  `${DATA_DIR}/uploads/{yyyy}/{mm}/{sha256}.pdf` with restrictive POSIX
  permissions. They are not encrypted at rest by the application; rely
  on full-disk encryption / encrypted volume for the data directory.
- **Postgres** is not encrypted at the application layer; standard
  `pg_dump` backups inherit this. Use TDE or encrypted volumes for the
  DB host.

## Network egress

The default posture is **zero outbound network calls at runtime**:

| Path                           | Default              | What egresses                                                                                                                                                                                                               |
| ------------------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local LLM extraction (default) | nothing              | All LLM traffic is to the in-cluster Vibe LLM Gateway.                                                                                                                                                                      |
| OCR (Vibe Shield)              | redacted page images | Scanned-page OCR runs through the on-appliance Vibe Shield gateway (Claude vision). Shield masks PII (token-overlay) before the image reaches Anthropic; markdown returns tokenized, materialized only at export (ADR-022). |
| FIDIR refresh                  | nothing              | The mirror at `data/fidir/fidir-us.txt` is replaced manually, never fetched (ADR-007).                                                                                                                                      |
| Anthropic provider (opt-in)    | OFF                  | OCR-extracted **markdown text** + the JSON schema → `api.anthropic.com`. **Never** raw PDFs or images.                                                                                                                      |
| Telemetry / analytics SDKs     | NEVER                | None. There are no analytics SDKs in any workspace.                                                                                                                                                                         |
| Container image pull           | first-run            | `docker pull` from GHCR. Thereafter offline.                                                                                                                                                                                |

There are no phone-home pings, no license-server calls, no auto-update
checks. `LICENSE` is enforced at source-level only (ADR-011); there is
no runtime DRM.

## The optional Anthropic provider

This is the only path that egresses customer-derived data. It is
strictly opt-in:

1. Admin pastes an API key in `/admin`. Stored AES-256-GCM-encrypted
   per the section above.
2. Admin must type a confirmation phrase ("I understand OCR text will
   be sent to Anthropic") before the provider becomes selectable.
3. Every extraction call against the provider writes an audit row with
   the model, token counts, cost, and statement id.
4. A **monthly cost cap** (USD micros) is enforced before the call;
   exceeding it fails the job with `LlmCostCapExceededError` and
   surfaces a banner to admins.
5. **What is sent:** the system prompt, the OCR-extracted markdown
   text, and the JSON schema (as a single tool's `input_schema`).
6. **What is never sent:** the raw PDF bytes, rasterized page images,
   account numbers in full, or any audit-log content.
7. To rotate: paste a new key in `/admin`. The old wrapped value is
   overwritten in the same row.
8. To disable: switch the provider back to `local` in `/admin` or
   delete the key. All subsequent extractions use the local gateway.

See ADR-019 and ADR-020 for the contract; see `docs/data-flow.md` for
the diagram.

## Logging

- HTTP request logs (method, path, status, duration, requestId).
- Audit-log entries for every mutation, redacted of PII.
- LLM call telemetry (tokens, ms, cost) at info level; **never** the
  prompt or response payload.
- `LLM_DEBUG_PAYLOADS=true` is a forensic switch that logs the full
  prompt and response to the operator's stdout. It must remain `false`
  in normal operation.

## Vulnerability surface and dependency management

- Dependencies are pinned in `pnpm-lock.yaml`. CI is expected to run
  `trivy` or `grype` in Phase 30 (deferred per `PROGRESS.md`).
- The runtime container is distroless and runs as non-root in the spec
  (currently runs as root per `PROGRESS.md` Phase 28 — an open gap).
- `NOTICE` carries third-party attributions. PolyForm Internal Use
  forbids redistribution; do not ship images outside the firm.

## Reporting issues

Internal-only project; report to the IT operator who owns this
deployment. There is no public security inbox.
