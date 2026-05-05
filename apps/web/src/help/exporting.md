# Exporting

Exports turn the reviewed statement into a file you can re-import into your accounting software. Seven formats are produced:

| Format              | What for                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **CSV (QBO 3-col)** | Date, Description, Amount. Smallest CSV.                                                                                  |
| **CSV (QBO 4-col)** | Date, Description, Credit, Debit. Some QuickBooks Desktop importers prefer this.                                          |
| **CSV (Xero)**      | `*Date, *Amount, Payee, …` — Xero's import schema.                                                                        |
| **CSV (Generic)**   | Date, Description, Amount, RunningBalance, … — kitchen-sink CSV with extras. Useful for spreadsheets or custom importers. |
| **OFX 2.x XML**     | Modern OFX. Most non-Intuit / non-Quicken importers want this.                                                            |
| **QBO Web Connect** | OFX 1.0.2 SGML + INTU.BID. QuickBooks Desktop's import format. Carries the bank routing number and Intuit bank ID.        |
| **QFX**             | OFX 1.0.2 SGML for Quicken.                                                                                               |

## Quick path: Download all (.zip)

The big green button on the review page renders all seven formats and bundles them into one zip. Use this if you don't know which format the downstream tool will accept — keep the one that works.

## Per-format buttons

Each format has its own button next to the bundle. Click one to render and download just that format.

## The Export… page

`/statements/<id>/export` is the considered path: live preview pane (first 30 lines of any format), prior-export history, per-format download with file size, admin Delete button per export job.

## Determinism

The same PDF, reviewed the same way, always produces the same export bytes (modulo `<DTSERVER>` timestamps in OFX). This is intentional — re-imports are idempotent.

## FITID

OFX/QBO/QFX use a FITID ("Financial Institution Transaction ID") to identify each transaction uniquely. Vibe derives it as:

```
FITID = "VTC-" + sha1(date | amount | normalized_desc | seq_index_in_day).truncate(20)
```

This means:

- Re-importing the same statement won't create duplicates in QuickBooks/Quicken — they recognize each FITID and skip.
- Two same-day same-amount transactions are disambiguated by `seq_index_in_day`.
- A user edit that changes the amount or date generates a new FITID — that's correct, because conceptually it's a new transaction.

## Override-only export

When reconciliation is `overridden` (not `verified`), exports include a small note in the file (an OFX comment or generic-CSV header line) flagging that the operator overrode. This makes it visible to reviewers downstream without breaking the format.

## When exports are blocked

- `discrepancy` — fix the rows or override.
- `awaiting-locale-confirmation` — pick MDY or DMY first.
- `failed` extraction — re-extract or fix the underlying issue.

The bundle button's tooltip explains why it's disabled in any of these states.
