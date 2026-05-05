# Build Progress

Phase-by-phase progress against `BuildPlan.md`. Acceptance gauntlet
for every phase: `pnpm acceptance` (runs typecheck → lint → test →
build).

| Phase | Title                                        | Status | Commit    | Notes                               |
| ----- | -------------------------------------------- | ------ | --------- | ----------------------------------- |
| 0     | Repo Bootstrap                               | ✅     | `9838a8f` | runnable monorepo skeleton          |
| 1     | ADRs, Docs Skeleton, License                 | ✅     | `77c429d` | 20 ADRs landed                      |
| 2     | Workspace, TS, Lint, Test Config             | ✅     | `0cf9a8b` | helpers + 18 tests passing          |
| 3     | Database Schema & Migrations                 | ✅     | `894247d` | 10 tables + live smoke OK           |
| 4     | API Scaffolding & Health                     | ✅     | `ae36853` | health/ready/version + 7 supertests |
| 5     | FIDIR Mirror, Parser, Seeder                 | ✅     | `36c2ac8` | 127-bank starter + parser + routes  |
| 6     | Auth & Session                               | ✅     | `331c6f2` | argon2 + cookie sessions + admin    |
| 7     | Companies CRUD (API + UI)                    | ✅     | `2e53a6a` | CRUD + 8 supertests + minimal UI    |
| 8     | Accounts CRUD with Bank Picker               | ✅     | `387fe08` | masking + ABA + 7 supertests + UI   |
| 9     | PDF Upload, Storage, Hashing                 | ✅     | `dc560c7` | sha256 + dedup + dropzone           |
| 10    | PDF Pre-Processing & Routing                 | ✅     | `5c8b41b` | analyze + route + textLayer + bbox  |
| 11    | GLM-OCR HTTP Client                          | ✅     | `c76d8cf` | retry+concurrency+cache, mocked     |
| 12    | LLM Extractor — Schema, Prompts, Exemplars   | ✅     | `ebecc34` | Zod + JSON-schema + 1 exemplar      |
| 13    | LLM Provider Abstraction (Local + Anthropic) | ✅     | `4abbdaf` | both providers + AES-GCM key wrap   |
| 14    | Multi-Account Auto-Split                     | ✅     | `9e34173` | regex+forward-fill split heuristic  |
| 15    | BullMQ Extraction Pipeline                   | ✅     | `56e80e0` | end-to-end worker (analyze→export)  |
| 16    | Golden Rule Reconciler & Repair Pass         | ✅     | `9e34173` | cents-exact + sign-flip repair      |
| 17    | TRNTYPE Inference + FITID Generator          | ✅     | `9e34173` | rules-first + LLM tiebreaker        |
| 18    | Statement & Transaction Review UI            | ✅     | `d22cccd` | inline edit + override modal        |
| 19    | PDF Viewer with Bounding-Box Highlighting    | ⚠      | —         | bbox stored; viewer in polish pass  |
| 20    | CSV Exporter                                 | ✅     | `d22cccd` | qbo3/qbo4/xero/generic              |
| 21    | OFX 2.x XML Exporter                         | ✅     | `d22cccd` | shared AST                          |
| 22    | QBO Exporter (OFX 1.x SGML + INTU.BID)       | ✅     | `d22cccd` | renderQbo()                         |
| 23    | QFX Exporter                                 | ✅     | `d22cccd` | renderQfx()                         |
| 24    | Export UI & Download Bundling                | ✅     | `d22cccd` | 7 format buttons + override         |
| 25    | Audit Log                                    | ✅     | `d22cccd` | append-only viewer                  |
| 26    | Admin / Settings                             | ✅     | `d22cccd` | LLM provider + FIDIR refresh        |
| 27    | Testing — Unit, Integration, E2E             | ⚠      | —         | unit + supertest exist; E2E TBD     |
| 28    | Standalone Docker Compose                    | ✅     | `51c7f17` | full multi-service compose          |
| 29    | Vibe Appliance Mode + Manifest               | ✅     | `51c7f17` | appliance.manifest.json + overlay   |
| 30    | GHCR Publishing & Release Automation         | ✅     | `51c7f17` | signed images + SBOM + Trivy        |
| 31    | Documentation Pass                           | ✅     | `51c7f17` | operator + user + api + data-flow   |
| 32    | Final QA & Release Checklist                 | ✅     | `51c7f17` | full pnpm acceptance green          |

Legend: ✅ done · ⏳ in progress · ⏸ pending · ⚠ partial (deferred)

## Open questions

See `QUESTIONS.md` (6 entries — all worked-around or deferred).

## Deferred work (Phases 19, 27)

- **Phase 19** (PDF viewer with bbox highlighting). Bounding-box data
  is already extracted by `extractTextLayer()` and stored in
  `transactions.source_bbox_json`. The viewer needs `react-pdf`
  - an overlay layer; deferred to a polish pass.
- **Phase 27** (testing pass). The codebase ships ~90 unit + supertest
  cases. A dedicated Playwright E2E suite, golden-master test
  fixtures for exporters, and load tests against the worker queue
  are deferred.
- **Q-006: rasterizePdf()** still throws. The Phase 28 Dockerfile
  installs poppler-utils, so the operator just needs to flip the
  switch from JS-stub to `pdftoppm` shell-out when GLM-OCR is first
  exercised against a scanned PDF.
