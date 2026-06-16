# @vibe-tx-converter/extractor

PDF preprocessing, Vibe Shield OCR client, LLM provider abstraction,
prompts, and exemplars. Owns everything between "PDF on disk" and
"validated `ExtractionResult`".

## Purpose

- **`preprocess.ts`** — text-layer probe via `pdfjs-dist/legacy` (no
  DOM, no canvas). Decides per-PDF whether to take the `text` route,
  the `ocr` route, or `hybrid`. Rasterizes via `pdftoppm` shell-out
  (Q-006 resolution) when OCR is needed.
- **`shield-ocr-client.ts`** — HTTP client for OCR via the Vibe Shield
  gateway (Claude vision, Anthropic Messages `/v1/messages`; ADR-022,
  supersedes ADR-003). Concurrency-limited, retries 5xx/429 with
  exponential backoff + circuit breaker, per-image sha256 + session
  cache (Redis-backed via the API layer's adapter).
- **`prompts/extract.ts`** — system prompt, user-prompt builder
  (`userPromptFor`), repair-prompt builder (`repairPromptFor`),
  markdown cleanup (`cleanupMarkdown`), token estimator
  (`estimateTokens`).
- **`exemplars.ts`** — 10 sanitized in-context exemplars for the
  local provider; the Anthropic provider gets a smaller subset.
- **`llm-client.ts`** — the `LlmProvider` interface (ADR-019). Two
  implementations: `LocalGatewayProvider` (default, OpenAI wire
  format) and `AnthropicProvider` (tool-use, schema as
  `input_schema`). Downstream code never branches on provider.
- **`multi-account-detector.ts`** — heuristic for spotting household
  statements where one PDF carries two or more accounts. Drives the
  Phase 14 split-confirm UI.

## Public API

```ts
export * from './preprocess.js';
export * from './shield-ocr-client.js';
export * from './prompts/extract.js';
export * from './exemplars.js';
export * from './llm-client.js';
export * from './multi-account-detector.js';
```

Notable types and functions:

- `analyzePdfFromPath(path)`, `routePdf(analysis)`,
  `extractTextLayer(path)`, `rasterizePdf(path, dpi)`.
- `ocrPdfPages(images, opts)`, `probeShieldHealth(opts)` (Vibe Shield
  OCR via Claude vision).
- `LlmProvider`, `LocalGatewayProvider`, `AnthropicProvider`,
  `prepareMarkdown(raw, budget)`.
- `SYSTEM_PROMPT`, `userPromptFor(markdown, opts)`,
  `repairPromptFor(input)`, `cleanupMarkdown(raw)`,
  `estimateTokens(text)`.
- `EXEMPLARS`, `exemplarsAsMessages(opts)`.
- `detectAccounts(pages)` and the `MultiAccountAnalysis` shape.

## How it's used

- `apps/api/src/jobs/extraction.worker.ts` orchestrates the full
  pipeline: `analyzePdf` → `routePdf` → (text / OCR) →
  `multi-account-detector` → `LlmProvider.extract` → reconciler →
  TRNTYPE + FITID → persist.
- `apps/api/src/scripts/shield-smoke.ts` exercises the OCR-via-Shield
  path end-to-end as a CLI (`pnpm shield:smoke`).
- `apps/api/src/routes/admin.ts` uses `LlmProvider.health()` to
  surface readiness on the admin page.

## Testing

```
pnpm --filter @vibe-tx-converter/extractor test
```

Tests cover preprocess routing, the Vibe Shield OCR client request/parse

- retry/cache/circuit breaker (stubbed HTTP), the extraction prompt builder (snapshot for fixed inputs), each
  exemplar round-tripping the Zod schema, and the multi-account detector
  on synthetic page-text inputs. The full PDF-to-FITID integration is
  exercised in `apps/api/src/api.test.ts` against the worker.
