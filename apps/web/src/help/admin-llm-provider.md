# LLM provider (admin)

`/admin/llm-provider` controls which LLM does the structured extraction. Two providers:

- **`local`** (default) — Qwen3-8B Q4_K_M served by the Vibe LLM Gateway over the OpenAI wire format. JSON-Schema-constrained generation guarantees the response shape.
- **`anthropic`** — Claude (default model `claude-sonnet-4-6`) over the Anthropic API. Uses Claude's tool-use feature with the schema as a single tool's `input_schema`.

## When to use which

Local is the right answer for almost everyone. Free, private, deterministic, fast on modern hardware.

Switch to Anthropic if:

- Your hardware doesn't have the GPU memory for a local 8B model.
- You're getting persistent extraction errors on hard PDFs that Claude is known to handle better.
- You explicitly want to spend money for higher quality on certain firms.

## Privacy contract

Even with the Anthropic provider:

- **Source PDFs and rasterized page images NEVER leave the server.** Only OCR-extracted markdown text + the JSON schema are sent.
- Every Anthropic call is audit-logged.
- The API key is encrypted at rest with AES-256-GCM, key derived from `SESSION_SECRET` via HKDF-SHA256. It's never logged, never returned via API, never visible in the UI after save.

This is enforced in code, not just policy. The extraction worker hands the LLM provider only the markdown string + schema; the PDF bytes are kept in the OCR step's local memory.

## Setting the API key

The form requires you to type `I UNDERSTAND OCR TEXT EGRESSES` exactly. This is intentional friction — make sure you've made the privacy decision deliberately, not by autopilot. The phrase is shown below the input so it stays visible while you type.

Saving the key:

1. Audit-logs `system.anthropic-key.set` (no payload — the key never lands in audit data).
2. Encrypts and stores in `system_settings`.
3. Refreshes the cached provider so the next extraction picks it up.

## Pricing table

The Anthropic page also has a per-model pricing table (input / output dollars per million tokens, in USD). The default values are pre-filled for the current Anthropic catalog; edit them if Anthropic changes prices and you haven't pushed a new app version.

These are used to compute `llm_cost_micros` per statement so the monthly cost rollup on the engines page is accurate. If pricing rows are missing for a model you actually use, cost rollup for that statement falls back to zero (still extracts fine; just no cost computed).

## Monthly cap

Set a monthly cost cap (USD) on the engines page; extraction blocks once cumulative spend in the calendar month exceeds it. The blocked statement goes to `failed` with a clear error message. Cap is checked per-call so a sudden spike can still ride the cap up to the threshold but no further.

## Test connection

The "Test connection" button hits `GET /v1/models` on Anthropic with the stored key. A green pill means the key is valid and reachable. A red pill shows the error verbatim. The local gateway has its own `/health` endpoint for the same purpose.
