# User Guide

This guide is for the bookkeeper / staff user.

## Day to day

1. **Companies → New Company.** Each client firm is a Company.
2. **Open the company → Add account.** Pick the client's bank using
   the Bank Picker. Enter the account number; routing number is
   optional (fees + warnings — never blocks save).
3. **Open the account → Drop PDF statements.** You can drop a single
   PDF or a batch.
4. **Wait ~30 seconds.** Statements appear under
   "View statements →" with status `review` once extracted.
5. **Click a statement** to review transactions. You can edit any row
   (description, amount, type). Edits are tracked.
6. **If reconciliation is `verified`**, click any of the export
   buttons (CSV / OFX / QBO / QFX) to download.
7. **If reconciliation is `discrepancy`**, fix transactions until
   balances tie, OR override with a typed reason (audit-logged).

## What gets exported

| Format          | Use it for                                             |
| --------------- | ------------------------------------------------------ |
| CSV (QBO 3-col) | QuickBooks 3-column CSV import                         |
| CSV (QBO 4-col) | QuickBooks 4-column CSV import                         |
| CSV (Xero)      | Xero bank-statement import                             |
| CSV (Generic)   | Anything that takes Date / Description / Amount / Memo |
| OFX 2.x         | Most modern OFX importers (Xero, modern aggregators)   |
| QBO Web Connect | QuickBooks Desktop "Web Connect" import                |
| QFX             | Quicken "Web Connect" import                           |

## Tips

- **Statement period detection** — if the LLM can't tell whether the
  statement uses MM/DD or DD/MM dates, the statement halts in
  `awaiting-locale-confirmation`. Open it and pick the format.
- **Same-day same-amount transactions** — these get distinct FITIDs
  by their order in the source PDF, so re-importing a corrected
  statement won't double-book.
- **Multi-account PDFs** (household statements) are detected
  automatically; the upload step asks you to confirm the split before
  extraction begins.
