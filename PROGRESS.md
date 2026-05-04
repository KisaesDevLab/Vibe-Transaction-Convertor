# Build Progress

Phase-by-phase progress against `BuildPlan.md`. Update after every phase
commit. Acceptance gauntlet for every phase: `pnpm acceptance` (runs
typecheck → lint → test → build).

| Phase | Title                                        | Status | Commit    | Notes                      |
| ----- | -------------------------------------------- | ------ | --------- | -------------------------- |
| 0     | Repo Bootstrap                               | ✅     | `9838a8f` | runnable monorepo skeleton |
| 1     | ADRs, Docs Skeleton, License                 | ✅     | `77c429d` | 20 ADRs landed             |
| 2     | Workspace, TS, Lint, Test Config             | ✅     | _next_    | helpers + 18 tests passing |
| 3     | Database Schema & Migrations                 | ⏸      | —         |                            |
| 4     | API Scaffolding & Health                     | ⏸      | —         |                            |
| 5     | FIDIR Mirror, Parser, Seeder                 | ⏸      | —         |                            |
| 6     | Auth & Session                               | ⏸      | —         |                            |
| 7     | Companies CRUD (API + UI)                    | ⏸      | —         |                            |
| 8     | Accounts CRUD with Bank Picker               | ⏸      | —         |                            |
| 9     | PDF Upload, Storage, Hashing                 | ⏸      | —         |                            |
| 10    | PDF Pre-Processing & Routing                 | ⏸      | —         |                            |
| 11    | GLM-OCR HTTP Client                          | ⏸      | —         |                            |
| 12    | LLM Extractor — Schema, Prompts, Exemplars   | ⏸      | —         |                            |
| 13    | LLM Provider Abstraction (Local + Anthropic) | ⏸      | —         |                            |
| 14    | Multi-Account Auto-Split                     | ⏸      | —         |                            |
| 15    | BullMQ Extraction Pipeline                   | ⏸      | —         |                            |
| 16    | Golden Rule Reconciler & Repair Pass         | ⏸      | —         |                            |
| 17    | TRNTYPE Inference + FITID Generator          | ⏸      | —         |                            |
| 18    | Statement & Transaction Review UI            | ⏸      | —         |                            |
| 19    | PDF Viewer with Bounding-Box Highlighting    | ⏸      | —         |                            |
| 20    | CSV Exporter                                 | ⏸      | —         |                            |
| 21    | OFX 2.x XML Exporter                         | ⏸      | —         |                            |
| 22    | QBO Exporter (OFX 1.x SGML + INTU.BID)       | ⏸      | —         |                            |
| 23    | QFX Exporter                                 | ⏸      | —         |                            |
| 24    | Export UI & Download Bundling                | ⏸      | —         |                            |
| 25    | Audit Log                                    | ⏸      | —         |                            |
| 26    | Admin / Settings                             | ⏸      | —         |                            |
| 27    | Testing — Unit, Integration, E2E             | ⏸      | —         |                            |
| 28    | Standalone Docker Compose                    | ⏸      | —         |                            |
| 29    | Vibe Appliance Mode + Manifest               | ⏸      | —         |                            |
| 30    | GHCR Publishing & Release Automation         | ⏸      | —         |                            |
| 31    | Documentation Pass                           | ⏸      | —         |                            |
| 32    | Final QA & Release Checklist                 | ⏸      | —         |                            |

Legend: ✅ done · ⏳ in progress · ⏸ pending · ⚠ blocked
