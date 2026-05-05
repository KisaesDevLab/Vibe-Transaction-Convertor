# Build Progress

Phase-by-phase status against `BuildPlan.md`. Status reflects **acceptance
verbatim** against the BuildPlan's Acceptance bullet for each phase, not
just whether the happy path runs. Acceptance gauntlet: `pnpm acceptance`
(typecheck → lint → test → build).

| Phase | Title                                     | Status | Last commit | Notes                                                          |
| ----- | ----------------------------------------- | ------ | ----------- | -------------------------------------------------------------- |
| 0     | Repo Bootstrap                            | ✅     | `9838a8f`   | clean                                                          |
| 1     | ADRs, Docs Skeleton, License              | ✅     | `77c429d`   | 20 ADRs                                                        |
| 2     | Workspace, TS, Lint, Test Config          | ✅     | `0cf9a8b`   | clean                                                          |
| 3     | Database Schema & Migrations              | ✅     | `894247d`   | clean                                                          |
| 4     | API Scaffolding & Health                  | ✅     | `ae36853`   | clean (101st-req rate-limit test missing)                      |
| 5     | FIDIR Mirror, Parser, Seeder              | ⚠      | `36c2ac8`   | 127-bank stub, not vendored Intuit                             |
| 6     | Auth & Session                            | ✅     | `331c6f2`   | clean                                                          |
| 7     | Companies CRUD (API + UI)                 | ⚠      | `2e53a6a`   | no shadcn/Radix; no detail-page edit/delete                    |
| 8     | Accounts CRUD with Bank Picker            | ⚠      | `387fe08`   | no edit/delete on detail; no test-stamp preview                |
| 9     | PDF Upload, Storage, Hashing              | ⚠      | `dc560c7`   | no ZIP batch; no MIME sniffing; no .tmp 1h cleanup             |
| 10    | PDF Pre-Processing & Routing              | ⚠      | `5c8b41b`   | no fixture suite; no per-page timeouts; no force-OCR flag      |
| 11    | GLM-OCR HTTP Client                       | ⚠      | `c76d8cf`   | in-memory cache (spec: Redis); no version probe; no breaker    |
| 12    | LLM Extractor                             | ⚠      | `c403118`   | 4 of 10 exemplars; token budget; cleanup; flat schema remains  |
| 13    | LLM Provider Abstraction                  | ⚠      | `c403118`   | dateFormatOverride wired; no 60-s cache; no @anthropic-ai/sdk  |
| 14    | Multi-Account Auto-Split                  | ⚠      | `2c664d7`   | real split via /split + page_range; no overlap-conflict tests  |
| 15    | BullMQ Extraction Pipeline                | ⚠      | `c403118`   | locale-gate now wired; no SSE progress; no cancel              |
| 16    | Golden Rule Reconciler & Repair Pass      | ⚠      | `ec3de5c`   | LLM repair + suspect rows + auto-recompute; no LLM-pass tests  |
| 17    | TRNTYPE Inference + FITID Generator       | ⚠      | `702449e`   | rule list + isCreditCard wired; no docs/extraction.md          |
| 18    | Statement & Transaction Review UI         | ⚠      | `d22cccd`   | no global /statements; no full-detail header                   |
| 19    | PDF Viewer with Bounding-Box Highlighting | ⚠      | `9a1fc2f`   | PDF→txn click selection not wired                              |
| 20    | CSV Exporter                              | ⚠      | `702449e`   | column shapes fixed; no golden-master fixtures yet             |
| 21    | OFX 2.x XML Exporter                      | ⚠      | `702449e`   | CRLF + SONRS FI block; no ofx4js parse roundtrip               |
| 22    | QBO Exporter                              | ⚠      | `702449e`   | INTU.BID always; BANKID ladder; no transliteration             |
| 23    | QFX Exporter                              | ⚠      | `702449e`   | INTU.USERID stable; needs golden-master + qfx-import.md        |
| 24    | Export UI & Download Bundling             | ⚠      | `<next>`    | <ExportPage> + preview + listing + per-job re-download         |
| 25    | Audit Log                                 | ⚠      | `d22cccd`   | no diffs / no JSON tree / no downloads / no retention          |
| 26    | Admin / Settings                          | ⚠      | `d22cccd`   | no LlmProviderAdminPage; no real BackupAdminPage; no FidirPage |
| 27    | Testing — Unit, Integration, Goldens, E2E | ⚠      | —           | 102 unit/supertests; no Playwright; no fixture suite           |
| 28    | Standalone Docker Compose                 | ⚠      | `51c7f17`   | no Caddy; no separate worker service; runs as root             |
| 29    | Vibe Appliance Mode + Manifest            | ⚠      | `51c7f17`   | manifest is JSON not vibe-app.yaml; no installer integration   |
| 30    | GHCR Publishing & Release Automation      | ⚠      | `51c7f17`   | no cosign sig; no syft SBOM; no CHANGELOG                      |
| 31    | Documentation Pass                        | ⚠      | `51c7f17`   | half the spec'd docs missing                                   |
| 32    | Final QA & Release Checklist              | ⚠      | `51c7f17`   | v0.1.0 not tagged; no documented smoke against Quicken/QB      |

Legend: ✅ done (passes BuildPlan acceptance verbatim) · ⚠ partial (functional but
acceptance bullet not satisfied) · ⏸ pending · ⏳ in progress

## State of the build

The **core happy path works end-to-end**: register first admin → create
company → add account with bank-picker → upload PDF → BullMQ worker
analyzes / extracts / reconciles → review grid with inline edits and
PDF viewer → export to CSV/OFX/QBO/QFX → audit-log every mutation. The
acceptance suite is green (128 unit + supertests pass, build clean).

What's missing is **breadth, polish and several spec invariants**:

- Frontend stack is raw HTML+Tailwind (CLAUDE.md locks shadcn/Radix).
- No fixture corpus / golden-master files; no Playwright; no React
  Testing Library.
- LLM extraction is wired but thin — 4 of 10 exemplars, flat schema
  (still pending nesting refactor). Token budget + markdown cleanup
  landed in `c403118`. LLM-driven repair pass landed in `ec3de5c`.
- ~~Multi-account split into multiple statement rows.~~ Landed
  2026-05-05: page_range int4range column on statements, partial
  unique index + GiST overlap-exclusion, POST /:id/split route, UI
  modal with per-segment account picker, page-range-scoped worker
  extraction.
- ~~Exporter byte shapes diverge from spec.~~ Resolved 2026-05-05 in
  commit `702449e`: CSV column sets, OFX 2.x CRLF + FI block, QBO
  always-emit INTU.BID with '3000' fallback, BANKID fallback ladder,
  QFX INTU.USERID stable per account. Still need golden-master
  fixtures per template.
- Admin, audit, export, and review UIs are missing dialog / preview /
  listing surfaces.
- Release pipeline lacks cosign signing, syft SBOM, CHANGELOG.
- Half the spec'd docs are not written.

A full audit log is in conversation history (2026-05-05). A complete
gap punch-list per phase is in `docs/GAPS.md` (TBD). The honest count
is **6 of 33 phases pass acceptance verbatim** (0, 1, 2, 3, 4, 6).

## Open questions

See `QUESTIONS.md`. Q-001 through Q-006 are all worked-around or
resolved. Q-006 (rasterizePdf) — resolved 2026-05-05 via pdftoppm
shell-out.

## Deferred / not-yet-started

- **Phase 27 testing pass** beyond unit + supertest: Playwright E2E,
  fixture-corpus golden masters per exporter, load tests, contract
  tests for both LLM providers, "no API key in logs" regression test,
  "no PDF/page-image bytes in payload" outbound assertion.
- ~~Phase 16 LLM-driven repair.~~ Landed 2026-05-05 in `ec3de5c`.
- **Phase 24 ExportPage** — full preview + per-format checkbox UI.
- **Phase 26 LlmProviderAdminPage** — typed-confirm phrase, model
  dropdown, monthly cost cap, test-connection.
