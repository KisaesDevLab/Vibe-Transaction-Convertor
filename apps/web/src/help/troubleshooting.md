# Troubleshooting

Common errors and what to do about them. The full audit log (`/admin/audit`) is your friend — every mutation is recorded with the actor, payload, and timestamp.

## Upload fails immediately

> **"there is no unique or exclusion constraint matching the ON CONFLICT specification"**

DB schema drift. Migration `0006_page_range_split.sql` replaced a unique index with a partial one and the upload service needs the matching `WHERE page_range IS NULL` predicate. Fixed in code; if you see this on a stale build, run `pnpm db:migrate` and pull the latest API container.

## Upload accepted but statement stuck at `uploaded`

The BullMQ enqueue step silently failed. Most common cause:

> Worker log: `Custom Id cannot contain :`

BullMQ 5.76+ rejects custom job IDs containing colons. Fixed in code; if you see it, you're on an older build — pull the latest.

To unstick a statement: visit it, click **Re-extract** (admin only). That re-enqueues the job with the right ID.

## "Could not load PDF: API version X does not match the Worker version Y"

Front-end `pdfjs-dist` vs `react-pdf` version mismatch. Pinned in code to `4.8.69`. Hard-refresh (Ctrl+F5) to pull the latest bundle.

## "Could not load PDF: Unexpected server response (0)"

Older bug where the viewer wrapped the API response in a `blob:` URL and pdf.js's worker did its own XHR. Fixed by handing pdf.js the raw bytes. Hard-refresh.

## "Failed to execute 'postMessage' on 'Worker': ArrayBuffer at index 0 is already detached"

pdf.js's worker transfers (not copies) the buffer; subsequent renders re-issue the load against a now-detached buffer. Fixed by memoizing the file prop and slicing a copy. Hard-refresh.

## Single-format export buttons return 500

> Server log: `TypeError ERR_INVALID_CHAR: Invalid character in header content ["content-disposition"]`

The export filename was built from the FI name + period and contained a non-ASCII character (curly quote, en/em dash, accented letter). Fixed by sanitizing to ASCII before the header is set.

## Extraction fails with "VIBE_SHIELD_URL is not set"

The PDF is scanned (no text layer) and OCR isn't configured. OCR runs through the Vibe Shield gateway (Claude vision).

- Configure **Vibe Shield (OCR via Claude)** on `/admin/engines` (URL + `vs_live_…` key) and re-extract. Run `pnpm shield:smoke` to confirm the full path.
- Or, if you're sure the PDF has a text layer, the routing heuristic was wrong — open the PDF in Acrobat / Preview and select some text to verify. If text selects, the heuristic is the bug. Re-extract; the LLM may pick up the text path on retry.

## Extraction fails with "LLM_GATEWAY_URL not set"

Provider is `local` but the gateway URL is empty.

- Set `LLM_GATEWAY_URL` and restart the API, **or**
- Switch the provider to Anthropic on `/admin/llm-provider` and set an API key.

## Extraction fails with "monthly Anthropic spend cap reached"

You hit the soft cap on `/admin/engines`. Either raise the cap, switch back to local, or wait for the next calendar month.

## "Date format ambiguous — please confirm before this statement can be reviewed"

The LLM saw dates like `04/05/2026` that could be either Apr 5 or May 4. The amber banner shows both interpretations side-by-side; pick the right one. The statement is re-extracted with the chosen format.

If you pick wrong, the **Change format** link in the header header reopens the override menu.

## Reconciliation `discrepancy` won't go away

See [Reconciliation](#reconciliation). Most common cause is a transaction with the wrong sign — fix it, click **Recompute**, and the delta should clear.

## "I deleted something and want it back"

`audit_log` is append-only and stores the full payload of every mutation. Visit `/admin/audit`, filter to the entity, find the delete event, and read the payload. From there you can either:

- Manually reconstruct the row through the UI (admin add transaction, etc.).
- Restore from the most recent backup on `/admin/backup`. Backup restore is a heavier operation; it rolls the whole DB back, not just one row.

## Where to look first when something's wrong

1. The statement's status badge and `errorMessage`.
2. **Failed extractions** panel on `/admin` (shows recent failures with one-click re-extract).
3. **Diagnostics** at `/admin/diagnostics` — queue counts, dependency health, build SHA.
4. The API log on disk (`apps/api/dev-restart.log` in dev, container stdout in prod).
5. The audit log for the entity (`/admin/audit?entityType=statement&entityId=…`).
