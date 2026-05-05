# API reference

The API is internal to the web app — there is no public REST surface.
Every mutating endpoint requires both an authenticated session and a
valid CSRF token from `GET /api/auth/csrf`.

| Method               | Path                                          | Auth                | Notes                                |
| -------------------- | --------------------------------------------- | ------------------- | ------------------------------------ |
| GET                  | `/api/health/live`                            | —                   | always 200                           |
| GET                  | `/api/health/ready`                           | —                   | 200/503 with per-dep status          |
| GET                  | `/api/version`                                | —                   | name, version, BUILD_SHA, node       |
| GET                  | `/api/auth/csrf`                              | —                   | issues + returns CSRF token          |
| GET                  | `/api/auth/users-exist`                       | —                   | bootstrap signal                     |
| POST                 | `/api/auth/register`                          | first user OR admin | argon2id                             |
| POST                 | `/api/auth/login`                             | rate-limited        | 30d session cookie                   |
| POST                 | `/api/auth/logout`                            | session             | clears cookie                        |
| GET                  | `/api/auth/me`                                | session             | current user                         |
| POST                 | `/api/auth/change-password`                   | session             |                                      |
| GET                  | `/api/users`                                  | admin               |                                      |
| POST                 | `/api/users`                                  | admin               | create staff                         |
| POST                 | `/api/users/:id/reset-password`               | admin               | returns temp password                |
| GET                  | `/api/companies`                              | session             | paginated                            |
| POST                 | `/api/companies`                              | session             |                                      |
| GET / PATCH / DELETE | `/api/companies/:id`                          | session             | DELETE 409s if accounts; ?force=true |
| GET / POST           | `/api/companies/:id/accounts`                 | session             |                                      |
| GET / PATCH / DELETE | `/api/accounts/:id`                           | session             | ?reveal=true admin-only              |
| POST                 | `/api/accounts/:id/uploads`                   | session             | multipart, multi-PDF                 |
| GET                  | `/api/uploads/:hash/raw`                      | admin               | streams source PDF                   |
| GET                  | `/api/statements?accountId=`                  | session             |                                      |
| GET                  | `/api/statements/:id`                         | session             | + transactions                       |
| PATCH                | `/api/statements/transactions/:txId`          | session             | recomputes FITID                     |
| POST                 | `/api/statements/:id/override-reconciliation` | session             | reason >= 5 chars                    |
| POST                 | `/api/statements/:id/exports/:format`         | session             | streams export bytes                 |
| GET                  | `/api/fidir/search?q=`                        | session             | pg_trgm + ILIKE                      |
| GET                  | `/api/fidir/by-bid/:bid`                      | session             |                                      |
| GET                  | `/api/fidir/status`                           | session             |                                      |
| GET                  | `/api/audit`                                  | admin               | filter ?entityType, ?entityId        |
| GET / POST           | `/api/admin/llm-provider`                     | admin               |                                      |
| POST                 | `/api/admin/llm-provider/anthropic-key`       | admin               | AES-256-GCM wrap                     |
| POST                 | `/api/admin/llm-provider/anthropic-model`     | admin               |                                      |
| POST                 | `/api/admin/fidir/refresh`                    | admin               | re-imports vendored FIDIR            |
| GET                  | `/api/admin/fidir/status`                     | admin               | entries + last-refreshed             |

## Error shape

Every non-2xx JSON response has the shape:

```json
{ "error": "ValidationError", "code": "VALIDATION", "message": "...", "details": ..., "requestId": "..." }
```

Codes: `VALIDATION` (400), `AUTH` (401), `FORBIDDEN` (403), `NOT_FOUND`
(404), `CONFLICT` (409), `RATE_LIMIT` (429), `INTERNAL` (500).
