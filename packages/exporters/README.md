# @vibe-tx-converter/exporters

CSV / OFX 2.x XML / OFX 1.0.2 SGML (QBO + QFX) writers, the TRNTYPE
inference rules, and the deterministic FITID generator.

## Purpose

- **CSV exporters** for QuickBooks 3-col, QuickBooks 4-col, Xero, and
  generic Date / Description / Amount / Memo.
- **OFX 2.1.1 XML** writer for modern OFX importers (Xero, modern
  aggregators) — ADR-008.
- **OFX 1.0.2 SGML** writer used by both **QBO** (with `<INTU.BID>`
  and the standard `<FI>` block) and **QFX** (with `<INTU.BID>` and
  `<INTU.USERID>`, no `<FI>` block) — Quicken / QuickBooks Desktop
  require SGML.
- **TRNTYPE inference rules** with first-match-wins ordering. See
  `docs/extraction.md` for the verbatim rule list.
- **FITID derivation** — `VTC-` + sha1(date | cents | normalized_desc
  | seq_in_day) truncated to 16 hex chars (ADR-005). Total length
  20 chars.
- **BANKID fallback ladder** — `routing → 9-digit BID → padded BID →
'000000000'` (commit `702449e`).

## Public API

```ts
export * from './fitid.js';
export * from './trntype-rules.js';
export * from './ofx/ast.js';
export * from './ofx/xml-writer.js';
export * from './ofx/sgml-writer.js';
export * from './csv/index.js';
```

Notable named exports:

- `computeFitid(input)`, `assignSeqInDay(rows)`.
- `inferTrntype(input)`, `inferTrntypeWithReason(input)`,
  `getTrntypeReason(input)`, `normalizeDescription(raw)`.
- `resolveBankId(routing, intuBid)`, `deriveIntuUserid(seed)`.
- `renderOfxXml(stmt)` (OFX 2.x).
- `renderOfxSgml(stmt, opts)`, `renderQbo(stmt)`, `renderQfx(stmt)`.
- The `Stmt`, `BankAccountInfo`, `StmtTrn` AST types in `ofx/ast.ts`.

## How it's used

- `apps/api/src/routes/statements.ts` — `POST /api/statements/:id/
exports/:format` builds a `Stmt` AST from the persisted statement +
  transactions and streams the writer's output back to the client.
- `apps/api/src/jobs/extraction.worker.ts` calls
  `inferTrntypeWithReason` and `computeFitid` just before persisting
  transactions (per Phase 17).
- The QBO export auto-splits over 200 transactions into a zip; the
  splitter lives in `apps/api`, but the writer is invoked once per
  chunk.

## Testing

```
pnpm --filter @vibe-tx-converter/exporters test
```

Tests in `exporters-render.test.ts` cover header bytes, CRLF line
endings, `<INTU.BID>` always-emit + `'3000'` fallback, the BANKID
fallback ladder per ADR-012, and FITID determinism. Per `PROGRESS.md`,
golden-master fixtures per template are not yet authored — use
`exporters-render.test.ts` as the source of truth until they land.
