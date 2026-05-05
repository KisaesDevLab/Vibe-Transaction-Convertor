# Importing `.qfx` into Quicken

Operator-facing walkthrough for taking a generated `.qfx` Web Connect
file from `vibe-tx-converter` into Quicken on Windows or macOS.

## What gets generated

QFX is OFX 1.0.2 SGML with Intuit-specific extensions (ADR-008).
Quicken-specific differences vs. QBO:

- The standard `<FI>` block is omitted (Quicken does not require it
  when `<INTU.BID>` is present).
- A synthetic `<INTU.USERID>` is always emitted. The value is
  `VTC` + the account's UUID with dashes stripped and uppercased
  (commit `702449e`, ADR exporters/src/ofx/ast.ts → `deriveIntuUserid`).
  This makes the value stable per account across re-exports.
- `<INTU.BID>` is always emitted, falling back to `3000` when the
  account has no BID on file.

## Import steps

### Quicken for Windows

1. **File → Import → Web Connect File...** (older versions: **File →
   File Import → Web Connect File**).
2. Browse to the downloaded `.qfx`.
3. Quicken prompts: "Add to existing account?" or "Create new account?"
   — pick the matching account.
4. Quicken applies the transactions to the register; review and
   accept.

### Quicken for Mac

1. **File → Import → Bank or Brokerage File**.
2. Browse to the `.qfx`.
3. If the import dialog rejects the file with "FI not subscribed" or
   refuses to recognize the `.qfx` extension, **rename the file
   extension to `.qbo`** and try again. Quicken for Mac is occasionally
   pickier about which extensions trigger the Web Connect importer —
   the underlying SGML body is identical.
4. Pick the existing account; review and accept.

## Common errors

### "FI not subscribed" / "This account is not set up for Web Connect"

Almost always caused by a missing `<INTU.USERID>` in the file. The
`vibe-tx-converter` QFX writer **always** emits a stable
`<INTU.USERID>` — derived from the account's UUID — so a freshly
downloaded `.qfx` from this app should never trip this error. If you
do see it, check that:

- The downloaded file is the `.qfx` you actually exported (not an
  earlier draft from a tool that produced QFX without USERID).
- The file has not been edited; opening in a text editor and saving
  with a different encoding will sometimes drop `<INTU.USERID>` if the
  editor's SGML parser is overly aggressive.

### "Cannot read this Web Connect file"

Caused by line-ending corruption. The writer emits `\r\n` SGML; ASCII
text-mode FTP, some scrubbers, and certain email gateways rewrite line
endings and break the parse. Re-download directly from the app.

### Account-mapping mismatch

Quicken matches incoming Web Connect files by `(INTU.BID, ACCTID)`. If
you change the bank in `vibe-tx-converter` after a previous import,
Quicken may not auto-match the new file to the existing register.
Either revert the bank choice or use Quicken's "Link to existing
account" path during import.

## Notes

- Re-importing the same `.qfx` is safe: FITIDs are deterministic
  (ADR-016) so Quicken deduplicates rather than double-booking.
- Quicken's older "Direct Connect" feature (live bank feed) is
  unrelated to Web Connect and is out of scope for `vibe-tx-converter`
  (per Appendix D, no push integrations in v1).
