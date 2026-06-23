# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

This repo is **pre-implementation**. The only files that exist are `README.md` (stub) and `BuildPlan.md`. There is no `package.json`, no `apps/`, no `packages/`, no migrations, no Docker config — the names referenced below are the targets defined by the plan, not files you can `Read` yet.

`BuildPlan.md` is the **authoritative spec** for everything that will be built: 33 numbered phases (~847 items), executed sequentially, each with an explicit Acceptance criterion. The user expects work to flow phase-by-phase from that document. Do not skip ahead, do not improvise structure that contradicts the plan, and do not invent items the plan does not call for. Before doing non-trivial work, re-read the relevant phase section of `BuildPlan.md` — most of what you need (file paths, schemas, exact endpoint shapes, env vars) is specified there.

When `BuildPlan.md` and this file disagree, `BuildPlan.md` wins. When `BuildPlan.md` is silent on something material, surface a question rather than guessing.

## Product in one paragraph

`vibe-tx-converter` (env prefix `VIBETC_`, DB schema `vibetc`) is a self-hosted Docker app that converts bank/credit-card PDF statements into **CSV, OFX 2.x XML, QFX, and QBO Web Connect** files for re-import into QuickBooks / Quicken / Xero. Pipeline: PDF upload → text-layer detection → (if scanned) local GLM-OCR transcription → local Ollama (Qwen) JSON-Schema-constrained extraction / (if text-layer) straight to extraction → Golden Rule reconciliation gate → review/edit grid (PDF coord highlight) → exporter pack → file download. Two deployment modes: **standalone** (ships its own Postgres / Redis / Ollama + GLM-OCR servers) and **Vibe Appliance** (uses shared services, incl. shared Ollama + GLM-OCR). See ADR-025.

## Hard product invariants — do not violate without explicit user approval

These are repeated throughout `BuildPlan.md` and are the rules most likely to bite if forgotten:

- **Zero outbound network calls at runtime by default.** FIDIR is mirrored at build/admin time, never fetched live. The only carve-out is the optional **Anthropic API** extraction provider (Tier 2), which is opt-in, off by default, and audit-logged on every call.
- **No telemetry, no phone-home, no analytics SDKs** — regardless of LLM provider.
- **OCR runs locally on VibeOCR (GLM-OCR fallback); extraction on local Ollama (ADR-026/025, amends ADR-023).** Scanned/image statements are transcribed to markdown by **VibeOCR** — the on-appliance, PDF-native OCR service (the whole PDF is uploaded once and OCR'd server-side; it fronts the GLM-OCR VLM). When VibeOCR is unset/unreachable the worker falls back to the per-page **GLM-OCR** llama-server (OpenAI-compatible `/v1/chat/completions` vision). The engine is chosen by `VIBETC_OCR_ENGINE` (`vibe`|`glm`, default `vibe`). Then the local **Ollama** text model (`qwen2.5:32b-instruct`) extracts the schema JSON from that markdown (two-stage). Text-layer statements skip OCR and go straight to the text model. Check payees are read via GLM-OCR transcribe→text-parse, falling back to the local Ollama vision model **`qwen3-vl:30b`**. OCR output is **cleartext** markdown (no `<ENTITY_N>` tokens, no materialize step).
- **Page images never leave the firm.** They are processed on-appliance by **GLM-OCR and Ollama** (the only loopback OCR/vision targets) and are never sent anywhere. The optional **Anthropic** provider is **text-only** — it receives cleartext OCR/text-layer markdown (never images) and is the single opt-in egress carve-out (Tier 2), off by default and audit-logged.
- **Golden Rule reconciliation gates exports by default.** User can override but must type-confirm; the override is audit-logged.
- **v1 is USD-only and en-US (MDY) on every output.** Source PDFs may be in any unambiguous date format; the LLM detects and normalizes to ISO 8601. Truly ambiguous statements halt in `awaiting-locale-confirmation` until the user picks.

## Tech stack (locked — do not deviate)

Match the rest of the Vibe family.

- **Frontend:** React 18, TypeScript 5.5+, Vite 5, Tailwind 3, shadcn/ui (Radix), TanStack Query 5, react-router 6, react-hook-form + zod, react-pdf for the review viewer.
- **Backend:** Node 20 LTS, Express 4, TypeScript, **Drizzle ORM** (not Prisma), Zod, Pino, Multer, **BullMQ** on **Redis 7**, ioredis.
- **DB:** PostgreSQL 16, schema name `vibetc`. Migrations live at `apps/api/src/db/migrations`.
- **OCR:** Default **VibeOCR** — on-appliance PDF-native OCR service (`:8099`; async job: upload PDF → poll → per-page markdown; fronts GLM-OCR). Fallback / alternative engine: local **GLM-OCR** llama-server (OpenAI-compatible `/v1/chat/completions` vision) transcribing rasterized pages. Engine via `VIBETC_OCR_ENGINE` (`vibe`|`glm`). On-appliance, zero egress. Check-payee fallback uses local Ollama **`qwen3-vl:30b`**. (ADR-026/025, amends ADR-023.)
- **LLM:** Qwen via local **Ollama** — text extraction over the OpenAI-compatible `/v1/chat/completions` (default `qwen2.5:32b-instruct`, a non-thinking instruct model — see ADR-024), JSON-Schema-constrained generation. Schemas sent to Ollama are stripped of `pattern` (regex) keywords, which silently disable its grammar engine; Zod re-validates after parsing (ADR-024). Optional **text-only** Anthropic provider uses **tool-use** with the schema as a single tool's `input_schema`; default model `claude-sonnet-4-6`.
- **Tests:** Vitest (unit + integration), Playwright (E2E).
- **Lint/format:** ESLint flat config, Prettier (`printWidth: 100`, `singleQuote: true`, `trailingComma: 'all'`), lint-staged + husky.
- **Package manager:** pnpm 9 with workspaces (`apps/*`, `packages/*`). Container: multi-stage Dockerfile, distroless runtime, GHCR.

## Architecture cross-cuts (the ADRs you'll touch most often)

Full set is ADR-001 through ADR-020 in §3 of `BuildPlan.md` (and lands in `docs/adrs/` during Phase 1). The ones that affect code in many places:

- **ADR-005 — FITID derivation.** `FITID = "VTC-" + sha1(date|amount|normalized_desc|seq_index_in_day)` truncated to 20 chars. Stable across re-imports of the same PDF; disambiguates same-day same-amount transactions. Implemented in `packages/exporters/src/fitid.ts`.
- **ADR-008 — OFX format split.** OFX **standalone** exports use **OFX 2.1.1 XML**. **QBO** and **QFX** use **OFX 1.0.2 SGML** (Intuit/Quicken require it). Both writers share a common AST in `packages/exporters/src/ofx/ast.ts`.
- **ADR-013 — `audit_log` is append-only.** Enforced at DB level: the app role is granted `INSERT, SELECT` only — `UPDATE` and `DELETE` are revoked. Never write code that tries to modify or delete audit rows.
- **ADR-016 — Determinism.** Same PDF in → same FITIDs out → same export bytes (modulo `<DTSERVER>`). Re-imports must be idempotent.
- **ADR-017 — Money is integer cents.** All money in DB and internal APIs is `BIGINT` cents. Decimal-as-string only at the API boundary and in exports. Helpers live in `packages/shared/src/money.ts`.
- **ADR-019 / ADR-020 — LLM provider abstraction.** All LLM calls go through `LlmProvider.extract(prompt, schema) → ExtractResult`. Two implementations: `LocalGatewayProvider` (default) and `AnthropicProvider`. **Downstream code never branches on provider.** Anthropic API key is AES-256-GCM-encrypted at rest in `system_settings`, key derived from `SESSION_SECRET` via HKDF-SHA256.
- **ADR-002 — BullMQ extraction jobs are idempotent on `(source_pdf_hash, account_id)`.**
- **ADR-007 — FIDIR is mirrored at `data/fidir/fidir-us.txt`. No runtime fetches.** Refresh is an explicit admin action.
- **ADR-015 — Auth is cookie-session, server-side store in Postgres `sessions` table, CSRF token on every mutating endpoint. Single firm per host.** No multi-tenant, no SSO in v1.

## Commands (will exist once Phase 0 lands)

The plan defines the following root scripts. None of these run today — they become real when `pnpm install` first works at the end of Phase 0.

- `pnpm dev` — run API + web in watch mode.
- `pnpm build` — build all workspaces.
- `pnpm typecheck` — `tsc -b` across all project references.
- `pnpm lint` — ESLint over the workspace.
- `pnpm test --run` — Vitest, all workspaces.
- `pnpm db:generate` — `drizzle-kit generate`.
- `pnpm db:migrate` — run migrations programmatically.
- `pnpm db:reset:dev` — drop + recreate `vibetc` schema (refuses in production).
- `pnpm db:fidir-seed` — load `data/fidir/fidir-us.txt` into `fidir_entries`.

A `justfile` mirrors operator-facing commands: `just dev`, `just build`, `just test`, `just migrate`, `just seed`, `just fidir:refresh`, `just up`, `just down`, `just logs`, `just psql`, `just redis-cli`.

A single test file: `pnpm --filter <pkg> test --run path/to/file.test.ts` (Vitest standard) — the plan does not specify a custom runner.

**Definition of done per phase** (Appendix C of `BuildPlan.md`): every numbered item implemented + acceptance bullet passing + tests written + `pnpm typecheck && pnpm lint && pnpm test --run && pnpm build` green + new env vars added to `.env.example` and Appendix B + ADRs written + conventional commit (`feat:` / `fix:` / `chore:` / `docs:` / `test:` / `refactor:`).

## Out of scope for v1 (do not creep in)

From Appendix D. Refuse and surface if asked:

- Push integrations (QBO Online via Intuit OAuth, Xero, Sage, NetSuite)
- Multi-currency (any non-USD)
- Non-MDY date output
- QIF / IIF exports
- Auto-categorization, fraud detection, template-learning loop, LoRA fine-tuning
- Email / Slack notifications
- Mobile app
- Public REST API for external callers
- Multi-tenant (more than one firm per host)
- SSO / SAML / OIDC
- License / subscription enforcement (PolyForm Internal Use is source-level only)

## Working style notes

- Respect the **scope lock** at the top of `BuildPlan.md`: USD + en-US dates only; download-only outputs; minimal Companies/Accounts model (name + FI + acct type + acct #).
- Audit-log every mutation (`audit_log` is append-only — see ADR-013).
- Never log PII or LLM payloads at info level. `LLM_DEBUG_PAYLOADS=true` is forensic-only.
- The Windows operator runs this — `.gitattributes` enforces LF on source, CRLF on `.cmd/.bat/.ps1`. Don't fight that.
