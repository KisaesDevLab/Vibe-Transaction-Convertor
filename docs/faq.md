# FAQ

Common operator and end-user questions.

## Does this app phone home?

**No.** Zero outbound network calls at runtime by default. There is no
telemetry, no analytics SDK, no auto-update check, no license-server
ping. The FIDIR mirror is shipped in source control and refreshed
manually (ADR-007). The only opt-in egress path is the optional
Anthropic API provider — see below.

## Will my PDFs be sent to OpenAI / Anthropic?

**No, never the PDFs themselves.** When you opt into the Anthropic
provider in `/admin`, the only data that leaves the box is the
**OCR-extracted markdown text** plus the JSON Schema (sent as a single
tool's `input_schema`). The raw PDF bytes and the rasterized page
images stay on your server and never leave it.

If you do not enable the Anthropic provider, nothing leaves the box at
all — extraction runs against the local Vibe LLM Gateway.

OpenAI is not a supported provider. Only the local gateway and the
Anthropic API are wired (ADR-019 / ADR-020).

## Where do my PDFs and exports live?

PDFs live under `${DATA_DIR}/uploads/{yyyy}/{mm}/{sha256}.pdf`,
content-addressed by SHA-256 so re-uploading the same statement
deduplicates. `DATA_DIR` defaults to `/var/lib/vibetc` in containers
and `./data` in dev. Postgres holds extracted transactions in the
`vibetc` schema. Audit logs and session records live in Postgres too.
Exports are streamed and not persisted on disk by default.

## Can I run this offline?

**Yes**, in the default local-provider mode. Once the container image
is pulled and FIDIR is mirrored, the application has no runtime
network dependency outside its own Postgres / Redis / GLM-OCR / LLM
Gateway containers. This is the supported posture for air-gapped
firms.

## Why are some FITIDs the same on re-import?

**That's the design** (ADR-005, ADR-016). FITIDs are derived from
`sha1(date | amount_cents | normalized_description | seq_in_day)`, so
re-importing a corrected statement of the same PDF produces the same
FITIDs and QuickBooks / Quicken / Xero deduplicate rather than
double-booking. If you edit a transaction's description in the review
UI, that row's FITID changes — which is correct, because a corrected
description is a logically different transaction.

## Can I disable reconciliation?

**No** — the Golden Rule reconciler is always run. But you can
**override** a discrepancy per-statement via the typed-confirmation
modal: type "I understand this export will not balance" and the
override is applied. Every override is audit-logged with the actor
and the reason. This is intentional — it keeps the gate visible
while still letting an experienced bookkeeper push past a known
benign mismatch.

## Can I use it for non-USD?

**Not in v1.** USD-only and en-US (MDY) on every output. Source PDFs
may be in any unambiguous date format and the LLM normalizes to ISO
internally; exports are always en-US. Multi-currency is explicitly
out of scope for v1 (Appendix D of `BuildPlan.md`).

## What if QuickBooks rejects my QBO file with `OL-220` or similar?

Try the **bank picker** dropdown — the BANKID fallback ladder (commit
`702449e`) chooses the routing number first, then a 9-digit BID, then
a zero-padded BID, then the hardcoded fallback. If QuickBooks still
rejects, switch to a known bank (Wells Fargo / Chase) in the account
settings; that uses a BID QuickBooks definitely accepts. See
`docs/qbo-import.md` for the full troubleshooting list.

## What about `.qfx` and Quicken for Mac?

Quicken for Mac sometimes refuses files with the `.qfx` extension. The
fix is to rename the file to `.qbo` and try the Web Connect importer
again — the SGML body is identical. See `docs/qfx-import.md`.

## How much does the Anthropic provider cost?

That depends on your bank statements and the model you pick (default
`claude-sonnet-4-6`). The admin page shows monthly cost-to-date in
USD micros; the per-call telemetry is also written to the audit log.
You can set a **monthly cap** in `/admin`; jobs that would exceed the
cap fail with `LlmCostCapExceededError` and surface a banner.

## How do I rotate the Anthropic API key?

In `/admin → LLM Provider`, paste a new key. The old wrapped value is
overwritten in `system_settings.value_encrypted`. To fully disable the
provider, switch the selector back to `local` or delete the key.

## My bank isn't in the picker — what do I do?

Click "Bank not listed?" when creating the account. The export will
use the BANKID fallback ladder, which lands on `'3000'` (Wells
Fargo's generic ID, accepted by QuickBooks and Quicken). If you have
Intuit's current FIDIR file, drop it at `data/fidir/fidir-us.txt` and
run `just fidir-refresh` (or admin → Refresh FIDIR).

## How do I back up?

`pg_dump` of the `vibetc` schema, plus the `${DATA_DIR}/uploads`
directory (or rely on dedup — re-upload the source PDFs to a fresh
install). FIDIR is in source control. See `docs/operator-guide.md` for
the full procedure.

## Is the source code redistributable?

**No.** The license is **PolyForm Internal Use 1.0.0** — the firm that
deploys this may use it internally without restriction, but cannot
redistribute the source or the container image to third parties. There
is no runtime DRM (ADR-011); the license is enforced at the
source-license level only.
