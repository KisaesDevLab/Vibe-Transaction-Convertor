# Appliance Manifest Reference

`vibe-app.yaml` at the repo root is the contract between this app and
`vibe-installer`. The installer reads it to: pull the right image, wire
in shared services, run migrations, route the per-app subdomain through
the appliance Caddy, and uninstall cleanly. This page documents every
field the installer consumes and what the runtime expects in return.

The schema below is what BuildPlan §29.1 specifies plus the optional
hardening fields the runtime relies on. New fields must be additive —
removing or renaming a field is an installer-breaking change.

## Top-level fields

| Field                 | Required | Type          | Notes                                                                                                                                                          |
| --------------------- | -------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                | yes      | string        | Stable internal id. Must be `vibe-tx-converter`.                                                                                                               |
| `display_name`        | yes      | string        | Human label for the installer UI.                                                                                                                              |
| `description`         | yes      | string        | One-sentence purpose blurb.                                                                                                                                    |
| `version`             | yes      | semver        | Manifest contract version. Must equal the running image's `package.json` version. Boot handshake compares it to `APPLIANCE_VERSION` injected by the installer. |
| `image`               | yes      | string        | Fully qualified image reference without a tag. The installer appends the version it wants.                                                                     |
| `image_tag_default`   | no       | string        | Tag to use when the installer doesn't pin one (`latest` is the only supported value).                                                                          |
| `db_schema`           | yes      | string        | Postgres schema this app owns. Must be `vibetc`. Migrations refuse to create anything outside it.                                                              |
| `shared_services`     | yes      | string[]      | Services the app expects the appliance to provision: `postgres`, `redis`, `vibe-shield`, `llm-gateway`, `caddy`.                                               |
| `routes`              | yes      | route[]       | Caddy routes the appliance configures. See below.                                                                                                              |
| `env`                 | yes      | env-spec      | Required and optional env vars. See below.                                                                                                                     |
| `volumes`             | yes      | volume[]      | Persistent volumes. The data volume (`/var/lib/vibetc`) holds source PDFs, exports, and the FIDIR mirror.                                                      |
| `migrations`          | yes      | command       | Command run after the container starts and before traffic is routed. Idempotent.                                                                               |
| `bootstrap`           | yes      | step[]        | Post-migration one-shots. The first step seeds the FIDIR mirror; the second runs the self-check.                                                               |
| `uninstall`           | yes      | command       | Clean-removal command. Refuses without `--i-have-a-backup` so a misfire of the orchestrator can't drop everything silently.                                    |
| `healthcheck`         | yes      | http-check    | Mirrors the Dockerfile `HEALTHCHECK`. Both must agree or the orchestrator and Compose disagree about readiness.                                                |
| `appliance_handshake` | yes      | endpoint-pair | Internal endpoints the orchestrator polls. `ready` is auth-free; `diagnostics` is admin-only and exposed on the appliance internal network only.               |
| `license`             | yes      | string        | `PolyForm-Internal-Use-1.0.0`. Single-firm, self-hosted only.                                                                                                  |

### `routes`

```yaml
routes:
  - host: tx.${appliance_domain}
    path: /
    service: api
    port: 4000
```

The appliance Caddy resolves `${appliance_domain}` from its own config.
The host pattern `tx.<domain>` is fixed in this app — operators who
need a different subdomain must change it in the manifest **and** in
the cookie/CSRF deployment so cookies stay scoped to that subdomain.

### `env`

```yaml
env:
  required:
    - DATABASE_URL
    - REDIS_URL
    - VIBE_SHIELD_URL
    - LLM_GATEWAY_URL
    - LLM_MODEL_ID
    - SESSION_SECRET
  optional:
    - LOG_LEVEL
    - MAX_UPLOAD_MB
    - MAX_BATCH_SIZE
    - VIBETC_FORCE_OCR
    - APPLIANCE_VERSION
```

The installer always injects `APPLIANCE_MODE=true` and
`APPLIANCE_VERSION=<n>` in appliance mode; both are read by
`runBootChecks()` and surfaced on the Diagnostics page. See
[`docs/operator-guide.md`](./operator-guide.md) for the full env
catalogue.

### `migrations` / `bootstrap` / `uninstall`

```yaml
migrations:
  command: ['node', 'apps/api/dist/db/migrate.js']

bootstrap:
  - description: 'Seed FIDIR mirror from the vendored fidir-us.txt.'
    command: ['node', 'apps/api/dist/scripts/fidir-refresh.js']
  - description: 'Verify dependencies + write self-check JSON.'
    command: ['node', 'apps/api/dist/scripts/appliance-self-check.js']
    optional: true # exit-code-1 is informational; orchestrator decides

uninstall:
  command: ['node', 'apps/api/dist/scripts/remove-from-appliance.js', '--i-have-a-backup']
```

The migrations command and the `db:migrate` script are idempotent — the
appliance's update flow runs them on every upgrade and on first install.

## Runtime contract

What the installer expects the running container to provide:

| Endpoint                             | Purpose                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `GET /api/health/live`               | Liveness. 200 = process up. No dependency checks.                                                                  |
| `GET /api/health/ready`              | Readiness. 200 = all configured deps healthy; 503 = degraded.                                                      |
| `GET /api/internal/appliance/health` | Rich health (queue depth, build SHA, manifest handshake). IP-restricted to the appliance internal network.         |
| `GET /api/admin/appliance/status`    | Admin-only. Compares running version to `VIBE_APPLIANCE_AVAILABLE_VERSION` to drive the "Update available" banner. |

The handshake response carries the manifest version the running image
was built with — the orchestrator can compare it against the version
the installer expected to detect a stale image or a partially applied
upgrade. The boot sequence also logs the handshake result; a mismatch
is a warning, not a fatal, because some installer rollouts deliberately
skew across patches.

## Don't change without a manifest version bump

These shapes are part of the public contract:

- `name` (the installer keys off this).
- `db_schema` (changing it would break upgrade paths and audit-log inserts).
- `migrations.command`, `bootstrap[*].command`, `uninstall.command` (the installer pins these as fixed strings).
- `healthcheck.http` path.
- `appliance_handshake.ready` and `appliance_handshake.diagnostics` paths.
- The set of required env vars.

When any of these need to change, bump the manifest's `version`, update
this doc, and announce in the appliance release notes so the installer
side can land its half before the image rolls.
