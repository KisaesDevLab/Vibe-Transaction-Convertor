# Getting started

Vibe Transactions Converter turns bank and credit-card PDF statements into the file formats your accounting software can re-import: CSV (in four shapes), OFX 2.x XML, QFX (Quicken), and QBO (QuickBooks Web Connect).

Everything runs locally. PDFs and rasterized page images never leave your server. The only carve-out is the optional Anthropic provider, which is off by default and only sends OCR-extracted text — never the raw PDF.

## The path through the app

1. **Sign in.** The first user you register on a fresh install is the admin; they can later create staff users.
2. **Create a Company** for each entity you do books for. A company is just a container — name only.
3. **Add Accounts** under each company. Each account has a nickname, a financial institution (picked from the FIDIR mirror), an account number, and an account type (checking, savings, credit card, etc.).
4. **Upload a PDF** statement on the account detail page (or drop several at once).
5. **Wait for extraction.** The pipeline runs: text-layer detection → OCR if needed → LLM extraction → reconciliation. You'll see status badges move from `uploaded` → `extracting` → `reconciling` → `review`.
6. **Review** the extracted transactions side-by-side with the source PDF. Edit anything that looks wrong, confirm the date format if asked.
7. **Export** in the format your accounting tool wants. Use "Download all (.zip)" if you want every format in one shot.

## Hard rules

- **USD only.** Multi-currency is out of scope for v1.
- **en-US dates (MDY) on every output.** Source PDFs can be in any format; the LLM detects and normalizes. Truly ambiguous statements halt and ask you to pick.
- **Exports are blocked when reconciliation is in `discrepancy`.** Either fix the rows or override (which is logged). `verified` and `overridden` are the only states that allow export.
- **Audit log is append-only.** Every mutation — edits, deletes, exports, overrides — is recorded. Rows are never modified or removed.

## Where to go next

- [Uploading PDFs](#uploading-pdfs) — what's supported, what happens during extraction
- [Reviewing transactions](#reviewing-transactions) — the grid, hot-keys, edits
- [Reconciliation](#reconciliation) — what the badges mean, how to clear discrepancies
- [Exporting](#exporting) — picking a format, FITID stability
- [Troubleshooting](#troubleshooting) — common errors
