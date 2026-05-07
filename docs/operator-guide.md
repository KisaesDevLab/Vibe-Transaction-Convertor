# Operator Guide

This guide is for the firm's IT operator deploying and running
Vibe Transactions Converter (`vibetc`).

## Deployment modes

### Standalone (recommended for first install)

```bash
cp .env.example .env       # set SESSION_SECRET (>= 32 bytes)
docker compose --profile standalone up -d
```

This brings up Postgres 16, Redis 7, GLM-OCR, the local LLM gateway,
and the API at `http://localhost:4000`.

### Vibe Appliance install

If your firm already runs the Vibe appliance, the recommended path is
the appliance installer, which reads `vibe-app.yaml` at the repo root
and wires in the shared Postgres / Redis / GLM-OCR / LLM gateway and
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

- Postgres `vibetc` schema → standard `pg_dump` (point-in-time
  recovery via WAL archiving recommended for production).
- `${DATA_DIR}/uploads` is content-addressed by sha256 — re-uploading
  the same PDF deduplicates without writing twice.
- `data/fidir/fidir-us.txt` is in source control.

## Troubleshooting

- **`/api/health/ready` returns 503** — check the per-dependency
  block: `postgres`, `redis`, `glmOcr`, `llmGateway`. Each entry is
  `{ status: ok | unconfigured | fail, detail? }`.
- **Extraction stuck in `extracting`** — check the worker logs
  (`docker logs vibe-tx-converter-api-1`). The most common failure is
  GLM-OCR being unhealthy; the OCR client retries 3× with exponential
  backoff before failing the job.
- **Discrepancy on the Golden Rule** — open the statement in the
  review UI; either edit transactions to make balances tie, or click
  through the typed-confirmation override (audit-logged).
