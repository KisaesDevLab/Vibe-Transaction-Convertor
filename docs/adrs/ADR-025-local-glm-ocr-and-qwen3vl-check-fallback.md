# ADR-025 — Local GLM-OCR for scanned statements, Qwen3-VL check-payee fallback

## Status

Accepted. Amends ADR-023 (local OCR via Ollama Qwen-VL): the **stage-1 OCR
engine for scanned statements changes from Ollama MiniCPM-V to a local GLM-OCR
engine**. The zero-egress / "page images never leave the firm" invariant is
unchanged and reaffirmed.

## Context

ADR-023 made scanned-statement OCR a two-stage local pipeline: Ollama
**MiniCPM-V** transcribes page images to markdown (stage 1), then a local text
model (qwen2.5:32b-instruct) extracts the schema JSON (stage 2). In production
on the operator's box this underperformed: MiniCPM-V is slow (~28 min/statement)
and a weak reader, so the stage-1 markdown was poor and the Golden-Rule
reconciliation routinely failed.

The project previously used **GLM-OCR** — a purpose-built OCR model served by a
llama.cpp `llama-server` — but it was removed in ADR-022/ADR-023 along with the
Vibe Shield egress gateway. GLM-OCR transcribes statement pages far better than
MiniCPM-V. The operator is reinstalling it **locally on the same box as Ollama**,
so the egress invariant holds.

## Decision

- **Stage-1 OCR runs on a local GLM-OCR engine.** `LocalGatewayProvider.ocrToMarkdown`
  calls the GLM-OCR client (`packages/extractor/src/glm-ocr-client.ts`, recovered
  from history) which POSTs page images to GLM-OCR's OpenAI-compatible
  `/v1/chat/completions` (`data:image/...;base64` + a `"Text Recognition:"` cue)
  and returns the transcription. Resilience (retry on 5xx/timeout, circuit
  breaker, image cache, `finish_reason=length` truncation guard) is reused.
- **MiniCPM-V is hard-removed from the statement-OCR path.** There is no
  Ollama-vision OCR fallback for statements: if GLM-OCR is down, scanned
  extraction **fails fast** with an actionable error (surfaced via the admin
  GLM-OCR health badge). Stage-2 text extraction (qwen2.5:32b-instruct) is
  unchanged.
- **Check payees: GLM-OCR transcribe → text-parse, with a Qwen3-VL-30B fallback.**
  The primary path transcribes the check region on GLM-OCR, then the local text
  model parses the structured `{check_number, payee, …}` fields (GLM-OCR is a
  transcription engine, not a JSON-adherent extractor; this also avoids the
  `date` `pattern` grammar hazard from ADR-024). When GLM-OCR fails or finds no
  payee, the cancelled-check images are read directly on the local vision model
  **qwen3-vl:30b** (served by Ollama, `/api/chat`). Both paths are local.
- **Config.** New operator settings (admin `ocr` group / env): `GLM_OCR_URL`,
  `GLM_OCR_MODEL`, `GLM_OCR_TIMEOUT_MS`, `GLM_OCR_CONCURRENCY`, `GLM_OCR_API_KEY`.
  The existing vision-model control now governs only the check-payee fallback
  (default `qwen3-vl:30b`). A `glm-ocr` docker-compose service co-located with
  Ollama, **no host port** (internal network only).

## Consequences

- Higher-fidelity, faster scanned-statement OCR; Golden-Rule pass rate improves.
- A new on-appliance dependency (GLM-OCR server). No new egress: GLM-OCR + Ollama
  are the only loopback OCR/vision targets; page images never leave the box.
- No statement-OCR fallback (accepted): GLM-OCR down ⇒ scanned extraction halts
  with a clear error rather than silently degrading.
- VRAM contention: GLM-OCR + Ollama (text + qwen3-vl) co-resident may contend;
  pin separate GPUs or run CPU-only with the 120s timeout.
- llama-server OCR reports no token usage; stage-1 telemetry is 0 tokens / $0
  (matches the existing local-path convention).

## Environment

| Var                   | Default               | Purpose                                                                                          |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| `GLM_OCR_URL`         | `http://glm-ocr:8082` | Local GLM-OCR llama-server base URL, with or without a trailing `/v1` (required for scanned OCR) |
| `GLM_OCR_MODEL`       | `glm-ocr`             | Model id the server advertises (must be exactly `glm-ocr`)                                       |
| `GLM_OCR_PROMPT`      | `OCR:`                | Transcription cue sent with each page                                                            |
| `GLM_OCR_TIMEOUT_MS`  | `120000`              | Per-page OCR timeout                                                                             |
| `GLM_OCR_CONCURRENCY` | `2`                   | Pages OCR'd in parallel                                                                          |
| `GLM_OCR_API_KEY`     | (unset)               | Optional bearer token (server is unauthenticated on the LAN)                                     |
| `OLLAMA_VISION_MODEL` | `qwen3-vl:30b`        | Check-payee fallback vision model                                                                |

The server (port `8082`) serves `POST /v1/chat/completions` and a root-level
`GET /health` (`{"status":"ok"}`); page images are sent one-per-request as a
base64 `image_url` data URL with the `OCR:` text cue. Statement pages are
rasterized to **PNG** (lossless; matches the `image/png` data URL).
