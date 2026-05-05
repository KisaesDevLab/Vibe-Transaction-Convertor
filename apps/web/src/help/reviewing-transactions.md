# Reviewing transactions

The review page (`/statements/<id>`) is where you spend most of your time: a transaction grid on the left, the source PDF on the right, and a sticky reconciliation widget showing whether the math balances.

## The grid

Each row is one transaction the LLM extracted. Columns:

- **Date** — posted date, ISO format. Color-coded amber when outside the statement's period bounds.
- **Description** — the merchant or memo. Click to start an inline edit.
- **Type** — TRNTYPE (DEBIT, CREDIT, XFER, CHECK, etc.). Inline dropdown when editing.
- **Check #** — when the LLM saw a check number.
- **Amount** — color-coded red for debits, emerald for credits.
- **Running** — running balance the LLM read from the PDF. When the per-row running balance doesn't match `prior + amount`, the row gets a red dot in the **Conf** column.
- **Pg** — source page number; click any cell to highlight that location in the PDF viewer.
- **Conf** — confidence dot. Yellow at < 0.7 (LLM was unsure); red on running-balance mismatch.

## Editing

- **Click anything** to enter edit mode for that row.
- **`e` hot-key** edits the highlighted row.
- Tab through fields; **Save** when done, **Cancel** to revert.
- **`s` hot-key** saves the row currently being edited.

If **Auto-save** is on (toolbar checkbox, persisted in localStorage), edits commit on blur instead of needing the Save button. Off by default — operators usually want explicit confirmation per row.

## Hot-keys

| Key   | Action                              |
| ----- | ----------------------------------- |
| `j`   | Next row                            |
| `k`   | Previous row                        |
| `e`   | Edit selected row                   |
| `x`   | Toggle row selection (for bulk ops) |
| `s`   | Save the row currently being edited |
| `r`   | Recompute reconciliation            |
| `Esc` | Cancel edit / clear selection       |
| `?`   | Open the keyboard-shortcuts overlay |
| `/`   | Focus the search/filter field       |

## Filters

The toolbar has:

- **Description filter** — substring match.
- **Type filter** — single TRNTYPE.
- **Edited only** — rows the user has touched.
- **Suspect only** — rows where the LLM confidence < 0.7.
- **Amount range** — min/max in dollars (parsed leniently; bad input is ignored, not erroring).

## Bulk operations

`x` to select rows (or use the header checkbox). With selections active, the toolbar shows a "Set TRNTYPE to…" dropdown and a "Delete selected" button (admin only, typed confirm).

## PDF viewer

Right-side panel. Selecting a row scrolls the PDF to that page and draws a yellow box over the LLM's reported `source_bbox`. Clicking on the PDF picks the closest matching transaction. Use `+` / `-` to zoom, arrow keys to page, the toolbar selector to switch between fit-width / fit-page / manual zoom.

## Re-extract

If extraction went badly (wrong account detected, dates botched, etc.), the **Re-extract** button (admin only) discards every transaction on this statement and runs the LLM again from the source PDF. User edits are lost; the audit trail and the original PDF are preserved.
