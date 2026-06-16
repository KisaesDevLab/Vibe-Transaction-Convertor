# Developer Guide

For engineers contributing to `vibe-tx-converter`. Pair this with
`BuildPlan.md` (the authoritative phase-by-phase spec) and `PROGRESS.md`
(what is actually built today vs. spec).

## Monorepo layout

pnpm 9 workspaces, two apps and five packages:

```
apps/
  api/              Express 4 + Drizzle + BullMQ. Owns DB, routes, workers.
  web/              React 18 + Vite 5 + Tailwind 3. SPA, fetches /api/*.
packages/
  shared/           Money, dates, ABA, account-type enums, Zod schemas.
  fidir/            FIDIR text-format parser + pg_trgm-style search helpers.
  reconciler/       Golden Rule reconciler + period-bounds checker.
  exporters/        CSV / OFX-XML / SGML (QBO + QFX) writers, FITID, TRNTYPE rules.
  extractor/        PDF preprocess, Vibe Shield OCR client, LLM provider abstraction, prompts.
data/
  fidir/fidir-us.txt   Vendored FIDIR mirror (ADR-007). Never fetched at runtime.
docs/
  adrs/             ADR-001 through ADR-020.
```

Workspaces are wired in `pnpm-workspace.yaml`. TypeScript project
references live in `tsconfig.base.json` + per-package `tsconfig.json`.

## Local development

Prerequisites: Node 20 LTS, pnpm 9, Docker (for Postgres + Redis), and
`poppler-utils` if you intend to exercise the OCR routing path locally
(`pdftoppm` is shelled out from `packages/extractor/src/preprocess.ts`).

```bash
pnpm install
cp .env.example .env                          # set SESSION_SECRET >= 32 bytes
docker compose up -d postgres redis           # standalone services
pnpm --filter @vibe-tx-converter/api run db:migrate
pnpm --filter @vibe-tx-converter/api run db:seed   # optional: load fixtures
pnpm dev                                       # api on :4000, web on :5173
```

Vibe Shield (OCR) and the LLM gateway are optional for most code paths — only the
extraction worker needs them. For unit tests, mocks live alongside the
clients.

## Commands

Root-level scripts (`package.json`):

- `pnpm dev` — runs api + web in parallel watch mode.
- `pnpm build` — `tsc` per workspace, then Vite build for `web`.
- `pnpm typecheck` — `tsc -b` across all references.
- `pnpm lint` — ESLint flat config (see `eslint.config.mjs`).
- `pnpm test` — Vitest, runs across the workspace via `vitest.workspace.ts`.
- `pnpm acceptance` — `typecheck && lint && test && build`. The bar a phase
  must clear before it counts as done (Appendix C of `BuildPlan.md`).
- `pnpm format` / `pnpm format:check` — Prettier.

Workspace-aware commands (e.g. running tests for one package):

```bash
pnpm --filter @vibe-tx-converter/exporters test fitid.test.ts
pnpm --filter @vibe-tx-converter/api run db:migrate
```

The `justfile` mirrors operator-facing commands: `just dev`, `just up`,
`just down`, `just psql`, `just redis-cli`, `just fidir-refresh`.

## Database / migrations

PostgreSQL 16, schema `vibetc`. Drizzle ORM, NOT Prisma. Migrations live
at `apps/api/src/db/migrations/`.

- `pnpm --filter @vibe-tx-converter/api run db:generate` — `drizzle-kit
generate` from `apps/api/src/db/schema.ts`.
- `pnpm --filter @vibe-tx-converter/api run db:migrate` — applies pending
  migrations.
- `audit_log` is append-only at the role level (ADR-013): the application
  role has only `INSERT, SELECT`. Do not write code that updates or
  deletes audit rows.

Money columns are `BIGINT` cents (ADR-017). Helpers live in
`packages/shared/src/money.ts`. Decimal-as-string only at the API
boundary and in OFX/CSV outputs.

## LLM + OCR development

OCR is called over HTTP through the Vibe Shield gateway — Claude vision,
with PII redacted before egress (ADR-022, supersedes ADR-003).
`packages/extractor/src/shield-ocr-client.ts` retries 5xx/429 with
backoff and caches by image sha256 + Shield session.

LLM extraction goes through `LlmProvider` (ADR-019/020). Two
implementations: `LocalGatewayProvider` (default, OpenAI wire format
against the Vibe LLM Gateway) and `AnthropicProvider` (opt-in, tool-use
with the schema as `input_schema`). Downstream code never branches on
provider.

To exercise the Anthropic path in dev set `LLM_PROVIDER=anthropic` and
`ANTHROPIC_API_KEY=...` in `.env`. Default model is `claude-sonnet-4-6`.

## Conventions

- **Conventional Commits.** Prefixes: `feat:`, `fix:`, `chore:`, `docs:`,
  `test:`, `refactor:`. The Definition of Done for each phase ends with a
  conventional-commit message specified in the BuildPlan.
- **ESLint flat config** at `eslint.config.mjs`. Includes `drizzle`,
  `import`, `react`, `react-hooks`, `unicorn`. CI fails on warnings.
- **Prettier** with `printWidth: 100`, `singleQuote: true`,
  `trailingComma: 'all'`, `semi: true` (`.prettierrc`). lint-staged +
  husky run on commit.
- **Line endings.** `.gitattributes` enforces LF on source and CRLF on
  `.cmd/.bat/.ps1`. The Windows operator runs this in production — do
  not normalize endings away from that.
- **No PII at info level.** LLM payloads are never logged at info; the
  forensic switch is `LLM_DEBUG_PAYLOADS=true` and is documented as
  off-by-default.

## Testing strategy

- Unit + integration: Vitest. Co-located `*.test.ts` next to source.
- Supertest against the Express app: `apps/api/src/api.test.ts`.
- E2E via Playwright is specified in Phase 27 but not yet wired (see
  `PROGRESS.md`).
- Golden-master fixtures per exporter are spec'd in Phase 27 but not yet
  authored — when adding exporter changes, hand-verify against
  `packages/exporters/src/exporters-render.test.ts` until the fixture
  corpus exists.

## Environment variables

The full canonical list is in `BuildPlan.md` Appendix B. The current set
the app actually reads is in `.env.example`. When you add a new env var
update both places (BuildPlan Appendix B and `.env.example`) — that is
part of Definition of Done.

## Releasing

Phase 30 wires GHCR multi-arch builds, cosign signing, and syft SBOM. As
of `PROGRESS.md` this is partially landed — the workflow exists but
signing, SBOM, and CHANGELOG generation are deferred. Ad-hoc images are
built via the multi-stage `Dockerfile` at the repo root.
