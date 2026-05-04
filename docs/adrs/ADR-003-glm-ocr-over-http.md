# ADR-003 — GLM-OCR over HTTP, never linked in-process

## Status

Accepted.

## Context

GLM-OCR (Zhipu AI, MIT-licensed) is the chosen OCR engine for scanned
statements. It is a heavy native model with substantial RAM and (optionally)
GPU footprint. Linking it in-process with the Node API would couple the
container's resource budget to OCR's worst case, cause cold-start regressions,
and break our distroless runtime story.

The Vibe Appliance already runs a shared GLM-OCR service that other family
products consume via HTTP. Reusing that pattern is the path of least surprise
for operators.

## Decision

GLM-OCR is **always called over HTTP** from the API process. The client lives
at `packages/extractor/src/glm-ocr-client.ts` and reads `GLM_OCR_URL` from the
environment. The client never `require()`s any model code or native binding.
Two deployment shapes are supported:

- **Standalone** — `docker-compose.yml` ships a `glm-ocr` service alongside
  the API. The compose file pins a specific image tag for reproducibility.
- **Appliance** — the API points at the shared appliance instance via the
  same `GLM_OCR_URL` env var, set from the appliance manifest. No code change
  is required to switch modes.

The HTTP contract is small enough that we own the request/response Zod
schemas in `packages/extractor` and adapt to the upstream image's surface
without leaking implementation details into business code.

## Consequences

- **Pro:** OCR can be scaled, restarted, version-pinned, or replaced without
  redeploying the API.
- **Pro:** Resource isolation — OCR memory pressure cannot evict API workers.
- **Pro:** Operators upgrading GLM-OCR retag a single image.
- **Con:** Adds a network hop and serialization cost per page.
- **Con:** The API needs a circuit-breaker / retry policy for OCR (Phase 11)
  to avoid cascading failures when GLM-OCR is unhealthy.

## References

- `packages/extractor/src/glm-ocr-client.ts`
- `docker-compose.yml`
- BuildPlan.md §3 ADR-003, Phase 11.
