# Engines (admin)

`/admin/engines` is where the runtime services the extractor depends on are configured. Edits land in the `system_settings` table and take effect on the next API call — no restart required. The ready-probe runs every 5 seconds and updates the badges.

## PostgreSQL 16

Persistence layer. Schema is `vibetc`. **Set via boot env only** (`DATABASE_URL`) — the Drizzle pools and BullMQ would need to reconnect, which a runtime change can't safely do.

`audit_log` rows are append-only at the DB grant level: the application role only has `INSERT, SELECT`. Don't try to write code that updates or deletes audit rows — the database will reject it.

## Redis 7

BullMQ extraction queue + login rate-limit + OCR cache. Boot env only (`REDIS_URL`). Without Redis, the extraction queue runs in-process and queue stats won't display on Diagnostics.

## GLM-OCR

Zhipu GLM-OCR over HTTP. Used **only** when the PDF lacks a text layer. If you only ever upload modern bank PDFs (which always have a text layer), you can leave this unset and the field stays at "unconfigured".

- **Standalone Docker:** typically `http://glm-ocr:8080` (the sibling container) or `http://localhost:8080` from the host.
- **Vibe Appliance:** the shared service URL from the appliance manifest.
- **Timeout:** default 60s. Increase if your GLM-OCR is on slow hardware.
- **Concurrency:** how many pages can be OCR'd in parallel. Default 2; raise if your hardware supports it.

The "Test connection" button hits the `/health` endpoint and reports latency. A green pill means OCR will work; red means scanned PDFs will fail with `GLM_OCR_URL is not set`-style errors.

## LLM Gateway (Vibe)

Default extraction provider — Qwen3-8B via the Vibe LLM Gateway (OpenAI wire format). Used when the LLM provider is set to `local` (the default).

- **URL:** wherever your gateway is. Standalone compose puts it next to the API.
- **Timeout:** 60s by default.

If you've switched to the Anthropic provider on `/admin/llm-provider`, this URL is unused.

## Why edits don't need a restart

Both the GLM-OCR client and the LocalGatewayProvider read their config from `system_settings` per call, falling back to the env var only when no DB override exists. So toggling the URL on this page changes the **next** request without any reload — useful when you're hot-swapping a backend during development.

## Auth

Neither field can carry an API key today. Both clients ship URL-only and assume a private network or appliance gateway in front. If you need bearer-token support, that's a real feature add — not configurable.
