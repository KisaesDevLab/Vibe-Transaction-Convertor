# Importing `.qbo` into QuickBooks Desktop

Operator-facing walkthrough for taking a generated `.qbo` Web Connect
file from `vibe-tx-converter` and pulling it into QuickBooks Desktop
Pro, Premier, or Enterprise.

## What gets generated

QBO Web Connect is OFX 1.0.2 SGML with Intuit-specific extensions
(ADR-008). Each export emits:

- The standard SGML header (`OFXHEADER:100`, `DATA:OFXSGML`,
  `VERSION:102`, etc.).
- A `<SONRS>` signon block with the standard `<FI><ORG><FID></FI>`
  block.
- An always-present `<INTU.BID>` tag with the BANKID fallback ladder
  (commit `702449e`).
- One `<STMTTRN>` per transaction with deterministic FITIDs (ADR-005).
- `<LEDGERBAL><DTASOF>` set to the statement period end (not the upload
  date).

## Credit-card accounts: amount signs

Credit-card statements are stored the way the issuer prints them —
charges positive, payments negative, an owed balance positive — because
that is what the Golden Rule reconciles. Every export flips them to the
**account holder's perspective** that QuickBooks, Quicken and Xero expect
(OFX spec §3.2.9.2):

| Row                  | Stored (statement sign) | Exported                                |
| -------------------- | ----------------------- | --------------------------------------- |
| Purchase / charge    | `127.83`                | `<TRNAMT>-127.83` (Debit column in CSV) |
| Payment / refund     | `-500.00`               | `<TRNAMT>500.00` (Credit column in CSV) |
| Owed closing balance | `2890.45`               | `<BALAMT>-2890.45`                      |

This applies to `.qbo`, `.qfx`, `.ofx` and all four CSV templates (the
Generic CSV's RunningBalance column is flipped the same way). Bank and
savings accounts are unaffected. The TRNTYPE is unchanged — a charge is
still `DEBIT`, it now simply carries a negative amount.

**Credit-card files exported before this fix had every sign inverted.**
FITIDs did not change (they are derived from the stored amounts —
ADR-005), so QuickBooks treats a corrected re-import as duplicates of the
earlier, wrongly signed transactions and skips them. Delete the earlier
import's transactions for that statement in QuickBooks first, then
import the re-exported file.

## BANKID fallback ladder

`packages/exporters/src/ofx/ast.ts → resolveBankId()` chooses the
`<BANKID>` value in this order:

1. **Account routing number**, if it is exactly 9 digits.
2. **Intuit BID, 9-digit form**, if it is exactly 9 digits.
3. **Intuit BID, padded form** — any 1- to 9-digit BID gets left-padded
   with zeros to 9 digits (e.g. `3000` → `000003000`).
4. **Hardcoded fallback** `000000000` — used only when the account has
   no routing number and no BID configured at all.

For `<INTU.BID>` and `<FID>`, the writer always emits a value. When the
account has no BID on file, `'3000'` is used (Wells Fargo's generic ID,
accepted by QuickBooks and noted in the audit log so operators can see
when guessing happens). This is the documented commit `702449e`
behavior.

## Import steps (QuickBooks Desktop)

1. In QuickBooks Desktop, open the company file you want to import
   into. Make sure the bank account is already created in your Chart of
   Accounts.
2. **File → Utilities → Import → Web Connect Files**.
3. Browse to the `.qbo` file you downloaded from `vibe-tx-converter`.
4. QuickBooks asks "Use an existing QuickBooks account?" — pick the
   matching account from the dropdown, click **Continue**.
5. QuickBooks shows the Bank Feeds Center with the imported
   transactions in the **Transactions List** panel. Match or add each
   row.
6. Repeat for each `.qbo` if you exported multiple statements.

## Large statements: 200-transaction split

The exporter automatically splits a `.qbo` over 200 transactions into
multiple files inside a single zip download. **QuickBooks Desktop does
not allow importing more than one Web Connect file in a single
batch** — you must import each `.qbo` individually, one after the
other. There is no way to merge them on the QuickBooks side.

## Common errors

### `OL-220` — "We're sorry. The financial institution you selected is not authorized..."

Caused by a stale or unrecognized `<INTU.BID>`. QuickBooks ships an
internal allow-list of BIDs and rejects unknown ones. Mitigations:

- Confirm the account in `vibe-tx-converter` has the correct Bank
  picked from the FIDIR list. The picker writes the BID into the
  account record.
- If your bank is not in the FIDIR mirror, the account will export with
  the `'3000'` fallback. QuickBooks accepts `3000` in current versions
  but very old QB releases may reject it — re-export against a known
  BID by editing the account's bank.
- Make sure the FIDIR mirror is fresh: `just fidir-refresh` (or admin →
  Refresh FIDIR).

### `OL-249` — "Account number mismatch"

Caused when the `<ACCTID>` in the `.qbo` does not match the account
QuickBooks has on file for that bank feed. Mitigations:

- In `vibe-tx-converter`, open the account, click **Reveal**
  (admin-only, 30-second window), and confirm the full account number
  matches what QuickBooks expects.
- If the bank statement printed only the masked tail (`••••1234`), the
  exporter will use the masked form — which fails this check. Edit the
  account to enter the full number and re-export.

### Other parser errors

QuickBooks's importer is strict about the SGML header line endings.
The writer emits `\r\n` everywhere (commit `702449e`); if you ever see
"OFX file is not in a valid format" the most likely cause is a
text-mode FTP transfer or a file scrubber that rewrote line endings —
re-download the file from the app.

## Notes

- QuickBooks Online uses a different import path (CSV / direct bank
  feed) and is not covered here. Use the **Generic CSV** export for
  QBO Online.
- Re-importing the same `.qbo` is safe: FITIDs are deterministic
  (ADR-016) so QuickBooks deduplicates rather than double-booking.
