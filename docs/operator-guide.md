# Operator Guide

This guide is for the firm's IT operator deploying and running
Vibe Transactions Converter (`vibetc`).

## Deployment modes

### Standalone (recommended for first install)

```bash
cp .env.example .env       # set SESSION_SECRET (>= 32 bytes)
docker compose --profile standalone up -d
```

Run the command from the repo root — `docker-compose.yml` mounts
`./Caddyfile` with a relative path, and Caddy will refuse to start if
launched from elsewhere.

This brings up Postgres 16, Redis 7, the local LLM gateway,
Caddy, and the API. Caddy serves plain HTTP on `:80` by default so the
out-of-the-box experience works on a LAN with no DNS or cert setup.
For that mode the compose ships `SESSION_SECURE=false` and
`WEB_BASE_URL=http://localhost` — the Secure-cookie flag is dropped
silently by browsers on HTTP, so leaving it on would 401-loop login.

To run the standalone deploy under HTTPS (recommended for anything but
a LAN evaluation):

1. Edit `Caddyfile` and uncomment the `tls internal` block (self-signed
   certs for LAN-only deploys) or set `VIBETC_DOMAIN=<your domain>` so
   Caddy provisions a Let's Encrypt cert.
2. Set `SESSION_SECURE=true` and `WEB_BASE_URL=https://<your domain>`
   in `.env`.
3. `docker compose --profile standalone up -d`.

### Vibe Appliance install

If your firm already runs the Vibe appliance, the recommended path is
the appliance installer, which reads `vibe-app.yaml` at the repo root
and wires in the shared Postgres / Redis / Vibe Shield / LLM gateway and
Caddy:

```bash
vibe install vibe-tx-converter
```

The installer applies migrations, seeds the FIDIR mirror, and routes
`tx.<appliance-domain>` to this service. It also injects `APPLIANCE_MODE=true`
and `APPLIANCE_VERSION=<n>`; the running app surfaces the latter on the
Diagnostics page and on `/api/internal/appliance/health`.

If you prefer to drive Compose directly (for example, on a homelab
without the full installer), the same image is wired by the overlay
file:

```bash
docker compose -f docker-compose.appliance.yml up -d
```

`vibe-app.yaml` is the canonical contract — see
[`docs/appliance-manifest.md`](./appliance-manifest.md) for the schema.

## First-run

1. Browse to the configured `WEB_BASE_URL`. The first request lands on
   `/register` because no users exist.
2. Create the first admin (12+ char password).
3. Add a Company.
4. Add an Account using the Bank Picker. Pick the closest match; if
   your bank is not listed, click "Bank not listed?" — exports will
   stamp the Wells Fargo fallback BID `3000`, which QuickBooks accepts.
5. Drop a PDF statement onto the Account page. Extraction runs in the
   background (BullMQ); statements appear under
   `/accounts/:id/statements` with status updates.

## Quarterly maintenance

- **FIDIR refresh** — replace `data/fidir/fidir-us.txt` with the
  current Intuit publication, then run `just fidir:refresh` (or click
  the **Refresh** button in `/admin`). The seeder refuses imports with
  fewer than 100 records as a defensive cap.
- **Audit-log retention** — set `AUDIT_RETENTION_DAYS` in the
  environment to enable pruning; unset (default) keeps everything.
- **Disk free** — uploads and exports live under `${DATA_DIR}` (default
  `/var/lib/vibetc`). The upload route refuses below 500 MB free,
  warns below 2 GB.

## Switching to the Anthropic provider (optional)

By default extraction runs locally. To opt into the Anthropic provider:

1. Sign in as admin and visit `/admin`.
2. Paste your Anthropic API key (stored AES-256-GCM-encrypted at rest).
3. Type the warning phrase to acknowledge that OCR text egresses to
   Anthropic.
4. Click "Use Anthropic". Subsequent extractions run on Sonnet/Opus/
   Haiku 4.x. Raw PDFs and rasterized images NEVER leave the server.
   See ADR-019 / ADR-020 for the contract.

## Port + system requirements

- 4 GB RAM (8 GB if running the standalone LLM gateway)
- 50 GB disk for `${DATA_DIR}` (PDFs are kept until manually purged)
- Outbound network: NONE for the local provider; only
  `api.anthropic.com` (or your override URL) when the Anthropic
  provider is enabled.

## Backups

- **Admin → Backup** (`/admin/backup`) runs `pg_dump` over the `vibetc`
  schema plus the `drizzle` migration-bookkeeping schema, writing a
  compressed custom-format dump to `${DATA_DIR}/backups`. Dumps can be
  downloaded, restored, or deleted from the same page, and are swept
  after `BACKUP_RETENTION_DAYS` (default 90).
- Point-in-time recovery via WAL archiving is still recommended for
  production; these dumps are snapshots, not continuous.
- `${DATA_DIR}/uploads` is content-addressed by sha256 — re-uploading
  the same PDF deduplicates without writing twice. It is **not** part of
  the dump; back up the directory separately if you need the source PDFs.
- `data/fidir/fidir-us.txt` is in source control.

## Restore

Restore is available from **Admin → Backup**: click **Restore** next to a
dump and type `RESTORE` to confirm. The same operation is available on
the host shell, running the same code:

```
pnpm --filter @vibe-tx-converter/api db:restore vibetc-2026-07-31T13-58-09-828Z.dump
```

What happens, in order:

1. A **safety dump of the current database** is taken first, so the
   restore is itself undoable. If `pg_dump` fails, the restore is
   refused rather than run without a way back.
2. The extraction queue is paused (best-effort; an unreachable Redis is
   a warning, not a failure).
3. The `vibetc` and `drizzle` schemas are dropped and rebuilt from the
   dump **in a single transaction**. Any failure — a lock timeout, a
   missing role, an unreadable dump — rolls the whole thing back and
   leaves the database exactly as it was. There is no half-restored
   state to clean up.
4. Migrations are re-applied. Because the dump carries the migration
   bookkeeping, a backup taken before an upgrade restores to its own
   schema version and is then brought forward to the running build.

Notes:

- `pg_dump`, `pg_restore` and `psql` must be on `PATH`. The Docker image
  bundles `postgresql-client-16`; on a dev host install it yourself (the
  client major must be ≥ the server major).
- Extensions (`pg_trgm`, `btree_gist`) live inside the `vibetc` schema on
  a standard install and are **not** contained in the dump, so the
  restore re-creates them itself. This is why a hand-rolled
  `pg_restore --clean` against a live database fails — use the UI or the
  script rather than calling `pg_restore` directly.
- The `sessions` table comes from the dump, so **you will probably be
  signed out** after restoring. Log back in and continue.
- Jobs already queued in Redis refer to the pre-restore database and
  will fail; the restore reports how many were pending.
- Both the intent (`backup.restore.start`) and the outcome
  (`backup.restore`) are written to `audit_log`. The "start" row lands in
  the safety dump — i.e. in the copy that survives a rollback of the
  restore itself.

## Troubleshooting

- **`/api/health/ready` returns 503** — check the per-dependency
  block: `postgres`, `redis`, `vibeShield`, `llmGateway`. Each entry is
  `{ status: ok | unconfigured | fail, detail? }`.
- **Extraction stuck in `extracting`** — check the worker logs
  (`docker logs vibe-tx-converter-api-1`). The most common failure is
  Vibe Shield being unhealthy; the OCR client retries 3× with exponential
  backoff before failing the job.
- **Discrepancy on the Golden Rule** — open the statement in the
  review UI; either edit transactions to make balances tie, or click
  through the typed-confirmation override (audit-logged).
