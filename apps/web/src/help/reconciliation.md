# Reconciliation

The Golden Rule: **opening balance + sum(transactions) = closing balance**, to the cent. The reconciliation widget on the right of the review page shows where you stand:

- **Opening** — what the LLM read as opening balance.
- **Sum of N txns** — sum of every transaction's amount (debits negative, credits positive).
- **Expected closing** — opening + sum.
- **Actual closing** — what the LLM read as closing balance.
- **Delta** — the difference between expected and actual. **Has to be exactly zero** for `verified`.

## Statuses

- **`pending`** — extraction is still running.
- **`verified`** — delta is $0.00. Exports allowed unconditionally.
- **`discrepancy`** — delta is non-zero. Exports are blocked. Either fix the rows that are wrong, or override.
- **`overridden`** — the operator typed-confirmed an override. Exports allowed but explicitly marked. The override reason is captured in the audit log.
- **`failed`** — reconciliation couldn't run (usually a missing balance).

## How discrepancies happen

Common causes, in rough order of frequency:

1. **Wrong amount sign.** A refund that the LLM read as a debit, or an interest credit read as zero. Look for rows whose Pg color matches a known credit/refund area of the statement.
2. **Missing rows.** The LLM dropped one. Use "Add transaction" (admin only) at the bottom of the grid.
3. **Extra rows.** The LLM duplicated something. Select and delete.
4. **Wrong opening or closing balance.** Re-read those off the PDF and edit them in the header.
5. **Period bounds violation.** The LLM extracted a transaction outside `period_start`/`period_end`. The reconciliation widget shows a sub-count "discrepancy · N outside period". Decide whether each one belongs to this statement.

The `r` hot-key recomputes reconciliation after a batch of edits without saving each one through the API.

## Override

If you've manually verified the totals and the LLM is just off by a cent or two on a fee that doesn't matter, click **Override**. You'll be asked for a reason and to type-confirm. Both go into the audit log. Exports are allowed but the reconciliation badge stays amber so it's obvious downstream.

Override is a deliberate audit-trail event, not an "ignore" button. Use it when you've decided the data is good enough; not as a workaround for a real extraction bug.

## Suspect rows

Per-row "running balance off by N cents" warnings appear in red dots on the Conf column. The reconciler computes `prior_running + amount` for each row; rows where the LLM's reported `running_balance` doesn't match are flagged. These are the rows most likely to be the source of a discrepancy.
