# Uploading PDFs

## Where to upload

On the **account detail page** (`/accounts/<id>`), drag PDFs onto the upload zone or click "Choose files". You can drop several at once — each becomes its own statement.

## What's supported

- **PDF only.** Other formats are rejected.
- **Max upload size:** controlled by `MAX_UPLOAD_MB` (default 25 MB per file).
- **Max batch size:** `MAX_BATCH_SIZE` (default 100 files per drop).
- **Text-layer or scanned.** The pipeline auto-detects. Scanned PDFs are routed through OCR (Claude vision via Vibe Shield); text-layer PDFs skip OCR entirely.

## What happens after a drop

For each file:

1. The bytes are SHA-256 hashed. If the same hash has already been uploaded under this account, the upload is **deduplicated** (no new statement created, no re-extraction). The dropzone shows "already uploaded" next to that filename.
2. The PDF is stored under `$DATA_DIR/uploads/`, content-addressed by hash.
3. A `statement` row is created with status `uploaded` and a BullMQ extraction job is enqueued.
4. The worker picks it up and progresses the status: `preprocessing` → `ocr` (only when needed) → `extracting` → `reconciling` → `review`.

## Multi-account PDFs

Some PDFs (especially personal banks) carry several accounts in one document. The pipeline detects this and writes a `detectedSplits` annotation on the statement. On the review page you'll see a banner offering two options:

- **Acknowledge** — keep the statement as a single blob (rare; usually leads to discrepancies).
- **Split** — pick which account each page range belongs to. The original statement is replaced by N child statements, each re-extracted as if it were the whole PDF.

## Date-format ambiguity

If the PDF uses an ambiguous date format (e.g. `04/05/2026` could be Apr 5 or May 4), extraction halts at status `awaiting-locale-confirmation`. The review page shows an amber banner with both interpretations side-by-side; pick MDY or DMY and the statement is re-extracted.

## What can go wrong at this stage

- **"there is no unique or exclusion constraint matching the ON CONFLICT specification"** — DB schema drift. Run `pnpm db:migrate` and restart.
- **"VIBE_SHIELD_URL is not set"** — the PDF is scanned and the OCR engine (Vibe Shield) isn't configured. Either configure it on `/admin/engines` or upload a text-layer PDF instead.
- **"LLM_GATEWAY_URL not set"** — the LLM provider is `local` but the gateway URL is empty. Either set it, or switch to the Anthropic provider with a key.

See [Troubleshooting](#troubleshooting) for more.
