# Engines (admin)

`/admin/engines` is where the runtime services the extractor depends on are configured. Edits land in the `system_settings` table and take effect on the next API call — no restart required. The ready-probe runs every 5 seconds and updates the badges.

## PostgreSQL 16

Persistence layer. Schema is `vibetc`. **Set via boot env only** (`DATABASE_URL`) — the Drizzle pools and BullMQ would need to reconnect, which a runtime change can't safely do.

`audit_log` rows are append-only at the DB grant level: the application role only has `INSERT, SELECT`. Don't try to write code that updates or deletes audit rows — the database will reject it.

## Redis 7

BullMQ extraction queue + login rate-limit + enrichment cache. Boot env only (`REDIS_URL`). Without Redis, the extraction queue runs in-process and queue stats won't display on Diagnostics.

## LLM Gateway (Ollama)

Local model server for both OCR and text extraction. Used when the LLM provider is set to `local` (the default). There is no separate OCR engine anymore — scanned pages are OCR'd **and** extracted in one call by a local Qwen-VL vision model (ADR-023); page images never leave the host.

- **URL:** your Ollama base URL, typically `http://localhost:11434` (standalone) or the shared appliance Ollama. A trailing `/v1` is tolerated and stripped.
- **Timeout:** 60s by default for text; the vision/OCR call gets a longer budget (`OLLAMA_VISION_TIMEOUT_MS`, default 120s).

The text and vision **model tags** are set on `/admin/llm-provider` (defaults `qwen3.5:35b-a3b` for text; a Qwen `-VL` tag for vision). Pull them on the Ollama host first, e.g. `ollama pull qwen3.5:35b-a3b`.

The "Test connection" button hits Ollama's native `/api/tags` endpoint (it has no `/health`).

## Why edits don't need a restart

The local provider reads its config from `system_settings` per call, falling back to the env var only when no DB override exists. So toggling the URL on this page changes the **next** request without any reload — useful when you're hot-swapping a backend during development.

## Auth

The LLM Gateway is URL-only and assumes a private network or appliance gateway in front. The optional Anthropic provider (text-only) takes an API key, configured on `/admin/llm-provider` and stored AES-256-GCM-encrypted at rest.
