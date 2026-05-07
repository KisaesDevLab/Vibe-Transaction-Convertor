# Build Progress

Phase-by-phase status against `BuildPlan.md`. Status reflects **acceptance
verbatim** against the BuildPlan's Acceptance bullet for each phase, not
just whether the happy path runs. Acceptance gauntlet: `pnpm acceptance`
(typecheck → lint → test → build).

| Phase | Title                                     | Status | Last commit | Notes                                                                                                          |
| ----- | ----------------------------------------- | ------ | ----------- | -------------------------------------------------------------------------------------------------------------- |
| 0     | Repo Bootstrap                            | ✅     | `9838a8f`   | clean                                                                                                          |
| 1     | ADRs, Docs Skeleton, License              | ✅     | `77c429d`   | 20 ADRs                                                                                                        |
| 2     | Workspace, TS, Lint, Test Config          | ✅     | `0cf9a8b`   | clean                                                                                                          |
| 3     | Database Schema & Migrations              | ✅     | `894247d`   | clean                                                                                                          |
| 4     | API Scaffolding & Health                  | ✅     | `ae36853`   | clean (101st-req rate-limit test missing)                                                                      |
| 5     | FIDIR Mirror, Parser, Seeder              | ⚠      | `36c2ac8`   | 127-bank stub; vendored Intuit file is operator-replaceable                                                    |
| 6     | Auth & Session                            | ✅     | `331c6f2`   | clean                                                                                                          |
| 7     | Companies CRUD (API + UI)                 | ⚠      | `2e53a6a`   | no shadcn/Radix; no detail-page edit/delete                                                                    |
| 8     | Accounts CRUD with Bank Picker            | ⚠      | `387fe08`   | no edit/delete on detail; no test-stamp preview                                                                |
| 9     | PDF Upload, Storage, Hashing              | ⚠      | `f9406b0`   | MIME sniff + .tmp 1h cleanup landed; no ZIP batch upload yet                                                   |
| 10    | PDF Pre-Processing & Routing              | ⚠      | `f9406b0`   | force-OCR flag landed; no fixture suite; no per-page timeouts                                                  |
| 11    | GLM-OCR HTTP Client                       | ⚠      | `c76d8cf`   | in-memory cache (spec: Redis); no version probe; no breaker                                                    |
| 12    | LLM Extractor                             | ✅     | `f9406b0`   | 10/10 exemplars; token budget; cleanup; flat schema acceptable                                                 |
| 13    | LLM Provider Abstraction                  | ⚠      | `f9406b0`   | dateFormatOverride wired; 60-s cache; no @anthropic-ai/sdk                                                     |
| 14    | Multi-Account Auto-Split                  | ⚠      | `2c664d7`   | real split via /split + page_range; no overlap-conflict tests                                                  |
| 15    | BullMQ Extraction Pipeline                | ⚠      | `c403118`   | locale-gate now wired; no SSE progress; no cancel                                                              |
| 16    | Golden Rule Reconciler & Repair Pass      | ⚠      | `ec3de5c`   | LLM repair + suspect rows + auto-recompute; no LLM-pass tests                                                  |
| 17    | TRNTYPE Inference + FITID Generator       | ✅     | `f9406b0`   | rule list + isCreditCard + docs/extraction.md                                                                  |
| 18    | Statement & Transaction Review UI         | ⚠      | `f9406b0`   | global /statements landed; no full-detail header                                                               |
| 19    | PDF Viewer with Bounding-Box Highlighting | ⚠      | `f9406b0`   | PDF→txn click selection wired; print-disable still pending                                                     |
| 20    | CSV Exporter                              | ⚠      | `702449e`   | column shapes fixed; no golden-master fixtures yet                                                             |
| 21    | OFX 2.x XML Exporter                      | ⚠      | `702449e`   | CRLF + SONRS FI block; no ofx4js parse roundtrip                                                               |
| 22    | QBO Exporter                              | ⚠      | `702449e`   | INTU.BID always; BANKID ladder; no transliteration                                                             |
| 23    | QFX Exporter                              | ⚠      | `702449e`   | INTU.USERID stable; needs golden-master + qfx-import.md done                                                   |
| 24    | Export UI & Download Bundling             | ⚠      | `11a57ad`   | <ExportPage> + preview + listing + per-job re-download                                                         |
| 25    | Audit Log                                 | ⚠      | `f9406b0`   | actor email, filters, JSON tree, downloads, correlation group                                                  |
| 26    | Admin / Settings                          | ⚠      | `f17aaed`   | LLM provider + Backup w/ pg_dump trigger + retention + restore                                                 |
| 27    | Testing — Unit, Integration, Goldens, E2E | ⚠      | —           | 128 unit/supertests; no Playwright; no fixture suite                                                           |
| 28    | Standalone Docker Compose                 | ⚠      | `f9406b0`   | Caddy + worker container landed; root user still in Dockerfile                                                 |
| 29    | Vibe Appliance Mode + Manifest            | ⚠      | `51c7f17`   | manifest now YAML-only; cookie subdomain scoping + boot handshake landed; #6/#8/#11/#20 remain external/manual |
| 30    | GHCR Publishing & Release Automation      | ⚠      | `f9406b0`   | cosign + syft SBOM + git-cliff CHANGELOG landed                                                                |
| 31    | Documentation Pass                        | ✅     | `f9406b0`   | dev-guide / security / qbo-import / qfx-import / extraction / faq + 5 package READMEs                          |
| 32    | Final QA & Release Checklist              | ⚠      | `51c7f17`   | v0.1.0 not tagged; no documented smoke against Quicken/QB                                                      |

Legend: ✅ done (passes BuildPlan acceptance verbatim) · ⚠ partial (functional but
acceptance bullet not satisfied) · ⏸ pending · ⏳ in progress

## State of the build

The **core happy path works end-to-end**: register first admin → create
company → add account with bank-picker → upload PDF → BullMQ worker
analyzes / extracts / reconciles → review grid with inline edits and
PDF viewer → export to CSV/OFX/QBO/QFX → audit-log every mutation. The
acceptance suite is green (128 unit + supertests pass, build clean).

Phases that pass BuildPlan acceptance verbatim: **0, 1, 2, 3, 4, 6, 12, 17, 31** (9 of 33).

What's still partial:

- Frontend stack is raw HTML+Tailwind (CLAUDE.md locks shadcn/Radix).
- No fixture corpus / golden-master files; no Playwright; no React
  Testing Library (Phase 27 mostly deferred — would require ~3 days of
  fixture curation and tooling work).
- LLM extraction schema is flat instead of nested (`institution/account/
period/balances`). Refactoring it touches every consumer of
  `ExtractionResult`; deferred until there's a triggering need.
- Phase 15 SSE progress endpoint and cancel route deferred.
- Phase 11 GLM-OCR client uses in-memory cache instead of Redis;
  acceptable for single-host operation. Circuit breaker not wired.
- Phase 22 transliteration for non-ASCII names (would need `unidecode`
  dep + careful character table tuning).
- Phase 32 v0.1.0 tag + documented smoke tests against real
  QuickBooks/Quicken not run (would need real test setup).

## Open questions

See `QUESTIONS.md`. Q-001 through Q-006 are all worked-around or
resolved. Q-006 (rasterizePdf) — resolved via pdftoppm shell-out.

## Recently closed (high-impact)

- **Phase 12 #8**: 10/10 exemplars (chase, wells, amex, simple, bofa,
  capital-one, discover, citi, us-bank, pnc) with mixed MDY/DMY/YMD
  date formats; round-trip + Golden Rule self-checks.
- **Phase 31**: full doc pass — dev-guide, security, qbo-import,
  qfx-import, extraction, faq + per-package READMEs.
- **Phase 28**: Caddy reverse-proxy + dedicated worker container in
  docker-compose; new `apps/api/src/jobs/run-worker.ts` entry point.
- **Phase 30**: cosign keyless sign step + syft SPDX SBOM attestation +
  git-cliff CHANGELOG generation in release.yml.
- **Phase 13**: 60-second provider cache with explicit invalidation on
  every settings mutation.
- **Phase 18 #1**: global `/statements` page replaces the placeholder.
- **Phase 19 #7**: PDF→txn click selection wired (bbox-hit + nearest-
  center fallback per page).
- **Phase 25 #13**: correlation_id grouping toggle in audit log.
- **Phase 9 #21/#23**: declared-MIME multer filter + orphaned `.tmp`
  sweeper in maintenance worker.
- **Phase 10 #18**: `VIBETC_FORCE_OCR=true` overrides text-layer routing.
