# Open Questions Log

Questions Claude could not resolve from `BuildPlan.md` or prior conversation
turns while building. Each entry: **what was asked**, **what assumption I
made to keep going**, and **what to revisit**. Resolve by editing the
relevant code/doc, then strike through the entry.

Format:

```
### Q-NNN — short title (Phase X, item Y) — yyyy-mm-dd
**Question:** ...
**Assumption made:** ...
**Where to revisit:** file:line / acceptance step / ADR-NNN
```

---

### Q-001 — drizzle-kit 0.24.2 silently drops `check()` constraints (Phase 3, item 27) — 2026-05-04

**Question:** With drizzle-orm 0.33.0 + drizzle-kit 0.24.2, table-level
`check('name', sql\`expr\`)`constraints inside the`(t) => ({ ... })`callback
are accepted at typecheck time but never appear in the generated migration
SQL or the snapshot. The schema.ts still declares them, but`db:generate`emits zero`ALTER TABLE ... ADD CONSTRAINT` statements.

**Assumption made:** Wrote the four CHECK constraints
(`accounts_currency_usd_only`, `accounts_credit_card_no_routing`,
`transactions_amount_nonzero`, `system_settings_secret_xor_plaintext`) as a
manual SQL migration `0003_check_constraints.sql`. Live smoke test confirms
they fire (CC-with-routing insert is rejected; system_settings xor insert is
rejected).

**Where to revisit:** Bumping drizzle-kit (0.25+ may fix), or migrating to
`pgPolicy`/`@drizzle/pgvector`-style constraint declarations. The `check`
imports in `apps/api/src/db/schema.ts` are kept for future kit upgrades to
re-detect them; if a future generator emits duplicates, drop the manual
migration.

### Q-002 — Authoritative Intuit FIDIR format + source URL (Phase 5, items 1-2) — 2026-05-04

**Question:** BuildPlan.md item 1 says "Document the canonical Intuit FIDIR
URL". The plan does not commit to one. Public mirrors of `fidir.txt` use at
least three different formats (flat key=value, INI-style sections,
JSON-with-headers) and the canonical Intuit URL has moved at least twice.
Without an authoritative source, the parser format I picked
(`KEY=value` lines, blank-line-separated records) is a documented choice
rather than Intuit's choice.

**Assumption made:** Vendored `data/fidir/fidir-us.txt` as a 127-record
**starter set** of major US banks/credit unions in the parser's expected
format. Documented this loud and clear in `data/fidir/README.md`. Wired
the seeder defensive cap (refuse < 100 entries) so a half-imported file
doesn't ship.

**Where to revisit:** Operator must confirm Intuit's authoritative URL
and format before production. If Intuit's format diverges from the
parser-friendly form, write a one-shot converter at
`apps/api/src/scripts/fidir-convert.ts`. Mirror cadence: quarterly per
plan.

### Q-003 — ZIP batch upload deferred (Phase 9, item 4) — 2026-05-04

**Question:** BuildPlan §9 item 4 says the upload route accepts up to
100 PDFs **and/or a single ZIP** that gets unzipped server-side.
Implementing ZIP needs an additional dep (yauzl or adm-zip) plus
in-memory size accounting (a malicious zip could expand to 10× and
exhaust the buffer limit), and adds a non-trivial test surface.

**Assumption made:** Phase 9 supports only multi-PDF multipart upload.
The route currently rejects ZIP files with the same magic-byte gate as
any other non-PDF (the entry's first 5 bytes are `PK..` not `%PDF-`).

**Where to revisit:** When the operator first asks to drop a ZIP. Add
`yauzl` (smallest, streaming), enforce a per-entry size cap, and write
a supertest with a real ZIP fixture in `tests/fixtures/`.

### Q-004 — Rasterization mechanism: pdftoppm vs pdfjs+canvas (Phase 10, items 2 + 6) — 2026-05-04

**Question:** BuildPlan §10 item 2 prefers `pdftoppm` (poppler-utils,
shell-out) for raster, but the user's dev box is Windows where poppler
is not installed by default. The pure-JS alternative is
`pdfjs-dist` + `canvas`, which adds a native build step (sharp/cairo)
that itself often fails on Windows.

**Assumption made:** `rasterizePdf()` is exported from
`packages/extractor/src/preprocess.ts` with the right contract but
throws `not implemented yet — wired up by Phase 11`. The text-layer
fast path (Phase 10's main deliverable) does not need rasterization.
Phase 11 (GLM-OCR HTTP client) wires the actual implementation —
likely shelling out to `pdftoppm` in the API container's Dockerfile,
with the operator-guide doc instructing local installs to add poppler.

**Where to revisit:** Phase 11 implementation. The API container's
Dockerfile (Phase 28) MUST add `poppler-utils`. The `/api/health/ready`
poppler-version probe (item 13) lands in Phase 11.

### Q-005 — GLM-OCR HTTP contract not specified (Phase 11) — 2026-05-04

**Question:** BuildPlan §11 calls for an HTTP client to `glm-ocr-server`
but never pins the request/response shape, endpoint paths, or auth
headers. Public Zhipu GLM-OCR repos use multiple shapes
(`/v1/ocr` + multipart, `/ocr` + JSON-base64, OpenAI-compatible
`/v1/chat/completions` with image attachments).

**Assumption made:** Implemented an assumed contract:
`POST {GLM_OCR_URL}/ocr` with `{ pages: [{ image_base64: string }] }`
returning `{ pages: [{ index, markdown, confidence }] }` and
`GET /health` returning 200. The client is fully tested with mocked
fetchers; swapping to the real contract is a one-file change.

**Where to revisit:** Operator stands up `glm-ocr-server` and
confirms the actual surface; update `glm-ocr-client.ts` accordingly.

### Q-006 — rasterizePdf — RESOLVED 2026-05-05

**Resolution:** `rasterizePdf` shells out to `pdftoppm` (poppler-utils).
The standalone Dockerfile already installs poppler; host operators need
`brew install poppler` / `apt install poppler-utils` /
`choco install poppler`. On ENOENT we throw a clear error pointing the
operator at the install commands. See `packages/extractor/src/preprocess.ts`.
