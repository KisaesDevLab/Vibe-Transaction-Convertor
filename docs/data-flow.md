# Data Flow

A one-page reference for SOC 2 reviewers and security auditors.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Operator browser                                                   │
│   │ session cookie + CSRF                                           │
│   ▼                                                                 │
│  apps/web (vite static SPA)                                         │
│   │ fetch /api/* (same-origin)                                      │
│   ▼                                                                 │
│  apps/api (Express)                                                 │
│   │                                                                 │
│   ├── Postgres (vibetc schema, append-only audit_log)               │
│   ├── Redis (sessions store + BullMQ queue)                         │
│   ├── Disk: ${DATA_DIR}/uploads/{yyyy}/{mm}/{sha256}.pdf            │
│   │                                                                 │
│   └── Extraction worker (BullMQ)                                    │
│        │                                                            │
│        ├── Local LLM Gateway  ◄─── DEFAULT (zero outbound)         │
│        │   (Vibe LLM Gateway, Qwen3-8B)                            │
│        │                                                            │
│        ├── GLM-OCR (HTTP, on-prem)                                  │
│        │                                                            │
│        └── Anthropic API (OPT-IN, admin-enabled)                    │
│            │                                                        │
│            └── Sends OCR markdown + JSON schema                     │
│                NEVER sends raw PDFs or page images                  │
└─────────────────────────────────────────────────────────────────────┘
```

## What egresses

| When                              | What goes to where                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Default mode (LLM_PROVIDER=local) | Nothing leaves the box.                                                                                                     |
| Anthropic mode (admin-enabled)    | OCR-extracted markdown text + JSON schema → `api.anthropic.com` (or override URL). Raw PDFs and rasterized images do not.   |
| FIDIR refresh                     | Operator manually downloads `fidir.txt` and replaces the vendored file. The application never fetches at runtime (ADR-007). |
| Container image pull              | First-run `docker pull` from GHCR; thereafter offline.                                                                      |

## What gets logged

- HTTP requests (method, path, status, duration, requestId).
- Audit-log entries for every state-changing action; redacted of PII.
- LLM call telemetry (tokens, ms, cost) — but **not** the prompt or
  response payload, except when `LLM_DEBUG_PAYLOADS=true` (forensic
  switch; never enable in normal ops).

## What is encrypted at rest

- Anthropic API key in `system_settings.value_encrypted` is
  AES-256-GCM wrapped using a key derived from `SESSION_SECRET` via
  HKDF-SHA256 with a domain-separating `info` string (ADR-020).
- Session cookies are signed (HMAC) but the session record is opaque.
