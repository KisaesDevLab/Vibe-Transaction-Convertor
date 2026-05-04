# ADR-008 — OFX format split: 2.x XML standalone, 1.x SGML for QBO/QFX

## Status

Accepted.

## Context

The OFX standard has two incompatible serializations. **OFX 2.x XML** is a
clean XML profile suitable for ingestion by Xero, modern aggregators, and
"OFX standalone" import paths. **OFX 1.0.2 SGML** is the older,
SGML-flavored, header-prefixed format that QuickBooks Web Connect (`.qbo`)
and Quicken (`.qfx`) actually require. Despite the version numbers, QBO and
QFX consumers in 2026 still demand the 1.x SGML profile — emitting 2.x
breaks the import. The two profiles share a logical structure (banks,
accounts, transactions, balances) but differ in syntax (XML vs SGML), header
encoding, and a handful of element naming nuances.

## Decision

The exporter package emits **two OFX profiles** from a shared AST:

- **OFX 2.x XML** — used by the OFX standalone export (`*.ofx`). Writer at
  `packages/exporters/src/ofx/xml-writer.ts`.
- **OFX 1.0.2 SGML** — used by the QBO export (`*.qbo`) and QFX export
  (`*.qfx`). Writer at `packages/exporters/src/ofx/sgml-writer.ts`.

The shared AST lives at `packages/exporters/src/ofx/ast.ts`. Building blocks
(SONRS / BANKMSGSRSV1 / STMTRS / BANKTRANLIST / STMTTRN / LEDGERBAL)
construct nodes once; each writer serializes the same node tree to its own
profile. This keeps the business logic (TRNTYPE inference, FITID generation,
balance handling) in one place and the syntax-specific bits in two thin
serializers.

QBO additionally requires `<INTU.BID>` and `<INTU.ORG>` elements in the
`<SONRS>` block (ADR-012). QFX uses `<INTU.BID>` only. The AST carries
optional Intuit fields; the writers emit or skip them per format.

## Consequences

- **Pro:** One AST, one set of unit tests for the logical structure, two
  thin syntax shims.
- **Pro:** Adding a new OFX consumer is a few hundred lines of writer
  plumbing.
- **Con:** Two writers means two opportunities for drift. Mitigation:
  golden-master tests in Phase 27 fix bytes for representative statements
  in both profiles.
- **Con:** SGML is awkward to validate; we ship a small parser-cum-validator
  in tests rather than relying on external tools.

## References

- `packages/exporters/src/ofx/ast.ts`
- `packages/exporters/src/ofx/xml-writer.ts`
- `packages/exporters/src/ofx/sgml-writer.ts`
- BuildPlan.md §3 ADR-008, Phases 21-23.
