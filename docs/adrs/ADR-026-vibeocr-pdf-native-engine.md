# ADR-026 — VibeOCR: PDF-native scanned-statement OCR engine (GLM-OCR fallback)

## Status

Accepted. Amends ADR-025 (local GLM-OCR). Adds **VibeOCR** as the default
stage-1 OCR engine for scanned statements; **GLM-OCR (ADR-025) becomes the
fallback**. The zero-egress / "page images never leave the firm" invariant is
unchanged and reaffirmed.

## Context

ADR-025 made stage-1 OCR a per-page loop: the worker rasterizes the PDF to PNGs
(`VIBETC_OCR_RASTER_DPI`) and calls the GLM-OCR VLM (`/v1/chat/completions`)
once **per page, sequentially**. Two problems surfaced in production:

- **Throughput.** Per-page sync calls don't overlap, and `GLM_OCR_CONCURRENCY`
  is effectively dead (the worker passes one image per call). A multi-page scan
  is the sum of per-page latencies; on a CPU/limited-GPU box a dense 200-DPI
  page measured ~42 s warm (~126 s on the first, cold-load page), so a 6-page
  statement ran several minutes and a slow page tripped the per-page timeout.
- **Coupling.** The app owns rasterization (DPI, format) and the per-page
  orchestration, duplicating logic the operator already has in a dedicated OCR
  service.

The operator runs **VibeOCR** on the appliance (default `:8099`): a PDF-native
OCR service that accepts the whole PDF (or an image) as one multipart upload,
rasterizes + OCRs every page server-side (it **fronts the same GLM-OCR VLM**),
and returns per-page markdown via an async job API. Sending the PDF once and
letting the service own rasterization is simpler and lets that service evolve
(batching, layout models) without app changes.

## Decision

- **VibeOCR is the default stage-1 OCR engine** (`VIBETC_OCR_ENGINE='vibe'`).
  The worker uploads the whole source PDF to VibeOCR, polls the job to
  completion, and uses the returned per-page markdown for stage-2 extraction
  (qwen2.5:32b) — the stage-2 path is **unchanged**.
- **GLM-OCR (ADR-025) is the fallback.** When VibeOCR is unset, unreachable, or
  errors, the worker automatically falls back to the per-page GLM-OCR path. The
  operator can also pin `VIBETC_OCR_ENGINE='glm'` to use GLM-OCR directly.
- **Same downstream contract.** VibeOCR returns `pages[].markdown`, page-marked
  (`# Page N`) exactly like the GLM path, so multi-account detection, the review
  grid, the Golden Rule, and the exporters are untouched.
- **On-appliance only.** VibeOCR is a loopback/LAN service; its `/healthz`
  reports its own status and that of its VLM backend. Page images never egress.
  The optional Anthropic text-only provider remains the single egress carve-out.

## API contract (VibeOCR)

```
POST   {VIBE_OCR_URL}/ocr                 multipart `file`; header x-api-key
       → { job_id, status: "queued" }
GET    {VIBE_OCR_URL}/ocr/{job_id}         → { status: queued|processing|completed|failed }
GET    {VIBE_OCR_URL}/ocr/{job_id}/result  → { total_pages, pages: [{ page_num, markdown }] }
GET    {VIBE_OCR_URL}/healthz              → { service, vlm_backend, … }
```

The service accepts **any non-empty `x-api-key`**; the key is a deploy gate, not
a secret, so it is stored as a plain setting (not encrypted like the Anthropic
key). The client (`packages/extractor/src/vibe-ocr-client.ts`) bounds the whole
job with `VIBE_OCR_TIMEOUT_MS` and each HTTP call with a per-request timeout, and
throws `VibeOcrError` on any failure so the worker can fall back cleanly.

## Consequences

- One upload replaces N per-page calls; rasterization moves server-side (the app
  no longer needs `VIBETC_OCR_RASTER_DPI` on the VibeOCR path — it still governs
  the GLM fallback and the check-payee rasterizer).
- A new failure surface (the async job service) is mitigated by the automatic
  GLM-OCR fallback and an admin health badge.
- Stage-1 token telemetry stays 0/0 (local OCR; cost 0), matching ADR-025.
- VibeOCR fronts GLM-OCR, so a healthy `vlm_backend` in `/healthz` and a healthy
  GLM-OCR badge are correlated; both are surfaced so a degraded backend is
  visible even when the front service is up.

## Settings

| id                 | key                   | env                   | default  |
| ------------------ | --------------------- | --------------------- | -------- |
| `ocrEngine`        | `ocr.engine`          | `VIBETC_OCR_ENGINE`   | `vibe`   |
| `vibeOcrUrl`       | `ocr.vibe.url`        | `VIBE_OCR_URL`        | `''`     |
| `vibeOcrApiKey`    | `ocr.vibe.api_key`    | `VIBE_OCR_API_KEY`    | `''`     |
| `vibeOcrTimeoutMs` | `ocr.vibe.timeout_ms` | `VIBE_OCR_TIMEOUT_MS` | `300000` |
