# Engines (admin)

`/admin/engines` is where the runtime services the extractor depends on are configured. Edits land in the `system_settings` table and take effect on the next API call — no restart required. The ready-probe runs every 5 seconds and updates the badges.

## PostgreSQL 16

Persistence layer. Schema is `vibetc`. **Set via boot env only** (`DATABASE_URL`) — the Drizzle pools and BullMQ would need to reconnect, which a runtime change can't safely do.

`audit_log` rows are append-only at the DB grant level: the application role only has `INSERT, SELECT`. Don't try to write code that updates or deletes audit rows — the database will reject it.

## Redis 7

BullMQ extraction queue + login rate-limit + OCR cache. Boot env only (`REDIS_URL`). Without Redis, the extraction queue runs in-process and queue stats won't display on Diagnostics.

## Vibe Shield (OCR via Claude)

Scanned pages are OCR'd by **Claude vision through the Vibe Shield gateway** (Anthropic Messages API at `/v1/messages`). Shield masks PII in each page image — under the token-overlay masker — before Claude transcribes it, so the markdown comes back tokenized and is materialized back to cleartext at export. Used **only** when the PDF lacks a text layer; if you only ever upload modern bank PDFs (which always have a text layer), you can leave this unset.

- **URL:** the Shield gateway, typically `http://vibe-shield-gateway:8080` (appliance) or your gateway host.
- **API key:** the Shield tenant key (`vs_live_…`), sent as `Authorization: Bearer`. The key MUST be issued with `appId='converter'`.
- **Model:** the Claude model used for OCR (default `claude-sonnet-4-6`).
- **OCR prompt:** the per-page transcription instruction.
- **Timeout / Concurrency:** Claude vision per page + the Shield hop; defaults 120s / 2.

The "Test connection" button hits the gateway `/health` endpoint. For a full end-to-end check (key appId, materialize gate, ZDR), run `pnpm shield:smoke` (or `just shield-smoke`). Prerequisites: Vibe Shield ≥ v1.12, an `appId='converter'` key, and `VIBE_SHIELD_ZDR_ENABLED=true` on the gateway. See ADR-022.

## LLM Gateway (Vibe)

Default extraction provider — Qwen3-8B via the Vibe LLM Gateway (OpenAI wire format). Used when the LLM provider is set to `local` (the default).

- **URL:** wherever your gateway is. Standalone compose puts it next to the API.
- **Timeout:** 60s by default.

If you've switched to the Anthropic provider on `/admin/llm-provider`, this URL is unused.

## Why edits don't need a restart

Both the Vibe Shield OCR client and the LocalGatewayProvider read their config from `system_settings` per call, falling back to the env var only when no DB override exists. So toggling the URL on this page changes the **next** request without any reload — useful when you're hot-swapping a backend during development.

## Auth

The Vibe Shield engine takes a bearer key (`vs_live_…`, stored AES-256-GCM-encrypted at rest). The LLM Gateway is URL-only and assumes a private network or appliance gateway in front.
